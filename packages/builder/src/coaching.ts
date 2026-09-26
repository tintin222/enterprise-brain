import { and, desc, eq, inArray } from "drizzle-orm";
import { AgentDefinition, isRecord, stringify, truncate, type FieldSpec, type WorkflowStep } from "@enterprise-brain/core";
import { coachingProposals } from "@enterprise-brain/db";
import type { LlmClient } from "@enterprise-brain/llm";
import { CoachingError, type AgentRecord, type CoachingNoteRow, type Platform, type RunRow, type TaskRow } from "@enterprise-brain/runtime";
import { ANALYST_PERSONA } from "./analyst.ts";
import { applyJsonPatch, type PatchOperation } from "./patch.ts";

export type ProposalRow = typeof coachingProposals.$inferSelect;
/** superseded: a newer proposal for the same AI employee took its place before anyone decided. */
export type ProposalStatus = "replaying" | "ready" | "published" | "kept" | "failed" | "superseded";

/** One change to the job, as a manager reads it. */
export interface JobChange {
  path: string;
  /** Where, in words: "Classify the email › Complaint about service › keywords". */
  label: string;
  before?: unknown;
  after?: unknown;
  /** Lists and longer text: what was added and what was taken out. */
  added?: string[];
  removed?: string[];
}

/** A result that comes out differently in a replay. Wording: text written anew (a summary, a draft). */
export interface ReplayFieldChange {
  key: string;
  label: string;
  before: unknown;
  after: unknown;
  kind: "outcome" | "wording";
}

/** A person it would now ask (or no longer ask), a change it would now make (or no longer make). */
export interface ReplayStepChange {
  stepId: string;
  name: string;
  kind: "person" | "action";
  change: "added" | "removed";
}

export interface ReplayItem {
  taskId: string;
  ref: string;
  title: string;
  /** People corrected this task: the notes the proposal takes in. */
  corrected: boolean;
  notes: string[];
  originalRunId?: string;
  /** The test run that replayed it. */
  runId?: string;
  status: "pending" | "same" | "changed" | "failed";
  error?: string;
  changes: ReplayFieldChange[];
  steps: ReplayStepChange[];
}

export interface ReplaySummary {
  total: number;
  done: number;
  /** Tasks whose result or course would change. */
  changed: number;
  failed: number;
  corrected: number;
  /** Corrected tasks that would now come out differently. */
  correctedChanged: number;
}

export interface ReplayResult {
  items: ReplayItem[];
  summary: ReplaySummary;
  /** How many recent tasks it replays at most. */
  limit?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface CoachingNoteView {
  id: string;
  kind: string;
  note: string;
  by: string;
  status: string;
  taskId: string | null;
  taskRef: string | null;
  taskTitle: string | null;
  proposalId: string | null;
  appliedVersion: number | null;
  createdAt: string;
}

export interface ProposalView {
  id: string;
  agentId: string;
  baseVersion: number;
  /** The AI employee's version now: a proposal is out of date once its job changed another way. */
  currentVersion: number;
  stale: boolean;
  status: ProposalStatus;
  rules: string[];
  explanation: string;
  changes: JobChange[];
  replay: ReplayResult;
  notes: CoachingNoteView[];
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  publishedVersion: number | null;
}

export interface CoachingOverview {
  notes: CoachingNoteView[];
  proposals: ProposalView[];
  llm: { available: boolean };
}

interface NoteContext {
  note: CoachingNoteRow;
  task?: TaskRow;
  output?: Record<string, unknown>;
}

interface Draft {
  definition: AgentDefinition;
  rules: string[];
  explanation: string;
}

export const RULES_HEADING = "## Rules from coaching";

/** Parts of a job coaching never changes: its address, what starts it, its connections, its model. */
const LOCKED_PATHS = ["/slug", "/triggers", "/connectors", "/model", "/paperclip"];

const DEFAULT_REPLAYS = 8;
const MAX_REPLAYS = 20;

const PATCH_SCHEMA = {
  type: "array",
  description: "JSON Patch (RFC 6902) operations on the job definition; empty when the rules in the instructions are enough",
  items: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["add", "replace", "remove"] },
      path: { type: "string", description: "JSON Pointer, e.g. /workflow/0/categories/6/keywords/- (append) or /workflow/3/when" },
      valueJson: { type: "string", description: "The new value as JSON; empty string for remove" },
    },
    required: ["op", "path", "valueJson"],
    additionalProperties: false,
  },
};

