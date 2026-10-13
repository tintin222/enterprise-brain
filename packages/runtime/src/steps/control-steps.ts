import { applyTransform, asList, renderTemplate, resolveTemplate, type WorkflowStep } from "@enterprise-brain/core";
import { runScript } from "@enterprise-brain/sandbox";
import type { ExecutionScope, StepOutcome } from "../run-types.ts";

type Step<T extends WorkflowStep["type"]> = Extract<WorkflowStep, { type: T }>;

/** Reshape a list: set fields, filter, sort, total by group, drop repeats, pick, rename, limit. */
export function runTransform(step: Step<"transform">, scope: ExecutionScope): StepOutcome {
  const list = asList(resolveTemplate(step.from, scope.context));
  const result = applyTransform(list, step.ops, scope.context as unknown as Record<string, unknown>);
  return { kind: "done", result, message: `${list.length} in, ${result.count} out` };
}

/** The longest a code step may run, whatever it asks. */
const MAX_CODE_SECONDS = 30;

/** Run the step's JavaScript in the sandbox with the run's data; what it returns is the result. */
export async function runCode(step: Step<"code">, scope: ExecutionScope): Promise<StepOutcome> {
  const context = scope.context;
  const values = step.input ? resolveTemplate(step.input, context) : {};
  const ctx: Record<string, unknown> = {
    input: context.input,
    steps: context.steps,
    vars: context.vars,
    agent: context.agent,
    run: context.run,
    values,
    ...(context.item !== undefined ? { item: context.item, index: context.index ?? 0 } : {}),
  };
  const seconds = Math.min(step.timeoutSeconds ?? 5, MAX_CODE_SECONDS);
  const ran = await runScript(step.code, ctx, { timeoutMs: seconds * 1000 });
  if (!ran.ok) throw new Error(`Step "${step.id}": the code ${ran.kind === "timeout" ? "ran too long" : "failed"}: ${ran.error}`);
  return { kind: "done", result: ran.value, message: ran.logs.length ? `Logged: ${ran.logs.slice(0, 3).join(" · ")}` : `Ran in ${ran.durationMs} ms` };
}

/** A header name a reply may carry, and ones only the server sets. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SERVER_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "set-cookie", "host"]);

/**
 * The answer for a system that started the work and waits for it: its status, headers and body as the
 * templates resolve now. The engine keeps the last one for the caller; a run nobody waits for only records it.
 */
export function runRespond(step: Step<"respond">, scope: ExecutionScope): StepOutcome {
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(step.headers ?? {})) {
    if (!HEADER_NAME.test(name) || SERVER_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = renderTemplate(template, scope.context).replace(/[\r\n]+/g, " ");
  }
  const status = step.status ?? 200;
  const body = step.body === undefined ? null : resolveTemplate(step.body, scope.context);
  return { kind: "done", result: { status, headers, body }, message: `the caller gets ${status}` };
}
