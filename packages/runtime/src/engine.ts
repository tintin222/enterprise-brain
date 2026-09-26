import { and, desc, eq, gte, inArray, max, sql } from "drizzle-orm";
import {
  evaluateCondition,
  isRecord,
  stringify,
  truncate,
  AgentDefinition,
  type WorkflowStep,
} from "@enterprise-brain/core";
import { activityLog, approvals, runEvents, runs, type DatabaseHandle } from "@enterprise-brain/db";
import type { LlmUsage } from "@enterprise-brain/llm";
import { describeAction, executeAction } from "./actions.ts";
import { MailService } from "./mail.ts";
import type { ActivityService } from "./activity.ts";
import type { PlatformEvents } from "./events.ts";
import { employmentOf, type AgentRecord, type AgentService } from "./agents.ts";
import type { CoachingNotes } from "./coaching-notes.ts";
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
import { wakeText, type TaskPlan, type TaskRow, type TaskService, type TaskWait, type WakeReason } from "./tasks.ts";
import type { AskPersonRequest, DeferredApprovalRequest, ToolDeps } from "./tools.ts";
import { WorkError, type WorkItemRow, type WorkService } from "./work.ts";

export type RunRow = typeof runs.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export interface EngineDeps extends Omit<ToolDeps, "requestApproval" | "tasks" | "askPerson"> {
  handle: DatabaseHandle;
  agents: AgentService;
  activity: ActivityService;
  tasks: TaskService;
  work: WorkService;
  /** Tells other services (notifications) when approvals appear and are decided. */
  events?: PlatformEvents;
  /** Where corrections are kept for the AI employee's next version. */
  coaching: CoachingNotes;
}

export interface StartRunOptions {
  trigger?: string;
  triggerRef?: string | null;
  isTest?: boolean;
  /** Await completion (or the first approval pause). Default true. */
  wait?: boolean;
  actor?: string;
  /** Run a free-form task with the agent's tools instead of its workflow (requests, Paperclip tasks, wake-ups). */
  task?: string;
  /** Continue this task (a wake-up); otherwise a new task is opened for the run (none for test runs). */
  taskId?: string;
  /** The task's title; derived from the request, the email or the input otherwise. */
  title?: string;
  /** Who asked for the work (a person's name, an email address). */
  requestedBy?: string | null;
  /** Test runs only: run this version of the job instead of the live one (a coaching proposal). */
  definition?: AgentDefinition;
  /** Test runs only: what the original task's waits found, reused instead of waiting (replays). */
  recorded?: Record<string, unknown>;
}

export interface Decision {
  approved: boolean;
  note?: string;
  decidedBy?: string;
  /** Corrections to the proposed change before it runs: an email's to/subject/body, a system action's input fields. */
  edits?: Record<string, unknown>;
  /** Where the person decided when not in the app: "email", "teams", "google-chat" (kept in the audit log). */
  via?: string;
}

