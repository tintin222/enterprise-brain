import type { ConnectorManifest } from "@enterprise-brain/core";
import { defineConnector } from "../define.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation, type SandboxStore } from "../types.ts";
import { addDays, startOfDay, toIsoDate, type Input, type Rec } from "../util.ts";

/**
 * Runtime shared by the built-in sandbox systems. Every sandbox keeps its data
 * in ctx.sandbox (system = connector type, entity = collection, id = business
 * key) and writes its demo data set the first time it is used.
 */

export type SandboxHandler = (input: Input, db: SandboxDb, ctx: ConnectorContext) => Promise<unknown>;

export interface SandboxDefinition {
  manifest: ConnectorManifest;
  /** Key field of every entity (collection), e.g. { suppliers: "supplier_id" }. */
  keys: Record<string, string>;
  /** Demo data written on first use. `today` is midnight UTC of the seeding day. */
  seed(today: Date): Record<string, object[]>;
  operations: Record<string, SandboxHandler>;
}

/** Typed access to the collections of one sandbox system. */
export class SandboxDb {
  constructor(
    private readonly store: SandboxStore,
    readonly system: string,
    private readonly keys: Record<string, string>,
  ) {}

  private keyOf(entity: string): string {
    const key = this.keys[entity];
    if (!key) throw new Error(`Sandbox ${this.system} has no entity "${entity}"`);
    return key;
  }

  /** All records of an entity, ordered by key. */
  async list<T extends object = Rec>(entity: string): Promise<T[]> {
    const key = this.keyOf(entity);
    const rows = await this.store.list(this.system, entity);
    rows.sort((a, b) => String(a[key]).localeCompare(String(b[key]), "en", { numeric: true }));
    return rows as unknown as T[];
  }

  async get<T extends object = Rec>(entity: string, id: string): Promise<T | undefined> {
    this.keyOf(entity);
    return (await this.store.get(this.system, entity, id)) as T | undefined;
  }

  /** Gets a record or throws a not_found ConnectorError ("Supplier SUP-9 not found"). */
  async require<T extends object = Rec>(entity: string, id: string, label: string): Promise<T> {
    const row = await this.get<T>(entity, id);
    if (!row) throw new ConnectorError(`${label} ${id} not found`, "not_found");
    return row;
  }

  async put<T extends object>(entity: string, record: T): Promise<T> {
    const key = this.keyOf(entity);
    const id = (record as Rec)[key];
    if (typeof id !== "string" || id === "") throw new Error(`Sandbox ${this.system}: ${entity} record without ${key}`);
    await this.store.upsert(this.system, entity, id, record as Rec);
    return record;
  }

