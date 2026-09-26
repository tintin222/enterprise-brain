import type { AgentDefinition, ConnectorBinding, JsonSchema } from "@enterprise-brain/core";
import { operationToolName } from "@enterprise-brain/connectors";
import { extractDocument, readWorkbook, writeWorkbook } from "@enterprise-brain/documents";
import { buildContext, type KnowledgeService, type SearchHit } from "@enterprise-brain/knowledge";
import type { LlmClient, LlmUsage, ToolDefinition, ToolExecution } from "@enterprise-brain/llm";
import { describeAction } from "./actions.ts";
import type { ConnectorService } from "./connectors.ts";
import type { FileService } from "./files.ts";
import type { MailService } from "./mail.ts";
import { checkApproval, DEFAULT_EMPLOYMENT, type ApprovalCheck, type Employment, type WriteAction } from "./policy.ts";
import type { ApprovalAction, RunEventInput } from "./run-types.ts";
import { withTaskRef, type TaskPlan, type TaskService } from "./tasks.ts";

export interface DeferredApprovalRequest {
  runId?: string;
  agentId: string;
  stepId: string;
  title: string;
  details: string;
  action: ApprovalAction;
  /** Why a person is asked, in plain words. */
  reason?: string;
}

/** A question an AI employee asks a person while working on a task. */
export interface AskPersonRequest {
  companyId: string;
  agentId: string;
  taskId: string;
  runId?: string;
  question: string;
  context?: string;
  /** What it would do, and why: the person can just agree. */
  suggestion?: string;
  options?: string[];
  /** Ask its manager rather than anyone who handles its department's work. */
  toManager?: boolean;
}

export interface ToolDeps {
  llm: LlmClient;
  files: FileService;
  connectors: ConnectorService;
  knowledge: KnowledgeService;
  mail: MailService;
  requestApproval: (companyId: string, request: DeferredApprovalRequest) => Promise<{ id: string }>;
  /** Changes the AI employee made alone today (for its daily limit when trusted). */
  changesToday?: (agentId: string) => Promise<number>;
  tasks?: TaskService;
  askPerson?: (request: AskPersonRequest) => Promise<{ id: string }>;
}

export interface ToolScope {
  companyId: string;
  agentId: string;
  runId?: string;
  definition: AgentDefinition;
  /** Its level and limits; supervised when unknown (e.g. the default company assistant). */
  employment?: Employment;
  /** Knowledge hits retrieved during the loop, used for citations. */
  citations: SearchHit[];
  /** Records changes made without a person in the run's history. */
  emit?: (event: RunEventInput) => Promise<void>;
  /** The task the run works on: its emails carry the reference, and the task tools act on it. */
  task?: { id: string; ref: string };
  /** A test run: nothing is sent or written, the tools say what they would do. */
  dryRun?: boolean;
  /** Model use the tools had (working an old system's screens), counted with the step's. */
  onUsage?: (usage: LlmUsage) => void;
}

export interface RuntimeTool {
  capability: string;
  kind: "read" | "write";
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<ToolExecution>;
}

/** Ask the policy, counting today's changes only when the AI employee has a daily limit. */
export async function approvalCheck(
  deps: Pick<ToolDeps, "changesToday">,
  scope: { agentId: string; definition: AgentDefinition; employment?: Employment },
  action: WriteAction,
  explicit?: boolean,
): Promise<ApprovalCheck> {
  const employment = scope.employment ?? DEFAULT_EMPLOYMENT;
  const counted = explicit === undefined && employment.probation === "trusted" && employment.limits.maxActionsPerDay !== undefined;
  const changesToday = counted ? await deps.changesToday?.(scope.agentId) : undefined;
  return checkApproval(scope.definition, employment, action, { explicit, changesToday });
}

function json(value: unknown, max = 40_000): string {
  const text = JSON.stringify(value, null, 1);
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

function objectSchema(schema: unknown): JsonSchema {
  const s = (schema && typeof schema === "object" ? schema : {}) as JsonSchema;
  return { type: "object", properties: {}, ...s };
}

/** Parse "connector:ats" / "connector:ats.create_candidate" capability names. */
function connectorCapability(capability: string): { ref: string; operation?: string } | undefined {
  const match = capability.match(/^connector:([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_.]+))?$/);
  if (!match) return undefined;
  return { ref: match[1]!, operation: match[2] };
}

