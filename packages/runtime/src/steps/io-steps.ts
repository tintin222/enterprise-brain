import { isRecord, renderTemplate, resolveTemplate, stringify, type WorkflowStep } from "@enterprise-brain/core";
import { extractDocument, readWorkbook, writeWorkbook, type SheetData } from "@enterprise-brain/documents";
import { buildContext } from "@enterprise-brain/knowledge";
import type { LlmUsage } from "@enterprise-brain/llm";
import { toFileIds } from "../files.ts";
import type { ExecutionScope, StepOutcome } from "../run-types.ts";
import { withTaskRef } from "../tasks.ts";
import { approvalCheck, type ToolDeps } from "../tools.ts";
import { mergeUsage } from "./llm-steps.ts";

type Step<T extends WorkflowStep["type"]> = Extract<WorkflowStep, { type: T }>;

export async function runExtract(step: Step<"extract">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const fileIds = toFileIds(resolveTemplate(step.from, scope.context));
  if (!fileIds.length) throw new Error(`Step "${step.id}": no file found in ${step.from}`);
  const documents = [];
  const warnings: string[] = [];
  let usage: LlmUsage | undefined;
  for (const fileId of fileIds) {
    const file = await deps.files.get(scope.companyId, fileId);
    const doc = await extractDocument(
      { data: file.data, fileName: file.name, mimeType: file.mimeType },
      { llm: deps.llm, ocr: step.ocr ?? "auto" },
    );
    warnings.push(...doc.warnings);
    usage = mergeUsage(usage, doc.usage);
    documents.push({
      fileId,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      text: doc.text,
      language: doc.language ?? null,
      documentType: doc.documentType,
      needsOcr: doc.needsOcr,
      method: doc.method,
      pages: doc.pages?.length ?? null,
      sheets: doc.sheets ?? null,
    });
  }
  const message = warnings.length ? warnings.join("; ") : undefined;
  if (documents.length === 1) return { kind: "done", result: documents[0], message, usage };
  return {
    kind: "done",
    usage,
    result: {
      documents,
      text: documents.map((d) => `=== ${d.fileName} ===\n${d.text}`).join("\n\n"),
    },
    message,
  };
}

export async function runKnowledgeSearch(step: Step<"knowledge.search">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const query = renderTemplate(step.query, scope.context).slice(0, 2000);
  const collections = step.collections?.length ? step.collections : scope.definition.knowledge.collections;
  const hits = await deps.knowledge.search(scope.companyId, query, {
    collections: collections.length ? collections : undefined,
    topK: step.topK ?? 5,
  });
  return {
    kind: "done",
    result: {
      query,
      hits: hits.map((h) => ({ title: h.title, content: h.content, score: h.score, collection: h.collectionKey, documentId: h.documentId })),
      context: buildContext(hits),
    },
  };
}

export async function runConnector(step: Step<"connector">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const binding = scope.definition.connectors.find((c) => c.ref === step.connector);
  if (!binding) throw new Error(`Step "${step.id}": connector "${step.connector}" is not declared by the agent`);
  const resolved = await deps.connectors.resolve(scope.companyId, binding);
  const op = deps.connectors.operation(resolved.impl, step.operation);
  const resolvedInput = resolveTemplate(step.input, scope.context);
  const input = isRecord(resolvedInput) ? stripEmpty(resolvedInput) : {};
  if (scope.context.run.isTest && (op.kind === "write" || op.requiresApproval)) {
    // Test runs never change a system, whatever approved them: what it would do is shown instead. A replay
    // carries on with what the system answered in the original task (a case number), when it was called.
    return {
      kind: "done",
      result: { ...replayed(scope, step.id), dryRun: true, wouldExecute: { type: "connector", system: resolved.name, operation: op.id, operationName: op.name, input } },
      message: `${op.name} in ${resolved.name}: not done in a test run (dry run)`,
    };
  }
  const check =
    op.kind === "write" || op.requiresApproval
      ? await approvalCheck(deps, scope, { type: "connector", ref: binding.ref, operation: op.id, input, alwaysAsk: op.requiresApproval }, step.requiresApproval)
      : undefined;
  if (check?.needed) {
    return {
      kind: "pause",
      title: `${op.name} in ${resolved.name}`,
      details: `${scope.definition.name} wants to ${op.name.toLowerCase()} in ${resolved.name}${resolved.sandbox ? " (sandbox)" : ""}.`,
      reason: check.reason,
      action: {
        type: "connector",
        ref: binding.ref,
        category: binding.category,
        instanceId: resolved.instanceId ?? undefined,
        operation: op.id,
        operationName: op.name,
        system: resolved.name,
        input,
      },
    };
  }
  const result = await deps.connectors.execute(scope.companyId, resolved, op.id, input);
  if (check) {
    await scope.emit({
      type: "action.executed",
      stepId: step.id,
      message: `${op.name} in ${resolved.name}`,
      data: { alone: check.alone ?? false, reason: check.reason, action: { type: "connector", ref: binding.ref, operation: op.id } },
    });
  }
  return { kind: "done", result, message: `${resolved.name}${resolved.sandbox ? " (sandbox)" : ""}: ${op.name}` };
}

