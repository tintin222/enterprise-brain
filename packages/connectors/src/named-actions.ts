import { NamedAction, type ActionParam, type JsonSchema, type OperationManifest } from "@enterprise-brain/core";
import { ConnectorError, type ConnectorContext, type ConnectorEvent, type ConnectorImplementation } from "./types.ts";
import { isRecord, type Rec } from "./util.ts";

/**
 * A connection with named actions: its operations are the actions IT defined (and nothing else), each
 * checked against its parameters and run by the connector's `runAction`. Watched actions become
 * events ("new:<action id>") that report new rows or items since the last check.
 */
export function withNamedActions(base: ConnectorImplementation, actions: NamedAction[]): ConnectorImplementation {
  const runAction = base.runAction;
  if (!runAction) throw new ConnectorError(`${base.manifest.name} doesn't support named actions`, "unsupported");
  const byId = new Map(actions.map((a) => [a.id, a]));
  const watched = actions.filter((a) => a.watch);
  return {
    manifest: {
      ...base.manifest,
      operations: actions.map(toOperation),
      events: watched.map((a) => ({ id: `new:${a.id}`, name: `New from ${a.name}`, description: `A new row or item appeared in "${a.name}" (by ${a.watch!.cursorField}).` })),
    },
    test: (ctx) => base.test(ctx),
    runAction,
    async execute(operationId, input, ctx) {
      const action = byId.get(operationId);
      if (!action) throw new ConnectorError(`${base.manifest.name} has no action "${operationId}"`, "unsupported");
      return runAction.call(base, action, checkParams(action, isRecord(input) ? input : {}), ctx);
    },
    async poll(eventId, ctx, cursor) {
      const action = byId.get(eventId.replace(/^new:/, ""));
      if (!action?.watch) throw new ConnectorError(`${base.manifest.name} has no event "${eventId}"`, "unsupported");
      return pollAction(action, (values) => runAction.call(base, action, values, ctx), eventId, cursor);
    },
  };
}

/** A named action as an operation (a tool for AI employees): its parameters as a JSON Schema. */
export function toOperation(action: NamedAction): OperationManifest {
  const properties: Record<string, JsonSchema> = {};
  for (const param of action.params) {
    const type = param.type === "integer" ? "integer" : param.type === "number" ? "number" : param.type === "boolean" ? "boolean" : "string";
    properties[param.key] = { type, ...(param.description ? { description: param.description } : {}), ...(param.type === "date" ? { format: "date" } : {}) };
  }
  return {
    id: action.id,
    name: action.name,
    description: action.description || action.name,
    kind: action.kind,
    input: { type: "object", properties, required: action.params.filter((p) => p.required).map((p) => p.key), additionalProperties: false },
    ...(action.requiresApproval ? { requiresApproval: true } : {}),
  };
}

/** The values for an action's parameters: required ones present, each converted to its type. */
export function checkParams(action: NamedAction, input: Rec): Rec {
  const values: Rec = {};
  for (const param of action.params) {
    const raw = input[param.key];
    if (raw === undefined || raw === null || raw === "") {
      if (param.required) throw new ConnectorError(`${action.name}: ${param.key} is required`, "validation");
      continue;
    }
    values[param.key] = convert(param, raw, action.name);
  }
  const unknown = Object.keys(input).filter((k) => !action.params.some((p) => p.key === k));
  if (unknown.length) throw new ConnectorError(`${action.name} doesn't take ${unknown.join(", ")}`, "validation");
  return values;
}

function convert(param: ActionParam, raw: unknown, actionName: string): unknown {
  const fail = (): never => {
    throw new ConnectorError(`${actionName}: ${param.key} must be ${param.type === "integer" ? "a whole number" : `a ${param.type}`}`, "validation");
  };
  switch (param.type) {
    case "number":
    case "integer": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n) || (param.type === "integer" && !Number.isInteger(n))) fail();
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      return fail();
    case "date": {
      const text = String(raw);
      if (Number.isNaN(Date.parse(text))) fail();
      return text;
    }
    default:
      if (typeof raw === "object") fail();
      return String(raw);
  }
}

/** "/customers/{id}/orders" with { id: "C 1" } → "/customers/C%201/orders". */
export function fillPath(template: string, values: Rec): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined || value === null || value === "") throw new ConnectorError(`The path needs ${key}`, "validation");
    return encodeURIComponent(String(value));
  });
}

/**
 * A query or body template with the values: a string that is exactly "{key}" becomes the value itself
 * (a number stays a number); "{key}" inside longer text is replaced by its text. Keys without a value
 * are left out.
 */
export function fillTemplate(template: unknown, values: Rec): unknown {
  if (typeof template === "string") {
    const whole = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/.exec(template);
    if (whole) return values[whole[1]!];
    return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key: string) => (values[key] === undefined || values[key] === null ? "" : String(values[key])));
  }
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values)).filter((v) => v !== undefined);
  if (isRecord(template)) {
    const out: Rec = {};
    for (const [key, value] of Object.entries(template)) {
      const filled = fillTemplate(value, values);
      if (filled !== undefined) out[key] = filled;
    }
    return out;
  }
  return template;
}

