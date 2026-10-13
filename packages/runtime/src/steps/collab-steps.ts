import { renderTemplate, type WorkflowStep } from "@enterprise-brain/core";
import type { ExecutionScope, StepOutcome } from "../run-types.ts";
import type { ToolDeps } from "../tools.ts";

type Step<T extends WorkflowStep["type"]> = Extract<WorkflowStep, { type: T }>;

/**
 * A message as the AI employee: in a channel, to a person (their direct message with it, or Teams or
 * Google Chat) or in the task's conversation. A person approves it first only when the step or the job
 * asks (a message stays visible where it is written); a test run finds the place and writes nothing.
 */
export async function runChatSend(step: Step<"chat.send">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  if (!deps.chat) throw new Error(`Step "${step.id}": Chat is not available here`);
  const to = renderTemplate(step.to, scope.context).trim();
  const text = renderTemplate(step.text, scope.context).trim();
  if (!to) throw new Error(`Step "${step.id}": nobody to write to`);
  if (!text) throw new Error(`Step "${step.id}": the message is empty`);
  const request = {
    companyId: scope.companyId,
    agentId: scope.agentId,
    to,
    ...(step.via ? { via: step.via } : {}),
    text,
    ...(scope.task ? { taskId: scope.task.id } : {}),
    runId: scope.runId,
  };
  if (scope.context.run.isTest) {
    const place = await deps.chat.post(request, { check: true });
    return {
      kind: "done",
      result: { dryRun: true, wouldSend: { to, where: place.where, via: place.via, text } },
      message: `message to ${place.where}: not sent in a test run (dry run)`,
    };
  }
  const asks = step.requiresApproval ?? scope.definition.guardrails.approvalRequiredFor.includes("chat.send");
  if (asks) {
    const place = await deps.chat.post(request, { check: true });
    return {
      kind: "pause",
      title: `Write to ${place.where}`,
      details: text,
      reason: step.requiresApproval ? "This step always asks a person" : "Its job says to always ask a person before writing in Chat",
      action: { type: "chat.send", ...request },
    };
  }
  const posted = await deps.chat.post(request);
  await scope.emit({
    type: "action.executed",
    stepId: step.id,
    message: `Wrote to ${posted.where}`,
    data: { action: { type: "chat.send", to, via: posted.via } },
  });
  return { kind: "done", result: { sent: true, to, ...posted }, message: `wrote to ${posted.where}` };
}