/** Replays: what a step's call returned in the original task (without its own dry-run marks), or nothing. */
function replayed(scope: ExecutionScope, stepId: string): Record<string, unknown> {
  const recorded = scope.recorded?.[stepId];
  if (!isRecord(recorded)) return {};
  const { dryRun: _dryRun, wouldExecute: _wouldExecute, ...rest } = recorded;
  return rest;
}

/** Drop undefined/empty-string values so optional operation parameters are omitted rather than sent blank. */
function stripEmpty(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

export function runApproval(step: Step<"approval">, scope: ExecutionScope): StepOutcome {
  const reason = step.reason ? renderTemplate(step.reason, scope.context).trim() : "";
  return {
    kind: "pause",
    title: renderTemplate(step.title, scope.context),
    details: step.details ? renderTemplate(step.details, scope.context) : "",
    assigneeRole: step.assigneeRole,
    action: { type: "decision" },
    ...(reason ? { reason } : {}),
  };
}

export async function runMailSend(step: Step<"mail.send">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const subject = renderTemplate(step.subject, scope.context);
  if (scope.context.run.isTest) {
    const to = renderTemplate(step.to, scope.context);
    return {
      kind: "done",
      result: { ...replayed(scope, step.id), dryRun: true, wouldExecute: { type: "mail.send", to, subject, body: renderTemplate(step.body, scope.context) } },
      message: `Email to ${to}: not sent in a test run (dry run)`,
    };
  }
  const action = {
    type: "mail.send" as const,
    to: renderTemplate(step.to, scope.context),
    // Replies find their way back to the task through its reference.
    subject: scope.task ? withTaskRef(subject, scope.task.ref) : subject,
    body: renderTemplate(step.body, scope.context),
    inReplyTo: step.inReplyTo ? renderTemplate(step.inReplyTo, scope.context) || undefined : undefined,
    ...(scope.task ? { taskId: scope.task.id } : {}),
  };
  if (!action.to) throw new Error(`Step "${step.id}": no recipient`);
  const check = await approvalCheck(deps, scope, { type: "mail.send", to: action.to }, step.requiresApproval);
  if (check.needed) {
    return {
      kind: "pause",
      title: `Send email to ${action.to}`,
      details: `Subject: ${action.subject}\n\n${action.body}`,
      reason: check.reason,
      action,
    };
  }
  const sent = await deps.mail.send(scope.companyId, action);
  await scope.emit({
    type: "action.executed",
    stepId: step.id,
    message: `Sent email to ${action.to}: ${action.subject}`,
    data: { alone: check.alone ?? false, reason: check.reason, action: { type: "mail.send", to: action.to, subject: action.subject } },
  });
  return { kind: "done", result: { sent: true, messageId: sent.messageId, delivery: sent.delivery, to: action.to, subject: action.subject } };
}

export async function runExcelRead(step: Step<"excel.read">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const [fileId] = toFileIds(resolveTemplate(step.from, scope.context));
  if (!fileId) throw new Error(`Step "${step.id}": no file found in ${step.from}`);
  const file = await deps.files.get(scope.companyId, fileId);
  let sheets: SheetData[];
  if (/\.(csv|tsv)$/i.test(file.name) || /csv/.test(file.mimeType)) {
    sheets = (await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType })).sheets ?? [];
  } else {
    sheets = await readWorkbook(file.data);
  }
  if (step.sheet) sheets = sheets.filter((s) => s.name === step.sheet);
  const first = sheets[0];
  return { kind: "done", result: { fileName: file.name, sheets, rows: first?.rows ?? [], columns: first?.columns ?? [] } };
}

