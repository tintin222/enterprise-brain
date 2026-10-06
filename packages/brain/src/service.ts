import { and, asc, desc, eq, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import {
  BRAIN_DIMENSIONS,
  BRAIN_KINDS,
  BRAIN_RELATIONS,
  brainData,
  brainKind,
  brainRelation,
  foldText,
  isBlankValue,
  relationFits,
  slugify,
  valueWords,
  type BrainEntityInput,
  type BrainEntityPatch,
  type BrainEventInput,
  type BrainField,
  type BrainKind,
  type BrainKindKey,
  type BrainLinkInput,
  type BrainRelation,
  type BrainRelationKey,
} from "@enterprise-brain/core";
import { brainEntities, brainEvents, brainLinks, type DatabaseHandle } from "@enterprise-brain/db";
import { overviewOf } from "./insights.ts";
import {
  emptyResult,
  type BrainEntitySummary,
  type BrainEntityView,
  type BrainEventView,
  type BrainGraph,
  type BrainLinkView,
  type BrainOverview,
  type SourceBatch,
  type SourceRef,
  type SyncResult,
} from "./types.ts";

export type EntityRow = typeof brainEntities.$inferSelect;
export type LinkRow = typeof brainLinks.$inferSelect;
export type EventRow = typeof brainEvents.$inferSelect;
type EventInsert = typeof brainEvents.$inferInsert;

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export interface BrainServiceOptions {
  /** Puts people's changes in the audit log. */
  onChange?: (companyId: string, change: { actor: string; action: string; entityId: string; summary: string }) => Promise<void> | void;
  /** How much a source's values count against another's when both know a field (people's own edits always win). */
  priority?: (origin: string) => number;
  /** A source's name in words ("Jira (demo)"), for the changes it brings. */
  originName?: (origin: string) => string;
}

/** Kinds whose name says which one it is: a source naming one finds the same thing. */
const NAME_IDENTIFIES = new Set<string>([
  "company",
  "department",
  "person",
  "role",
  "ai_employee",
  "site",
  "process",
  "policy",
  "document",
  "system",
  "database",
  "data_store",
  "infrastructure",
  "client",
  "supplier",
  "product",
  "project",
  "goal",
  "term",
]);

/** Kinds found by name in messages and emails: the ones people talk about by name. */
const MENTIONED = new Set<string>(["person", "client", "supplier", "project", "system", "product", "site", "ai_employee", "process", "database", "data_store"]);

const STOP_WORDS = new Set(
  (
    "a an and are as at be by can do does for from has have how i in is it its me my of on or our the their them they this to was we what when where which who whom why will with you your " +
    "about any anyone anything know knows tell show list give find all there here should would could did " +
    "bir bu ve ile icin ne kim kimler nerede nasil hangi mi mu var yok olan da de"
  ).split(" "),
);

const EVENT_LIMIT = 30;

/** The links that say most about a thing in a list: a task's person and project, a project's lead and client… */
const KEY_LINKS: Record<string, { relation: string; direction: "out" | "in"; label: string }[]> = {
  department: [{ relation: "heads", direction: "in", label: "Head" }],
  person: [
    { relation: "works_in", direction: "out", label: "Department" },
    { relation: "reports_to", direction: "out", label: "Manager" },
  ],
  role: [{ relation: "holds", direction: "in", label: "People" }],
  ai_employee: [
    { relation: "works_in", direction: "out", label: "Department" },
    { relation: "manages", direction: "in", label: "Manager" },
  ],
  process: [
    { relation: "owns", direction: "in", label: "Owner" },
    { relation: "does", direction: "in", label: "Done by" },
  ],
  policy: [{ relation: "owns", direction: "in", label: "Owner" }],
  document: [
    { relation: "owns", direction: "in", label: "Owner" },
    { relation: "stored_in", direction: "out", label: "Kept in" },
  ],
  system: [
    { relation: "owns", direction: "in", label: "Owner" },
    { relation: "looks_after", direction: "in", label: "IT contact" },
  ],
  database: [
    { relation: "has_database", direction: "in", label: "System" },
    { relation: "looks_after", direction: "in", label: "IT contact" },
  ],
  data_store: [{ relation: "owns", direction: "in", label: "Owner" }],
  infrastructure: [{ relation: "looks_after", direction: "in", label: "IT contact" }],
  client: [{ relation: "owns", direction: "in", label: "Account owner" }],
  deal: [
    { relation: "for_client", direction: "out", label: "Client" },
    { relation: "owns", direction: "in", label: "Owner" },
  ],
  case: [
    { relation: "for_client", direction: "out", label: "Client" },
    { relation: "owns", direction: "in", label: "Owner" },
  ],
  supplier: [{ relation: "owns", direction: "in", label: "Buyer" }],
  project: [
    { relation: "leads", direction: "in", label: "Lead" },
    { relation: "for_client", direction: "out", label: "Client" },
  ],
  task: [
    { relation: "assigned_to", direction: "out", label: "Who" },
    { relation: "part_of", direction: "out", label: "Project" },
  ],
  goal: [{ relation: "leads", direction: "in", label: "Owner" }],
  decision: [{ relation: "decided_by", direction: "out", label: "Decided by" }],
  knowhow: [{ relation: "shared_by", direction: "out", label: "From" }],
};

/** The labels of a kind's key links, in order: the columns of its list. */
export function keyLinkLabels(kind: string): string[] {
  return (KEY_LINKS[kind] ?? []).map((k) => k.label);
}

/** Does a word of the text start with the term ("qual" in "quality", but not "ali" in it)? */
function wordStart(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true;
  return false;
}

/** The words of a question that say what to look for. */
function searchTerms(query: string): string[] {
  const folded = foldText(query).trim();
  return [...new Set(folded.split(/[^a-z0-9@./_-]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t)))].slice(0, 8);
}

