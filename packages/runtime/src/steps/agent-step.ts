import { renderTemplate, type WorkflowStep } from "@enterprise-brain/core";
import { buildContext } from "@enterprise-brain/knowledge";
import type { LlmUsage } from "@enterprise-brain/llm";
import type { ExecutionScope, StepOutcome } from "../run-types.ts";
import { buildTools, type ToolDeps, type ToolScope } from "../tools.ts";
import { mergeUsage } from "./llm-steps.ts";

type AgentStep = Extract<WorkflowStep, { type: "agent" }>;

export const TOOL_GUIDANCE = [
  "Working rules:",
  "- Use the tools to look things up instead of guessing; never invent records, numbers or policy text.",
  "- Actions that change other systems or send email may be queued for human approval; say so plainly when that happens.",
  "- When you rely on knowledge base sources, cite them as [n].",
  "- Finish with a concise answer or summary of what you did and what is pending.",
].join("\n");

/** How to work on a task that can last days: wait for people instead of guessing, and close it when done. */
export function taskGuidance(ref: string): string {
  return [
    `This work is task ${ref}. It can take days; you are woken up when something happens.`,
    "- Emails you send carry the task's reference, so replies come back to this task.",
    "- When you need someone's answer, email them and call task_wait_for_reply; to check something later, call task_follow_up.",
    "- Record findings and decisions with task_note. When the work is finished, call task_complete with the outcome.",
  ].join("\n");
}

/** Autonomous tool-use loop (Claude) for open-ended steps. */
export async function runAgentStep(step: AgentStep, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const task = renderTemplate(step.task, scope.context);
  const capabilities = [...new Set([...step.tools, ...scope.definition.tools])];
  let toolUsage: LlmUsage | undefined;
  const toolScope: ToolScope = {
    companyId: scope.companyId,
    agentId: scope.agentId,
    runId: scope.runId,
    definition: scope.definition,
    employment: scope.employment,
    citations: [],
    emit: scope.emit,
    task: scope.task,
    dryRun: scope.context.run.isTest,
    onUsage: (usage) => {
      toolUsage = mergeUsage(toolUsage, usage);
    },
  };

  if (!deps.llm.available) {
    // Offline mode: no reasoning loop; surface the most relevant knowledge so the step is still useful.
    if (capabilities.includes("knowledge.search")) {
      const hits = await deps.knowledge.search(scope.companyId, task.slice(0, 500), {
        collections: scope.definition.knowledge.collections.length ? scope.definition.knowledge.collections : undefined,
        topK: 3,
      });
      return {
        kind: "done",
        result: {
          text: hits.length
            ? `Offline mode (no LLM configured). Most relevant knowledge:\n\n${buildContext(hits, 4000)}`
            : "Offline mode (no LLM configured) and no relevant knowledge was found.",
          offline: true,
        },
        message: "Autonomous step ran in offline mode",
      };
    }
    return {
      kind: "done",
      result: { text: "Offline mode: this step needs an LLM (set ANTHROPIC_API_KEY).", offline: true },
      message: "Autonomous step skipped in offline mode",
    };
  }

  const { tools, serverTools, warnings } = await buildTools(deps, toolScope, capabilities);
  for (const warning of warnings) await scope.emit({ type: "warning", stepId: step.id, message: warning });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const result = await deps.llm.runTools({
    purpose: `runtime.agent:${scope.definition.slug}.${step.id}`,
    system: `${scope.definition.instructions}\n\n${TOOL_GUIDANCE}${scope.task ? `\n\n${taskGuidance(scope.task.ref)}` : ""}`,
    messages: [{ role: "user", content: task }],
    tools: tools.map((t) => t.definition),
    serverTools,
    maxTurns: step.maxTurns ?? 12,
    effort: scope.definition.model?.effort ?? "high",
    model: scope.definition.model?.model,
    onText: scope.onText,
    executeTool: async (call) => {
      const tool = byName.get(call.name);
      if (!tool) return { content: `Unknown tool ${call.name}`, isError: true };
      return tool.execute((call.input ?? {}) as Record<string, unknown>);
    },
    onEvent: async (event) => {
      if (event.type === "assistant" && event.toolCalls.length) {
        await scope.emit({
          type: "tool.call",
          stepId: step.id,
          message: event.toolCalls.map((c) => c.name).join(", "),
          data: { turn: event.turn, calls: event.toolCalls, text: event.text },
        });
      } else if (event.type === "tool_result") {
        await scope.emit({
          type: "tool.result",
          stepId: step.id,
          message: `${event.call.name}${event.result.isError ? " (error)" : ""}`,
          data: { turn: event.turn, name: event.call.name, isError: event.result.isError ?? false, preview: event.result.content.slice(0, 500), durationMs: event.durationMs },
        });
      }
    },
  });
  return {
    kind: "done",
    result: {
      text: result.text,
      turns: result.turns,
      stopReason: result.stopReason,
      citations: toolScope.citations.map((c, i) => ({ n: i + 1, title: c.title, collection: c.collectionKey, documentId: c.documentId })),
    },
    usage: mergeUsage(result.usage, toolUsage),
  };
}