/** Where people act outside the app, as the audit log says it. */
const VIA_LABELS: Record<string, string> = { email: "an email", teams: "Microsoft Teams", "google-chat": "Google Chat" };

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
      tasks: deps.tasks,
      askPerson: (request) => this.askPerson(request),
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
    const missing = (options.isTest && options.definition ? options.definition : agent.definition).inputs
      .filter((f) => !options.task && f.required && (input[f.key] === undefined || input[f.key] === null || input[f.key] === ""))
      .map((f) => f.label ?? f.key);
    if (missing.length && trigger !== "mailbox") throw new RunError(`Missing required input: ${missing.join(", ")}`);

    // Every piece of real work is a task (test runs aren't): a new one, or the one being continued.
    let taskId = options.isTest ? null : (options.taskId ?? null);
    if (!options.isTest && !taskId) {
      const task = await this.deps.tasks.create(companyId, {
        agentId: agent.row.id,
        title: options.title ?? taskTitle(agent.definition, input, trigger, options.task),
        source: trigger === "manual" ? "request" : trigger,
        sourceRef: options.triggerRef ?? null,
        requestedBy: options.requestedBy ?? (trigger === "manual" || trigger === "request" ? (options.actor ?? null) : null),
        input: options.task ? { ...input, request: options.task } : input,
      });
      taskId = task.id;
      await this.deps.tasks.record(companyId, task.id, { type: "created", message: `${SOURCE_TEXT[trigger] ?? "Started"}: ${task.title}`, actor: options.actor ?? "system" });
    } else if (taskId) {
      await this.deps.tasks.update(taskId, { status: "working" });
    }

    if ((options.definition || options.recorded) && !options.isTest) throw new RunError("Only test runs can run a version that isn't live");
    const state: PersistedRunState = {
      steps: {},
      completed: [],
      ...(options.task ? { task: options.task } : {}),
      ...(options.definition ? { override: AgentDefinition.parse(options.definition) as unknown as Record<string, unknown> } : {}),
      ...(options.recorded ? { recorded: options.recorded } : {}),
    };
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
        taskId,
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
    return this.costSince(agentId, monthStart(now));
  }

  /** Model cost of an AI employee's work since a moment (e.g. midnight for "today"). */
  async costSince(agentId: string, since: Date): Promise<number> {
    const [row] = await this.deps.handle.db
      .select({ usd: sql<number>`coalesce(sum((${runs.usage}->>'costUsd')::numeric), 0)::float` })
      .from(runs)
      .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, since)));
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
    const agent = await this.deps.agents.find(companyId, agentId);
    await this.deps.work.create(companyId, {
      kind: "notice",
      title: `${name} stopped: it reached its monthly budget`,
      details: `It used $${spent.toFixed(2)} of its $${budget.toFixed(2)} budget this month, so it starts no new work. Raise its budget on its page to let it continue; its emails and tasks wait meanwhile.`,
      agentId,
      departmentId: agent?.row.departmentId ?? null,
      assigneeUserId: agent?.row.managerUserId ?? null,
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
    let task: TaskRow | undefined;
    const persisted = normalizeState(run.context);
    try {
      definition =
        run.isTest && persisted.override ? AgentDefinition.parse(persisted.override) : await this.deps.agents.definitionAt(run.agentId, run.agentVersion);
      agentName = definition.name;
      agentSlug = definition.slug;
      // The level and limits as the manager set them now (a run resumed after a change follows the change).
      employment = employmentOf((await this.deps.agents.get(companyId, run.agentId)).row);
      task = run.taskId ? await this.deps.tasks.byId(run.taskId) : undefined;
    } catch (error) {
      await this.fail(run, error);
      return;
    }
    const state = persisted;
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
      ...(task ? { task: { id: task.id, ref: task.ref } } : {}),
      context,
      emit: (event) => this.emit(runId, event),
      onText: (delta) => this.textListeners.get(runId)?.forEach((fn) => fn(delta)),
      ...(state.recorded ? { recorded: state.recorded } : {}),
    };
    const workflow = state.task
      ? [taskStep(definition, state.task)]
      : definition.workflow.length
        ? definition.workflow
        : [defaultAgentStep(definition)];
    let usage = (run.usage && "calls" in run.usage ? run.usage : undefined) as LlmUsage | undefined;

    let first = true;
    for (const step of workflow) {
      if (state.completed.includes(step.id)) continue;
      // Between steps: stop when the run was cancelled (its task stopped), hold when its task was paused.
      if (!first && (await this.holdAtBoundary(run))) return;
      first = false;
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
        // Test runs never touch real systems: gated actions become dry runs, decisions auto-approve. A replay
        // takes the decision people made in the original task, when they were asked there too.
        const decided = state.recorded?.[step.id];
        outcome =
          outcome.action.type === "decision" && isRecord(decided) && typeof decided.approved === "boolean"
            ? { kind: "done", result: decided, message: `${outcome.title}: as decided in the original task (replay)` }
            : {
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
        this.deps.events?.emit("queue.added", { companyId, type: "approval", id: approval!.id });
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
        if (run.taskId) {
          await this.deps.tasks.update(run.taskId, { status: "needs_person" });
          await this.deps.tasks.record(companyId, run.taskId, {
            type: "needs_person",
            message: `Asked a person to decide: ${outcome.title}${outcome.reason ? ` (${outcome.reason})` : ""}`,
            actor: `agent:${run.agentId}`,
            runId,
            data: { approvalId: approval!.id },
          });
        }
        return;
      }

      if (outcome.kind === "wait") {
        // The task waits for a reply or a time; waking it completes this step with what happened.
        state.pending = { stepId: step.id, kind: "wait" };
        await this.persist(runId, { status: "waiting", context: state as unknown as Record<string, unknown>, usage: (usage ?? {}) as Record<string, unknown> });
        await this.emit(runId, { type: "task.waiting", stepId: step.id, message: outcome.title, data: { for: outcome.for, until: outcome.until?.toISOString() ?? null } });
        if (run.taskId) {
          const wait: TaskWait = { kind: outcome.for, since: new Date().toISOString(), days: outcome.days, runId, stepId: step.id };
          await this.deps.tasks.update(run.taskId, { status: "waiting", waitingFor: wait as unknown as Record<string, unknown>, nextCheckAt: outcome.until ?? null });
          await this.deps.tasks.record(companyId, run.taskId, { type: "waiting", message: outcome.title, actor: `agent:${run.agentId}`, runId });
        }
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
    if (run.taskId) await this.settleTask(companyId, run.taskId, runId, outputText(output));
  }

  /**
   * Between steps: a cancelled run stops; a run whose task was paused holds (status "waiting") and
   * continues from the next step when the task is resumed.
   */
  private async holdAtBoundary(run: RunRow): Promise<boolean> {
    const [current] = await this.deps.handle.db.select({ status: runs.status }).from(runs).where(eq(runs.id, run.id));
    if (current?.status !== "running") return true;
    if (!run.taskId) return false;
    const task = await this.deps.tasks.byId(run.taskId);
    if (task?.status !== "paused") return false;
    await this.persist(run.id, { status: "waiting" });
    await this.emit(run.id, { type: "task.paused", message: "Holding: its task was paused" });
    const wait = { ...((task.waitingFor ?? {}) as Record<string, unknown>), pausedFrom: "working", runId: run.id };
    await this.deps.tasks.update(task.id, { waitingFor: wait });
    return true;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  /** After a run: a person is still needed, or the task follows its plan (wait, follow up, done). */
  private async settleTask(companyId: string, taskId: string, runId: string, outcome: string) {
    const task = await this.deps.tasks.byId(taskId);
    if (!task || task.status !== "working") return;
    const pending = [...(await this.deps.tasks.approvalsOf(taskId, "pending")).map((a) => a.title), ...(await this.deps.work.openFor(taskId, "question")).map((q) => q.title)];
    if (pending.length) {
      await this.deps.tasks.update(taskId, { status: "needs_person" });
      await this.deps.tasks.record(companyId, taskId, {
        type: "needs_person",
        message: `Waiting for a person: ${pending.join("; ")}`,
        actor: `agent:${task.agentId}`,
        runId,
      });
      return;
    }
    await this.followPlan(task, runId, outcome);
  }

  /** A question from an AI employee to a person (its manager, or its department): the task waits for the answer. */
  private async askPerson(request: AskPersonRequest): Promise<{ id: string }> {
    const agent = await this.deps.agents.get(request.companyId, request.agentId);
    const item = await this.deps.work.create(request.companyId, {
      kind: "question",
      title: request.question,
      details: request.context ?? "",
      suggestion: request.suggestion ?? null,
      options: request.options ?? null,
      taskId: request.taskId,
      agentId: agent.row.id,
      departmentId: agent.row.departmentId,
      assigneeUserId: request.toManager ? agent.row.managerUserId : null,
    });
    await this.deps.tasks.record(request.companyId, request.taskId, { type: "asked", message: `Asked: ${request.question}`, actor: `agent:${agent.row.id}`, runId: request.runId ?? null, data: { workItemId: item.id } });
    return { id: item.id };
  }

  /** No person is needed any more: wait for a reply, follow up later, or close the task. */
  private async followPlan(task: TaskRow, runId: string | null, fallbackOutcome: string) {
    const plan = task.plan as TaskPlan | null;
    const now = new Date();
    const actor = `agent:${task.agentId}`;
    // A reply that came in while it was busy or waiting on a person: look at it right away.
    const replyMessageId = (task.waitingFor as { replyMessageId?: string } | null)?.replyMessageId;
    if (plan?.next === "wait_reply") {
      const wait = { kind: "reply", since: now.toISOString(), days: plan.days, note: plan.note, ...(replyMessageId ? { replyMessageId } : {}) };
      const until = new Date(now.getTime() + plan.days * 86_400_000);
      await this.deps.tasks.update(task.id, { status: "waiting", plan: null, waitingFor: wait, nextCheckAt: replyMessageId ? now : until });
      await this.deps.tasks.record(task.companyId, task.id, {
        type: "waiting",
        message: `Waiting for a reply until ${until.toISOString().slice(0, 10)}${plan.note ? `: ${plan.note}` : ""}`,
        actor,
        runId,
      });
    } else if (plan?.next === "follow_up") {
      const wait: TaskWait = { kind: "time", since: now.toISOString(), note: plan.note };
      await this.deps.tasks.update(task.id, { status: "waiting", plan: null, waitingFor: wait as unknown as Record<string, unknown>, nextCheckAt: new Date(plan.at) });
      await this.deps.tasks.record(task.companyId, task.id, {
        type: "waiting",
        message: `Will look again on ${plan.at.slice(0, 10)}${plan.note ? `: ${plan.note}` : ""}`,
        actor,
        runId,
      });
    } else {
      const outcome = plan?.next === "complete" ? plan.outcome : fallbackOutcome;
      await this.deps.tasks.update(task.id, { status: "done", plan: null, waitingFor: null, nextCheckAt: null, outcome, closedAt: now });
      await this.deps.tasks.record(task.companyId, task.id, { type: "done", message: `Done: ${truncate(outcome, 400)}`, actor, runId });
      // In Shadow, a person checks every finished task.
      const agent = await this.deps.agents.find(task.companyId, task.agentId);
      if (agent && employmentOf(agent.row).probation === "shadow") {
        await this.deps.work.create(task.companyId, {
          kind: "review",
          title: `Check ${agent.definition.name}'s work: ${task.title}`,
          details: outcome,
          taskId: task.id,
          agentId: agent.row.id,
          departmentId: agent.row.departmentId,
          assigneeUserId: agent.row.managerUserId,
        });
      }
    }
  }

  /**
   * Wake a task: a reply arrived, its time came, people decided, or its manager resumed it. A workflow
   * waiting at a wait step continues there; otherwise a new run continues from a brief of the task.
   */
  async wakeTask(companyId: string, ref: string, reason: WakeReason, options: { wait?: boolean; actor?: string } = {}): Promise<TaskRow> {
    const task = await this.deps.tasks.get(companyId, ref);
    const wait = (task.waitingFor ?? null) as (TaskWait & { pausedFrom?: string }) | null;
    await this.deps.tasks.record(companyId, task.id, { type: "woke", message: `Woke up: ${truncate(wakeText(reason, task).split("\n")[0]!, 300)}`, actor: options.actor ?? "system", data: { reason: reason.kind } });
    await this.deps.tasks.update(task.id, { status: "working", wakeups: task.wakeups + 1, waitingFor: null, nextCheckAt: null, closedAt: null });
    try {
      if (wait?.runId) {
        const result =
          reason.kind === "reply"
            ? { replied: true, reply: reason.email }
            : wait.kind === "reply"
              ? { replied: false, timedOut: true }
              : { waited: true };
        await this.continueRun(companyId, wait.runId, wait.stepId, result, options.wait ?? false);
      } else {
        await this.start(companyId, task.agentId, task.input, {
          taskId: task.id,
          trigger: "wake",
          triggerRef: reason.kind,
          task: await this.deps.tasks.brief(task, reason),
          wait: options.wait ?? false,
          actor: options.actor,
        });
      }
    } catch (error) {
      // It can't work now (paused, over its budget): keep waiting and look again in an hour.
      if (!(error instanceof RunError)) throw error;
      await this.deps.tasks.update(task.id, { status: "waiting", waitingFor: (wait ?? { kind: "time", since: new Date().toISOString() }) as unknown as Record<string, unknown>, nextCheckAt: new Date(Date.now() + 3_600_000) });
      await this.deps.tasks.record(companyId, task.id, { type: "blocked", message: `Couldn't continue: ${error.message}`, actor: "system" });
    }
    return this.deps.tasks.get(companyId, task.id);
  }

  /** Continue a run held at a wait step (with what happened) or at a step boundary (paused task). */
  private async continueRun(companyId: string, runId: string, stepId: string | undefined, result: unknown, wait: boolean) {
    const run = await this.getRow(companyId, runId);
    if (run.status !== "waiting") return;
    const state = normalizeState(run.context);
    if (stepId && state.pending?.kind === "wait" && state.pending.stepId === stepId) {
      state.steps[stepId] = result;
      state.completed.push(stepId);
      state.pending = undefined;
      const replied = isRecord(result) && result.replied === true;
      await this.emit(runId, { type: "step.completed", stepId, message: replied ? "A reply arrived" : "The wait is over", data: { preview: truncate(stringify(result), 600) } });
    }
    await this.persist(runId, { status: "running", context: state as unknown as Record<string, unknown> });
    const execution = this.execute(runId);
    if (wait) await execution;
  }

  /** Wake every waiting task whose time has come (the scheduler calls this every minute). */
  async wakeDueTasks(now = new Date()): Promise<number> {
    const due = await this.deps.tasks.due(now);
    for (const task of due) {
      const wait = (task.waitingFor ?? {}) as { replyMessageId?: string };
      const reply = wait.replyMessageId ? await this.deps.mail.get(task.companyId, wait.replyMessageId).catch(() => undefined) : undefined;
      await this.wakeTask(task.companyId, task.id, reply ? { kind: "reply", email: MailService.toEmailInput(reply) } : { kind: "time" }).catch((error) =>
        console.error(`[tasks] could not wake ${task.ref}:`, error),
      );
    }
    return due.length;
  }

  /** Hold a task: no wake-ups, and a run working on it holds at its next step. */
  async pauseTask(companyId: string, ref: string, by: string): Promise<TaskRow> {
    const task = await this.deps.tasks.get(companyId, ref);
    if (!["working", "waiting", "needs_person"].includes(task.status)) throw new RunError(`Task ${task.ref} is ${task.status}`, 409);
    const wait = { ...((task.waitingFor ?? {}) as Record<string, unknown>), pausedFrom: task.status };
    await this.deps.tasks.update(task.id, { status: "paused", waitingFor: wait });
    await this.deps.tasks.record(companyId, task.id, { type: "paused", message: `${by} paused the task`, actor: by });
    return this.deps.tasks.get(companyId, task.id);
  }

  /** Pick a paused task up again where it was. */
  async resumeTask(companyId: string, ref: string, by: string, options: { wait?: boolean } = {}): Promise<TaskRow> {
    const task = await this.deps.tasks.get(companyId, ref);
    if (task.status !== "paused") throw new RunError(`Task ${task.ref} is not paused`, 409);
    const { pausedFrom, ...wait } = (task.waitingFor ?? {}) as unknown as Partial<TaskWait> & { pausedFrom?: string; replyMessageId?: string };
    await this.deps.tasks.record(companyId, task.id, { type: "resumed", message: `${by} resumed the task`, actor: by });
    const restored = Object.keys(wait).length ? (wait as unknown as Record<string, unknown>) : null;
    if (pausedFrom === "waiting") {
      // Waits whose time passed meanwhile wake on the next check; one that got its reply, right away.
      await this.deps.tasks.update(task.id, { status: "waiting", waitingFor: restored, ...(wait.replyMessageId ? { nextCheckAt: new Date() } : {}) });
    } else if (pausedFrom === "needs_person") {
      await this.deps.tasks.update(task.id, { status: "needs_person", waitingFor: restored });
      await this.afterDecisions(companyId, task.id);
    } else if (wait.runId) {
      await this.deps.tasks.update(task.id, { status: "working", waitingFor: null });
      await this.continueRun(companyId, wait.runId, undefined, undefined, options.wait ?? false);
    } else {
      await this.deps.tasks.update(task.id, { status: "waiting", waitingFor: null });
      await this.wakeTask(companyId, task.id, { kind: "resumed", by }, { wait: options.wait, actor: by });
    }
    return this.deps.tasks.get(companyId, task.id);
  }

  /**
   * A person handles a work-queue item: answers a question (the task wakes with the answer), checks a
   * Shadow AI employee's work (a "wrong" verdict is kept as a coaching note), retries a failed task, or
   * dismisses a notice.
   */
  async resolveWorkItem(
    companyId: string,
    id: string,
    input: { answer?: string; verdict?: "right" | "wrong"; note?: string; retry?: boolean; dismiss?: boolean },
    by: string,
    options: { wait?: boolean; via?: string } = {},
  ): Promise<WorkItemRow> {
    const item = await this.deps.work.get(companyId, id);
    const record = (type: string, message: string, data: Record<string, unknown> = {}) =>
      item.taskId
        ? this.deps.tasks.record(companyId, item.taskId, { type, message, actor: by, data: { workItemId: item.id, ...(options.via ? { via: options.via } : {}), ...data } })
        : Promise.resolve();
    if (item.kind === "question") {
      const answer = input.dismiss ? "No answer: the question was dismissed" : input.answer?.trim();
      if (!answer) throw new WorkError("Write an answer, or dismiss the question");
      const resolved = await this.deps.work.resolve(companyId, id, { status: input.dismiss ? "dismissed" : "done", answer, by });
      await record("answered", `${by} answered "${truncate(item.title, 120)}": ${truncate(answer, 400)}`);
      if (item.taskId) await this.afterDecisions(companyId, item.taskId);
      return resolved;
    }
    if (item.kind === "review" && !input.dismiss) {
      if (!input.verdict) throw new WorkError("Say whether the work was right or wrong");
      const note = input.note?.trim() || null;
      const resolved = await this.deps.work.resolve(companyId, id, { status: "done", answer: input.verdict === "right" ? "Right" : `Wrong${note ? `: ${note}` : ""}`, by, data: { verdict: input.verdict, note } });
      await record("checked", `${by} checked the work: ${input.verdict}${note ? ` (${note})` : ""}`, { verdict: input.verdict });
      if (input.verdict === "wrong" && item.agentId) {
        // Kept for coaching: the next version of the AI employee learns from it.
        await this.deps.coaching.record(companyId, {
          agentId: item.agentId,
          taskId: item.taskId,
          kind: "check",
          note: note ?? `Marked as wrong: ${item.title}`,
          by,
          data: { workItemId: item.id },
          summary: `${by}: ${note ?? "marked a task as wrong"}`,
        });
      }
      return resolved;
    }
    if (item.kind === "failure" && input.retry) {
      if (!item.taskId) throw new WorkError("There is no task to retry");
      await this.retryTask(companyId, item.taskId, by, options);
      return this.deps.work.get(companyId, id);
    }
    const resolved = await this.deps.work.resolve(companyId, id, { status: input.dismiss ? "dismissed" : "done", by });
    await record("handled", `${by} ${input.dismiss ? "dismissed" : "handled"}: ${truncate(item.title, 160)}`);
    return resolved;
  }

  /** Try a failed task again: its last run continues from the step that failed. */
  async retryTask(companyId: string, ref: string, by: string, options: { wait?: boolean } = {}): Promise<TaskRow> {
    const task = await this.deps.tasks.get(companyId, ref);
    if (task.status !== "failed") throw new RunError(`Task ${task.ref} is ${task.status}, not failed`, 409);
    const run = (await this.deps.tasks.runsOf(task.id)).at(-1);
    if (!run || run.status !== "failed") throw new RunError(`Task ${task.ref} has no failed run to retry`, 409);
    await this.deps.tasks.update(task.id, { status: "working", closedAt: null });
    await this.deps.tasks.record(companyId, task.id, { type: "retried", message: `${by} retried the task`, actor: by, runId: run.id });
    for (const item of await this.deps.work.openFor(task.id, "failure")) await this.deps.work.resolve(companyId, item.id, { status: "done", by, answer: "Retried" });
    await this.persist(run.id, { status: "running", error: null, finishedAt: null });
    await this.emit(run.id, { type: "run.retried", message: `${by} retried from the step that failed` });
    const execution = this.execute(run.id);
    if (options.wait ?? true) await execution;
    return this.deps.tasks.get(companyId, task.id);
  }

  /** End a task for good: its runs are cancelled and its open approvals withdrawn. */
  async stopTask(companyId: string, ref: string, by: string): Promise<TaskRow> {
    const task = await this.deps.tasks.get(companyId, ref);
    if (["done", "stopped", "failed"].includes(task.status)) throw new RunError(`Task ${task.ref} is already ${task.status}`, 409);
    await this.deps.tasks.update(task.id, { status: "stopped", waitingFor: null, nextCheckAt: null, plan: null, closedAt: new Date() });
    for (const run of await this.deps.tasks.runsOf(task.id)) {
      if (["running", "waiting", "waiting_approval", "queued"].includes(run.status)) await this.cancel(companyId, run.id);
    }
    for (const approval of await this.deps.tasks.approvalsOf(task.id, "pending")) {
      await this.deps.handle.db.update(approvals).set({ status: "cancelled", decidedAt: new Date(), decidedBy: by }).where(eq(approvals.id, approval.id));
      this.deps.events?.emit("queue.resolved", { companyId, type: "approval", id: approval.id, by, outcome: "withdrawn: the task was stopped" });
    }
    for (const item of await this.deps.work.openFor(task.id)) {
      await this.deps.work.resolve(companyId, item.id, { status: "dismissed", by, answer: "The task was stopped" });
    }
    await this.deps.tasks.record(companyId, task.id, { type: "stopped", message: `${by} stopped the task`, actor: by });
    return this.deps.tasks.get(companyId, task.id);
  }

  /**
   * After people decided on a task's changes: once nothing is pending, a rejection wakes the AI employee
   * to rethink; otherwise the task follows its plan.
   */
  async afterDecisions(companyId: string, taskId: string) {
    const task = await this.deps.tasks.byId(taskId);
    if (!task || task.status !== "needs_person") return;
    if ((await this.deps.tasks.approvalsOf(taskId, "pending")).length) return;
    if ((await this.deps.work.openFor(taskId, "question")).length) return;
    const runsOfTask = await this.deps.tasks.runsOf(taskId);
    // A workflow run still waiting on its own approval step resumes by itself.
    if (runsOfTask.some((r) => r.status === "waiting_approval" || r.status === "running")) return;
    const latest = runsOfTask.at(-1);
    const since = latest?.startedAt ?? latest?.createdAt ?? new Date(0);
    const decided = (await this.deps.tasks.approvalsOf(taskId)).filter((a) => a.origin === "deferred" && a.decidedAt && a.createdAt >= since);
    const answered = (await this.deps.work.list(companyId, { taskId, kind: "question", statuses: ["done"] })).filter((q) => q.createdAt >= since);
    // Answers and rejections change the picture: the AI employee looks again. Otherwise it follows its plan.
    if (answered.length || decided.some((a) => a.status === "rejected")) {
      await this.wakeTask(companyId, taskId, {
        kind: "decisions",
        decisions: decided.map((a) => ({ title: a.title, approved: a.status === "approved", note: a.decisionNote, decidedBy: a.decidedBy })),
        answers: answered.map((q) => ({ question: q.title, answer: q.answer ?? "", by: q.resolvedBy })),
      });
      return;
    }
    await this.deps.tasks.update(taskId, { status: "working" });
    await this.followPlan({ ...task, status: "working" }, latest?.id ?? null, latest?.output ? outputText(latest.output) : "Done after approval");
  }

  private async fail(run: RunRow, error: unknown, stepId?: string) {
    const message = errorMessage(error);
    await this.persist(run.id, { status: "failed", error: message, finishedAt: new Date() });
    await this.emit(run.id, { type: "run.failed", stepId: stepId ?? null, message });
    if (run.taskId) {
      await this.deps.tasks.update(run.taskId, { status: "failed", nextCheckAt: null, closedAt: new Date() });
      await this.deps.tasks.record(run.companyId, run.taskId, { type: "failed", message: `Failed: ${truncate(message, 300)}`, runId: run.id });
      const task = await this.deps.tasks.byId(run.taskId);
      const agent = await this.deps.agents.find(run.companyId, run.agentId);
      if (task && agent) {
        await this.deps.work.create(run.companyId, {
          kind: "failure",
          title: `${agent.definition.name} couldn't finish: ${task.title}`,
          details: message,
          suggestion: "Fix the cause (a connection, missing data), then retry: it continues from the step that failed.",
          taskId: task.id,
          agentId: agent.row.id,
          departmentId: agent.row.departmentId,
          assigneeUserId: agent.row.managerUserId,
        });
      }
    }
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
    if (run.taskId) {
      const task = await this.deps.tasks.byId(run.taskId);
      if (task && ["working", "waiting", "needs_person", "paused"].includes(task.status)) {
        await this.deps.tasks.update(task.id, { status: "stopped", nextCheckAt: null, waitingFor: null, closedAt: new Date() });
        await this.deps.tasks.record(companyId, task.id, { type: "stopped", message: "Its run was cancelled", runId });
      }
    }
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
    this.deps.events?.emit("queue.added", { companyId, type: "approval", id: approval!.id });
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
    if (approval.status !== "pending") throw new RunError(`Approval is already ${approval.status}${approval.decidedBy ? ` by ${approval.decidedBy}` : ""}`, 409);
    const decidedBy = decision.decidedBy ?? "user";
    // One decision wins: people may decide the same approval at once (in the app, a Teams card, an email).
    const [claimed] = await this.deps.handle.db
      .update(approvals)
      .set({
        status: decision.approved ? "approved" : "rejected",
        decidedBy,
        decisionNote: decision.note ?? null,
        decidedAt: new Date(),
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (!claimed) {
      const current = await this.approvalRow(approvalId);
      throw new RunError(`Approval is already ${current.status}${current.decidedBy ? ` by ${current.decidedBy}` : ""}`, 409);
    }
    if (decision.approved && decision.edits && Object.keys(decision.edits).length) {
      // The person corrected the proposed change: what runs is the corrected version, and the approval shows it.
      const corrected = applyEdits(approval.action as unknown as ApprovalAction, decision.edits);
      await this.deps.handle.db
        .update(approvals)
        .set({ action: { ...(corrected as unknown as Record<string, unknown>), correctedBy: decidedBy } })
        .where(eq(approvals.id, approvalId));
      approval.action = corrected as unknown as Record<string, unknown>;
    }
    await this.deps.activity.record(companyId, {
      actor: decidedBy,
      action: decision.approved ? "approval.approved" : "approval.rejected",
      entityType: "approval",
      entityId: approvalId,
      summary: `${decision.approved ? "Approved" : "Rejected"}${decision.via ? ` in ${VIA_LABELS[decision.via] ?? decision.via}` : ""}: ${approval.title}`,
      data: decision.via ? { via: decision.via } : undefined,
    });
    const action = approval.action as unknown as ApprovalAction;
    const corrected = Boolean(decision.approved && decision.edits && Object.keys(decision.edits).length);
    this.deps.events?.emit("queue.resolved", {
      companyId,
      type: "approval",
      id: approvalId,
      by: decidedBy,
      outcome: corrected ? "corrected and approved" : decision.approved ? "approved" : "rejected",
    });
    if (corrected || (!decision.approved && decision.note?.trim())) {
      // A correction or a reasoned "no" is coaching: kept on the AI employee for its next version.
      const fields = Object.keys(isRecord(decision.edits?.input) ? decision.edits.input : (decision.edits ?? {}));
      const decidedRun = approval.runId ? await this.getRow(companyId, approval.runId).catch(() => undefined) : undefined;
      await this.deps.coaching.record(companyId, {
        agentId: approval.agentId,
        taskId: decidedRun?.taskId ?? null,
        kind: corrected ? "correction" : "rejection",
        note: corrected
          ? `Corrected “${approval.title}” before approving (${fields.join(", ")})${decision.note ? `: ${decision.note}` : ""}`
          : `Rejected “${approval.title}”: ${decision.note}`,
        by: decidedBy,
        summary: corrected
          ? `${decidedBy} corrected “${approval.title}” before approving (${fields.join(", ")})${decision.note ? `: ${decision.note}` : ""}`
          : `${decidedBy} rejected “${approval.title}”: ${decision.note}`,
        data: { approvalId, edits: decision.edits ?? null, note: decision.note ?? null },
      });
    }

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
          result = { approved: decision.approved, note: decision.note ?? "", decidedBy, ...(decision.via ? { via: VIA_LABELS[decision.via] ?? decision.via } : {}) };
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
        const task = run.taskId ? await this.deps.tasks.byId(run.taskId) : undefined;
        if (task) {
          await this.deps.tasks.record(companyId, task.id, {
            type: "decided",
            message: `${decidedBy} ${corrected ? "corrected and approved" : decision.approved ? "approved" : "rejected"}: ${approval.title}${decision.note ? ` (${decision.note})` : ""}`,
            actor: decidedBy,
            runId: run.id,
          });
        }
        if (task?.status === "paused") {
          // Decided while paused: the run holds until the task is resumed.
          await this.persist(run.id, { status: "waiting" });
          await this.deps.tasks.update(task.id, { waitingFor: { ...((task.waitingFor ?? {}) as Record<string, unknown>), pausedFrom: "working", runId: run.id } });
          return this.approvalRow(approvalId);
        }
        if (task) await this.deps.tasks.update(task.id, { status: "working" });
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
    const [run] = approval.runId ? await this.deps.handle.db.select().from(runs).where(eq(runs.id, approval.runId)) : [];
    if (run?.taskId) {
      await this.deps.tasks.record(companyId, run.taskId, {
        type: "decided",
        message: `${decidedBy} ${corrected ? "corrected and approved" : decision.approved ? "approved" : "rejected"}: ${approval.title}${decision.note ? ` (${decision.note})` : ""}`,
        actor: decidedBy,
        runId: run.id,
      });
      await this.afterDecisions(companyId, run.taskId);
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
    override: isRecord(record.override) ? record.override : undefined,
    recorded: isRecord(record.recorded) ? record.recorded : undefined,
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

/** A proposed change with a person's corrections: an email's to/subject/body, or a system action's input fields. */
export function applyEdits(action: ApprovalAction, edits: Record<string, unknown>): ApprovalAction {
  switch (action.type) {
    case "mail.send": {
      const text = (key: string, current: string) => (typeof edits[key] === "string" && (edits[key] as string).trim() ? (edits[key] as string) : current);
      return { ...action, to: text("to", action.to), subject: text("subject", action.subject), body: text("body", action.body) };
    }
    case "connector": {
      const input = isRecord(edits.input) ? edits.input : edits;
      return { ...action, input: { ...action.input, ...input } };
    }
    case "decision":
      return action;
  }
}

const SOURCE_TEXT: Record<string, string> = {
  manual: "New request",
  request: "New request",
  mailbox: "New email",
  schedule: "Scheduled work",
  form: "Form submitted",
  webhook: "Called by another system",
  paperclip: "Assigned in Paperclip",
  "connector-event": "Event in a connected system",
  chat: "Asked in chat",
  teams: "Asked in Microsoft Teams",
  "google-chat": "Asked in Google Chat",
};

/** A task's title: the request's first line, the email's subject, or the AI employee and its input. */
export function taskTitle(definition: AgentDefinition, input: Record<string, unknown>, trigger: string, request?: string): string {
  if (request?.trim()) return truncate(request.trim().split("\n")[0]!.replace(/^#+\s*/, ""), 120);
  const email = isRecord(input.email) ? input.email : undefined;
  if (email && typeof email.subject === "string") return truncate(email.subject || `Email from ${String(email.from ?? "?")}`, 120);
  if (trigger === "schedule") return `${definition.name}: scheduled work`;
  const first = definition.inputs.map((f) => input[f.key]).find((v) => typeof v === "string" && v.trim() && v.length < 200) as string | undefined;
  return truncate(first ? `${definition.name}: ${first.trim()}` : definition.name, 120);
}

/** A short outcome from a run's output: its text, summary or fields. */
function outputText(output: unknown): string {
  if (!isRecord(output)) return "Finished";
  for (const key of ["summary", "text", "result", "answer", "reply"]) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 600);
  }
  // A task that ends with an email: say so in words.
  if (output.sent === true && typeof output.to === "string") {
    return truncate(`Sent “${typeof output.subject === "string" ? output.subject : "an email"}” to ${output.to}${typeof output.approvedBy === "string" ? `, approved by ${output.approvedBy}` : ""}`, 600);
  }
  return truncate(stringify(output), 600) || "Finished";
}

function stepLabel(step: WorkflowStep): string {
  return step.name ?? `${step.id} (${step.type})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