const COACH_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: { type: "string" },
      description: 'The lessons as short rules in plain words, one per distinct lesson, e.g. "An email about a late delivery is a complaint."',
    },
    operations: PATCH_SCHEMA,
    explanation: { type: "string", description: "Two or three sentences for the manager: what changes in the job, and why" },
  },
  required: ["rules", "operations", "explanation"],
  additionalProperties: false,
};

/** The instructions with these rules under "Rules from coaching", each once. */
export function withCoachingRules(instructions: string, rules: readonly string[]): string {
  const lines = instructions.split("\n");
  const present = new Set(
    lines.map((line) =>
      line
        .replace(/^\s*[-*]\s+/, "")
        .trim()
        .toLowerCase(),
    ),
  );
  const fresh = [...new Set(rules.map((rule) => rule.replace(/\s+/g, " ").trim()))].filter((rule) => rule && !present.has(rule.toLowerCase()));
  if (!fresh.length) return instructions;
  const bullets = fresh.map((rule) => `- ${rule}`);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === RULES_HEADING.toLowerCase());
  if (heading < 0) return `${instructions.trimEnd()}\n\n${RULES_HEADING}\n${bullets.join("\n")}\n`;
  let end = heading + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!)) end++;
  while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
  lines.splice(end, 0, ...bullets);
  return lines.join("\n");
}

/** A note as a rule when no model can phrase it: the person's own words. */
function ruleFromNote(note: CoachingNoteRow): string {
  const said = typeof note.data.note === "string" ? note.data.note.trim() : "";
  const text = said || note.note.replace(/^Marked as wrong:\s*/i, "Look again at work like this: ");
  return truncate(text.replace(/\s+/g, " ").trim(), 400);
}

// ---------------------------------------------------------------------------
// What changed in the job, in words
// ---------------------------------------------------------------------------

const KEY_WORDS: Record<string, string> = {
  instructions: "Instructions",
  workflow: "Steps",
  guardrails: "Rules",
  approvalRequiredFor: "Always asks a person before",
  notes: "Notes",
  outputs: "Results",
  inputs: "Inputs",
  ui: "Screen",
  highlight: "Shown first",
  keywords: "keywords",
  blockers: "phrases that rule it out",
  when: "runs when",
  passScore: "pass score",
  kind: "kind",
  weight: "weight",
  description: "description",
  label: "name",
  title: "title",
  details: "details",
  reason: "why a person is asked",
  assigneeRole: "who is asked",
  fields: "fields",
  categories: "categories",
  criteria: "criteria",
  prompt: "prompt",
  fallback: "text without a model",
  summary: "Summary",
  name: "Name",
  kpis: "Targets",
  tools: "Tools",
  knowledge: "Knowledge",
  personalData: "personal data",
};

const IDENTITY_KEYS = ["id", "key", "value", "ref"];

function identity(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of IDENTITY_KEYS) if (typeof item[key] === "string") return `${key}:${item[key]}`;
  return undefined;
}

function itemName(item: unknown, fallback: string): string {
  if (!isRecord(item)) return fallback;
  for (const key of ["name", "label", "title", "id", "key", "value"]) if (typeof item[key] === "string" && item[key]) return item[key] as string;
  return fallback;
}

function scalarText(value: unknown): string {
  return typeof value === "string" ? value : stringify(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** Text as lines people read: without markdown's heading and list marks. */
function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, ""),
    )
    .filter(Boolean);
}