export async function buildTools(
  deps: ToolDeps,
  scope: ToolScope,
  capabilities: string[],
): Promise<{ tools: RuntimeTool[]; serverTools: Record<string, unknown>[]; warnings: string[] }> {
  const tools: RuntimeTool[] = [];
  const serverTools: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const { companyId, definition } = scope;
  const unique = [...new Set(capabilities)];

  const deferred = async (title: string, action: ApprovalAction, reason: string): Promise<ToolExecution> => {
    const approval = await deps.requestApproval(companyId, {
      runId: scope.runId,
      agentId: scope.agentId,
      stepId: "agent",
      title,
      details: describeAction(action),
      action,
      reason,
    });
    return {
      content: `Submitted for human approval (approval id ${approval.id}). The action will be executed once approved; tell the user it is pending approval.`,
    };
  };

  for (const capability of unique) {
    switch (capability) {
      case "knowledge.search":
        tools.push({
          capability,
          kind: "read",
          definition: {
            name: "knowledge_search",
            description:
              "Search the company knowledge base (policies, procedures, product docs, past cases). Returns numbered sources; cite them as [n] in answers.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "What to look for, in natural language" },
                collections: { type: "array", items: { type: "string" }, description: "Optional collection keys to restrict the search" },
              },
              required: ["query"],
            },
          },
          async execute(input) {
            const collections = (input.collections as string[] | undefined)?.length
              ? (input.collections as string[])
              : definition.knowledge.collections.length
                ? definition.knowledge.collections
                : undefined;
            const hits = await deps.knowledge.search(companyId, String(input.query ?? ""), { collections, topK: 6 });
            const offset = scope.citations.length;
            scope.citations.push(...hits);
            if (!hits.length) return { content: "No matching knowledge found." };
            return {
              content: hits
                .map((h, i) => `[${offset + i + 1}] ${h.title} (${h.collectionKey})\n${h.content}`)
                .join("\n\n"),
            };
          },
        });
        break;
      case "documents.read":
        tools.push({
          capability,
          kind: "read",
          definition: {
            name: "documents_read",
            description: "Read the text of an uploaded file (PDF, Word, Excel, image via OCR) by file id.",
            inputSchema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] },
          },
          async execute(input) {
            const file = await deps.files.get(companyId, String(input.file_id));
            const doc = await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType }, { llm: deps.llm });
            return { content: `${file.name} (${doc.documentType}, ${doc.language ?? "unknown language"})\n\n${doc.text.slice(0, 30_000)}` };
          },
        });
        break;
      case "excel.read":
        tools.push({
          capability,
          kind: "read",
          definition: {
            name: "excel_read",
            description: "Read an Excel/CSV file by file id. Returns sheets with columns and rows (JSON).",
            inputSchema: {
              type: "object",
              properties: { file_id: { type: "string" }, sheet: { type: "string" }, max_rows: { type: "number" } },
              required: ["file_id"],
            },
          },
          async execute(input) {
            const file = await deps.files.get(companyId, String(input.file_id));
            const maxRows = Number(input.max_rows ?? 300);
            let sheets = /\.csv$|text\/csv/i.test(`${file.name} ${file.mimeType}`)
              ? ((await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType })).sheets ?? [])
              : await readWorkbook(file.data);
            if (input.sheet) sheets = sheets.filter((s) => s.name === input.sheet);
            return {
              content: json(sheets.map((s) => ({ name: s.name, columns: s.columns, totalRows: s.rows.length, rows: s.rows.slice(0, maxRows) }))),
            };
          },
        });
        break;
      case "excel.write":
        tools.push({
          capability,
          kind: "read",
          definition: {
            name: "excel_write",
            description: "Create an Excel workbook from rows and store it as a file the user can download. Returns the file id.",
            inputSchema: {
              type: "object",
              properties: {
                file_name: { type: "string" },
                sheets: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { name: { type: "string" }, rows: { type: "array", items: { type: "object" } } },
                    required: ["name", "rows"],
                  },
                },
              },
              required: ["file_name", "sheets"],
            },
          },
          async execute(input) {
            const sheets = (input.sheets as { name: string; rows: Record<string, unknown>[] }[]) ?? [];
            const data = await writeWorkbook(sheets);
            const name = String(input.file_name || "result.xlsx").replace(/[^\w.\- ]+/g, "_");
            const stored = await deps.files.put(companyId, {
              name: name.endsWith(".xlsx") ? name : `${name}.xlsx`,
              data,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              source: "generated",
            });
            return { content: json({ file_id: stored.id, file_name: stored.name, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })) }) };
          },
        });
        break;
      case "mail.draft":
        tools.push({
          capability,
          kind: "read",
          definition: {
            name: "mail_draft",
            description: "Save an email draft for a human to review and send.",
            inputSchema: {
              type: "object",
              properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, in_reply_to: { type: "string" } },
              required: ["to", "subject", "body"],
            },
          },
          async execute(input) {
            const draft = await deps.mail.draft(companyId, {
              to: String(input.to),
              subject: String(input.subject),
              body: String(input.body),
              inReplyTo: input.in_reply_to ? String(input.in_reply_to) : undefined,
            });
            return { content: `Draft saved (id ${draft.id}).` };
          },
        });
        break;
      case "mail.send":
        tools.push({
          capability,
          kind: "write",
          definition: {
            name: "mail_send",
            description: "Send an email. Depending on policy this is queued for human approval first.",
            inputSchema: {
              type: "object",
              properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, in_reply_to: { type: "string" } },
              required: ["to", "subject", "body"],
            },
          },
          async execute(input) {
            const action: ApprovalAction = {
              type: "mail.send",
              to: String(input.to),
              // Replies find their way back to the task through its reference.
              subject: scope.task ? withTaskRef(String(input.subject), scope.task.ref) : String(input.subject),
              body: String(input.body),
              inReplyTo: input.in_reply_to ? String(input.in_reply_to) : undefined,
              ...(scope.task ? { taskId: scope.task.id } : {}),
            };
            if (scope.dryRun) return { content: `Test run: the email to ${action.to} ("${action.subject}") was not sent. Carry on as if it had been.` };
            const check = await approvalCheck(deps, scope, { type: "mail.send", to: action.to });
            if (check.needed) return deferred(`Send email to ${action.to}`, action, check.reason);
            const sent = await deps.mail.send(companyId, action);
            await scope.emit?.({
              type: "action.executed",
              stepId: "agent",
              message: `Sent email to ${action.to}: ${action.subject}`,
              data: { alone: check.alone ?? false, reason: check.reason, action: { type: "mail.send", to: action.to, subject: action.subject } },
            });
            return { content: `Email sent (id ${sent.messageId}).` };
          },
        });
        break;
      case "web.search":
        serverTools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
        break;
      default: {
        const parsed = connectorCapability(capability);
        if (!parsed) {
          warnings.push(`Unknown capability "${capability}" ignored`);
          break;
        }
        const binding: ConnectorBinding | undefined = definition.connectors.find((c) => c.ref === parsed.ref);
        if (!binding) {
          warnings.push(`Capability "${capability}" has no connector binding "${parsed.ref}"`);
          break;
        }
        let resolved;
        try {
          resolved = await deps.connectors.resolve(companyId, binding);
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
          break;
        }
        const operations = resolved.impl.manifest.operations.filter(
          (op) => (!parsed.operation || op.id === parsed.operation) && (!binding.operations?.length || binding.operations.includes(op.id)),
        );
        for (const op of operations) {
          const toolName = operationToolName(binding.ref, op.id);
          const target = resolved;
          tools.push({
            capability: `connector:${binding.ref}.${op.id}`,
            kind: op.kind,
            definition: {
              name: toolName,
              description: `[${resolved.name}${resolved.sandbox ? " — sandbox" : ""}] ${op.name}: ${op.description}${op.kind === "write" ? " (changes data; may require approval)" : ""}`,
              inputSchema: objectSchema(op.input),
            },
            async execute(input) {
              if (scope.dryRun && (op.kind === "write" || op.requiresApproval)) {
                return { content: `Test run: ${op.name} in ${target.name} was not done. It would have been called with ${json(input, 2000)}. Carry on as if it had been.` };
              }
              const check =
                op.kind === "write" || op.requiresApproval
                  ? await approvalCheck(deps, scope, { type: "connector", ref: binding.ref, operation: op.id, input, alwaysAsk: op.requiresApproval })
                  : undefined;
              if (check?.needed) {
                return deferred(
                  `${op.name} in ${target.name}`,
                  {
                    type: "connector",
                    ref: binding.ref,
                    category: binding.category,
                    instanceId: target.instanceId ?? undefined,
                    operation: op.id,
                    operationName: op.name,
                    system: target.name,
                    input,
                  },
                  check.reason,
                );
              }
              const result = await deps.connectors.execute(companyId, target, op.id, input, { onUsage: scope.onUsage });
              if (check) {
                await scope.emit?.({
                  type: "action.executed",
                  stepId: "agent",
                  message: `${op.name} in ${target.name}`,
                  data: { alone: check.alone ?? false, reason: check.reason, action: { type: "connector", ref: binding.ref, operation: op.id } },
                });
              }
              return { content: json(result) };
            },
          });
        }
      }
    }
  }
  if (scope.task && deps.tasks) tools.push(...taskTools(deps, deps.tasks, scope, scope.task));
  return { tools, serverTools, warnings };
}

