import { eq } from "drizzle-orm";
import { approvals, companies, runs } from "@enterprise-brain/db";
import { PaperclipClient, hermesOutput } from "@enterprise-brain/paperclip";
import type { Platform } from "@enterprise-brain/runtime";
import type { ServerConfig } from "./config.ts";

/**
 * What Enterprise Brain keeps about the Paperclip company it pushed to, in the company's settings.
 * Keys are encrypted with the platform's secret box.
 */
export interface PaperclipLink {
  url: string;
  /** The company's id in Paperclip. */
  companyId?: string;
  /** Board API key used for the push (encrypted), when one was given instead of PAPERCLIP_API_KEY. */
  boardKey?: string;
  /** Per Paperclip agent id: the Enterprise Brain agent slug and the agent's Paperclip API key (encrypted). */
  agents: Record<string, { slug: string; key: string }>;
}

interface PaperclipRunRef {
  /** Paperclip ids from the gateway's session key (X-Hermes-Session-Key). */
  agentId?: string;
  issueId?: string;
}

type RunRow = typeof runs.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

/** Run events after which an issue blocked on approvals may be ready to close. */
const APPROVAL_OUTCOME_EVENTS = new Set(["run.succeeded", "run.failed", "approval.executed", "approval.failed", "approval.decided"]);

/**
 * Makes Enterprise Brain agents behave like Paperclip employees. When a heartbeat run ends, the agent
 * gives its issue a disposition: done, or blocked while a person approves something in Enterprise
 * Brain. Once every approval of the run is decided, the issue is closed (or annotated when an action
 * was rejected or failed), since the Paperclip run has ended by then.
 */
export class PaperclipBridge {
  private readonly settled = new Map<string, Promise<void>>();

  constructor(
    private readonly platform: Platform,
    private readonly config: ServerConfig,
  ) {}

  /** Follow approvals decided after the Paperclip run ended. Returns an unsubscribe function. */
  start(): () => void {
    return this.platform.engine.onAnyEvent((event) => {
      if (!APPROVAL_OUTCOME_EVENTS.has(event.type)) return;
      this.reconcile(event.runId).catch((error) => this.warn(`updating the Paperclip issue of run ${event.runId}`, error));
    });
  }

  async link(companyId: string): Promise<PaperclipLink | undefined> {
    const [row] = await this.platform.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const link = row?.settings.paperclip as PaperclipLink | undefined;
    return link?.url ? { ...link, agents: link.agents ?? {} } : undefined;
  }

  /** Remember the Paperclip company and its Enterprise Brain agents' keys (merged with what's known). */
  async remember(
    companyId: string,
    input: { url: string; companyId?: string; boardKey?: string; agents: { paperclipAgentId: string; slug: string; token: string }[] },
  ): Promise<PaperclipLink> {
    const [row] = await this.platform.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const previous = row?.settings.paperclip as PaperclipLink | undefined;
    const same = previous?.url === input.url;
    const link: PaperclipLink = {
      url: input.url,
      companyId: input.companyId ?? (same ? previous?.companyId : undefined),
      boardKey: input.boardKey ? this.platform.secretBox.encrypt(input.boardKey) : same ? previous?.boardKey : undefined,
      agents: {
        ...(same ? previous?.agents : {}),
        ...Object.fromEntries(input.agents.map((a) => [a.paperclipAgentId, { slug: a.slug, key: this.platform.secretBox.encrypt(a.token) }])),
      },
    };
    await this.platform.handle.db
      .update(companies)
      .set({ settings: { ...(row?.settings ?? {}), paperclip: link } })
      .where(eq(companies.id, companyId));
    return link;
  }

  /**
   * The task as the assignee sees it in Paperclip (title, description, the latest comments), read with the
   * agent's key. Paperclip's wake prompt also carries identity, API instructions and JSON that Enterprise
   * Brain agents don't need; undefined when the issue can't be read (then the prompt is used as is).
   */
  async taskBrief(companyId: string, ref: PaperclipRunRef): Promise<string | undefined> {
    if (!ref.issueId) return undefined;
    const link = await this.link(companyId);
    if (!link) return undefined;
    const agent = ref.agentId ? link.agents[ref.agentId] : undefined;
    const as = agent ? { token: this.platform.secretBox.decrypt<string>(agent.key) } : undefined;
    try {
      const client = this.client(link);
      const [issue, comments] = await Promise.all([client.getIssue(ref.issueId, as), client.issueComments(ref.issueId, as).catch(() => [])]);
      const recent = comments
        .filter((c) => c.body?.trim() && c.authorAgentId !== ref.agentId)
        .slice(-5)
        .map((c) => `- ${c.authorAgentId ? "Agent" : "Person"}: ${c.body!.trim()}`);
      return [
        `Task${issue.identifier ? ` ${issue.identifier}` : ""} assigned to you in Paperclip: ${issue.title ?? "(untitled)"}`,
        issue.description?.trim() ?? "",
        recent.length ? `Latest comments on the task:\n${recent.join("\n")}` : "",
        "Answer with the result for the people who follow this task; your answer is posted on it.",
      ]
        .filter(Boolean)
        .join("\n\n");
    } catch (error) {
      this.warn(`reading Paperclip issue ${ref.issueId}`, error);
      return undefined;
    }
  }