/** "Selin Acar <selin.acar@acme.com.tr>" → "Selin Acar"; source keys stay as they are. */
export function actorName(actor: string): string {
  return actor.replace(/\s*<[^>]*>\s*$/, "").trim() || actor;
}

function uniqueStrings(values: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text) continue;
    const folded = foldText(text);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(text);
  }
  return out;
}

/** A value with its objects' keys in order: Postgres keeps jsonb keys in its own order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value ?? null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function withoutBlanks(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => !isBlankValue(value)));
}

/** A value in words, as lists and timelines show it. */
export function formatValue(field: BrainField, value: unknown, data: Record<string, unknown> = {}): string {
  if (isBlankValue(value)) return "";
  switch (field.type) {
    case "list":
      return (value as string[]).join(", ");
    case "money": {
      const amount = Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
      return typeof data.currency === "string" && data.currency ? `${amount} ${data.currency}` : amount;
    }
    case "percent":
      return `${Number(value)}%`;
    case "number":
      return Number(value).toLocaleString("en-US");
    case "steps":
      return `${(value as unknown[]).length} steps`;
    case "apis":
      return (value as { name: string }[]).map((a) => a.name).join(", ");
    case "tables":
      return `${(value as unknown[]).length} tables`;
    case "contacts":
      return (value as { name: string }[]).map((c) => c.name).join(", ");
    case "milestones":
      return (value as { name: string }[]).map((m) => m.name).join(", ");
    default:
      return String(value);
  }
}

function searchTextOf(kind: BrainKind, name: string, aliases: string[], summary: string, data: Record<string, unknown>): string {
  const values = kind.fields.filter((f) => !f.hidden).flatMap((f) => valueWords(data[f.key]));
  return foldText([name, ...aliases, summary, kind.name, ...values].join(" \n")).slice(0, 50_000);
}

function eventText(row: Pick<EventRow, "title" | "body">): string {
  return `${row.title}\n${row.body}`;
}

/** The brain's things of one company, found by source id, key, name or email. */
class EntityIndex {
  readonly rows = new Map<string, EntityRow>();
  private readonly byRef = new Map<string, string>();
  private readonly byKey = new Map<string, string>();
  private readonly byName = new Map<string, Set<string>>();
  private readonly byEmail = new Map<string, string>();

  constructor(rows: EntityRow[]) {
    for (const row of rows) this.add(row);
  }

  add(row: EntityRow) {
    const previous = this.rows.get(row.id);
    if (previous) this.forget(previous);
    this.rows.set(row.id, row);
    for (const [origin, ref] of Object.entries(row.refs)) this.byRef.set(`${row.kind}|${origin}|${ref}`, row.id);
    this.byKey.set(`${row.kind}|${row.key}`, row.id);
    for (const name of [row.name, ...row.aliases]) {
      const key = `${row.kind}|${foldText(name).trim()}`;
      if (!this.byName.has(key)) this.byName.set(key, new Set());
      this.byName.get(key)!.add(row.id);
    }
    const email = row.data.email;
    if (row.kind === "person" && typeof email === "string" && email) this.byEmail.set(email.toLowerCase(), row.id);
  }

  private forget(row: EntityRow) {
    for (const [origin, ref] of Object.entries(row.refs)) this.byRef.delete(`${row.kind}|${origin}|${ref}`);
    this.byKey.delete(`${row.kind}|${row.key}`);
    for (const name of [row.name, ...row.aliases]) this.byName.get(`${row.kind}|${foldText(name).trim()}`)?.delete(row.id);
    const email = row.data.email;
    if (typeof email === "string") this.byEmail.delete(email.toLowerCase());
  }

  private one(id: string | undefined): EntityRow | undefined {
    return id ? this.rows.get(id) : undefined;
  }

  resolve(ref: SourceRef, origin: string): EntityRow | undefined {
    if (ref.ref) {
      const found = this.one(this.byRef.get(`${ref.kind}|${ref.origin ?? origin}|${ref.ref}`));
      if (found) return found;
    }
    if (ref.key) {
      const found = this.one(this.byKey.get(`${ref.kind}|${ref.key}`));
      if (found) return found;
    }
    if (ref.email) {
      const found = this.one(this.byEmail.get(ref.email.toLowerCase()));
      if (found && found.kind === ref.kind) return found;
    }
    if (ref.name && NAME_IDENTIFIES.has(ref.kind)) {
      const ids = this.byName.get(`${ref.kind}|${foldText(ref.name).trim()}`);
      if (ids?.size === 1) return this.one([...ids][0]);
    }
    return undefined;
  }

  /** A person named in a source: by email, or by full name. */
  person(nameOrEmail: string): EntityRow | undefined {
    const text = nameOrEmail.trim();
    const email = text.match(/<([^>]+)>/)?.[1] ?? (text.includes("@") ? text : undefined);
    if (email) {
      const found = this.one(this.byEmail.get(email.toLowerCase()));
      if (found) return found;
    }
    return this.resolve({ kind: "person", name: actorName(text) }, "");
  }

  uniqueKey(kind: string, base: string): string {
    const root = base || kind;
    let key = root;
    for (let n = 2; this.byKey.has(`${kind}|${key}`); n++) key = `${root}-${n}`;
    return key;
  }

