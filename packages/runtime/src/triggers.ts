import { eq } from "drizzle-orm";
import type { TriggerSpec } from "@enterprise-brain/core";
import { companies, type DatabaseHandle } from "@enterprise-brain/db";
import type { AgentService } from "./agents.ts";
import { RunError, type RunEngine, type RunRow } from "./engine.ts";
import { MailService, type MailMessage } from "./mail.ts";
import type { PeopleService } from "./people.ts";
import type { TaskRow, TaskService } from "./tasks.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
  if (field === "*" || field === "?") return null;
  const values = new Set<number>();
  const toNumber = (token: string) => {
    const lower = token.toLowerCase();
    const named = names?.indexOf(lower) ?? -1;
    if (named >= 0) return named + (min === 1 ? 1 : 0);
    const n = Number(token);
    if (!Number.isInteger(n)) throw new Error(`Invalid cron value "${token}"`);
    return n;
  };
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}"`);
    let start: number;
    let end: number;
    if (range === "*" || range === undefined) {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      start = toNumber(a!);
      end = toNumber(b!);
    } else {
      start = toNumber(range);
      end = stepRaw ? max : start;
    }
    for (let v = start; v <= end; v += step) values.add(max === 6 && v === 7 ? 0 : v);
  }
  return values;
}

function zonedParts(date: Date, timezone?: string) {
  if (!timezone) {
    return { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, weekday: date.getDay() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")) % 24,
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: DAYS.indexOf(get("weekday").slice(0, 3).toLowerCase()),
  };
}

/** Standard 5-field cron (minute hour day-of-month month day-of-week), with names and steps. */
export function cronMatches(expression: string, date: Date, timezone?: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields: "${expression}"`);
  const [minF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const minute = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const month = parseField(monthF, 1, 12, MONTHS);
  const dow = parseField(dowF, 0, 6, DAYS);
  const p = zonedParts(date, timezone);
  if (minute && !minute.has(p.minute)) return false;
  if (hour && !hour.has(p.hour)) return false;
  if (month && !month.has(p.month)) return false;
  // Vixie cron semantics: when both day fields are restricted, either may match.
  if (dom && dow) return dom.has(p.day) || dow.has(p.weekday);
  if (dom && !dom.has(p.day)) return false;
  if (dow && !dow.has(p.weekday)) return false;
  return true;
}

type MailboxTrigger = Extract<TriggerSpec, { type: "mailbox" }>;

export function mailboxTriggerMatches(trigger: MailboxTrigger, message: MailMessage): boolean {
  const mailbox = trigger.mailbox.toLowerCase();
  if (mailbox !== "*" && mailbox !== message.mailbox.toLowerCase()) return false;
  const filter = trigger.filter;
  if (!filter) return true;
  if (filter.hasAttachment !== undefined && filter.hasAttachment !== message.attachments.length > 0) return false;
  if (filter.subjectContains?.length) {
    const subject = message.subject.toLowerCase();
    if (!filter.subjectContains.some((s) => subject.includes(s.toLowerCase()))) return false;
  }
  if (filter.fromDomains?.length) {
    const domain = message.fromAddress.split("@")[1]?.toLowerCase() ?? "";
    if (!filter.fromDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`))) return false;
  }
  return true;
}