/** Tools for working on a task over days: notes in its history, waiting for replies, follow-ups, closing it. */
function taskTools(deps: ToolDeps, tasks: TaskService, scope: ToolScope, task: { id: string; ref: string }): RuntimeTool[] {
  const plan = async (next: TaskPlan, text: string): Promise<ToolExecution> => {
    await tasks.update(task.id, { plan: next as unknown as Record<string, unknown> });
    return { content: text };
  };
  const tool = (name: string, description: string, properties: Record<string, JsonSchema>, required: string[], execute: RuntimeTool["execute"]): RuntimeTool => ({
    capability: "task",
    kind: "read",
    definition: { name, description, inputSchema: { type: "object", properties, required } },
    execute,
  });
  return [
    tool(
      "task_note",
      `Write a note in the history of task ${task.ref}: a finding, a decision and why, or what you are waiting for. People read it on the task page.`,
      { text: { type: "string" } },
      ["text"],
      async (input) => {
        await tasks.record(scope.companyId, task.id, { type: "note", message: String(input.text), actor: `agent:${scope.agentId}`, runId: scope.runId });
        return { content: "Noted in the task's history." };
      },
    ),
    tool(
      "task_wait_for_reply",
      `Wait for a reply to the emails you sent in task ${task.ref} (their subject carries the reference). You are woken when a reply arrives, or after the given days if nobody answers, to remind them or decide. Call it last, then end your turn.`,
      { days: { type: "number", description: "At most this many days (1–60)" }, note: { type: "string", description: "What you expect, for when you wake up" } },
      ["days"],
      async (input) => {
        const days = Math.min(60, Math.max(0.01, Number(input.days) || 3));
        return plan({ next: "wait_reply", days, note: input.note ? String(input.note) : undefined }, `Task ${task.ref} will wait for a reply for up to ${days} day(s). End your turn now.`);
      },
    ),
    tool(
      "task_follow_up",
      `Look at task ${task.ref} again later, e.g. to check that a payment arrived or a delivery was made. Give days, or a date. Call it last, then end your turn.`,
      { days: { type: "number" }, date: { type: "string", description: "YYYY-MM-DD" }, note: { type: "string", description: "What to check then" } },
      [],
      async (input) => {
        const date = typeof input.date === "string" && !Number.isNaN(Date.parse(input.date)) ? new Date(input.date) : undefined;
        const at = date ?? new Date(Date.now() + Math.min(365, Math.max(0.01, Number(input.days) || 1)) * 86_400_000);
        return plan({ next: "follow_up", at: at.toISOString(), note: input.note ? String(input.note) : undefined }, `Task ${task.ref} will be looked at again on ${at.toISOString().slice(0, 10)}. End your turn now.`);
      },
    ),
    tool(
      "task_ask_person",
      `Ask a person when you are unsure or something is missing that your tools and knowledge can't settle (a decision, a missing fact, an exception). Task ${task.ref} waits for the answer and you are woken with it. Give your suggestion when you have one: they can just agree. Call it last, then end your turn.`,
      {
        question: { type: "string", description: "One clear question" },
        context: { type: "string", description: "What you found and why you ask" },
        suggestion: { type: "string", description: "What you would do, and why" },
        options: { type: "array", items: { type: "string" }, description: "Possible answers, when there are a few" },
        to_manager: { type: "boolean", description: "Ask your manager (decisions above your level) rather than anyone in your department" },
      },
      ["question"],
      async (input) => {
        if (!deps.askPerson) return { content: "Asking people is not available here.", isError: true };
        await deps.askPerson({
          companyId: scope.companyId,
          agentId: scope.agentId,
          taskId: task.id,
          runId: scope.runId,
          question: String(input.question),
          context: input.context ? String(input.context) : undefined,
          suggestion: input.suggestion ? String(input.suggestion) : undefined,
          options: Array.isArray(input.options) ? input.options.map(String).slice(0, 8) : undefined,
          toManager: input.to_manager === true,
        });
        return { content: `Asked. Task ${task.ref} waits for the answer; you will be woken with it. End your turn now.` };
      },
    ),
    tool(
      "task_complete",
      `Close task ${task.ref}: the work is finished. Give the outcome in one or two sentences for the people who read the task.`,
      { outcome: { type: "string" } },
      ["outcome"],
      async (input) => plan({ next: "complete", outcome: String(input.outcome) }, `Task ${task.ref} will close as done. End your turn now.`),
    ),
  ];
}

export { buildContext };