  /** Finds the things a text names: people by full name, clients, systems, projects… by name or other name. */
  mentions(): (text: string) => string[] {
    const owners = new Map<string, Set<string>>();
    for (const row of this.rows.values()) {
      if (row.status !== "active" || !MENTIONED.has(row.kind)) continue;
      for (const name of [row.name, ...row.aliases]) {
        const term = foldText(name).trim();
        // A person by their full name only; a process or project by more than one word ("Purchasing" is any purchasing).
        const oneWord = !/[\s-]/.test(term);
        if (term.length < 3 || (oneWord && (row.kind === "person" || row.kind === "process" || row.kind === "project"))) continue;
        if (!owners.has(term)) owners.set(term, new Set());
        owners.get(term)!.add(row.id);
      }
    }
    // A word that names several things names none of them for sure.
    const terms = [...owners].filter(([, ids]) => ids.size === 1).map(([term, ids]) => ({ term, id: [...ids][0]! }));
    const boundary = /[a-z0-9]/;
    return (text: string) => {
      const folded = foldText(text);
      const found = new Set<string>();
      for (const { term, id } of terms) {
        let at = folded.indexOf(term);
        while (at >= 0) {
          const before = folded[at - 1];
          const after = folded[at + term.length];
          if ((!before || !boundary.test(before)) && (!after || !boundary.test(after))) {
            found.add(id);
            break;
          }
          at = folded.indexOf(term, at + 1);
        }
      }
      return [...found];
    };
  }
}

/**
 * The company brain of each company: things and their links, what happens, and what each source
 * knows. People's own edits are kept over what sources bring; a source's values are kept over a
 * lower-priority source's. Every method takes the company id first.
 */