/** Starts runs from schedules and inbound mail. */
export class TriggerService {
  private timer: NodeJS.Timeout | undefined;
  private lastTick = "";

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly agents: AgentService,
    private readonly engine: RunEngine,
    private readonly mail: MailService,
    private readonly tasks: TaskService,
    private readonly people?: PeopleService,
  ) {}

  /**
   * Route an inbound message: a reply to a task goes back to that task (waking it); anything else goes
   * to every active AI employee whose mailbox duty matches, as new work.
   */
  async routeInboundMail(companyId: string, message: MailMessage, options: { wait?: boolean } = {}): Promise<RunRow[]> {
    const task = await this.tasks.matchReply(companyId, message);
    if (task && task.status !== "stopped" && task.status !== "failed") {
      await this.replyToTask(companyId, task, message, options);
      return [];
    }
    const forwarded = await this.forwardedToAiEmployee(companyId, message, options);
    if (forwarded !== undefined) return forwarded;
    const active = await this.agents.list(companyId, { status: "active" });
    const started: RunRow[] = [];
    for (const agent of active) {
      const trigger = agent.definition.triggers.find(
        (t): t is MailboxTrigger => t.type === "mailbox" && mailboxTriggerMatches(t, message),
      );
      if (!trigger) continue;
      await this.mail.update(companyId, message.id, { status: "processing" });
      let run: RunRow;
      try {
        run = await this.engine.start(
          companyId,
          agent.row.id,
          { email: MailService.toEmailInput(message) },
          { trigger: "mailbox", triggerRef: message.id, wait: options.wait ?? false },
        );
      } catch (error) {
        // Stopped at its budget (or paused meanwhile): the email stays new, to be handled once it may work again.
        if (error instanceof RunError) {
          await this.mail.update(companyId, message.id, { status: "new" });
          continue;
        }
        throw error;
      }
      await this.mail.update(companyId, message.id, { runId: run.id, status: run.status === "failed" ? "error" : "triaged" });
      started.push(run);
    }
    return started;
  }

  /**
   * An email to the company's AI mailbox gives an AI employee work: "ai+cv-screener@acme.com.tr", or
   * "CV Screener: …" in the subject. Only people with an account can give work this way.
   */
  private async forwardedToAiEmployee(companyId: string, message: MailMessage, options: { wait?: boolean }): Promise<RunRow[] | undefined> {
    const [company] = await this.handle.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const aiMailbox = typeof company?.settings.aiMailbox === "string" ? company.settings.aiMailbox.trim().toLowerCase() : "";
    if (!aiMailbox.includes("@")) return undefined;
    const [local, domain] = aiMailbox.split("@") as [string, string];
    const recipients = [message.mailbox, ...message.toAddresses].map((a) => a.toLowerCase().replace(/^.*</, "").replace(/>.*$/, "").trim());
    const plus = recipients.map((a) => new RegExp(`^${escapeRegExp(local)}\\+([a-z0-9-]+)@${escapeRegExp(domain)}$`).exec(a)?.[1]).find(Boolean);
    if (!plus && !recipients.includes(aiMailbox)) return undefined;

    const agents = await this.agents.list(companyId);
    const agent = plus
      ? agents.find((a) => a.row.slug === plus)
      : agents.find((a) => message.subject.toLowerCase().startsWith(`${a.definition.name.toLowerCase()}:`) || message.subject.toLowerCase().startsWith(`${a.row.slug}:`));
    const sender = this.people ? await this.people.findByEmail(companyId, message.fromAddress) : undefined;
    if (!agent || !sender || sender.status !== "active") {
      await this.mail.update(companyId, message.id, { status: "ignored" });
      return [];
    }
    const stripped = plus ? message.subject.trim() : message.subject.slice(message.subject.indexOf(":") + 1).trim();
    const subject = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    await this.mail.update(companyId, message.id, { status: "processing" });
    try {
      const run = await this.engine.start(companyId, agent.row.id, { email: MailService.toEmailInput(message) }, {
        trigger: "email",
        triggerRef: message.id,
        task: `${sender.name} sent you this email to handle.\n\nSubject: ${subject}\n\n${message.bodyText}`,
        title: subject || `Email from ${sender.name}`,
        requestedBy: sender.name,
        actor: `${sender.name} <${sender.email}>`,
        wait: options.wait ?? false,
      });
      if (run.taskId) await this.tasks.linkMail(companyId, message.id, run.taskId);
      await this.mail.update(companyId, message.id, { runId: run.id, status: "triaged" });
      return [run];
    } catch (error) {
      if (!(error instanceof RunError)) throw error;
      await this.mail.update(companyId, message.id, { status: "new" });
      return [];
    }
  }

  private async replyToTask(companyId: string, task: TaskRow, message: MailMessage, options: { wait?: boolean }) {
    await this.tasks.linkMail(companyId, message.id, task.id);
    await this.mail.update(companyId, message.id, { status: "triaged" });
    await this.tasks.record(companyId, task.id, {
      type: "email",
      message: `Reply from ${message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}: ${message.subject}`,
      actor: message.fromAddress,
      data: { mailId: message.id },
    });
    if (task.status === "waiting" || task.status === "done") {
      await this.engine.wakeTask(companyId, task.id, { kind: "reply", email: MailService.toEmailInput(message) }, { wait: options.wait ?? false });
      return;
    }
    // Busy, waiting on a person, or paused: keep the reply; the task wakes with it as soon as it can.
    const wait = { ...((task.waitingFor ?? {}) as Record<string, unknown>), replyMessageId: message.id };
    await this.tasks.update(task.id, { waitingFor: wait, ...(task.status === "paused" ? {} : { nextCheckAt: new Date() }) });
  }

  /** Run every schedule trigger that matches the given minute (called once per minute). */
  async tick(now = new Date()): Promise<RunRow[]> {
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey === this.lastTick) return [];
    this.lastTick = minuteKey;
    // Tasks whose follow-up time came, or whose reply didn't come in time.
    await this.engine.wakeDueTasks(now).catch((error) => console.error("[tasks]", error));
    const started: RunRow[] = [];
    const companyRows = await this.handle.db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const active = await this.agents.list(company.id, { status: "active" });
      for (const agent of active) {
        for (const trigger of agent.definition.triggers) {
          if (trigger.type !== "schedule") continue;
          let due = false;
          try {
            due = cronMatches(trigger.cron, now, trigger.timezone);
          } catch {
            continue;
          }
          if (!due) continue;
          try {
            started.push(await this.engine.start(company.id, agent.row.id, {}, { trigger: "schedule", triggerRef: trigger.cron, wait: false }));
          } catch (error) {
            // One AI employee that can't start (budget reached) doesn't hold up the others' schedules.
            if (!(error instanceof RunError)) throw error;
          }
        }
      }
    }
    return started;
  }

  start(intervalMs = 20_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error("[scheduler]", error));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async companyExists(companyId: string): Promise<boolean> {
    const [row] = await this.handle.db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    return Boolean(row);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
