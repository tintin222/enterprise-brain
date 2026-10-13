import type { TransformOp } from "./agent.ts";
import { compareValues, evaluateCondition, resolveTemplate } from "./expressions.ts";
import { getPath, isRecord } from "./util.ts";

/**
 * A transform step's work, as plain data in and out: a list reshaped by its operations in order. Fields
 * are paths in each item ("customer.name"); templates and conditions see the item as `item` and its
 * position as `index`, besides the run's context.
 */

export interface TransformResult {
  items: unknown[];
  count: number;
  /** The first item, or null: handy after an aggregate over the whole list. */
  first: unknown;
}

/** A value as a list: a list as is, nothing as no items, anything else as a list of one. */
export function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

/** Set a path in a plain object (making the objects on the way), returning the object. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length) return target;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    current = current[part] = isRecord(next) ? { ...next } : {};
  }
  current[parts[parts.length - 1]!] = value;
  return target;
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[part];
  }
  if (isRecord(current)) delete current[parts[parts.length - 1]!];
}

/** A copy of an item deep enough to change: objects at any depth are copied as they are set. */
function copyOf(item: unknown): Record<string, unknown> {
  return isRecord(item) ? structuredClone(item) : { value: item };
}

function keyOf(item: unknown, paths: readonly string[] | undefined): string {
  if (!paths?.length) return JSON.stringify(item ?? null);
  return JSON.stringify(paths.map((p) => getPath(item, p) ?? null));
}

function numbersOf(items: readonly unknown[], field?: string): number[] {
  const out: number[] = [];
  for (const item of items) {
    const value = field ? getPath(item, field) : item;
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

type AggregateFn = Extract<TransformOp, { op: "aggregate" }>["values"][string]["fn"];

function aggregate(items: readonly unknown[], fn: AggregateFn, field?: string): unknown {
  const values = field ? items.map((i) => getPath(i, field)) : [...items];
  switch (fn) {
    case "count":
      return field ? values.filter((v) => v !== undefined && v !== null && v !== "").length : items.length;
    case "sum":
      return numbersOf(items, field).reduce((a, b) => a + b, 0);
    case "avg": {
      const numbers = numbersOf(items, field);
      return numbers.length ? Math.round((numbers.reduce((a, b) => a + b, 0) / numbers.length) * 1e6) / 1e6 : null;
    }
    case "min":
      return values.filter((v) => v !== undefined && v !== null && v !== "").sort(compareValues)[0] ?? null;
    case "max":
      return (
        values
          .filter((v) => v !== undefined && v !== null && v !== "")
          .sort(compareValues)
          .at(-1) ?? null
      );
    case "first":
      return values[0] ?? null;
    case "last":
      return values.at(-1) ?? null;
    case "list":
      return values;
  }
}

/** Apply a transform's operations to a list, in order. `context` is the run's (input, steps, vars…). */
export function applyTransform(list: readonly unknown[], ops: readonly TransformOp[], context: Record<string, unknown>): TransformResult {
  let items: unknown[] = [...list];
  const inItem = (item: unknown, index: number) => ({ ...context, item, index });
  for (const op of ops) {
    switch (op.op) {
      case "set":
        items = items.map((item, index) => {
          const out = copyOf(item);
          for (const [path, template] of Object.entries(op.fields)) setPath(out, path, resolveTemplate(template, inItem(item, index)));
          return out;
        });
        break;
      case "filter":
        items = items.filter((item, index) => evaluateCondition(op.where, inItem(item, index)));
        break;
      case "sort": {
        const direction = op.order === "desc" ? -1 : 1;
        items = [...items].sort((a, b) => direction * compareValues(getPath(a, op.by), getPath(b, op.by)));
        break;
      }
      case "aggregate": {
        const groups = new Map<string, unknown[]>();
        for (const item of items) {
          const key = keyOf(item, op.groupBy?.length ? op.groupBy : ["__all__"]);
          (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
        }
        if (!op.groupBy?.length && !groups.size) groups.set("[]", []);
        items = [...groups.values()].map((group) => {
          const row: Record<string, unknown> = {};
          for (const path of op.groupBy ?? []) setPath(row, path, getPath(group[0], path) ?? null);
          for (const [name, spec] of Object.entries(op.values)) row[name] = aggregate(group, spec.fn, spec.field);
          return row;
        });
        break;
      }
      case "dedupe": {
        const seen = new Set<string>();
        items = items.filter((item) => {
          const key = keyOf(item, op.by);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        break;
      }
      case "pick":
        items = items.map((item) => {
          const out: Record<string, unknown> = {};
          for (const path of op.fields) {
            const value = getPath(item, path);
            if (value !== undefined) setPath(out, path, value);
          }
          return out;
        });
        break;
      case "rename":
        items = items.map((item) => {
          const out = copyOf(item);
          for (const [from, to] of Object.entries(op.fields)) {
            const value = getPath(out, from);
            if (value === undefined) continue;
            deletePath(out, from);
            setPath(out, to, value);
          }
          return out;
        });
        break;
      case "limit":
        items = items.slice(op.offset ?? 0, (op.offset ?? 0) + op.count);
        break;
    }
  }
  return { items, count: items.length, first: items[0] ?? null };
}