  /**
   * Called before the gateway reports a finished run: the agent sets its issue to done, or to blocked
   * while approvals are pending, inside the Paperclip heartbeat run (Paperclip attributes agent writes
   * to the run in X-Paperclip-Run-Id). Never throws: Paperclip still gets the run result if this fails.
   */
  async settleDuringRun(runId: string): Promise<void> {
    const existing = this.settled.get(runId);
    if (existing) return existing;
    const loaded = await this.load(runId);
    if (!loaded || !isFinished(loaded.run)) return; // not ready; a later call settles it
    const attempt = this.settle(loaded).catch((error) => this.warn(`setting the Paperclip disposition of run ${runId}`, error));
    this.settled.set(runId, attempt);
    setTimeout(() => this.settled.delete(runId), 15 * 60_000).unref();
    return attempt;
  }

  private async load(runId: string) {
    const [run] = await this.platform.handle.db.select().from(runs).where(eq(runs.id, runId));
    const ref = run?.trigger === "paperclip" ? paperclipRef(run.input) : undefined;
    if (!run || !ref?.issueId) return undefined;
    const link = await this.link(run.companyId);
    if (!link) return undefined;
    const runApprovals = await this.platform.handle.db.select().from(approvals).where(eq(approvals.runId, runId));
    return { run, ref: ref as PaperclipRunRef & { issueId: string }, link, runApprovals };
  }

  private async settle({ run, ref, link, runApprovals }: NonNullable<Awaited<ReturnType<PaperclipBridge["load"]>>>) {
    const pending = runApprovals.filter((a) => a.status === "pending");
    let patch: { status: string; comment?: string } | undefined;
    if (run.status === "waiting_approval") {
      patch = { status: "blocked" }; // the run summary explains what is waiting
    } else if (run.status === "succeeded" && pending.length) {
      patch = {
        status: "blocked",
        comment: `Waiting for approval in Enterprise Brain: ${pending.map((a) => `**${a.title}**`).join(", ")}. Approve or reject it at ${this.config.publicUrl}/approvals; this issue is closed automatically afterwards.`,
      };
    } else if (run.status === "succeeded") {
      patch = { status: "done" };
    }
    if (!patch) return; // failed and cancelled runs are handled by Paperclip itself
    const agent = ref.agentId ? link.agents[ref.agentId] : undefined;
    const as = agent && run.triggerRef ? { token: this.platform.secretBox.decrypt<string>(agent.key), runId: run.triggerRef } : undefined;
    await this.client(link).updateIssue(ref.issueId, patch, as);
  }

  /** After approvals are decided: close the issue this bridge blocked, or say why it stays blocked. */
  private async reconcile(runId: string) {
    const loaded = await this.load(runId);
    if (!loaded || !hasEnded(loaded.run) || !loaded.runApprovals.length) return;
    const { run, ref, link, runApprovals } = loaded;
    if (runApprovals.some((a) => a.status === "pending")) return; // still waiting on someone
    const client = this.client(link);
    const issue = await client.getIssue(ref.issueId);
    if (issue.status !== "blocked") return; // not blocked by us, or a person already moved it on
    const deciders = [...new Set(runApprovals.map((a) => a.decidedBy).filter(Boolean))].join(", ");
    const rejected = runApprovals.filter((a) => a.status === "rejected");
    const failed = runApprovals.filter((a) => typeof (a.action as { error?: unknown } | null)?.error === "string");
    if (run.status === "succeeded" && !rejected.length && !failed.length) {
      const summary = hermesOutput({ id: run.id, status: run.status, output: run.output ?? null, error: run.error, usage: run.usage ?? {} });
      await client.updateIssue(ref.issueId, {
        status: "done",
        comment: `Approved in Enterprise Brain${deciders ? ` by ${deciders}` : ""}: ${runApprovals.map((a) => a.title).join("; ")}.\n\n${summary}`,
      });
      return;
    }
    await client.updateIssue(ref.issueId, { comment: explainBlocked(run, rejected, failed) });
  }

  private client(link: PaperclipLink): PaperclipClient {
    const boardKey = link.boardKey ? this.platform.secretBox.decrypt<string>(link.boardKey) : this.config.paperclip?.apiKey;
    return new PaperclipClient(link.url, boardKey);
  }

  private warn(what: string, error: unknown) {
    console.warn(`[paperclip] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The Paperclip run can report it: finished, or paused on a workflow approval. */
function isFinished(run: RunRow): boolean {
  return run.status !== "queued" && run.status !== "running";
}

/** Finished for good; a paused workflow resumes once its approval is decided. */
function hasEnded(run: RunRow): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

function explainBlocked(run: RunRow, rejected: ApprovalRow[], failed: ApprovalRow[]): string {
  const lines = [
    ...rejected.map((a) => `Rejected in Enterprise Brain${a.decidedBy ? ` by ${a.decidedBy}` : ""}: ${a.title}${a.decisionNote ? ` (${a.decisionNote})` : ""}.`),
    ...failed.map((a) => `Approved, but the action failed in Enterprise Brain: ${a.title}: ${(a.action as { error?: string }).error}.`),
    ...(run.status === "failed" ? [`The Enterprise Brain run failed: ${run.error ?? "unknown error"}.`] : []),
    ...(run.status === "cancelled" ? ["The Enterprise Brain run was cancelled."] : []),
  ];
  return `${lines.join("\n")}\nThis issue stays blocked until someone decides the next step.`;
}

function paperclipRef(input: unknown): PaperclipRunRef | undefined {
  const ref = (input as { paperclip?: PaperclipRunRef } | null)?.paperclip;
  return ref && typeof ref === "object" ? ref : undefined;
}
