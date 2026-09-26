import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

/**
 * Calculations in a sandbox. The code runs in QuickJS, a JavaScript engine compiled to WebAssembly, in
 * a fresh engine for every run: it gets only the rows it is given, as data, and nothing of the server
 * (no network, disk, timers, modules or host functions), with limits on time, memory, stack and the
 * size of what it returns. Memory is capped where it can't be got round: the engine's WebAssembly
 * memory can't grow past the limit, so running out stops the calculation, not the server.
 */

export interface SandboxLimits {
  /** Default 5 seconds. */
  timeoutMs?: number;
  /** Default 64 MB. */
  memoryBytes?: number;
  /** The largest result, as JSON (default 5 MB). */
  outputBytes?: number;
}

export interface CalculationInput {
  /** Rows by table key: plain objects of field values. */
  tables: Record<string, Record<string, unknown>[]>;
  /** Values the rule may use: today, this month, last month… */
  params?: Record<string, unknown>;
}

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[]; durationMs: number }
  | { ok: false; kind: "error" | "timeout" | "memory" | "output"; error: string; logs: string[]; durationMs: number };

const PAGE = 64 * 1024;
/** The engine's own start (16 MB): what the WebAssembly module asks for before any code runs. */
const INITIAL_PAGES = 256;

/** The parts of WebAssembly used here (Node has it; the TypeScript setup declares no browser types). */
interface Wasm {
  compile(bytes: Uint8Array): Promise<object>;
  Memory: new (descriptor: { initial: number; maximum: number }) => object;
}
const wasm = (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

let compiled: Promise<object> | undefined;

/** A new engine with its own memory, from the WebAssembly module compiled once. */
async function engine(memoryBytes: number): Promise<QuickJSWASMModule> {
  compiled ??= readFile(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")).then((bytes) => wasm.compile(bytes));
  const maximum = Math.max(INITIAL_PAGES, Math.ceil(memoryBytes / PAGE));
  const memory = new wasm.Memory({ initial: INITIAL_PAGES, maximum });
  return newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: (await compiled) as never, wasmMemory: memory as never }));
}

/** The program run in the sandbox: the input as JSON text, the code as a function body, the result as JSON text. */
function program(code: string, input: CalculationInput): string {
  return `"use strict";
const __logs = [];
const __say = (...values) => { if (__logs.length < 100) __logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ").slice(0, 500)); };
const console = { log: __say, info: __say, warn: __say, error: __say };
const __input = JSON.parse(${JSON.stringify(JSON.stringify({ tables: input.tables, params: input.params ?? {} }))});
const __value = (function calculate(tables, params) {
${code}
})(__input.tables, __input.params);
JSON.stringify({ value: __value === undefined ? null : __value, logs: __logs });`;
}

/** The line of the rule's code an error is on (the code starts on the program's 7th line). */
function where(stack: unknown): string {
  const line = typeof stack === "string" ? /:(\d+)(?::\d+)?\)?\s*$/m.exec(stack.split("\n")[0] ?? "")?.[1] : undefined;
  return line && Number(line) > 6 ? ` (line ${Number(line) - 6})` : "";
}

/**
 * Run a calculation: `code` is the body of `function calculate(tables, params)` and returns rows (an
 * array of objects), a number, a text or an object; the result comes back as data.
 */
export async function runCalculation(code: string, input: CalculationInput, limits: SandboxLimits = {}): Promise<SandboxResult> {
  const started = Date.now();
  const QuickJS = await engine(limits.memoryBytes ?? 64 * 1024 * 1024);
  const runtime = QuickJS.newRuntime();
  const timeoutMs = limits.timeoutMs ?? 5000;
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const context = runtime.newContext();
  const took = () => Date.now() - started;
  try {
    const evaluated = context.evalCode(program(code, input), "calculation.js");
    if (evaluated.error) {
      const error = context.dump(evaluated.error) as { name?: string; message?: string; stack?: string } | string;
      evaluated.error.dispose();
      const message = typeof error === "string" ? error : `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      if (/interrupted/i.test(message))
        return { ok: false, kind: "timeout", error: `It took longer than ${Math.round(timeoutMs / 1000)} seconds`, logs: [], durationMs: took() };
      if (/out of memory/i.test(message))
        return { ok: false, kind: "memory", error: "It needed more memory than a calculation may use", logs: [], durationMs: took() };
      return { ok: false, kind: "error", error: `${message}${typeof error === "string" ? "" : where(error?.stack)}`, logs: [], durationMs: took() };
    }
    const text = context.getString(evaluated.value);
    evaluated.value.dispose();
    if (text.length > (limits.outputBytes ?? 5 * 1024 * 1024)) {
      return { ok: false, kind: "output", error: "The result is too large; return fewer rows", logs: [], durationMs: took() };
    }
    const { value, logs } = JSON.parse(text) as { value: unknown; logs: string[] };
    return { ok: true, value, logs, durationMs: took() };
  } catch (error) {
    // The engine itself ran out of memory while building the result.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: /memory/i.test(message) ? "memory" : "error", error: message, logs: [], durationMs: took() };
  } finally {
    // An engine that ran out of memory may not tidy up; it is thrown away either way.
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      // nothing to keep
    }
  }
}
