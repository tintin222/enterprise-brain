/** A JSON Patch (RFC 6902) subset: the operations refinement needs. */
export interface PatchOperation {
  op: "add" | "replace" | "remove";
  /** JSON Pointer, e.g. /workflow/2/criteria/1/kind or /guardrails/approvalRequiredFor/- */
  path: string;
  value?: unknown;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function parsePointer(path: string): string[] {
  if (!path.startsWith("/")) throw new Error(`"${path}" is not a JSON Pointer`);
  const tokens = path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const forbidden = tokens.find((token) => FORBIDDEN_KEYS.has(token));
  if (forbidden) throw new Error(`"${forbidden}" is not allowed in a path`);
  return tokens;
}

function arrayIndex(array: unknown[], token: string, path: string, forInsert: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new Error(`${path}: "${token}" is not an array index`);
  const index = Number(token);
  if (index > array.length || (!forInsert && index === array.length)) throw new Error(`${path} does not exist`);
  return index;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

/** Apply operations to a copy of `document`; throws when a path doesn't exist. */
export function applyJsonPatch<T>(document: T, operations: readonly PatchOperation[]): T {
  const root = structuredClone(document) as unknown;
  for (const operation of operations) {
    const tokens = parsePointer(operation.path);
    const key = tokens.pop()!;
    let parent: unknown = root;
    for (const token of tokens) {
      if (Array.isArray(parent)) parent = parent[arrayIndex(parent, token, operation.path, false)];
      else if (isContainer(parent) && Object.hasOwn(parent, token)) parent = (parent as Record<string, unknown>)[token];
      else throw new Error(`${operation.path} does not exist`);
    }
    if (!isContainer(parent)) throw new Error(`${operation.path} does not exist`);
    if (Array.isArray(parent)) {
      if (operation.op === "add") parent.splice(key === "-" ? parent.length : arrayIndex(parent, key, operation.path, true), 0, operation.value);
      else if (operation.op === "remove") parent.splice(arrayIndex(parent, key, operation.path, false), 1);
      else parent[arrayIndex(parent, key, operation.path, false)] = operation.value;
    } else {
      if (operation.op !== "add" && !Object.hasOwn(parent, key)) throw new Error(`${operation.path} does not exist`);
      if (operation.op === "remove") delete parent[key];
      else parent[key] = operation.value;
    }
  }
  return root as T;
}