// ---------------------------------------------------------------------------
// Watching an action for new rows or items
// ---------------------------------------------------------------------------

/** Rows from an action's result: SQL rows, or a web service's list (data, items, value, results). */
export function rowsOf(result: unknown): Rec[] {
  const unwrap = (value: unknown): unknown => (isRecord(value) && "data" in value && "status" in value ? value.data : value);
  const data = unwrap(result);
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data)) {
    for (const key of ["rows", "items", "value", "results", "data", "records"]) {
      if (Array.isArray(data[key])) return (data[key] as unknown[]).filter(isRecord);
    }
  }
  return [];
}

/** Compare cursor values: numbers as numbers, dates as dates, anything else as text. */
export function compareCursor(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const da = Date.parse(String(a));
  const db = Date.parse(String(b));
  if (!Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-\d{2}-\d{2}/.test(String(a)) && /\d{4}-\d{2}-\d{2}/.test(String(b))) return da - db;
  return String(a).localeCompare(String(b));
}

/** One check of a watched action: the first only records where to start; later ones report what is new. */
export async function pollAction(
  action: NamedAction,
  run: (values: Rec) => Promise<unknown>,
  eventId: string,
  cursor: string | undefined,
): Promise<{ events: ConnectorEvent[]; cursor?: string }> {
  const watch = action.watch!;
  if (cursor === undefined) {
    const start = !watch.start || watch.start === "now" ? new Date().toISOString() : watch.start;
    return { events: [], cursor: start };
  }
  const rows = rowsOf(await run({ since: cursor }));
  const fresh = rows
    .filter((row) => row[watch.cursorField] !== undefined && row[watch.cursorField] !== null && compareCursor(row[watch.cursorField], cursor) > 0)
    .sort((a, b) => compareCursor(a[watch.cursorField], b[watch.cursorField]));
  const events = fresh.map((row) => ({
    id: `${action.id}:${String(row[watch.idField ?? watch.cursorField])}`,
    type: eventId,
    occurredAt: new Date().toISOString(),
    data: row,
  }));
  const last = fresh.at(-1)?.[watch.cursorField];
  return { events, cursor: last === undefined ? cursor : String(last instanceof Date ? last.toISOString() : last) };
}

// ---------------------------------------------------------------------------
// Proposing actions: from an OpenAPI (Swagger) description, or from example calls
// ---------------------------------------------------------------------------

export interface ProposedActions {
  actions: NamedAction[];
  /** The service's base URL, when the description names one. */
  baseUrl?: string;
  warnings: string[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Actions from an OpenAPI 3 or Swagger 2 document: one per operation, GET as read, the rest as write. */
export function actionsFromOpenApi(doc: unknown): ProposedActions {
  if (!isRecord(doc) || !isRecord(doc.paths)) throw new ConnectorError("This is not an OpenAPI or Swagger description (no paths)", "validation");
  const warnings: string[] = [];
  const actions: NamedAction[] = [];
  const used = new Set<string>();
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isRecord) : [];
  const baseUrl =
    typeof servers[0]?.url === "string"
      ? servers[0].url
      : typeof doc.host === "string"
        ? `${Array.isArray(doc.schemes) && doc.schemes.includes("https") ? "https" : "http"}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`
        : undefined;
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isRecord(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const params: ActionParam[] = [];
      const query: Record<string, string> = {};
      let body: unknown;
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const param = resolveRef(doc, raw);
        if (!isRecord(param) || typeof param.name !== "string") continue;
        const where = String(param.in);
        if (where === "body") {
          body = bodyTemplate(doc, param.schema, params);
          continue;
        }
        if (where !== "path" && where !== "query") continue;
        const key = safeKey(param.name);
        if (params.some((p) => p.key === key)) continue;
        params.push({ key, type: paramType(isRecord(param.schema) ? param.schema : param), description: typeof param.description === "string" ? param.description : undefined, required: where === "path" || param.required === true });
        if (where === "query") query[param.name] = `{${key}}`;
      }
      const requestBody = resolveRef(doc, op.requestBody);
      if (isRecord(requestBody) && isRecord(requestBody.content)) {
        const json = requestBody.content["application/json"] ?? Object.values(requestBody.content)[0];
        if (isRecord(json)) body = bodyTemplate(doc, json.schema, params);
      }
      const id = uniqueId(typeof op.operationId === "string" ? snake(op.operationId) : snake(`${method} ${path.replace(/\{[^}]+\}/g, "by")}`), used);
      const title = typeof op.summary === "string" && op.summary.trim() ? op.summary.trim() : humanize(id);
      const action = NamedAction.safeParse({
        id,
        name: title.charAt(0).toUpperCase() + title.slice(1),
        description: typeof op.description === "string" ? op.description.trim() : title,
        kind: method === "get" ? "read" : "write",
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, (_, name: string) => `{${safeKey(name)}}`),
        params,
        ...(Object.keys(query).length ? { query } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      if (action.success) actions.push(action.data);
      else warnings.push(`${method.toUpperCase()} ${path}: ${action.error.issues[0]?.message ?? "skipped"}`);
    }
  }
  return { actions, baseUrl, warnings };
}

/** A JSON body template from a schema's top-level properties, each one a parameter. */
function bodyTemplate(doc: Rec, rawSchema: unknown, params: ActionParam[]): unknown {
  const schema = resolveRef(doc, rawSchema);
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    if (!params.some((p) => p.key === "body")) params.push({ key: "body", type: "string", description: "The request body (JSON)", required: true });
    return "{body}";
  }
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const template: Rec = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const key = safeKey(name);
    if (params.some((p) => p.key === key)) continue;
    const resolved = resolveRef(doc, prop);
    params.push({ key, type: paramType(isRecord(resolved) ? resolved : {}), description: isRecord(resolved) && typeof resolved.description === "string" ? resolved.description : undefined, required: required.includes(name) });
    template[name] = `{${key}}`;
  }
  return template;
}

