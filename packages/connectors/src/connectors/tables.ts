import type { ActionParam, NamedAction, TableField } from "@enterprise-brain/core";
import { defineConnector, defineManifest } from "../define.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation } from "../types.ts";
import type { Rec } from "../util.ts";

/**
 * The company's own tables as a connection: each table offers AI employees four actions (find, get,
 * add, change records), so its changes are approved by probation level, left out of test runs and
 * replayed like any other system's. The platform keeps the actions in step with the tables.
 */

const manifest = defineManifest({
  type: "tables",
  name: "Tables",
  vendor: "Enterprise Brain",
  category: "tables",
  description: "The tables people make in Enterprise Brain (a complaints register, a training log): AI employees find, read, add and change their records.",
  auth: "none",
  maturity: "stable",
  config: [],
  operations: [],
  itRequirements: [],
  managed: true,
});

/** A field as an action's value: numbers stay numbers, yes/no a boolean, dates a date; the rest text. */
function paramOf(field: TableField, required: boolean): ActionParam {
  const type = field.type === "number" || field.type === "money" ? "number" : field.type === "yes_no" ? "boolean" : field.type === "date" ? "date" : "string";
  const hints = [
    field.description,
    field.type === "choice" ? `one of: ${(field.choices ?? []).join(", ")}` : undefined,
    field.type === "person" ? "a person's email or name" : undefined,
    field.type === "link" ? "the linked record's number or name" : undefined,
    field.type === "money" && field.currency ? `in ${field.currency}` : undefined,
    field.type === "file" ? "a stored file's id" : undefined,
    field.default !== undefined ? `"${String(field.default)}" when not given` : undefined,
  ].filter(Boolean);
  return { key: field.key, type, required, description: `${field.label}${hints.length ? ` (${hints.join("; ")})` : ""}` };
}

const FILTERABLE = new Set(["choice", "yes_no", "person", "link", "email", "date"]);

/** The actions a table offers AI employees: find, get, add and change records. */
export function tableActions(table: { key: string; name: string; description?: string; fields: TableField[] }): NamedAction[] {
  const about = table.description ? ` ${table.description}` : "";
  const record: ActionParam = { key: "record", type: "string", required: true, description: "The record's number (e.g. 12) or id" };
  return [
    {
      id: `find_${table.key}`,
      name: `Look up records in ${table.name}`,
      description: `Records of ${table.name}, by words in them or by field.${about}`,
      kind: "read",
      params: [
        { key: "search", type: "string", required: false, description: "Words to look for" },
        ...table.fields.filter((f) => FILTERABLE.has(f.type)).map((f) => paramOf(f, false)),
        { key: "limit", type: "integer", required: false, description: "At most this many records (default 20, at most 200)" },
      ],
      table: { key: table.key, operation: "find" },
    },
    {
      id: `get_${table.key}`,
      name: `Read a record of ${table.name}`,
      description: `One record of ${table.name}, by its number.`,
      kind: "read",
      params: [record],
      table: { key: table.key, operation: "get" },
    },
    {
      id: `add_${table.key}`,
      name: `Add a record to ${table.name}`,
      description: `A new record in ${table.name}.${about}`,
      kind: "write",
      params: table.fields.map((f) => paramOf(f, Boolean(f.required) && f.default === undefined)),
      table: { key: table.key, operation: "add" },
    },
    {
      id: `update_${table.key}`,
      name: `Change a record in ${table.name}`,
      description: `Change fields of a record in ${table.name}; fields left out stay as they are.`,
      kind: "write",
      params: [record, ...table.fields.map((f) => paramOf(f, false))],
      table: { key: table.key, operation: "update" },
    },
  ].map((action) => ({ ...action, params: action.params.map((p) => ({ ...p, required: Boolean(p.required) })) }) as NamedAction);
}

function storeOf(ctx: ConnectorContext) {
  if (!ctx.tables) throw new ConnectorError("Tables are not available here", "unsupported");
  return ctx.tables;
}

const tablesImplementation = defineConnector({
  manifest,
  async test(ctx) {
    storeOf(ctx);
    return { ok: true, message: "The company's tables are ready." };
  },
  operations: {},
});

export const tablesConnector: ConnectorImplementation = {
  ...tablesImplementation,
  async runAction(action: NamedAction, values: Rec, ctx: ConnectorContext) {
    if (!action.table) throw new ConnectorError(`${action.name} names no table`, "config");
    const store = storeOf(ctx);
    const by = { actor: ctx.actor ?? "An AI employee", ...(ctx.runId ? { runId: ctx.runId } : {}) };
    const { key, operation } = action.table;
    const { record, search, limit, ...fields } = values;
    switch (operation) {
      case "find":
        return store.find(key, {
          ...(typeof search === "string" && search.trim() ? { search: search.trim() } : {}),
          where: fields,
          limit: Math.min(200, Math.max(1, typeof limit === "number" ? limit : 20)),
        });
      case "get":
        return store.get(key, String(record));
      case "add":
        return store.add(key, values, by);
      case "update":
        return store.update(key, String(record), fields, by);
    }
  },
};
