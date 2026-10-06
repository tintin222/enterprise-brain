import type { BrainEventKind, BrainKindKey, BrainRelationKey } from "@enterprise-brain/core";

/** A thing of the brain, in a list: its name, kind and the few values that say most about it. */
export interface BrainEntitySummary {
  id: string;
  kind: BrainKindKey;
  key: string;
  name: string;
  summary: string;
  /** The kind's brief fields that have a value, as words: [["Title", "Quality Engineer"], ["Status", "Active"]]. */
  brief: [string, string][];
  updatedAt: string;
  /** In lists: the links that say most about it ("Who" of a task, "Lead" of a project), by label. */
  keyLinks?: Record<string, { id: string; kind: BrainKindKey; name: string }[]>;
}

export interface BrainLinkView {
  id: string;
  relation: BrainRelationKey;
  /** "out": this thing is the first of the link; "in": the second. */
  direction: "out" | "in";
  /** The relation read from this thing's side: "Knows", "Who knows it". */
  label: string;
  detail: string;
  origin: string;
  other: BrainEntitySummary;
}

export interface BrainEventView {
  id: string;
  at: string;
  kind: BrainEventKind;
  origin: string;
  title: string;
  body: string;
  actor: string | null;
  actorId: string | null;
  place: string | null;
  about: { id: string; kind: BrainKindKey; name: string }[];
  data: Record<string, unknown>;
}

export interface BrainEntityView extends BrainEntitySummary {
  aliases: string[];
  data: Record<string, unknown>;
  /** Where each value came from: "manual" or a source key, by field ("name", "summary", "data.title"). */
  origins: Record<string, string>;
  /** Its id in each source. */
  refs: Record<string, string>;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  links: BrainLinkView[];
  events: BrainEventView[];
}

// ---------------------------------------------------------------------------
// What a source brings

/** Finds a thing: by its id in the source, its key, its name (or one of its other names), or a person's email. */
export interface SourceRef {
  kind: BrainKindKey;
  ref?: string;
  /** Whose id `ref` is, when another source's (the CRM's account id, named by the ERP). */
  origin?: string;
  key?: string;
  name?: string;
  email?: string;
}

export interface SourceEntity {
  kind: BrainKindKey;
  /** Its id in the source. */
  ref?: string;
  key?: string;
  name: string;
  summary?: string;
  aliases?: string[];
  data?: Record<string, unknown>;
}

export interface SourceLink {
  from: SourceRef;
  relation: BrainRelationKey;
  to: SourceRef;
  detail?: string;
}

export interface SourceEvent {
  /** Its id in the source: the same event is never added twice. */
  ref: string;
  at: string | Date;
  kind: BrainEventKind;
  title: string;
  body?: string;
  /** Who said or did it: a name or an email. */
  actor?: string;
  place?: string;
  /** What it is about, besides what its words name. */
  about?: SourceRef[];
  data?: Record<string, unknown>;
}

/** Everything a source knows now. Links are the full set: links it brought before and no longer has go. */
export interface SourceBatch {
  entities?: SourceEntity[];
  links?: SourceLink[];
  events?: SourceEvent[];
}

export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  links: { added: number; removed: number };
  events: number;
  /** Values that changed (status, stage, health…), each also on the timeline. */
  changes: number;
  /** New things, by kind. */
  byKind: Record<string, number>;
  /** What could not be placed, in words. */
  skipped: string[];
}

export function emptyResult(): SyncResult {
  return { added: 0, updated: 0, unchanged: 0, links: { added: 0, removed: 0 }, events: 0, changes: 0, byKind: {}, skipped: [] };
}

// ---------------------------------------------------------------------------
// Overview

export interface BrainAttention {
  /** risk · issue · overdue · deal · goal · data (a report showing old numbers) */
  type: string;
  title: string;
  detail: string;
  entity: { id: string; kind: BrainKindKey; name: string };
  severity: "high" | "medium";
}

export interface BrainGap {
  /** single-expert · on-leave-expert · no-owner · no-definitions · no-steps · no-one */
  type: string;
  title: string;
  detail: string;
  entity: { id: string; kind: BrainKindKey; name: string };
}

export interface BrainProjectView {
  id: string;
  name: string;
  status: string | null;
  health: string | null;
  progress: number | null;
  end: string | null;
  client: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
  openTasks: number;
  now: string | null;
}

export interface BrainOverview {
  company: BrainEntitySummary | null;
  counts: Record<string, number>;
  total: number;
  links: number;
  events: { total: number; lastWeek: number; bySource: Record<string, number> };
  recent: BrainEventView[];
  projects: BrainProjectView[];
  attention: BrainAttention[];
  gaps: BrainGap[];
  /** Who has the most open tasks, and on what. */
  busy: { person: { id: string; name: string; title: string | null }; open: number; tasks: string[] }[];
  goals: BrainEntitySummary[];
}

/**
 * Where data comes from and where it goes, around a report, data set or table: what each is built
 * on, back to the database tables, and the reports and work built on it. Data flows from lower
 * layers to higher ones; the thing itself is layer 0.
 */
export interface BrainLineage {
  root: string;
  nodes: (BrainEntitySummary & { layer: number; /** Where it lives: a table's database, a report's tool. */ place: string | null })[];
  /** From the data to what is built on it. */
  edges: { from: string; to: string; relation: BrainRelationKey; detail: string }[];
}

export interface BrainGraph {
  focus: string | null;
  nodes: { id: string; kind: BrainKindKey; name: string; depth: number }[];
  edges: { id: string; from: string; to: string; relation: BrainRelationKey; label: string; detail: string }[];
  /** Neighbours left out to keep the picture readable. */
  more: number;
}