  /** Next sequential identifier `<prefix><n>` (zero-padded to `width`) after the highest existing one. */
  async nextId(entity: string, prefix: string, width: number, field = this.keyOf(entity)): Promise<string> {
    const rows = await this.store.list(this.system, entity);
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`);
    let max = 0;
    for (const row of rows) {
      const match = pattern.exec(String(row[field] ?? ""));
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `${prefix}${String(max + 1).padStart(width, "0")}`;
  }
}

// Operations of one sandbox (per company) run one at a time, so "read max id,
// then write" sequences and first-use seeding cannot interleave.
const queues = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function ensureSeeded(ctx: ConnectorContext, definition: SandboxDefinition): Promise<void> {
  const store = ctx.sandbox;
  const system = definition.manifest.type;
  if ((await store.count(system)) > 0) return;
  const data = definition.seed(startOfDay());
  for (const [entity, rows] of Object.entries(data)) {
    const key = definition.keys[entity];
    if (!key) throw new Error(`Sandbox ${system}: seed data for unknown entity "${entity}"`);
    for (const row of rows) {
      const record = row as Rec;
      await store.upsert(system, entity, String(record[key]), record);
    }
  }
  ctx.logger.info("Seeded sandbox demo data", { system, entities: Object.keys(data).length, records: await store.count(system) });
}

export function defineSandboxConnector(definition: SandboxDefinition): ConnectorImplementation {
  const system = definition.manifest.type;
  const operations = Object.fromEntries(
    Object.entries(definition.operations).map(([id, handler]) => [
      id,
      (input: Input, ctx: ConnectorContext) =>
        serialized(`${ctx.companyId}\u0000${system}`, async () => {
          await ensureSeeded(ctx, definition);
          return handler(input, new SandboxDb(ctx.sandbox, system, definition.keys), ctx);
        }),
    ]),
  );
  return defineConnector({
    manifest: definition.manifest,
    async test() {
      return {
        ok: true,
        message: `${definition.manifest.name} is ready: a built-in demo system with realistic data for Acme Endüstri A.Ş. No credentials needed.`,
        details: { sandbox: true, system },
      };
    },
    operations,
  });
}

// ---------------------------------------------------------------------------
// Helpers shared by the sandbox data sets
// ---------------------------------------------------------------------------

/** Date helpers relative to the seeding day. */
export function relativeDates(today: Date) {
  return {
    /** YYYY-MM-DD `offset` days from today. */
    day: (offset: number) => toIsoDate(addDays(today, offset)),
    /** ISO timestamp `offset` days from today at hh:mm UTC. */
    at: (offset: number, hours = 9, minutes = 0) => new Date(addDays(today, offset).getTime() + (hours * 60 + minutes) * 60_000).toISOString(),
    /** First working day (Mon-Fri) on or after today + offset. */
    workday: (offset: number) => toIsoDate(nextWorkday(addDays(today, offset))),
  };
}

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function nextWorkday(date: Date): Date {
  let current = date;
  while (isWeekend(current)) current = addDays(current, 1);
  return current;
}

/** Turkish public holidays with a fixed date (MM-DD). Religious holidays move every year and are not modelled. */
const FIXED_HOLIDAYS = new Set(["01-01", "04-23", "05-01", "05-19", "07-15", "08-30", "10-29"]);

/** Working days (Mon-Fri, excluding fixed public holidays) between two dates, inclusive. */
export function workingDaysBetween(start: string, end: string): number {
  let count = 0;
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t);
    if (!isWeekend(date) && !FIXED_HOLIDAYS.has(toIsoDate(date).slice(5))) count++;
  }
  return count;
}

/** Adds working days to a date (n=0 returns the date itself). */
export function addWorkingDays(start: string, n: number): string {
  let date = new Date(`${start}T00:00:00Z`);
  let remaining = n;
  while (remaining > 0) {
    date = addDays(date, 1);
    if (!isWeekend(date) && !FIXED_HOLIDAYS.has(toIsoDate(date).slice(5))) remaining--;
  }
  return toIsoDate(date);
}

function mod97(digits: string): number {
  let remainder = 0;
  for (const char of digits) remainder = (remainder * 10 + Number(char)) % 97;
  return remainder;
}

function ibanDigits(value: string): string {
  return value.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
}

/** Builds a valid IBAN (ISO 13616 check digits) from a country code and BBAN, grouped in blocks of four. */
export function makeIban(country: string, bban: string): string {
  const check = String(98 - mod97(ibanDigits(`${bban}${country}00`))).padStart(2, "0");
  return formatIban(`${country}${check}${bban}`);
}

export function formatIban(value: string): string {
  return value
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, "$1 ");
}

export function isValidIban(value: string): boolean {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  return mod97(ibanDigits(`${compact.slice(4)}${compact.slice(0, 4)}`)) === 1;
}

/** "first.last@domain" with Turkish characters transliterated. */
export function emailFor(first: string, last: string, domain: string): string {
  const part = (s: string) =>
    s
      .replace(/[İIı]/g, "i")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  return `${part(first)}.${part(last)}@${domain}`;
}

/** Wraps a list result in the common `{ items, total }` shape. */
export function listResult<T>(items: T[], extra: Rec = {}): Rec {
  return { items, total: items.length, ...extra };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return toIsoDate(startOfDay());
}
