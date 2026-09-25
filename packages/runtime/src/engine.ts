import { and, desc, eq, gte, inArray, max, sql } from "drizzle-orm";
import {
  evaluateCondition,
  isRecord,
  stringify,
  truncate,
  type AgentDefinition,
  type WorkflowStep,
} from "@enterprise-brain/core";
import { activityLog, approvals, runEvents, runs, type DatabaseHandle } from "@enterprise-brain/db";
import type { LlmUsage } from "@enterprise-brain/llm";
import { describeAction, executeAction } from "./actions.ts";
import type { ActivityService } from "./activity.ts";
import { employmentOf, type AgentRecord, type AgentService } from "./agents.ts";
import type {
  ApprovalAction,
  ExecutionScope,
  PersistedRunState,
  RunContext,
  RunEventInput,
  RunEventRecord,
  RunStatus,
  StepOutcome,
} from "./run-types.ts";
import { executeStep, mergeUsage } from "./steps/index.ts";
import type { DeferredApprovalRequest, ToolDeps } from "./tools.ts";

export type RunRow = typeof runs.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export interface EngineDeps extends Omit<ToolDeps, "requestApproval"> {
  handle: DatabaseHandle;
  agents: AgentService;
  activity: ActivityService;
}

export interface StartRunOptions {
  trigger?: string;
  triggerRef?: string | null;
  isTest?: boolean;
  /** Await completion (or the first approval pause). Default true. */
  wait?: boolean;
  actor?: string;
  /** Run a free-form task with the agent's tools instead of its workflow (used for Paperclip tasks). */
  task?: string;
}

export interface Decision {
  approved: boolean;
  note?: string;
  decidedBy?: string;
}

const AUTOMATED_TRIGGERS = new Set(["mailbox", "schedule", "webhook", "paperclip", "connector-event"]);

export class RunError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RunError";
  }
}

/** The AI employee reached its monthly budget: it starts no new work until its manager raises it. */
export class BudgetError extends RunError {
  constructor(message: string) {
    super(message, 409);
    this.name = "BudgetError";
  }
}

/** The first moment of the current month (server time): budgets count from here. */
export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** The default single step for agents without a workflow: an autonomous tool loop over the input. */
export function defaultAgentStep(definition: AgentDefinition): WorkflowStep {
  return {
    id: "agent",
    type: "agent",
    task: "Handle the following request.\n\n{{ input | json }}",
    tools: definition.tools,
  };
}

/**
 * Executes agents. Workflows run step by step with their state persisted after
 * every step, so a run can pause for a human approval and resume later (even
 * after a restart) exactly where it stopped.
 */
export class RunEngine {
  readonly toolDeps: ToolDeps;
  private readonly listeners = new Map<string, Set<(event: RunEventRecord) => void>>();
  private readonly anyListeners = new Set<(event: RunEventRecord) => void>();
  private readonly textListeners = new Map<string, Set<(delta: string) => void>>();
  private readonly executing = new Map<string, Promise<void>>();
  private readonly seqs = new Map<string, number>();