/** The changes from one job to another, leaf by leaf, with lists and text as what was added and taken out. */
export function describeJobChanges(before: AgentDefinition, after: AgentDefinition): JobChange[] {
  const changes: JobChange[] = [];
  const walk = (a: unknown, b: unknown, path: string, label: string[]) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const where = label.join(" › ") || "Job";
    if (Array.isArray(a) && Array.isArray(b)) {
      if ([...a, ...b].every(isScalar)) {
        const was = new Set(a.map(scalarText));
        const now = new Set(b.map(scalarText));
        changes.push({ path, label: where, before: a, after: b, added: [...now].filter((v) => !was.has(v)), removed: [...was].filter((v) => !now.has(v)) });
        return;
      }
      const keyed = [...a, ...b].every((item) => identity(item) !== undefined);
      if (keyed) {
        const oldIndex = new Map(a.map((item, i) => [identity(item)!, i]));
        b.forEach((item, i) => {
          const id = identity(item)!;
          const name = itemName(item, `#${i + 1}`);
          if (!oldIndex.has(id)) changes.push({ path: `${path}/${i}`, label: [...label, name].join(" › "), after: item, added: [name] });
          else walk(a[oldIndex.get(id)!], item, `${path}/${i}`, [...label, name]);
        });
        const newIds = new Set(b.map((item) => identity(item)!));
        a.forEach((item, i) => {
          if (newIds.has(identity(item)!)) return;
          const name = itemName(item, `#${i + 1}`);
          changes.push({ path: `${path}/${i}`, label: [...label, name].join(" › "), before: item, removed: [name] });
        });
        return;
      }
      const length = Math.max(a.length, b.length);
      for (let i = 0; i < length; i++) walk(a[i], b[i], `${path}/${i}`, [...label, itemName(b[i] ?? a[i], `#${i + 1}`)]);
      return;
    }
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}/${key}`, [...label, KEY_WORDS[key] ?? key]);
      return;
    }
    if (typeof a === "string" && typeof b === "string" && (a.includes("\n") || b.includes("\n") || a.length > 200 || b.length > 200)) {
      const was = linesOf(a);
      const now = linesOf(b);
      changes.push({ path, label: where, added: now.filter((line) => !was.includes(line)), removed: was.filter((line) => !now.includes(line)) });
      return;
    }
    changes.push({ path, label: where, before: a, after: b });
  };
  const top = (key: keyof AgentDefinition) => walk(before[key], after[key], `/${key}`, [KEY_WORDS[key] ?? key]);
  for (const key of Object.keys({ ...before, ...after }) as (keyof AgentDefinition)[]) {
    if (key === "workflow") {
      // Steps by id, named as people see them.
      const was = new Map(before.workflow.map((step) => [step.id, step]));
      after.workflow.forEach((step, i) => {
        const old = was.get(step.id);
        const name = step.name ?? step.id;
        if (!old) changes.push({ path: `/workflow/${i}`, label: `Steps › ${name}`, after: step, added: [name] });
        else walk(old, step, `/workflow/${i}`, [name]);
      });
      const now = new Set(after.workflow.map((step) => step.id));
      before.workflow.forEach((step, i) => {
        if (!now.has(step.id))
          changes.push({ path: `/workflow/${i}`, label: `Steps › ${step.name ?? step.id}`, before: step, removed: [step.name ?? step.id] });
      });
    } else top(key);
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Replays: before and after
// ---------------------------------------------------------------------------

/** Steps whose results a replay reuses from the original task: waits (replies), decisions, and writes (what a system answered). */
const RECORDED_TYPES = new Set<WorkflowStep["type"]>(["wait", "approval", "connector", "mail.send"]);

function stateOf(run: RunRow): { steps: Record<string, unknown>; task?: string } {
  const context = isRecord(run.context) ? run.context : {};
  return { steps: isRecord(context.steps) ? context.steps : {}, ...(typeof context.task === "string" ? { task: context.task } : {}) };
}

function normalized(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    return /^-?\d+(\.\d+)?$/.test(text) ? String(Math.round(Number(text) * 100) / 100) : text;
  }
  if (Array.isArray(value)) return JSON.stringify(value.map(normalized).sort());
  if (isRecord(value)) {
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalized(value[key])]),
    );
  }
  return String(value);
}

const WORDING_TYPES = new Set<FieldSpec["type"]>(["text"]);

/** The results a replay compares: the ones shown first, else all of them. */
function comparedFields(definition: AgentDefinition): { key: string; label: string; wording: boolean }[] {
  const byKey = new Map(definition.outputs.map((field) => [field.key, field]));
  const keys = definition.ui.highlight?.length ? definition.ui.highlight : definition.outputs.map((field) => field.key);
  return keys.map((key) => {
    const field = byKey.get(key);
    return { key, label: field?.label ?? key, wording: field ? WORDING_TYPES.has(field.type) : false };
  });
}

export function compareOutputs(definition: AgentDefinition, before: Record<string, unknown>, after: Record<string, unknown>): ReplayFieldChange[] {
  const changes: ReplayFieldChange[] = [];
  for (const field of comparedFields(definition)) {
    const was = before[field.key];
    const now = after[field.key];
    if (normalized(was) === normalized(now)) continue;
    const long = [was, now].some((value) => typeof value === "string" && value.length > 160);
    changes.push({ key: field.key, label: field.label, before: was ?? null, after: now ?? null, kind: field.wording || long ? "wording" : "outcome" });
  }
  return changes;
}

function summarize(items: ReplayItem[]): ReplaySummary {
  const finished = items.filter((item) => item.status !== "pending");
  const corrected = items.filter((item) => item.corrected);
  return {
    total: items.length,
    done: finished.length,
    changed: finished.filter((item) => item.status === "changed").length,
    failed: finished.filter((item) => item.status === "failed").length,
    corrected: corrected.length,
    correctedChanged: corrected.filter((item) => item.status === "changed").length,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Studio's coach. People's corrections become rules in an AI employee's next version: the coach
 * drafts the rules and the change to the job, replays recent tasks with it (as tests, so nothing is
 * sent or written) to show what would come out differently, and its manager publishes the new version
 * or keeps the one it has.
 */
export class StudioCoach {
  private readonly replaying = new Map<string, Promise<void>>();

  constructor(
    private readonly platform: Platform,
    private readonly llm: LlmClient = platform.llm,
  ) {}

  private get db() {
    return this.platform.handle.db;
  }

  get online(): boolean {
    return this.llm.available;
  }

  /** A person marks a finished task as wrong and says why: a note for its AI employee's next version. */
  async correctTask(companyId: string, taskRef: string, input: { note: string; by: string }): Promise<CoachingNoteRow> {
    const task = await this.platform.tasks.get(companyId, taskRef);
    if (task.status !== "done") throw new CoachingError("Only a finished task can be marked as wrong", 409);
    const note = await this.platform.coachingNotes.record(companyId, {
      agentId: task.agentId,
      taskId: task.id,
      kind: "task",
      note: input.note,
      by: input.by,
      summary: `${input.by} marked ${task.ref} (“${task.title}”) as wrong: ${input.note.trim()}`,
    });
    await this.platform.tasks.record(companyId, task.id, {
      type: "corrected",
      message: `${input.by} marked it as wrong: ${truncate(note.note, 400)}`,
      actor: input.by,
      data: { noteId: note.id },
    });
    return note;
  }

  /** An AI employee's corrections (open ones first) and the proposals made from them, newest first. */
  async overview(companyId: string, agentRef: string): Promise<CoachingOverview> {
    const agent = await this.platform.agents.get(companyId, agentRef);
    const notes = await this.platform.coachingNotes.list(companyId, agent.row.id);
    const rows = await this.db
      .select()
      .from(coachingProposals)
      .where(and(eq(coachingProposals.companyId, companyId), eq(coachingProposals.agentId, agent.row.id)))
      .orderBy(desc(coachingProposals.createdAt))
      .limit(20);
    const order = { open: 0, applied: 1, kept: 2 } as Record<string, number>;
    const sorted = [...notes].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
    return {
      notes: await this.noteViews(companyId, sorted),
      proposals: await Promise.all(rows.map((row) => this.view(companyId, row, agent, notes))),
      llm: { available: this.online },
    };
  }

  async proposal(companyId: string, id: string): Promise<ProposalView> {
    const row = await this.row(companyId, id);
    const agent = await this.platform.agents.get(companyId, row.agentId);
    return this.view(companyId, row, agent);
  }

  /** The AI employee a proposal changes (for access checks before acting on it). */
  async agentOf(companyId: string, proposalId: string): Promise<AgentRecord> {
    const row = await this.row(companyId, proposalId);
    return this.platform.agents.get(companyId, row.agentId);
  }

  /**
   * Turn open corrections into rules and a new version of the job, then replay recent tasks with it.
   * The replay runs in the background unless `wait` is set.
   */
  async propose(companyId: string, agentRef: string, input: { by: string; noteIds?: string[]; limit?: number; wait?: boolean }): Promise<ProposalView> {
    const agent = await this.platform.agents.get(companyId, agentRef);
    const open = await this.platform.coachingNotes.list(companyId, agent.row.id, { status: ["open"] });
    const notes = input.noteIds?.length ? open.filter((note) => input.noteIds!.includes(note.id)) : open;
    if (input.noteIds?.length && notes.length !== new Set(input.noteIds).size) throw new CoachingError("Some of these corrections are not open any more", 409);
    if (!notes.length) throw new CoachingError(`${agent.definition.name} has no open corrections to learn from`, 409);
    const contexts = await Promise.all(notes.map((note) => this.noteContext(note)));
    const draft = await this.draft(agent.definition, contexts);
    // One proposal at a time: a newer one takes the place of those nobody decided on.
    await this.db
      .update(coachingProposals)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(coachingProposals.agentId, agent.row.id), inArray(coachingProposals.status, ["replaying", "ready", "failed"])));
    const [row] = await this.db
      .insert(coachingProposals)
      .values({
        companyId,
        agentId: agent.row.id,
        baseVersion: agent.row.version,
        definition: draft.definition as unknown as Record<string, unknown>,
        rules: draft.rules,
        explanation: draft.explanation,
        changes: describeJobChanges(agent.definition, draft.definition).map((change) =>
          // The rules show as rules; the heading they sit under is just layout.
          change.path === "/instructions" ? { ...change, added: change.added?.filter((line) => `## ${line}` !== RULES_HEADING) } : change,
        ) as unknown as Record<string, unknown>[],
        status: "replaying",
        replay: input.limit ? { limit: input.limit } : {},
        createdBy: input.by,
      })
      .returning();
    await this.platform.coachingNotes.update(
      companyId,
      notes.map((note) => note.id),
      { proposalId: row!.id },
    );
    await this.platform.activity.record(companyId, {
      actor: input.by,
      action: "agent.coaching_proposed",
      entityType: "agent",
      entityId: agent.row.id,
      summary: `${input.by} asked the Studio to turn ${notes.length} correction${notes.length === 1 ? "" : "s"} into rules for ${agent.definition.name}`,
      data: { proposalId: row!.id, rules: draft.rules },
    });
    const replay = this.replay(companyId, row!.id, { limit: input.limit });
    if (input.wait) await replay;
    else replay.catch(() => undefined);
    return this.proposal(companyId, row!.id);
  }

  /** Replays cut short by a restart start over (at startup). */
  async resumeInterrupted(): Promise<number> {
    const rows = await this.db.select().from(coachingProposals).where(eq(coachingProposals.status, "replaying"));
    for (const row of rows) this.replay(row.companyId, row.id).catch(() => undefined);
    return rows.length;
  }

  /** Waits for a proposal's replay (tests, scripts). */
  async settled(proposalId: string): Promise<void> {
    await this.replaying.get(proposalId)?.catch(() => undefined);
  }

  /** Publish the proposal as the AI employee's next version; its corrections become applied rules. */
  async publish(companyId: string, id: string, by: string): Promise<ProposalView> {
    const row = await this.row(companyId, id);
    if (row.status === "replaying") throw new CoachingError("The replay is still running", 409);
    if (row.status === "superseded") throw new CoachingError("A newer proposal took this one's place", 409);
    if (row.status !== "ready") throw new CoachingError(`This proposal was already ${row.status}`, 409);
    const agent = await this.platform.agents.get(companyId, row.agentId);
    if (agent.row.version !== row.baseVersion) {
      throw new CoachingError(
        `${agent.definition.name} changed since this proposal (now version ${agent.row.version}). Propose again from its current version.`,
        409,
      );
    }
    const rules = row.rules;
    const updated = await this.platform.agents.update(companyId, row.agentId, AgentDefinition.parse(row.definition), {
      note: truncate(`Coaching: ${rules.join(" · ")}`, 500),
      createdBy: by,
    });
    const notes = await this.proposalNotes(companyId, row);
    await this.db
      .update(coachingProposals)
      .set({ status: "published", decidedBy: by, decidedAt: new Date(), publishedVersion: updated.row.version, updatedAt: new Date() })
      .where(eq(coachingProposals.id, row.id));
    await this.platform.coachingNotes.update(
      companyId,
      notes.map((note) => note.id),
      { status: "applied", appliedVersion: updated.row.version },
    );
    for (const taskId of new Set(notes.map((note) => note.taskId).filter((taskId): taskId is string => !!taskId))) {
      await this.platform.tasks.record(companyId, taskId, {
        type: "coached",
        message: `The correction became a rule in version ${updated.row.version} of ${agent.definition.name}`,
        actor: by,
        data: { proposalId: row.id, version: updated.row.version },
      });
    }
    await this.platform.activity.record(companyId, {
      actor: by,
      action: "agent.coached",
      entityType: "agent",
      entityId: row.agentId,
      summary: `${by} published version ${updated.row.version} of ${agent.definition.name} with ${rules.length} new rule${rules.length === 1 ? "" : "s"}`,
      data: { proposalId: row.id, version: updated.row.version, rules },
    });
    return this.proposal(companyId, id);
  }

  /** Keep the version the AI employee has: the proposal is set aside and its corrections are closed as kept. */
  async keep(companyId: string, id: string, by: string): Promise<ProposalView> {
    const row = await this.row(companyId, id);
    if (row.status === "published" || row.status === "kept" || row.status === "superseded")
      throw new CoachingError(`This proposal was already ${row.status}`, 409);
    const notes = await this.proposalNotes(companyId, row);
    await this.db
      .update(coachingProposals)
      .set({ status: "kept", decidedBy: by, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(coachingProposals.id, row.id));
    await this.platform.coachingNotes.update(
      companyId,
      notes.map((note) => note.id),
      { status: "kept" },
    );
    const agent = await this.platform.agents.get(companyId, row.agentId);
    await this.platform.activity.record(companyId, {
      actor: by,
      action: "agent.coaching_kept",
      entityType: "agent",
      entityId: row.agentId,
      summary: `${by} kept version ${agent.row.version} of ${agent.definition.name} (the proposed rules were not published)`,
      data: { proposalId: row.id },
    });
    return this.proposal(companyId, id);
  }

  // -------------------------------------------------------------------------
  // Drafting
  // -------------------------------------------------------------------------

  private async noteContext(note: CoachingNoteRow): Promise<NoteContext> {
    if (!note.taskId) return { note };
    const task = await this.platform.tasks.byId(note.taskId);
    const runs = task ? (await this.platform.tasks.runsOf(task.id)).filter((run) => !run.isTest) : [];
    const output = runs.find((run) => run.output)?.output ?? undefined;
    return { note, ...(task ? { task } : {}), ...(output ? { output } : {}) };
  }

  private async draft(definition: AgentDefinition, contexts: NoteContext[]): Promise<Draft> {
    const offline = (): Draft => {
      const rules = [...new Set(contexts.map((context) => ruleFromNote(context.note)))];
      return {
        definition: { ...definition, instructions: withCoachingRules(definition.instructions, rules) },
        rules,
        explanation:
          "No language model is set up, so the corrections are added to its instructions as people wrote them. " +
          "Without a model it works from keywords and doesn't read instructions, so the replay can't show a difference yet.",
      };
    };
    if (!this.llm.available) return offline();

    const corrections = contexts.map((context, i) =>
      [
        `${i + 1}. ${context.note.kind === "task" || context.note.kind === "check" ? "Marked as wrong" : context.note.kind === "correction" ? "Corrected before approving" : "Rejected"} by ${context.note.by}${
          context.task ? ` on the task “${context.task.title}” (${context.task.ref})` : ""
        }: ${context.note.note}`,
        context.note.kind === "correction" && context.note.data.edits ? `   What they changed: ${truncate(stringify(context.note.data.edits), 1200)}` : "",
        context.task ? `   The task as it arrived: ${truncate(stringify(context.task.input), 1500)}` : "",
        context.output ? `   What the AI employee produced: ${truncate(stringify(context.output), 1500)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const { data } = await this.llm.structured<{
      rules: string[];
      operations: { op: PatchOperation["op"]; path: string; valueJson: string }[];
      explanation: string;
    }>({
      purpose: "coaching.propose",
      system: ANALYST_PERSONA,
      effort: "high",
      schema: COACH_SCHEMA,
      messages: [
        {
          role: "user",
          content: [
            "People corrected this AI employee's work. Turn their corrections into rules for its next version.",
            "- Write each lesson as a short, general rule in plain words that its manager can read and agree with; not a note about one task.",
            "- Change the job itself only where following the rule needs it: category descriptions and keywords, evaluation criteria, extraction instructions, conditions (when), the questions it asks people. Keep ids, step types and {{ }} templates valid, and change nothing else.",
            `- Don't write the rules into /instructions yourself: they are added under "${RULES_HEADING.replace(/^#+\s*/, "")}" for you.`,
            "- The slug, triggers, connectors and model can't change here.",
            "<job>",
            JSON.stringify(definition, null, 1),
            "</job>",
            "<corrections>",
            ...corrections,
            "</corrections>",
          ].join("\n"),
        },
      ],
    });
    const rules = [...new Set(data.rules.map((rule) => rule.replace(/\s+/g, " ").trim()).filter(Boolean))];
    if (!rules.length) return offline();
    let changed: unknown = definition;
    const left: string[] = [];
    for (const operation of data.operations) {
      const path = operation.path.trim();
      if (LOCKED_PATHS.some((locked) => path === locked || path.startsWith(`${locked}/`))) {
        left.push(`${path} can't change through coaching`);
        continue;
      }
      try {
        const value = operation.op === "remove" ? undefined : (JSON.parse(operation.valueJson) as unknown);
        changed = applyJsonPatch(changed, [{ op: operation.op, path, ...(operation.op === "remove" ? {} : { value }) }]);
      } catch (error) {
        left.push(`${path}: ${errorText(error)}`);
      }
    }
    let parsed = AgentDefinition.safeParse(changed);
    if (!parsed.success) {
      left.push("the changed steps didn't fit together");
      parsed = AgentDefinition.safeParse(definition);
    }
    const next = parsed.data ?? definition;
    return {
      definition: { ...next, slug: definition.slug, instructions: withCoachingRules(next.instructions, rules) },
      rules,
      explanation: [data.explanation.trim(), left.length ? `Left out, because it didn't fit the job: ${left.join("; ")}.` : ""].filter(Boolean).join(" "),
    };
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  /** Replay recent tasks with the proposal, one by one (the proposal shows progress as it goes). */
  private replay(companyId: string, proposalId: string, options: { limit?: number } = {}): Promise<void> {
    const running = this.replaying.get(proposalId);
    if (running) return running;
    const promise = this.replayInner(companyId, proposalId, options)
      .catch(async (error) => {
        await this.db
          .update(coachingProposals)
          .set({ status: "failed", replay: { items: [], summary: summarize([]), error: errorText(error) }, updatedAt: new Date() })
          .where(and(eq(coachingProposals.id, proposalId), eq(coachingProposals.status, "replaying")));
        throw error;
      })
      .finally(() => this.replaying.delete(proposalId));
    this.replaying.set(proposalId, promise);
    return promise;
  }

  private async replayInner(companyId: string, proposalId: string, options: { limit?: number }): Promise<void> {
    const row = await this.row(companyId, proposalId);
    const definition = AgentDefinition.parse(row.definition);
    const notes = await this.proposalNotes(companyId, row);
    const asked = options.limit ?? (typeof row.replay.limit === "number" ? row.replay.limit : undefined);
    const limit = Math.min(Math.max(asked ?? DEFAULT_REPLAYS, 1), MAX_REPLAYS);

    // The corrected tasks first, then the latest finished ones.
    const correctedIds = [...new Set(notes.map((note) => note.taskId).filter((taskId): taskId is string => !!taskId))];
    const tasks: TaskRow[] = [];
    for (const taskId of correctedIds) {
      const task = await this.platform.tasks.byId(taskId);
      if (task && tasks.length < limit) tasks.push(task);
    }
    const recent = await this.platform.tasks.list(companyId, { statuses: ["done"], agentIds: [row.agentId], limit: limit + correctedIds.length });
    for (const task of recent) if (tasks.length < limit && !tasks.some((t) => t.id === task.id)) tasks.push(task);

    const items: ReplayItem[] = tasks.map((task) => {
      const about = notes.filter((note) => note.taskId === task.id);
      return {
        taskId: task.id,
        ref: task.ref,
        title: task.title,
        corrected: about.length > 0,
        notes: about.map((note) => note.note),
        status: "pending",
        changes: [],
        steps: [],
      };
    });
    const startedAt = new Date().toISOString();
    const save = async (finished = false) => {
      const replay: ReplayResult = { items, summary: summarize(items), limit, startedAt, ...(finished ? { finishedAt: new Date().toISOString() } : {}) };
      // Progress as it goes; ready at the end, unless a newer proposal took its place meanwhile.
      await this.db
        .update(coachingProposals)
        .set({ replay: replay as unknown as Record<string, unknown>, updatedAt: new Date(), ...(finished ? { status: "ready" } : {}) })
        .where(and(eq(coachingProposals.id, proposalId), eq(coachingProposals.status, "replaying")));
    };
    await save();
    for (const [i, task] of tasks.entries()) {
      if ((await this.row(companyId, proposalId)).status !== "replaying") return;
      try {
        items[i] = await this.replayTask(companyId, task, definition, items[i]!, row.createdBy);
      } catch (error) {
        items[i] = { ...items[i]!, status: "failed", error: errorText(error) };
      }
      await save();
    }
    await save(true);
  }

  private async replayTask(companyId: string, task: TaskRow, definition: AgentDefinition, item: ReplayItem, by: string): Promise<ReplayItem> {
    const original = (await this.platform.tasks.runsOf(task.id)).find((run) => !run.isTest);
    if (!original) return { ...item, status: "failed", error: "It has no run to replay" };
    const originalDefinition = await this.platform.agents.definitionAt(original.agentId, original.agentVersion).catch(() => undefined);
    const state = stateOf(original);
    const recordedTypes = new Map([...(originalDefinition?.workflow ?? []), ...definition.workflow].map((step) => [step.id, step.type]));
    const recorded = Object.fromEntries(Object.entries(state.steps).filter(([stepId]) => RECORDED_TYPES.has(recordedTypes.get(stepId)!)));
    const run = await this.platform.engine.start(companyId, original.agentId, original.input, {
      trigger: original.trigger,
      triggerRef: original.triggerRef,
      isTest: true,
      definition,
      recorded,
      ...(state.task ? { task: state.task } : {}),
      actor: by,
      wait: true,
    });
    const base = { ...item, originalRunId: original.id, runId: run.id };
    if (run.status !== "succeeded") return { ...base, status: "failed", error: run.error ?? `The replay ended ${run.status}` };
    const changes = compareOutputs(definition, original.output ?? {}, run.output ?? {});
    const steps = await this.stepChanges(companyId, originalDefinition ?? definition, definition, state.steps, stateOf(run).steps);
    return { ...base, status: changes.length || steps.length ? "changed" : "same", changes, steps };
  }

  /** People it would now ask (or no longer ask), and changes it would now make (or no longer make) in systems. */
  private async stepChanges(
    companyId: string,
    before: AgentDefinition,
    after: AgentDefinition,
    ran: Record<string, unknown>,
    replayed: Record<string, unknown>,
  ): Promise<ReplayStepChange[]> {
    const changes: ReplayStepChange[] = [];
    const steps = new Map<string, { step: WorkflowStep; definition: AgentDefinition }>();
    for (const step of before.workflow) steps.set(step.id, { step, definition: before });
    for (const step of after.workflow) steps.set(step.id, { step, definition: after });
    for (const [stepId, { step, definition }] of steps) {
      const kind =
        step.type === "approval"
          ? "person"
          : step.type === "mail.send" || (step.type === "connector" && (await this.writes(companyId, definition, step)))
            ? "action"
            : undefined;
      if (!kind) continue;
      const was = ran[stepId] !== undefined;
      const now = replayed[stepId] !== undefined;
      if (was !== now) changes.push({ stepId, name: step.name ?? stepId, kind, change: now ? "added" : "removed" });
    }
    return changes;
  }

  private async writes(companyId: string, definition: AgentDefinition, step: Extract<WorkflowStep, { type: "connector" }>): Promise<boolean> {
    const binding = definition.connectors.find((c) => c.ref === step.connector);
    if (!binding) return false;
    try {
      const resolved = await this.platform.connectors.resolve(companyId, binding);
      const operation = this.platform.connectors.operation(resolved.impl, step.operation);
      return operation.kind === "write" || !!operation.requiresApproval;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private async row(companyId: string, id: string): Promise<ProposalRow> {
    const [row] = await this.db
      .select()
      .from(coachingProposals)
      .where(and(eq(coachingProposals.companyId, companyId), eq(coachingProposals.id, id)));
    if (!row) throw new CoachingError("Proposal not found", 404);
    return row;
  }

  private async proposalNotes(companyId: string, row: ProposalRow): Promise<CoachingNoteRow[]> {
    return (await this.platform.coachingNotes.list(companyId, row.agentId)).filter((note) => note.proposalId === row.id);
  }

  private async noteViews(companyId: string, notes: CoachingNoteRow[]): Promise<CoachingNoteView[]> {
    const tasks = new Map<string, TaskRow | undefined>();
    for (const taskId of new Set(notes.map((note) => note.taskId).filter((taskId): taskId is string => !!taskId))) {
      const task = await this.platform.tasks.byId(taskId);
      tasks.set(taskId, task?.companyId === companyId ? task : undefined);
    }
    return notes.map((note) => {
      const task = note.taskId ? tasks.get(note.taskId) : undefined;
      return {
        id: note.id,
        kind: note.kind,
        note: note.note,
        by: note.by,
        status: note.status,
        taskId: note.taskId,
        taskRef: task?.ref ?? null,
        taskTitle: task?.title ?? null,
        proposalId: note.proposalId,
        appliedVersion: note.appliedVersion,
        createdAt: note.createdAt.toISOString(),
      };
    });
  }

  private async view(companyId: string, row: ProposalRow, agent: AgentRecord, allNotes?: CoachingNoteRow[]): Promise<ProposalView> {
    const notes = (allNotes ?? (await this.platform.coachingNotes.list(companyId, row.agentId))).filter((note) => note.proposalId === row.id);
    const replay = row.replay as Partial<ReplayResult>;
    const items = Array.isArray(replay.items) ? replay.items : [];
    return {
      id: row.id,
      agentId: row.agentId,
      baseVersion: row.baseVersion,
      currentVersion: agent.row.version,
      stale: (row.status === "ready" || row.status === "replaying") && agent.row.version !== row.baseVersion,
      status: row.status as ProposalStatus,
      rules: row.rules,
      explanation: row.explanation,
      changes: row.changes as unknown as JobChange[],
      replay: { ...replay, items, summary: replay.summary ?? summarize(items) },
      notes: await this.noteViews(companyId, notes),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      publishedVersion: row.publishedVersion,
    };
  }
}