function resolveRef(doc: Rec, value: unknown): unknown {
  if (!isRecord(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return value;
  let node: unknown = doc;
  for (const part of value.$ref.slice(2).split("/")) node = isRecord(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return node;
}

function paramType(schema: Rec): ActionParam["type"] {
  const type = String(schema.type ?? "string");
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (schema.format === "date" || schema.format === "date-time") return "date";
  return "string";
}

/**
 * Actions from example calls, one per line: "GET https://api.acme.com/v1/customers/C-1001?status=open",
 * or "POST https://api.acme.com/v1/orders {"customer": "C-1001", "amount": 10}". Numbers and ids in the
 * path, query values and body fields become parameters.
 */
export function actionsFromExamples(text: string): ProposedActions {
  const actions: NamedAction[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  const origins = new Set<string>();
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s*(.*)$/i.exec(line);
    if (!match) {
      warnings.push(`Not an example call: ${line.slice(0, 80)}`);
      continue;
    }
    const method = match[1]!.toUpperCase() as NonNullable<NamedAction["method"]>;
    let url: URL;
    try {
      url = new URL(match[2]!);
    } catch {
      warnings.push(`Not a full URL: ${match[2]}`);
      continue;
    }
    origins.add(url.origin);
    const params: ActionParam[] = [];
    const segments = url.pathname.split("/").filter(Boolean);
    const words: string[] = [];
    const path = `/${segments
      .map((segment, i) => {
        if (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27}$|^[A-Z]{1,5}-?\d+$/i.test(segment) && i > 0) {
          const key = safeKey(`${singular(segments[i - 1]!)}_id`);
          params.push({ key, type: /^\d+$/.test(segment) ? "integer" : "string", required: true });
          return `{${key}}`;
        }
        if (!/^v\d+$/i.test(segment) && !segment.includes(".")) words.push(segment);
        return segment;
      })
      .join("/")}`;
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) {
      const key = safeKey(name);
      params.push({ key, type: /^-?\d+(\.\d+)?$/.test(value) ? "number" : "string", required: false });
      query[name] = `{${key}}`;
    }
    let body: unknown;
    if (match[3]) {
      try {
        const parsed = JSON.parse(match[3]);
        if (isRecord(parsed)) {
          const template: Rec = {};
          for (const [name, value] of Object.entries(parsed)) {
            const key = safeKey(name);
            if (params.some((p) => p.key === key)) continue;
            params.push({ key, type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string", required: true });
            template[name] = `{${key}}`;
          }
          body = template;
        }
      } catch {
        warnings.push(`The body of "${line.slice(0, 60)}" is not JSON; add it by hand`);
      }
    }
    const resource = words.at(-1) ?? "item";
    const byId = path.endsWith("}");
    const verb = method === "GET" ? (byId ? "get" : "list") : method === "POST" ? "create" : method === "DELETE" ? "delete" : "update";
    const noun = verb === "list" ? resource : singular(resource);
    const id = uniqueId(snake(`${verb} ${noun}`), used);
    const parsed = NamedAction.safeParse({
      id,
      name: humanize(id),
      description: `${humanize(id)} (${method} ${path})`,
      kind: method === "GET" ? "read" : "write",
      method,
      path,
      params,
      ...(Object.keys(query).length ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    if (parsed.success) actions.push(parsed.data);
    else warnings.push(`${line.slice(0, 60)}: ${parsed.error.issues[0]?.message}`);
  }
  const [origin] = [...origins];
  return { actions, baseUrl: origins.size === 1 ? origin : undefined, warnings };
}

function snake(text: string): string {
  const out = text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return /^[a-z]/.test(out) ? out : `action_${out}`;
}

function safeKey(name: string): string {
  const key = name.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^(\d)/, "_$1");
  return key || "value";
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base.slice(0, 60);
  for (let i = 2; used.has(id); i++) id = `${base.slice(0, 57)}_${i}`;
  used.add(id);
  return id;
}

function humanize(id: string): string {
  const text = id.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
  if (/(ses|xes|ches|shes)$/i.test(word)) return word.replace(/es$/i, "");
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}