export async function runExcelWrite(step: Step<"excel.write">, scope: ExecutionScope, deps: ToolDeps): Promise<StepOutcome> {
  const data = resolveTemplate(step.data, scope.context);
  let sheets: { name: string; rows: Record<string, unknown>[] }[];
  if (Array.isArray(data)) {
    sheets = [{ name: "Sheet1", rows: data.filter(isRecord) }];
  } else if (isRecord(data) && isRecord(data.sheets)) {
    sheets = Object.entries(data.sheets).map(([name, rows]) => ({ name, rows: Array.isArray(rows) ? rows.filter(isRecord) : [] }));
  } else if (isRecord(data) && Array.isArray(data.sheets)) {
    sheets = (data.sheets as unknown[]).filter(isRecord).map((s, i) => ({
      name: String(s.name ?? `Sheet${i + 1}`),
      rows: Array.isArray(s.rows) ? (s.rows as unknown[]).filter(isRecord) : [],
    }));
  } else if (isRecord(data)) {
    sheets = [{ name: "Sheet1", rows: [data] }];
  } else {
    throw new Error(`Step "${step.id}": data must resolve to rows, got ${stringify(data).slice(0, 80)}`);
  }
  const buffer = await writeWorkbook(sheets);
  const rawName = step.fileName ? renderTemplate(step.fileName, scope.context) : `${scope.definition.slug}-${step.id}.xlsx`;
  const fileName = (rawName.endsWith(".xlsx") ? rawName : `${rawName}.xlsx`).replace(/[^\w.\- ]+/g, "_");
  const stored = await deps.files.put(scope.companyId, {
    name: fileName,
    data: buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source: "generated",
    metadata: { runId: scope.runId, agentId: scope.agentId },
  });
  return {
    kind: "done",
    result: { fileId: stored.id, fileName: stored.name, rowCount: sheets.reduce((n, s) => n + s.rows.length, 0) },
  };
}

export function runOutput(step: Step<"output">, scope: ExecutionScope): StepOutcome {
  return { kind: "done", result: resolveTemplate(step.value, scope.context) };
}

/**
 * Wait for a reply to the task's emails (at most `days`), or for a time. Outside a task (test runs)
 * nothing waits: the step completes at once as if the time had passed.
 */
export function runWait(step: Step<"wait">, scope: ExecutionScope): StepOutcome {
  let until: Date | undefined;
  if (step.until) {
    const resolved = renderTemplate(step.until, scope.context).trim();
    const parsed = resolved ? new Date(resolved) : undefined;
    if (parsed && !Number.isNaN(parsed.getTime())) until = parsed;
  }
  if (!until && step.days) until = new Date(Date.now() + step.days * 86_400_000);
  if (step.for === "time" && !until) throw new Error(`Step "${step.id}": a time wait needs days or a date in until`);
  if (!scope.task) {
    // A replay reuses what the original task found (its reply); otherwise the time is taken as passed.
    const recorded = scope.recorded?.[step.id];
    if (recorded !== undefined) return { kind: "done", result: recorded, message: "As in the original task (replay)" };
    return {
      kind: "done",
      result: step.for === "reply" ? { replied: false, timedOut: true, skipped: true } : { waited: true, skipped: true },
      message: "Not waiting outside a task (test run)",
    };
  }
  const title =
    step.for === "reply"
      ? `Waiting for a reply${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}`
      : `Waiting until ${until!.toISOString().slice(0, 16).replace("T", " ")}`;
  return { kind: "wait", title, for: step.for, until, days: step.days };
}