  constructor(private readonly deps: EngineDeps) {
    this.toolDeps = {
      ...deps,
      requestApproval: (companyId, request) => this.requestDeferredApproval(companyId, request),
      changesToday: (agentId) => this.changesToday(agentId),
    };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async start(companyId: string, agentRef: string, input: Record<string, unknown>, options: StartRunOptions = {}): Promise<RunRow> {
    const agent = await this.deps.agents.get(companyId, agentRef);
    const trigger = options.trigger ?? "manual";
    this.assertRunnable(agent, trigger, options.isTest ?? false);
    if (!options.isTest) await this.assertWithinBudget(companyId, agent);
    const missing = agent.definition.inputs
      .filter((f) => !options.task && f.required && (input[f.key] === undefined || input[f.key] === null || input[f.key] === ""))
      .map((f) => f.label ?? f.key);
    if (missing.length && trigger !== "mailbox") throw new RunError(`Missing required input: ${missing.join(", ")}`);

    const state: PersistedRunState = { steps: {}, completed: [], ...(options.task ? { task: options.task } : {}) };
    const [run] = await this.deps.handle.db
      .insert(runs)
      .values({
        companyId,
        agentId: agent.row.id,
        agentVersion: agent.row.version,
        trigger,
        triggerRef: options.triggerRef ?? null,
        status: "running",
        input,
        context: state as unknown as Record<string, unknown>,
        isTest: options.isTest ?? false,
        startedAt: new Date(),
      })
      .returning();
    await this.emit(run!.id, { type: "run.started", message: `${agent.definition.name} started (${trigger})`, data: { trigger } });
    await this.deps.activity.record(companyId, {
      actor: options.actor ?? "system",
      action: "run.started",
      entityType: "run",
      entityId: run!.id,
      summary: `Started ${agent.definition.name}${options.isTest ? " (test)" : ""}`,
      data: { agentId: agent.row.id, trigger },
    });
    const execution = this.execute(run!.id);
    if (options.wait ?? true) await execution;
    return this.getRow(companyId, run!.id);
  }

  /** This month's model cost of an AI employee's work (test runs included: they cost the same). */
  async costThisMonth(agentId: string, now = new Date()): Promise<number> {
    const [row] = await this.deps.handle.db
      .select({ usd: sql<number>`coalesce(sum((${runs.usage}->>'costUsd')::numeric), 0)::float` })
      .from(runs)
      .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, monthStart(now))));
    return Number(row?.usd ?? 0);
  }

  /** Changes the AI employee made alone (without a person) since midnight, for its daily limit. */
  async changesToday(agentId: string, now = new Date()): Promise<number> {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [row] = await this.deps.handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(runEvents)
      .innerJoin(runs, eq(runs.id, runEvents.runId))
      .where(
        and(eq(runs.agentId, agentId), eq(runEvents.type, "action.executed"), gte(runEvents.createdAt, midnight), sql`(${runEvents.data}->>'alone')::boolean`),
      );
    return Number(row?.n ?? 0);
  }

  private async assertWithinBudget(companyId: string, agent: AgentRecord) {
    const budget = agent.row.monthlyBudgetUsd;
    if (budget === null || budget === undefined) return;
    const spent = await this.costThisMonth(agent.row.id);
    if (spent < budget) return;
    await this.noteBudgetReached(companyId, agent.row.id, agent.definition.name, spent, budget);
    throw new BudgetError(`${agent.definition.name} reached its monthly budget ($${budget.toFixed(2)}). Its manager can raise it.`);
  }

  /** Tell the manager once a month that the AI employee stopped at its budget (activity; the work queue shows it). */
  private async noteBudgetReached(companyId: string, agentId: string, name: string, spent: number, budget: number) {
    const [already] = await this.deps.handle.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "agent.budget_reached"),
          eq(activityLog.entityId, agentId),
          gte(activityLog.createdAt, monthStart()),
        ),
      )
      .limit(1);
    if (already) return;
    await this.deps.activity.record(companyId, {
      actor: `agent:${agentId}`,
      action: "agent.budget_reached",
      entityType: "agent",
      entityId: agentId,
      summary: `${name} stopped: it reached its monthly budget ($${spent.toFixed(2)} of $${budget.toFixed(2)})`,
      data: { spentUsd: spent, budgetUsd: budget },
    });
  }

  /** After a run: when it used up the rest of the budget, tell the manager now rather than at the next start. */
  private async afterRun(companyId: string, agentId: string) {
    const agent = await this.deps.agents.find(companyId, agentId);
    const budget = agent?.row.monthlyBudgetUsd;
    if (!agent || budget === null || budget === undefined) return;
    const spent = await this.costThisMonth(agentId);
    if (spent >= budget) await this.noteBudgetReached(companyId, agentId, agent.definition.name, spent, budget);
  }

  private assertRunnable(agent: AgentRecord, trigger: string, isTest: boolean) {
    const status = agent.row.status;
    if (isTest) return;
    if (status === "paused" || status === "archived") throw new RunError(`${agent.definition.name} is ${status}`, 409);
    if (AUTOMATED_TRIGGERS.has(trigger) && status !== "active") {
      throw new RunError(`${agent.definition.name} is not active (status: ${status})`, 409);
    }
  }

  /** Execute (or continue) a run. Concurrent calls for the same run share one execution. */
  execute(runId: string): Promise<void> {
    const existing = this.executing.get(runId);
    if (existing) return existing;
    const promise = this.executeInner(runId).finally(() => this.executing.delete(runId));
    this.executing.set(runId, promise);
    return promise;
  }

  private async executeInner(runId: string): Promise<void> {
    const [run] = await this.deps.handle.db.select().from(runs).where(eq(runs.id, runId));
    if (!run || run.status !== "running") return;
    const companyId = run.companyId;
    let definition: AgentDefinition;
    let agentName = "Agent";
    let agentSlug = "agent";
    let employment;
    try {
      definition = await this.deps.agents.definitionAt(run.agentId, run.agentVersion);
      agentName = definition.name;
      agentSlug = definition.slug;
      // The level and limits as the manager set them now (a run resumed after a change follows the change).
      employment = employmentOf((await this.deps.agents.get(companyId, run.agentId)).row);
    } catch (error) {
      await this.fail(run, error);
      return;
    }
    const state = normalizeState(run.context);
    const started = run.startedAt ?? run.createdAt;
    const context: RunContext = {
      input: run.input,
      steps: state.steps,
      agent: { id: run.agentId, name: agentName, slug: agentSlug, department: definition.department },
      trigger: { type: run.trigger, ref: run.triggerRef },
      run: { id: run.id, isTest: run.isTest, startedAt: started.toISOString(), date: started.toLocaleDateString("sv-SE") },
    };
    const scope: ExecutionScope = {
      companyId,
      runId,
      agentId: run.agentId,
      definition,
      employment,
      context,
      emit: (event) => this.emit(runId, event),
      onText: (delta) => this.textListeners.get(runId)?.forEach((fn) => fn(delta)),
    };
    const workflow = state.task
      ? [taskStep(definition, state.task)]
      : definition.workflow.length
        ? definition.workflow
        : [defaultAgentStep(definition)];
    let usage = (run.usage && "calls" in run.usage ? run.usage : undefined) as LlmUsage | undefined;

    for (const step of workflow) {
      if (state.completed.includes(step.id)) continue;
      let shouldRun: boolean;
      try {
        shouldRun = evaluateCondition(step.when, context);
      } catch (error) {
        await this.fail(run, new Error(`Step "${step.id}" condition failed: ${errorMessage(error)}`));
        return;
      }
      if (!shouldRun) {
        state.completed.push(step.id);
        await this.persist(runId, { context: state as unknown as Record<string, unknown> });
        await this.emit(runId, { type: "step.skipped", stepId: step.id, message: `${stepLabel(step)} skipped (condition not met)` });
        continue;
      }
      await this.persist(runId, { currentStep: step.id });
      await this.emit(runId, { type: "step.started", stepId: step.id, message: stepLabel(step), data: { type: step.type } });
      let outcome: StepOutcome;
      const started = Date.now();
      try {
        outcome = await executeStep(step, scope, this.toolDeps);
      } catch (error) {
        if (step.onError === "continue") {
          state.steps[step.id] = { error: errorMessage(error) };
          state.completed.push(step.id);
          await this.persist(runId, { context: state as unknown as Record<string, unknown> });
          await this.emit(runId, { type: "step.failed", stepId: step.id, message: `${stepLabel(step)} failed, continuing: ${errorMessage(error)}` });
          continue;
        }
        await this.emit(runId, { type: "step.failed", stepId: step.id, message: `${stepLabel(step)} failed: ${errorMessage(error)}` });
        await this.fail(run, error, step.id);
        return;
      }

      if (outcome.kind === "pause" && run.isTest) {
        // Test runs never touch real systems: gated actions become dry runs, decisions auto-approve.
        outcome = {
          kind: "done",
          result:
            outcome.action.type === "decision"
              ? { approved: true, note: "Auto-approved in test run", decidedBy: "test" }
              : { dryRun: true, wouldExecute: outcome.action },
          message: `${outcome.title} — skipped in test run (dry run)`,
        };
      }

      if (outcome.kind === "pause") {
        const [approval] = await this.deps.handle.db
          .insert(approvals)
          .values({
            companyId,
            runId,
            agentId: run.agentId,
            origin: "workflow",
            stepId: step.id,
            title: outcome.title,
            details: outcome.details || describeAction(outcome.action),
            action: outcome.action as unknown as Record<string, unknown>,
            assigneeRole: outcome.assigneeRole ?? null,
            reason: outcome.reason ?? null,
          })
          .returning();
        state.pending = { stepId: step.id, approvalId: approval!.id, kind: outcome.action.type === "decision" ? "decision" : "gated" };
        await this.persist(runId, {
          status: "waiting_approval",
          context: state as unknown as Record<string, unknown>,
          usage: (usage ?? {}) as Record<string, unknown>,
        });
        await this.emit(runId, {
          type: "approval.requested",
          stepId: step.id,
          message: outcome.title,
          data: { approvalId: approval!.id, action: outcome.action as unknown as Record<string, unknown>, reason: outcome.reason ?? null },
        });
        await this.deps.activity.record(companyId, {
          actor: `agent:${run.agentId}`,
          action: "approval.requested",
          entityType: "approval",
          entityId: approval!.id,
          summary: `${agentName}: ${outcome.title}`,
        });
        return;
      }

      state.steps[step.id] = outcome.result;
      state.completed.push(step.id);
      usage = mergeUsage(usage, outcome.usage);
      await this.persist(runId, {
        context: state as unknown as Record<string, unknown>,
        usage: (usage ?? {}) as Record<string, unknown>,
      });
      await this.emit(runId, {
        type: "step.completed",
        stepId: step.id,
        message: outcome.message ? `${stepLabel(step)} — ${outcome.message}` : stepLabel(step),
        data: { preview: truncate(stringify(outcome.result), 600), durationMs: Date.now() - started, usage: outcome.usage ?? null },
      });
    }

    const outputStep = [...workflow].reverse().find((s) => s.type === "output");
    const finalStep = workflow[workflow.length - 1];
    const raw = outputStep ? state.steps[outputStep.id] : finalStep ? state.steps[finalStep.id] : undefined;
    const output = isRecord(raw) ? raw : { result: raw ?? null };
    const missing = definition.outputs.filter((f) => f.required && (output[f.key] === undefined || output[f.key] === null));
    if (missing.length) {
      await this.emit(runId, { type: "warning", message: `Output is missing required fields: ${missing.map((f) => f.key).join(", ")}` });
    }
    await this.persist(runId, { status: "succeeded", output, currentStep: null, finishedAt: new Date() });
    await this.emit(runId, { type: "run.succeeded", message: `${agentName} finished`, data: { usage: usage ?? null } });
    await this.deps.activity.record(companyId, {
      actor: `agent:${run.agentId}`,
      action: "run.succeeded",
      entityType: "run",
      entityId: runId,
      summary: `${agentName} finished`,
    });
    await this.afterRun(companyId, run.agentId).catch(() => undefined);
  }

  private async fail(run: RunRow, error: unknown, stepId?: string) {
    const message = errorMessage(error);
    await this.persist(run.id, { status: "failed", error: message, finishedAt: new Date() });
    await this.emit(run.id, { type: "run.failed", stepId: stepId ?? null, message });
    await this.deps.activity.record(run.companyId, {
      actor: `agent:${run.agentId}`,
      action: "run.failed",
      entityType: "run",
      entityId: run.id,
      summary: `Run failed: ${truncate(message, 200)}`,
    });
    await this.afterRun(run.companyId, run.agentId).catch(() => undefined);
  }

  private async persist(runId: string, patch: Partial<Pick<RunRow, "status" | "context" | "usage" | "currentStep" | "output" | "error" | "finishedAt">>) {
    await this.deps.handle.db.update(runs).set(patch).where(eq(runs.id, runId));
  }

  async cancel(companyId: string, runId: string): Promise<RunRow> {
    const run = await this.getRow(companyId, runId);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await this.persist(runId, { status: "cancelled", finishedAt: new Date() });
    await this.deps.handle.db
      .update(approvals)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
    await this.emit(runId, { type: "run.cancelled", message: "Run cancelled" });
    return this.getRow(companyId, runId);
  }

  async getRow(companyId: string, runId: string): Promise<RunRow> {
    const [run] = await this.deps.handle.db.select().from(runs).where(and(eq(runs.companyId, companyId), eq(runs.id, runId)));
    if (!run) throw new RunError(`Run ${runId} not found`, 404);
    return run;
  }

  async get(companyId: string, runId: string) {
    const run = await this.getRow(companyId, runId);
    const events = await this.deps.handle.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.seq);
    const runApprovals = await this.deps.handle.db.select().from(approvals).where(eq(approvals.runId, runId)).orderBy(approvals.createdAt);
    return { run, events, approvals: runApprovals };
  }

  async list(companyId: string, filter: { agentId?: string; status?: RunStatus; limit?: number } = {}) {
    const conditions = [eq(runs.companyId, companyId)];
    if (filter.agentId) conditions.push(eq(runs.agentId, filter.agentId));
    if (filter.status) conditions.push(eq(runs.status, filter.status));
    return this.deps.handle.db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt))
      .limit(filter.limit ?? 50);
  }

  /** Wait until a run is no longer running (succeeded, failed, cancelled or waiting for approval). */
  async waitForSettled(companyId: string, runId: string, timeoutMs = 600_000): Promise<RunRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRow(companyId, runId);
      if (run.status !== "running" || Date.now() > deadline) return run;
      // execute() joins the in-flight execution, or resumes a run left "running" by a restart.
      await Promise.race([this.execute(runId), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  private async requestDeferredApproval(companyId: string, request: DeferredApprovalRequest): Promise<{ id: string }> {
    const [approval] = await this.deps.handle.db
      .insert(approvals)
      .values({
        companyId,
        runId: request.runId ?? null,
        agentId: request.agentId,
        origin: "deferred",
        stepId: request.stepId,
        title: request.title,
        details: request.details,
        action: request.action as unknown as Record<string, unknown>,
        reason: request.reason ?? null,
      })
      .returning();
    if (request.runId) {
      await this.emit(request.runId, {
        type: "approval.requested",
        stepId: request.stepId,
        message: request.title,
        data: { approvalId: approval!.id, deferred: true, reason: request.reason ?? null },
      });
    }
    await this.deps.activity.record(companyId, {
      actor: `agent:${request.agentId}`,
      action: "approval.requested",
      entityType: "approval",
      entityId: approval!.id,
      summary: request.title,
    });
    return { id: approval!.id };
  }

  async listApprovals(companyId: string, filter: { status?: string; limit?: number } = {}) {
    const conditions = [eq(approvals.companyId, companyId)];
    if (filter.status) conditions.push(eq(approvals.status, filter.status));
    return this.deps.handle.db
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(desc(approvals.createdAt))
      .limit(filter.limit ?? 100);
  }

  async decide(companyId: string, approvalId: string, decision: Decision, options: { wait?: boolean } = {}): Promise<ApprovalRow> {
    const [approval] = await this.deps.handle.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.id, approvalId)));
    if (!approval) throw new RunError(`Approval ${approvalId} not found`, 404);
    if (approval.status !== "pending") throw new RunError(`Approval is already ${approval.status}`, 409);
    const decidedBy = decision.decidedBy ?? "user";
    await this.deps.handle.db
      .update(approvals)
      .set({
        status: decision.approved ? "approved" : "rejected",
        decidedBy,
        decisionNote: decision.note ?? null,
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));
    await this.deps.activity.record(companyId, {
      actor: decidedBy,
      action: decision.approved ? "approval.approved" : "approval.rejected",
      entityType: "approval",
      entityId: approvalId,
      summary: `${decision.approved ? "Approved" : "Rejected"}: ${approval.title}`,
    });
    const action = approval.action as unknown as ApprovalAction;

    if (approval.origin === "workflow" && approval.runId) {
      const run = await this.getRow(companyId, approval.runId);
      const state = normalizeState(run.context);
      if (run.status === "waiting_approval" && state.pending?.approvalId === approvalId) {
        await this.emit(run.id, {
          type: "approval.decided",
          stepId: approval.stepId,
          message: `${decision.approved ? "Approved" : "Rejected"} by ${decidedBy}${decision.note ? `: ${decision.note}` : ""}`,
        });
        let result: unknown;
        if (state.pending.kind === "decision") {
          result = { approved: decision.approved, note: decision.note ?? "", decidedBy };
        } else if (decision.approved) {
          try {
            const executed = await executeAction(this.deps, companyId, action);
            result = isRecord(executed) ? { ...executed, approvedBy: decidedBy } : { result: executed, approvedBy: decidedBy };
          } catch (error) {
            state.pending = undefined;
            await this.persist(run.id, { context: state as unknown as Record<string, unknown> });
            await this.fail(run, error, approval.stepId);
            return this.approvalRow(approvalId);
          }
        } else {
          result = { skipped: true, rejected: true, note: decision.note ?? "", decidedBy };
        }
        state.steps[approval.stepId] = result;
        state.completed.push(approval.stepId);
        state.pending = undefined;
        await this.persist(run.id, { status: "running", context: state as unknown as Record<string, unknown> });
        await this.emit(run.id, {
          type: "step.completed",
          stepId: approval.stepId,
          message: `${approval.title} — ${decision.approved ? "approved" : "rejected"}`,
          data: { preview: truncate(stringify(result), 600) },
        });
        const continuation = this.execute(run.id);
        if (options.wait ?? true) await continuation;
      }
      return this.approvalRow(approvalId);
    }

    // Deferred actions requested by autonomous steps/chat run when approved.
    const executes = decision.approved && action.type !== "decision";
    if (executes) {
      try {
        const result = await executeAction(this.deps, companyId, action);
        await this.deps.handle.db
          .update(approvals)
          .set({ action: { ...(action as unknown as Record<string, unknown>), result } as Record<string, unknown> })
          .where(eq(approvals.id, approvalId));
        if (approval.runId) {
          await this.emit(approval.runId, { type: "approval.executed", message: `Executed: ${approval.title}`, data: { approvalId } });
        }
      } catch (error) {
        await this.deps.handle.db
          .update(approvals)
          .set({ action: { ...(action as unknown as Record<string, unknown>), error: errorMessage(error) } as Record<string, unknown> })
          .where(eq(approvals.id, approvalId));
        if (approval.runId) {
          await this.emit(approval.runId, { type: "approval.failed", message: `Failed: ${approval.title}: ${errorMessage(error)}`, data: { approvalId } });
        }
      }
    }
    if (!executes && approval.runId) {
      await this.emit(approval.runId, {
        type: "approval.decided",
        message: `${decision.approved ? "Approved" : "Rejected"} by ${decidedBy}${decision.note ? `: ${decision.note}` : ""}`,
        data: { approvalId, approved: decision.approved, deferred: true },
      });
    }
    return this.approvalRow(approvalId);
  }

  private async approvalRow(approvalId: string): Promise<ApprovalRow> {
    const [row] = await this.deps.handle.db.select().from(approvals).where(eq(approvals.id, approvalId));
    return row!;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Events of every run, for integrations that follow runs they didn't start (e.g. after an approval). */
  onAnyEvent(listener: (event: RunEventRecord) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  subscribe(runId: string, onEvent: (event: RunEventRecord) => void, onText?: (delta: string) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(onEvent);
    this.listeners.set(runId, set);
    let textSet: Set<(delta: string) => void> | undefined;
    if (onText) {
      textSet = this.textListeners.get(runId) ?? new Set();
      textSet.add(onText);
      this.textListeners.set(runId, textSet);
    }
    return () => {
      set.delete(onEvent);
      if (!set.size) this.listeners.delete(runId);
      if (textSet && onText) {
        textSet.delete(onText);
        if (!textSet.size) this.textListeners.delete(runId);
      }
    };
  }

  private async nextSeq(runId: string): Promise<number> {
    let seq = this.seqs.get(runId);
    if (seq === undefined) {
      const [row] = await this.deps.handle.db.select({ seq: max(runEvents.seq) }).from(runEvents).where(eq(runEvents.runId, runId));
      seq = row?.seq ?? 0;
    }
    seq += 1;
    this.seqs.set(runId, seq);
    return seq;
  }

  private async emit(runId: string, event: RunEventInput): Promise<void> {
    const seq = await this.nextSeq(runId);
    const createdAt = new Date();
    await this.deps.handle.db.insert(runEvents).values({
      runId,
      seq,
      type: event.type,
      stepId: event.stepId ?? null,
      message: event.message,
      data: event.data ?? {},
      createdAt,
    });
    const record: RunEventRecord = { ...event, runId, seq, createdAt: createdAt.toISOString() };
    this.listeners.get(runId)?.forEach((fn) => fn(record));
    this.anyListeners.forEach((fn) => fn(record));
    if (["run.succeeded", "run.failed", "run.cancelled"].includes(event.type)) this.seqs.delete(runId);
  }

  /** Resume runs that were executing when the process stopped. */
  async resumeInterrupted(): Promise<number> {
    const interrupted = await this.deps.handle.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ["running"]));
    for (const run of interrupted) void this.execute(run.id);
    return interrupted.length;
  }
}

function normalizeState(value: unknown): PersistedRunState {
  const record = isRecord(value) ? value : {};
  return {
    steps: isRecord(record.steps) ? (record.steps as Record<string, unknown>) : {},
    completed: Array.isArray(record.completed) ? (record.completed as string[]) : [],
    pending: isRecord(record.pending) ? (record.pending as PersistedRunState["pending"]) : undefined,
    warnings: Array.isArray(record.warnings) ? (record.warnings as string[]) : undefined,
    task: typeof record.task === "string" ? record.task : undefined,
  };
}

/** One autonomous step over a free-form task, with every tool and connector the agent has. */
export function taskStep(definition: AgentDefinition, task: string): WorkflowStep {
  const brief = task.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
  return {
    id: "task",
    name: "Work on the assigned task",
    type: "agent",
    task: brief,
    tools: [...new Set([...definition.tools, "knowledge.search", ...definition.connectors.map((c) => `connector:${c.ref}`)])],
    maxTurns: 16,
  };
}

function stepLabel(step: WorkflowStep): string {
  return step.name ?? `${step.id} (${step.type})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