export class BrainService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly options: BrainServiceOptions = {},
  ) {}

  private get db() {
    return this.handle.db;
  }

  model() {
    return { dimensions: BRAIN_DIMENSIONS, kinds: BRAIN_KINDS, relations: BRAIN_RELATIONS };
  }

  private priority(origin: string): number {
    if (origin === "manual") return 1000;
    return this.options.priority?.(origin) ?? 50;
  }

  /** May `origin` set a value that `current` set? A person's value stays; a source keeps its own up to date. */
  private may(current: string | undefined, origin: string): boolean {
    if (!current || current === origin) return true;
    if (current === "manual") return false;
    return this.priority(origin) > this.priority(current);
  }

  // -------------------------------------------------------------------------
  // Reading

  summaryOf(row: EntityRow): BrainEntitySummary {
    const kind = brainKind(row.kind);
    const brief: [string, string][] = [];
    for (const field of kind?.fields ?? []) {
      if (!field.brief) continue;
      const value = formatValue(field, row.data[field.key], row.data);
      if (value) brief.push([field.label, value]);
    }
    return {
      id: row.id,
      kind: row.kind as BrainKindKey,
      key: row.key,
      name: row.name,
      summary: row.summary,
      brief,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async rows(companyId: string, where?: SQL): Promise<EntityRow[]> {
    const conditions = [eq(brainEntities.companyId, companyId), eq(brainEntities.status, "active")];
    if (where) conditions.push(where);
    return this.db
      .select()
      .from(brainEntities)
      .where(and(...conditions))
      .orderBy(asc(brainEntities.name));
  }

  private async row(companyId: string, id: string): Promise<EntityRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BrainError("Not found in the brain", 404);
    const [row] = await this.db
      .select()
      .from(brainEntities)
      .where(and(eq(brainEntities.companyId, companyId), eq(brainEntities.id, id), eq(brainEntities.status, "active")));
    if (!row) throw new BrainError("Not found in the brain", 404);
    return row;
  }

  async counts(companyId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ kind: brainEntities.kind, n: sql<number>`count(*)::int` })
      .from(brainEntities)
      .where(and(eq(brainEntities.companyId, companyId), eq(brainEntities.status, "active")))
      .groupBy(brainEntities.kind);
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  async list(
    companyId: string,
    filter: { kind?: string; kinds?: string[]; q?: string; limit?: number; keyLinks?: boolean } = {},
  ): Promise<BrainEntitySummary[]> {
    const kinds = filter.kinds ?? (filter.kind ? [filter.kind] : undefined);
    const found = filter.q?.trim()
      ? await this.search(companyId, filter.q, { kinds, limit: filter.limit ?? 50 })
      : (await this.rows(companyId, kinds?.length ? inArray(brainEntities.kind, kinds) : undefined))
          .slice(0, filter.limit ?? 500)
          .map((row) => this.summaryOf(row));
    return filter.keyLinks ? this.withKeyLinks(companyId, found) : found;
  }

  /** Adds each thing's key links (a task's person and project…), for lists. */
  private async withKeyLinks<T extends BrainEntitySummary>(companyId: string, things: T[]): Promise<T[]> {
    const wanted = things.filter((t) => KEY_LINKS[t.kind]);
    if (!wanted.length) return things;
    const ids = wanted.map((t) => t.id);
    const relations = [...new Set(wanted.flatMap((t) => KEY_LINKS[t.kind]!.map((k) => k.relation)))];
    const links = await this.db
      .select()
      .from(brainLinks)
      .where(
        and(
          eq(brainLinks.companyId, companyId),
          ne(brainLinks.origin, "removed"),
          inArray(brainLinks.relation, relations),
          or(inArray(brainLinks.fromId, ids), inArray(brainLinks.toId, ids)),
        ),
      );
    const otherIds = [...new Set(links.flatMap((l) => [l.fromId, l.toId]))];
    const others = otherIds.length ? await this.rows(companyId, inArray(brainEntities.id, otherIds)) : [];
    const byId = new Map(others.map((o) => [o.id, o]));
    return things.map((thing) => {
      const spec = KEY_LINKS[thing.kind];
      if (!spec) return thing;
      const keyLinks: NonNullable<BrainEntitySummary["keyLinks"]> = {};
      for (const { relation, direction, label } of spec) {
        const matched = links.filter((l) => l.relation === relation && (direction === "out" ? l.fromId === thing.id : l.toId === thing.id));
        const refs = matched.flatMap((l) => {
          const other = byId.get(direction === "out" ? l.toId : l.fromId);
          return other ? [{ id: other.id, kind: other.kind as BrainKindKey, name: other.name }] : [];
        });
        if (refs.length) keyLinks[label] = refs.sort((a, b) => a.name.localeCompare(b.name));
      }
      return { ...thing, keyLinks };
    });
  }

  /**
   * Things whose name, other names, summary or values hold the words asked for, best first: the name
   * itself, then a name that starts with or holds them, then the rest.
   */
  async search(companyId: string, query: string, options: { kinds?: string[]; limit?: number } = {}): Promise<(BrainEntitySummary & { score: number })[]> {
    const folded = foldText(query).trim();
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const like = or(...terms.map((term) => sql`${brainEntities.searchText} like ${`%${term.replace(/[%_\\]/g, "\\$&")}%`}`))!;
    const kinds = options.kinds?.length ? inArray(brainEntities.kind, options.kinds) : undefined;
    const rows = await this.rows(companyId, kinds ? and(like, kinds) : like);
    const phrase = terms.join(" ");
    const scored = rows.map((row) => {
      const name = foldText(row.name);
      const aliases = row.aliases.map(foldText);
      const summary = foldText(row.summary);
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const nameWords = name.split(/[^a-z0-9]+/);
        const best = Math.max(
          name === term ? 12 : 0,
          aliases.includes(term) ? 10 : 0,
          name.startsWith(term) ? 7 : 0,
          nameWords.includes(term) ? 6 : 0,
          aliases.some((a) => a.split(/[^a-z0-9]+/).includes(term)) ? 5 : 0,
          name.includes(term) ? 4 : 0,
          wordStart(summary, term) ? 2 : 0,
          wordStart(row.searchText, term) ? 1 : 0,
        );
        if (best) matched++;
        score += best;
      }
      if (terms.length > 1 && name.includes(phrase)) score += 10;
      if (name === folded || aliases.includes(folded)) score += 20;
      const coverage = matched / terms.length;
      return { row, score: score * coverage * coverage };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
      .slice(0, options.limit ?? 20)
      .map((s) => ({ ...this.summaryOf(s.row), score: Math.round(s.score * 10) / 10 }));
  }

  /** A thing by its id, or by its name or other name when that names one thing (or one clearly best). */
  async find(companyId: string, idOrName: string, kind?: string): Promise<EntityRow | undefined> {
    const text = idOrName.trim();
    if (/^[0-9a-f-]{36}$/i.test(text)) return this.row(companyId, text).catch(() => undefined);
    const folded = foldText(text);
    const found = await this.search(companyId, text, { kinds: kind ? [kind] : undefined, limit: 8 });
    if (!found.length) return undefined;
    const rows = await this.rows(
      companyId,
      inArray(
        brainEntities.id,
        found.map((f) => f.id),
      ),
    );
    const named = rows.filter(
      (r) =>
        foldText(r.name) === folded ||
        r.aliases.some((a) => foldText(a) === folded) ||
        (r.kind === "person" && String(r.data.email ?? "").toLowerCase() === folded),
    );
    if (named.length === 1) return named[0];
    // Otherwise the clear best match, when it holds every word asked for.
    const terms = searchTerms(text);
    const [first, second] = found;
    const best = first ? rows.find((r) => r.id === first.id) : undefined;
    if (best && (!second || first!.score >= second.score * 1.5) && terms.every((term) => wordStart(best.searchText, term))) return best;
    return undefined;
  }

  async get(companyId: string, id: string): Promise<BrainEntityView> {
    const row = await this.row(companyId, id);
    const [links, events] = await Promise.all([this.linksOf(companyId, row), this.events(companyId, { about: row.id, limit: EVENT_LIMIT })]);
    return {
      ...this.summaryOf(row),
      aliases: row.aliases,
      data: row.data,
      origins: row.origins,
      refs: row.refs,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      links,
      events,
    };
  }

  private async linksOf(companyId: string, row: EntityRow): Promise<BrainLinkView[]> {
    const links = await this.db
      .select()
      .from(brainLinks)
      .where(and(eq(brainLinks.companyId, companyId), ne(brainLinks.origin, "removed"), or(eq(brainLinks.fromId, row.id), eq(brainLinks.toId, row.id))));
    const otherIds = [...new Set(links.map((l) => (l.fromId === row.id ? l.toId : l.fromId)))];
    const others = otherIds.length ? await this.rows(companyId, inArray(brainEntities.id, otherIds)) : [];
    const byId = new Map(others.map((o) => [o.id, o]));
    const views: BrainLinkView[] = [];
    for (const link of links) {
      const out = link.fromId === row.id;
      const other = byId.get(out ? link.toId : link.fromId);
      const relation = brainRelation(link.relation);
      if (!other || !relation) continue;
      views.push({
        id: link.id,
        relation: link.relation as BrainRelationKey,
        direction: out ? "out" : "in",
        label: out ? relation.label : relation.inverse,
        detail: link.detail,
        origin: link.origin,
        other: this.summaryOf(other),
      });
    }
    const order = new Map(BRAIN_RELATIONS.map((r, i) => [r.key as string, i]));
    return views.sort(
      (a, b) =>
        (order.get(a.relation) ?? 0) - (order.get(b.relation) ?? 0) || a.direction.localeCompare(b.direction) || a.other.name.localeCompare(b.other.name),
    );
  }

  /** What happened, newest first: about a thing (or said by that person), from a source, or everything. */
  async events(companyId: string, filter: { about?: string; origin?: string; before?: Date; since?: Date; limit?: number } = {}): Promise<BrainEventView[]> {
    const conditions: SQL[] = [eq(brainEvents.companyId, companyId)];
    if (filter.about) conditions.push(or(sql`${brainEvents.about} @> ${JSON.stringify([filter.about])}::jsonb`, eq(brainEvents.actorId, filter.about))!);
    if (filter.origin) conditions.push(eq(brainEvents.origin, filter.origin));
    if (filter.before) conditions.push(lt(brainEvents.at, filter.before));
    if (filter.since) conditions.push(sql`${brainEvents.at} >= ${filter.since.toISOString()}`);
    const rows = await this.db
      .select()
      .from(brainEvents)
      .where(and(...conditions))
      .orderBy(desc(brainEvents.at), desc(brainEvents.createdAt))
      .limit(Math.min(filter.limit ?? 50, 500));
    return this.eventViews(companyId, rows);
  }

  private async eventViews(companyId: string, rows: EventRow[]): Promise<BrainEventView[]> {
    const ids = [...new Set(rows.flatMap((r) => r.about))];
    const things = ids.length ? await this.rows(companyId, inArray(brainEntities.id, ids)) : [];
    const byId = new Map(things.map((t) => [t.id, t]));
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      kind: r.kind as BrainEventView["kind"],
      origin: r.origin,
      title: r.title,
      body: r.body,
      actor: r.actor,
      actorId: r.actorId,
      place: r.place,
      about: r.about.flatMap((id) => {
        const thing = byId.get(id);
        return thing ? [{ id: thing.id, kind: thing.kind as BrainKindKey, name: thing.name }] : [];
      }),
      data: r.data,
    }));
  }

  /**
   * A thing and what is linked to it, `depth` links away (people around a process, the systems those
   * people use…). Without a focus: the company's map of departments, processes and systems.
   */
  async graph(companyId: string, focus?: string, options: { depth?: number; limit?: number } = {}): Promise<BrainGraph> {
    const limit = Math.min(options.limit ?? 60, 200);
    const links = await this.db
      .select()
      .from(brainLinks)
      .where(and(eq(brainLinks.companyId, companyId), ne(brainLinks.origin, "removed")));
    const rows = await this.rows(companyId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const depthOf = new Map<string, number>();
    let more = 0;
    if (focus) {
      const start = await this.row(companyId, focus);
      depthOf.set(start.id, 0);
      let frontier = [start.id];
      for (let depth = 1; depth <= Math.min(options.depth ?? 1, 3) && frontier.length; depth++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const link of links) {
            const other = link.fromId === id ? link.toId : link.toId === id ? link.fromId : undefined;
            if (!other || depthOf.has(other) || !byId.has(other)) continue;
            if (depthOf.size >= limit) {
              more++;
              continue;
            }
            depthOf.set(other, depth);
            next.push(other);
          }
        }
        frontier = next;
      }
    } else {
      const map = rows.filter((r) => ["company", "department", "process", "system"].includes(r.kind));
      for (const row of map.slice(0, limit)) depthOf.set(row.id, row.kind === "company" ? 0 : 1);
      more = Math.max(0, map.length - limit);
    }
    const nodes = [...depthOf].map(([id, depth]) => {
      const row = byId.get(id)!;
      return { id, kind: row.kind as BrainKindKey, name: row.name, depth };
    });
    const edges = links
      .filter((l) => depthOf.has(l.fromId) && depthOf.has(l.toId))
      .map((l) => ({
        id: l.id,
        from: l.fromId,
        to: l.toId,
        relation: l.relation as BrainRelationKey,
        label: brainRelation(l.relation)?.label ?? l.relation,
        detail: l.detail,
      }));
    return { focus: focus ?? null, nodes, edges, more };
  }

  async overview(companyId: string, now = new Date()): Promise<BrainOverview> {
    const [rows, links, recentRows, eventStats] = await Promise.all([
      this.rows(companyId),
      this.db
        .select()
        .from(brainLinks)
        .where(and(eq(brainLinks.companyId, companyId), ne(brainLinks.origin, "removed"))),
      this.db.select().from(brainEvents).where(eq(brainEvents.companyId, companyId)).orderBy(desc(brainEvents.at), desc(brainEvents.createdAt)).limit(14),
      this.db
        .select({
          origin: brainEvents.origin,
          n: sql<number>`count(*)::int`,
          recent: sql<number>`count(*) filter (where ${brainEvents.at} >= ${new Date(now.getTime() - 7 * 86_400_000).toISOString()})::int`,
        })
        .from(brainEvents)
        .where(eq(brainEvents.companyId, companyId))
        .groupBy(brainEvents.origin),
    ]);
    const recent = await this.eventViews(companyId, recentRows);
    return overviewOf({ rows, links, recent, eventStats, now, summaryOf: (row) => this.summaryOf(row) });
  }

  // -------------------------------------------------------------------------
  // People's edits

  async create(companyId: string, input: BrainEntityInput, actor: string): Promise<BrainEntityView> {
    const kind = brainKind(input.kind);
    if (!kind) throw new BrainError(`There is no kind "${input.kind}"`);
    const { data, problems } = brainData(kind, input.data ?? {});
    if (problems.length) throw new BrainError(problems.join(" "), 400, problems);
    const index = new EntityIndex(await this.db.select().from(brainEntities).where(eq(brainEntities.companyId, companyId)));
    const same = index.resolve({ kind: input.kind, name: input.name, email: typeof data.email === "string" ? data.email : undefined }, "manual");
    if (same && same.status === "active") throw new BrainError(`${kind.name} "${same.name}" is already in the brain`, 409);
    const values = withoutBlanks(data);
    const aliases = uniqueStrings(input.aliases ?? []);
    const summary = input.summary ?? "";
    const origins: Record<string, string> = { name: "manual", ...(summary ? { summary: "manual" } : {}) };
    for (const key of Object.keys(values)) origins[`data.${key}`] = "manual";
    const [row] = await this.db
      .insert(brainEntities)
      .values({
        companyId,
        kind: input.kind,
        key: index.uniqueKey(input.kind, slugify(input.name, 80)),
        name: input.name,
        summary,
        aliases,
        data: values,
        origins,
        searchText: searchTextOf(kind, input.name, aliases, summary, values),
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    await this.options.onChange?.(companyId, {
      actor,
      action: "brain.added",
      entityId: row!.id,
      summary: `Added ${kind.name.toLowerCase()} "${input.name}" to the company brain`,
    });
    return this.get(companyId, row!.id);
  }

  async update(companyId: string, id: string, patch: BrainEntityPatch, actor: string): Promise<BrainEntityView> {
    const row = await this.row(companyId, id);
    const kind = brainKind(row.kind)!;
    const { data, problems } = brainData(kind, patch.data ?? {});
    if (problems.length) throw new BrainError(problems.join(" "), 400, problems);
    const origins = { ...row.origins };
    const next = { ...row.data };
    const changes: EventInsert[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (sameValue(row.data[key], value)) continue;
      const field = kind.fields.find((f) => f.key === key)!;
      if (field.tracked && !isBlankValue(row.data[key]) && !isBlankValue(value))
        changes.push(this.changeEvent(companyId, row, field, row.data[key], value, "manual", actorName(actor)));
      if (isBlankValue(value)) delete next[key];
      else next[key] = value;
      origins[`data.${key}`] = "manual";
    }
    const name = patch.name ?? row.name;
    const summary = patch.summary ?? row.summary;
    const aliases = patch.aliases ? uniqueStrings(patch.aliases) : row.aliases;
    if (name !== row.name) origins.name = "manual";
    if (summary !== row.summary) origins.summary = "manual";
    const [updated] = await this.db
      .update(brainEntities)
      .set({
        name,
        summary,
        aliases,
        data: next,
        origins,
        searchText: searchTextOf(kind, name, aliases, summary, next),
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(brainEntities.id, row.id))
      .returning();
    if (changes.length) await this.insertEvents(changes);
    await this.options.onChange?.(companyId, {
      actor,
      action: "brain.changed",
      entityId: row.id,
      summary: `Changed ${kind.name.toLowerCase()} "${updated!.name}" in the company brain`,
    });
    return this.get(companyId, row.id);
  }

  /** Removes a thing. One a source brings is only hidden, so the next reading doesn't bring it back. */
  async remove(companyId: string, id: string, actor: string): Promise<void> {
    const row = await this.row(companyId, id);
    if (Object.keys(row.refs).length || Object.values(row.origins).some((origin) => origin !== "manual")) {
      await this.db.update(brainEntities).set({ status: "removed", updatedBy: actor, updatedAt: new Date() }).where(eq(brainEntities.id, row.id));
      await this.db.delete(brainLinks).where(or(eq(brainLinks.fromId, row.id), eq(brainLinks.toId, row.id)));
    } else {
      await this.db.delete(brainEntities).where(eq(brainEntities.id, row.id));
    }
    await this.db
      .update(brainEvents)
      .set({ about: sql`${brainEvents.about} - ${row.id}::text` })
      .where(and(eq(brainEvents.companyId, companyId), sql`${brainEvents.about} @> ${JSON.stringify([row.id])}::jsonb`));
    await this.options.onChange?.(companyId, {
      actor,
      action: "brain.removed",
      entityId: row.id,
      summary: `Removed ${brainKind(row.kind)?.name.toLowerCase() ?? "thing"} "${row.name}" from the company brain`,
    });
  }

  async link(companyId: string, input: BrainLinkInput, actor: string): Promise<BrainLinkView> {
    const relation = brainRelation(input.relation);
    if (!relation) throw new BrainError(`There is no relation "${input.relation}"`);
    const [from, to] = await Promise.all([this.row(companyId, input.from), this.row(companyId, input.to)]);
    if (from.id === to.id) throw new BrainError("A thing can't be linked to itself");
    if (!relationFits(relation, from.kind, to.kind)) {
      throw new BrainError(`"${relation.label}" doesn't go from ${brainKind(from.kind)!.name.toLowerCase()} to ${brainKind(to.kind)!.name.toLowerCase()}`);
    }
    const detail = input.detail ?? "";
    const [row] = await this.db
      .insert(brainLinks)
      .values({ companyId, fromId: from.id, relation: input.relation, toId: to.id, detail, origin: "manual", createdBy: actor })
      .onConflictDoUpdate({ target: [brainLinks.fromId, brainLinks.relation, brainLinks.toId], set: { detail, origin: "manual", createdBy: actor } })
      .returning();
    await this.options.onChange?.(companyId, {
      actor,
      action: "brain.linked",
      entityId: from.id,
      summary: `Linked "${from.name}" ${relation.label.toLowerCase()} "${to.name}"`,
    });
    return { id: row!.id, relation: input.relation, direction: "out", label: relation.label, detail, origin: "manual", other: this.summaryOf(to) };
  }

  /** Removes a link. One a source brings is only hidden, so the next reading doesn't bring it back. */
  async unlink(companyId: string, linkId: string, actor: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(linkId)) throw new BrainError("Link not found", 404);
    const [link] = await this.db
      .select()
      .from(brainLinks)
      .where(and(eq(brainLinks.companyId, companyId), eq(brainLinks.id, linkId)));
    if (!link || link.origin === "removed") throw new BrainError("Link not found", 404);
    if (link.origin === "manual") await this.db.delete(brainLinks).where(eq(brainLinks.id, link.id));
    else await this.db.update(brainLinks).set({ origin: "removed", createdBy: actor }).where(eq(brainLinks.id, link.id));
    await this.options.onChange?.(companyId, {
      actor,
      action: "brain.unlinked",
      entityId: link.fromId,
      summary: `Removed a link (${brainRelation(link.relation)?.label ?? link.relation}) from the company brain`,
    });
  }

  /** A note or an update someone writes: on the timeline of what it is about. */
  async addEvent(companyId: string, input: BrainEventInput, actor: string, actorEmail?: string | null): Promise<BrainEventView> {
    const about = input.about?.length
      ? (
          await this.rows(
            companyId,
            inArray(
              brainEntities.id,
              input.about.filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
            ),
          )
        ).map((r) => r.id)
      : [];
    const person = actorEmail
      ? (await this.rows(companyId, and(eq(brainEntities.kind, "person"), sql`lower(${brainEntities.data}->>'email') = ${actorEmail.toLowerCase()}`)))[0]
      : undefined;
    const [row] = await this.db
      .insert(brainEvents)
      .values({
        companyId,
        at: input.at ? new Date(input.at) : new Date(),
        kind: input.kind,
        origin: "manual",
        title: input.title,
        body: input.body ?? "",
        actor: actorName(actor),
        actorId: person?.id ?? null,
        about,
      })
      .returning();
    return (await this.eventViews(companyId, [row!]))[0]!;
  }

  // -------------------------------------------------------------------------
  // What sources bring

  private changeEvent(companyId: string, row: EntityRow, field: BrainField, from: unknown, to: unknown, origin: string, actor: string): EventInsert {
    const words = (value: unknown) => formatValue(field, value, row.data) || "nothing";
    return {
      companyId,
      at: new Date(),
      kind: "change",
      origin,
      title: `${row.name}: ${field.label.toLowerCase()} ${words(from)} → ${words(to)}`,
      actor,
      about: [row.id],
      data: { field: field.key, from: from ?? null, to: to ?? null },
    };
  }

  private async insertEvents(events: EventInsert[]): Promise<void> {
    for (let i = 0; i < events.length; i += 200) await this.db.insert(brainEvents).values(events.slice(i, i + 200));
  }

  /**
   * Merges what a source knows into the brain. Things are found by the source's id, key, name or email;
   * a value is set unless a person wrote it or a higher-priority source did. Tracked values that change
   * (a deal's stage, a project's health) go on the timeline. The source's links are its full set: links
   * it brought before and no longer has are removed. Events are added once.
   */
  async apply(companyId: string, origin: string, batch: SourceBatch): Promise<SyncResult> {
    const result = emptyResult();
    const index = new EntityIndex(await this.db.select().from(brainEntities).where(eq(brainEntities.companyId, companyId)));
    const sourceName = this.options.originName?.(origin) ?? origin;
    const changes: EventInsert[] = [];

    const insert = async (values: typeof brainEntities.$inferInsert): Promise<EntityRow> => {
      const [row] = await this.db.insert(brainEntities).values(values).returning();
      index.add(row!);
      result.added++;
      result.byKind[row!.kind] = (result.byKind[row!.kind] ?? 0) + 1;
      return row!;
    };

    for (const input of batch.entities ?? []) {
      const kind = brainKind(input.kind);
      if (!kind) {
        result.skipped.push(`${input.name}: unknown kind "${input.kind}"`);
        continue;
      }
      const { data, problems } = brainData(kind, input.data ?? {});
      if (problems.length) result.skipped.push(`${input.name}: ${problems.join(" ")}`);
      const email = typeof data.email === "string" ? data.email : undefined;
      const existing = index.resolve({ kind: input.kind, ref: input.ref, key: input.key, name: input.name, email }, origin);
      if (existing?.status === "removed") {
        result.unchanged++;
        continue;
      }
      const values = withoutBlanks(data);
      if (!existing) {
        const aliases = uniqueStrings(input.aliases ?? []);
        const summary = input.summary ?? "";
        const origins: Record<string, string> = { name: origin, ...(summary ? { summary: origin } : {}) };
        for (const key of Object.keys(values)) origins[`data.${key}`] = origin;
        await insert({
          companyId,
          kind: input.kind,
          key: index.uniqueKey(input.kind, input.key ?? slugify(input.name, 80)),
          name: input.name,
          summary,
          aliases,
          data: values,
          origins,
          refs: input.ref ? { [origin]: input.ref } : {},
          searchText: searchTextOf(kind, input.name, aliases, summary, values),
          createdBy: origin,
          updatedBy: origin,
        });
        continue;
      }
      const origins = { ...existing.origins };
      const next = { ...existing.data };
      let name = existing.name;
      let summary = existing.summary;
      let changed = false;
      if (input.name !== existing.name && this.may(origins.name, origin)) {
        name = input.name;
        origins.name = origin;
        changed = true;
      }
      if (input.summary && input.summary !== existing.summary && this.may(origins.summary, origin)) {
        summary = input.summary;
        origins.summary = origin;
        changed = true;
      }
      const aliases = uniqueStrings([...existing.aliases, ...(input.aliases ?? [])]);
      if (aliases.length !== existing.aliases.length) changed = true;
      for (const [key, value] of Object.entries(values)) {
        const at = `data.${key}`;
        if (!this.may(origins[at], origin)) continue;
        if (sameValue(existing.data[key], value)) {
          // The same value from a source that counts more (the HR system over the app): it knows it now.
          if (origins[at] !== origin && origins[at] !== "manual") {
            origins[at] = origin;
            changed = true;
          }
          continue;
        }
        const field = kind.fields.find((f) => f.key === key)!;
        if (field.tracked && !isBlankValue(existing.data[key]))
          changes.push(this.changeEvent(companyId, existing, field, existing.data[key], value, origin, sourceName));
        next[key] = value;
        origins[at] = origin;
        changed = true;
      }
      const refs = input.ref && existing.refs[origin] !== input.ref ? { ...existing.refs, [origin]: input.ref } : existing.refs;
      if (refs !== existing.refs) changed = true;
      if (!changed) {
        result.unchanged++;
        continue;
      }
      const [updated] = await this.db
        .update(brainEntities)
        .set({
          name,
          summary,
          aliases,
          data: next,
          origins,
          refs,
          searchText: searchTextOf(kind, name, aliases, summary, next),
          updatedBy: origin,
          updatedAt: new Date(),
        })
        .where(eq(brainEntities.id, existing.id))
        .returning();
      index.add(updated!);
      result.updated++;
    }
    result.changes = changes.length;

    if (batch.links) {
      const existingLinks = await this.db.select().from(brainLinks).where(eq(brainLinks.companyId, companyId));
      const byKey = new Map(existingLinks.map((l) => [`${l.fromId}|${l.relation}|${l.toId}`, l]));
      const asserted = new Set<string>();
      // People a source names (an account owner, a case owner) join the brain when they aren't in it yet.
      const endpoint = async (ref: SourceRef): Promise<EntityRow | undefined> => {
        const found = index.resolve(ref, origin);
        if (found || ref.kind !== "person" || !ref.name) return found;
        return insert({
          companyId,
          kind: "person",
          key: index.uniqueKey("person", slugify(ref.name, 80)),
          name: ref.name,
          data: ref.email ? { email: ref.email.toLowerCase() } : {},
          origins: { name: origin, ...(ref.email ? { "data.email": origin } : {}) },
          searchText: foldText(`${ref.name} ${ref.email ?? ""} person`),
          createdBy: origin,
          updatedBy: origin,
        });
      };
      for (const link of batch.links) {
        const relation = brainRelation(link.relation);
        const [from, to] = [await endpoint(link.from), await endpoint(link.to)];
        if (!relation || !from || !to) {
          const missing = !from ? link.from : link.to;
          result.skipped.push(`${missing.name ?? missing.ref ?? missing.key ?? missing.email} (${missing.kind}): not in the brain`);
          continue;
        }
        if (from.status === "removed" || to.status === "removed" || from.id === to.id) continue;
        if (!relationFits(relation as BrainRelation, from.kind, to.kind)) {
          result.skipped.push(`${from.name} ${relation.label.toLowerCase()} ${to.name}: doesn't fit`);
          continue;
        }
        const key = `${from.id}|${link.relation}|${to.id}`;
        const existing = byKey.get(key);
        const detail = link.detail ?? "";
        if (existing) {
          asserted.add(existing.id);
          if (existing.origin === origin && existing.detail !== detail) await this.db.update(brainLinks).set({ detail }).where(eq(brainLinks.id, existing.id));
          continue;
        }
        const [row] = await this.db
          .insert(brainLinks)
          .values({ companyId, fromId: from.id, relation: link.relation, toId: to.id, detail, origin, createdBy: origin })
          .returning();
        byKey.set(key, row!);
        asserted.add(row!.id);
        result.links.added++;
      }
      const stale = existingLinks.filter((l) => l.origin === origin && !asserted.has(l.id)).map((l) => l.id);
      for (let i = 0; i < stale.length; i += 500) await this.db.delete(brainLinks).where(inArray(brainLinks.id, stale.slice(i, i + 500)));
      result.links.removed = stale.length;
    }

    if (batch.events?.length) {
      const known = new Set(
        (
          await this.db
            .select({ ref: brainEvents.ref })
            .from(brainEvents)
            .where(and(eq(brainEvents.companyId, companyId), eq(brainEvents.origin, origin)))
        ).map((r) => r.ref),
      );
      const mentions = index.mentions();
      const fresh: EventInsert[] = [];
      for (const event of batch.events) {
        if (known.has(event.ref)) continue;
        known.add(event.ref);
        const about = new Set<string>();
        for (const ref of event.about ?? []) {
          const found = index.resolve(ref, origin);
          if (found?.status === "active") about.add(found.id);
        }
        const actor = event.actor ? index.person(event.actor) : undefined;
        for (const id of mentions(eventText({ title: event.title, body: event.body ?? "" }))) if (id !== actor?.id) about.add(id);
        fresh.push({
          companyId,
          at: new Date(event.at),
          kind: event.kind,
          origin,
          ref: event.ref,
          title: event.title,
          body: event.body ?? "",
          actor: actor?.name ?? (event.actor ? actorName(event.actor) : null),
          actorId: actor?.id ?? null,
          place: event.place ?? null,
          about: [...about],
          data: event.data ?? {},
        });
      }
      await this.insertEvents(fresh);
      result.events = fresh.length;
    }
    if (changes.length) await this.insertEvents(changes);
    return result;
  }

  /** Empties a company's brain (things, links, events). */
  async clear(companyId: string): Promise<void> {
    await this.db.delete(brainEvents).where(eq(brainEvents.companyId, companyId));
    await this.db.delete(brainLinks).where(eq(brainLinks.companyId, companyId));
    await this.db.delete(brainEntities).where(eq(brainEntities.companyId, companyId));
  }

  /** Everything in the brain, for the overview, the map and the tools. */
  async everything(companyId: string): Promise<{ rows: EntityRow[]; links: LinkRow[] }> {
    const [rows, links] = await Promise.all([
      this.rows(companyId),
      this.db
        .select()
        .from(brainLinks)
        .where(and(eq(brainLinks.companyId, companyId), ne(brainLinks.origin, "removed"))),
    ]);
    return { rows, links };
  }
}
