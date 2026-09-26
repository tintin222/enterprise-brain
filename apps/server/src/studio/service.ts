import { and, asc, desc, eq, gt } from "drizzle-orm";
import {
  AppSpec,
  AskItInput,
  AskPersonInput,
  EmployeeSpec,
  LookAtInput,
  RemoveInput,
  STUDIO_TOOLS,
  TableSpec,
  TryInput,
  abilitiesOf,
  compileEmployee,
  employeeCard,
  plainApp,
  proposeApp,
  settle,
  studioSystemPrompt,
  type CompileContext,
  type StudioQuestion,
  type StudioSystem,
} from "@enterprise-brain/builder";
import { sandboxConnectorFor } from "@enterprise-brain/connectors";
import { AppDesign, describeDuties, isRecord, slugify, truncate, type TableField } from "@enterprise-brain/core";
import { studioEvents, studioThreads } from "@enterprise-brain/db";
import { extractDocument } from "@enterprise-brain/documents";
import {
  addUsage,
  emptyUsage,
  type LlmUsage,
  type MessageParam,
  type ToolCall,
  type ToolDefinition,
  type ToolExecution,
  type ToolResultParam,
} from "@enterprise-brain/llm";
import { MailService, workingHoursOf, type Platform, type TableView } from "@enterprise-brain/runtime";
import { canBuildFor, rulesOf } from "../auth/building.ts";
import { actorOf, canSeeDepartment, type Viewer } from "../auth/viewer.ts";
import { HttpError } from "../http.ts";
import { personalDataAfterDesign } from "../routes/building.ts";

/**
 * The Studio as an agent, on the server: conversations kept in the database, each turn a tool loop
 * of Claude over the Studio's tools (packages/builder/src/studio-agent.ts), run in the background
 * while the page follows its events. Parts are real but not at work: AI employees are drafts, tables
 * are kept out of the department's list, apps are planned; putting the solution to work makes them live.
 */

type ThreadRow = typeof studioThreads.$inferSelect;

export class StudioError extends HttpError {
  constructor(message: string, status = 400) {
    super(status, message);
    this.name = "StudioError";
  }
}

interface TryRecord {
  key: string;
  runId: string;
  status: string;
  example: string;
  outcome: string;
  at: string;
}

/** What a conversation made so far. */
export interface SolutionState {
  employees: { key: string; agentId: string; spec: EmployeeSpec; notes: string[] }[];
  tables: { key: string; tableId: string }[];
  apps: { key: string; spec: AppSpec; design: Record<string, unknown>; notes: string[] }[];
  requests: { workItemId: string; system: string; needed: string; for?: string }[];
  tries: TryRecord[];
  files: { id: string; name: string }[];
  built?: { employees: string[]; tables: string[]; apps: string[]; at: string };
}

/** What the Studio waits on: its question, and the results of the turn's other tools. */
interface Pending {
  call: ToolCall;
  results: ToolResultParam[];
  questions: StudioQuestion[];
  /** The person stopped the turn: their next message says why. */
  stopped?: boolean;
}

export interface StudioEventView {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
  at: string;
}

/** Per turn: the questions asked so far, and whether the person stopped it. */
interface Turn {
  asked: StudioQuestion[];
  stop: boolean;
}

const MAX_TURNS = 30;
/** A conversation's model calls stop here and ask to carry on. */
const TOOL_NAMES = new Set(STUDIO_TOOLS.map((t) => t.name));

function emptySolution(): SolutionState {
  return { employees: [], tables: [], apps: [], requests: [], tries: [], files: [] };
}

function solutionOf(row: ThreadRow): SolutionState {
  return { ...emptySolution(), ...(row.solution as Partial<SolutionState>) };
}

function ownerOf(row: ThreadRow): Viewer {
  return row.owner as unknown as Viewer;
}

function json(value: unknown, max = 30_000): string {
  const text = JSON.stringify(value, null, 1);
  return text.length > max ? `${text.slice(0, max)}\n…(cut)` : text;
}

function problem(text: string): ToolExecution {
  return { content: text, isError: true };
}

export class StudioService {
  /** Turns running in this process, by conversation. */
  private readonly running = new Map<string, { turn: Turn; done: Promise<void> }>();

  constructor(private readonly platform: Platform) {}

  private get db() {
    return this.platform.handle.db;
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  async start(companyId: string, viewer: Viewer, input: { text: string; departmentId?: string | null; fileIds?: string[] }): Promise<ThreadRow> {
    if (!this.platform.llm.available) throw new StudioError("The Studio agent works with Claude: without it, use the guided interview", 409);
    const text = input.text.trim();
    if (!text) throw new StudioError("Say what you need");
    const company = await this.platform.company(companyId);
    if (!company) throw new StudioError("No such company", 404);
    const departments = await this.platform.catalog.departments(companyId);
    const department = input.departmentId ? departments.find((d) => d.id === input.departmentId || d.key === input.departmentId) : undefined;
    if (input.departmentId && !department) throw new StudioError("No such department", 404);
    const person = viewer.userId ? await this.platform.people.get(companyId, viewer.userId).catch(() => undefined) : undefined;
    const system = studioSystemPrompt({
      company: company.name,
      person: {
        name: viewer.name,
        title: person?.title ?? null,
        admin: viewer.isAdmin,
        departments: viewer.departments.map((d) => ({ name: d.name, role: d.role })),
      },
      ...(department ? { department: { key: department.key, name: department.name } } : {}),
    });
    const [row] = await this.db
      .insert(studioThreads)
      .values({
        companyId,
        title: truncate(text.replace(/\s+/g, " "), 80),
        owner: viewer as unknown as Record<string, unknown>,
        ownerId: viewer.userId,
        departmentId: department?.id ?? null,
        status: "idle",
        // The instructions and tools stay as written for the whole conversation.
        setup: { system, tools: STUDIO_TOOLS },
        messages: [],
        solution: emptySolution() as unknown as Record<string, unknown>,
      })
      .returning();
    await this.send(companyId, row!.id, viewer, { text, fileIds: input.fileIds });
    return this.row(companyId, row!.id);
  }

  async list(companyId: string, viewer: Viewer) {
    const rows = await this.db.select().from(studioThreads).where(eq(studioThreads.companyId, companyId)).orderBy(desc(studioThreads.updatedAt)).limit(100);
    return rows
      .filter((r) => viewer.isAdmin || r.ownerId === viewer.userId)
      .map((r) => {
        const solution = solutionOf(r);
        return {
          id: r.id,
          title: r.title,
          status: this.statusOf(r),
          owner: ownerOf(r).name,
          parts: solution.employees.length + solution.tables.length + solution.apps.length,
          builtAt: r.builtAt,
          updatedAt: r.updatedAt,
        };
      });
  }

  async row(companyId: string, id: string): Promise<ThreadRow> {
    const [row] = await this.db
      .select()
      .from(studioThreads)
      .where(and(eq(studioThreads.companyId, companyId), eq(studioThreads.id, id)));
    if (!row) throw new StudioError("No such conversation", 404);
    return row;
  }

  /** A conversation the viewer may see: theirs, or any for IT. */
  async mine(companyId: string, id: string, viewer: Viewer): Promise<ThreadRow> {
    const row = await this.row(companyId, id);
    if (!viewer.isAdmin && row.ownerId !== viewer.userId) throw new StudioError("This conversation is someone else's", 403);
    return row;
  }

  /** Working, as far as this process knows: a turn left "working" by a restart is over. */
  private statusOf(row: ThreadRow): string {
    return row.status === "working" && !this.running.has(row.id) ? "interrupted" : row.status;
  }

  async view(companyId: string, id: string, viewer: Viewer, after = 0) {
    const row = await this.mine(companyId, id, viewer);
    const events = await this.db
      .select()
      .from(studioEvents)
      .where(and(eq(studioEvents.threadId, id), gt(studioEvents.seq, after)))
      .orderBy(asc(studioEvents.seq));
    const pending = row.pending as Pending | null;
    const solution = solutionOf(row);
    return {
      id: row.id,
      title: row.title,
      status: this.statusOf(row),
      error: row.error,
      owner: ownerOf(row).name,
      departmentId: row.departmentId,
      questions: pending && !pending.stopped ? pending.questions : [],
      solution: await this.solutionView(companyId, solution),
      built: solution.built ?? null,
      usage: row.usage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      events: events.map((e): StudioEventView => ({ seq: e.seq, kind: e.kind, data: e.data, at: e.createdAt.toISOString() })),
    };
  }

  /** The person's message: an answer to the Studio's questions, or what they say next. */
  async send(companyId: string, id: string, viewer: Viewer, input: { text: string; fileIds?: string[] }): Promise<void> {
    const row = await this.mine(companyId, id, viewer);
    if (this.running.has(id)) throw new StudioError("The Studio is still working: wait for it, or stop it", 409);
    if (row.builtAt) throw new StudioError("This solution is at work: change it from its parts' pages, or start a new conversation", 409);
    const text = input.text.trim();
    if (!text) throw new StudioError("Say something");
    const solution = solutionOf(row);
    const files: { id: string; name: string }[] = [];
    for (const fileId of input.fileIds ?? []) {
      const file = await this.platform.files.get(companyId, fileId).catch(() => undefined);
      if (!file) throw new StudioError(`No such file: ${fileId}`, 404);
      files.push({ id: fileId, name: file.name });
    }
    solution.files.push(...files);
    const said = files.length ? `${text}\n\n(Files added: ${files.map((f) => `${f.name} [id ${f.id}]`).join(", ")})` : text;
    const pending = row.pending as Pending | null;
    let next: MessageParam;
    if (pending) {
      const answer = pending.stopped ? `The person stopped you here, and says: ${said}` : pending.questions.length ? `The person answered:\n${said}` : said;
      next = { role: "user", content: [...pending.results, { type: "tool_result", tool_use_id: pending.call.id, content: answer }] };
    } else {
      next = { role: "user", content: said };
    }
    await this.db
      .update(studioThreads)
      .set({
        owner: viewer as unknown as Record<string, unknown>,
        pending: null,
        status: "working",
        error: null,
        solution: solution as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(studioThreads.id, id));
    await this.event(id, pending && !pending.stopped && pending.questions.length ? "answer" : "user", { text, files });
    const turn: Turn = { asked: [], stop: false };
    const done = this.runTurn(companyId, id, viewer, next, turn).finally(() => this.running.delete(id));
    this.running.set(id, { turn, done });
  }

  /** Stop the turn at the next tool: the Studio waits for the person's next message. */
  async stop(companyId: string, id: string, viewer: Viewer): Promise<void> {
    await this.mine(companyId, id, viewer);
    const running = this.running.get(id);
    if (running) running.turn.stop = true;
    else
      await this.db
        .update(studioThreads)
        .set({ status: "idle" })
        .where(and(eq(studioThreads.id, id), eq(studioThreads.status, "working")));
  }

  /** For tests and shutdown: the turn running now, if any. */
  async idle(id: string): Promise<void> {
    await this.running.get(id)?.done;
  }

  private async event(threadId: string, kind: string, data: Record<string, unknown>): Promise<void> {
    // One writer per conversation (its turn), so the next number is safe to take.
    const [last] = await this.db
      .select({ seq: studioEvents.seq })
      .from(studioEvents)
      .where(eq(studioEvents.threadId, threadId))
      .orderBy(desc(studioEvents.seq))
      .limit(1);
    await this.db.insert(studioEvents).values({ threadId, seq: (last?.seq ?? 0) + 1, kind, data });
  }

  private async saveSolution(threadId: string, solution: SolutionState): Promise<void> {
    await this.db
      .update(studioThreads)
      .set({ solution: solution as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(studioThreads.id, threadId));
  }

  private async runTurn(companyId: string, id: string, viewer: Viewer, next: MessageParam, turn: Turn): Promise<void> {
    const row = await this.row(companyId, id);
    const setup = row.setup as { system: string; tools: ToolDefinition[] };
    const messages = [...(row.messages as MessageParam[]), next];
    let usage: LlmUsage = emptyUsage();
    try {
      const result = await this.platform.llm.runTools({
        purpose: "studio.agent",
        system: setup.system,
        messages,
        tools: setup.tools,
        maxTurns: MAX_TURNS,
        effort: "medium",
        executeTool: (call) => this.execute(companyId, id, viewer, call, turn),
        onEvent: async (event) => {
          if (event.type === "assistant" && event.toolCalls.length && event.text.trim()) await this.event(id, "note", { text: event.text.trim() });
        },
      });
      usage = result.usage;
      const history = result.messages.length >= messages.length ? result.messages : messages;
      const previous = (row.usage ?? {}) as Partial<LlmUsage>;
      const total = addUsage({ ...emptyUsage(), ...previous }, usage);
      if (result.stopped) {
        const pending: Pending = {
          call: result.stopped.call,
          results: result.stopped.results,
          questions: turn.stop ? [] : turn.asked,
          ...(turn.stop ? { stopped: true } : {}),
        };
        await this.db
          .update(studioThreads)
          .set({
            messages: history,
            pending: pending as unknown as Record<string, unknown>,
            status: turn.stop ? "idle" : "asking",
            usage: total as unknown as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(studioThreads.id, id));
        await this.event(id, turn.stop ? "stopped" : "question", turn.stop ? {} : { questions: turn.asked });
        return;
      }
      await this.db
        .update(studioThreads)
        .set({ messages: history, pending: null, status: "idle", usage: total as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(studioThreads.id, id));
      if (result.stopReason === "max_turns") {
        await this.event(id, "said", { text: "That was a lot of work in one go, so I've paused here. Say “carry on” and I'll continue." });
      } else if (result.text.trim()) {
        await this.event(id, "said", { text: result.text.trim() });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.update(studioThreads).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(studioThreads.id, id));
      await this.event(id, "error", { text: message });
    }
  }

  // -------------------------------------------------------------------------
  // The tools
  // -------------------------------------------------------------------------

  private async execute(companyId: string, id: string, viewer: Viewer, call: ToolCall, turn: Turn): Promise<ToolExecution> {
    if (turn.stop) return { content: "The person stopped you. Wait for their message.", stop: true };
    if (!TOOL_NAMES.has(call.name)) return problem(`There is no tool called ${call.name}.`);
    const input = isRecord(call.input) ? call.input : {};
    try {
      switch (call.name) {
        case "look_around":
          return await this.lookAround(companyId, id, viewer);
        case "read_mailbox":
          return await this.readMailbox(companyId, id, viewer, input);
        case "read_email":
          return await this.readEmail(companyId, id, viewer, input);
        case "read_file":
          return await this.readFile(companyId, id, input);
        case "look_at":
          return await this.lookAt(companyId, id, viewer, input);
        case "search_knowledge":
          return await this.searchKnowledge(companyId, id, input);
        case "ask_person": {
          const parsed = AskPersonInput.safeParse(input);
          if (!parsed.success) return problem(`Ask one to three questions: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
          turn.asked.push(...parsed.data.questions);
          return { content: "The questions are shown to the person; the conversation waits for the answer.", stop: true };
        }
        case "ask_it":
          return await this.askIt(companyId, id, viewer, input);
        case "save_table":
          return await this.saveTable(companyId, id, viewer, input);
        case "save_ai_employee":
          return await this.saveEmployee(companyId, id, viewer, input);
        case "save_app":
          return await this.saveApp(companyId, id, viewer, input);
        case "try_ai_employee":
          return await this.tryEmployee(companyId, id, viewer, input);
        case "remove":
          return await this.remove(companyId, id, input);
        default:
          return problem(`There is no tool called ${call.name}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.event(id, "step", { tool: call.name, text: `Couldn't ${verbOf(call.name)}: ${truncate(message, 200)}`, ok: false });
      return problem(message);
    }
  }

  private async step(id: string, tool: string, text: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.event(id, "step", { tool, text, ok: true, ...data });
  }

  /** The systems AI employees may use: connections with actions, and demo systems where none is connected. */
  private async systems(companyId: string): Promise<StudioSystem[]> {
    const out: StudioSystem[] = [];
    const taken = new Set<string>();
    const connected = new Set<string>();
    for (const instance of await this.platform.connectors.list(companyId)) {
      if (instance.type === "tables" || ["mail", "messaging"].includes(instance.category)) continue;
      const operations = await this.platform.connectors.operationsOf(companyId, instance.id).catch(() => []);
      if (!operations.length) continue;
      let key = slugify(instance.name, 40);
      for (let n = 2; taken.has(key); n++) key = `${slugify(instance.name, 36)}-${n}`;
      taken.add(key);
      if (!instance.sandbox) connected.add(instance.category);
      out.push({
        key,
        name: instance.name,
        category: instance.category,
        instanceId: instance.id,
        demo: instance.sandbox,
        actions: operations.map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
      });
    }
    for (const category of ["erp", "crm", "hris", "ats", "itsm", "calendar"]) {
      if (connected.has(category)) continue;
      const type = sandboxConnectorFor(category);
      const impl = type ? this.platform.connectors.registry.get(type) : undefined;
      if (!impl) continue;
      out.push({
        key: `demo-${category}`,
        name: impl.manifest.name,
        category,
        demo: true,
        actions: impl.manifest.operations.map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
      });
    }
    return out;
  }

  private async compileContext(companyId: string, slug?: string): Promise<CompileContext> {
    const [departments, tables, systems, collections, mailboxes, company] = await Promise.all([
      this.platform.catalog.departments(companyId),
      this.platform.tables.list(companyId),
      this.systems(companyId),
      this.platform.knowledge.listCollections(companyId),
      this.platform.mail.mailboxes(companyId),
      this.platform.company(companyId),
    ]);
    return {
      departments: departments.map((d) => ({ id: d.id, key: d.key, name: d.name })),
      tables: tables.map((t) => ({ key: t.key, name: t.name, fields: t.fields })),
      tablesConnectionId: tables.length ? await this.platform.tables.connectionId(companyId) : undefined,
      systems,
      collections: collections.map((c) => c.key),
      mailboxes: mailboxes.map((m) => m.mailbox),
      timeZone: workingHoursOf(company?.settings ?? {}).timeZone,
      ...(slug ? { slug } : {}),
    };
  }

  private async lookAround(companyId: string, id: string, viewer: Viewer): Promise<ToolExecution> {
    const thread = await this.row(companyId, id);
    const solution = solutionOf(thread);
    const rules = rulesOf((await this.platform.company(companyId))!);
    const [departments, people, agents, tables, apps, systems, mailboxes, collections, company] = await Promise.all([
      this.platform.catalog.departments(companyId),
      this.platform.people.list(companyId),
      this.platform.agents.list(companyId),
      this.platform.tables.list(companyId),
      this.platform.apps.list(companyId),
      this.systems(companyId),
      this.platform.mail.mailboxes(companyId),
      this.platform.knowledge.listCollections(companyId),
      this.platform.company(companyId),
    ]);
    const keyOf = new Map(departments.map((d) => [d.id, d.key]));
    const zone = workingHoursOf(company?.settings ?? {}).timeZone;
    const manages = viewer.isAdmin || viewer.departments.some((d) => d.role === "manager");
    const followers = (mailbox: string) =>
      agents
        .filter((a) => a.row.status !== "archived" && a.definition.triggers.some((t) => t.type === "mailbox" && t.mailbox.toLowerCase() === mailbox))
        .map((a) => a.definition.name);
    const requests = await Promise.all(
      solution.requests.map(async (r) => {
        const item = await this.platform.work.get(companyId, r.workItemId).catch(() => undefined);
        return { system: r.system, needed: r.needed, status: item?.status === "done" ? "answered" : (item?.status ?? "open"), answer: item?.answer ?? null };
      }),
    );
    const overview = {
      today: new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date()),
      time_zone: zone,
      you_build_for: departments.filter((d) => canBuildFor(viewer, d.id, rules)).map((d) => d.key),
      you_hire_for: departments
        .filter((d) => viewer.isAdmin || viewer.departments.some((m) => m.departmentId === d.id && m.role === "manager"))
        .map((d) => d.key),
      departments: departments.map((d) => {
        const members = people.filter((p) => p.status === "active" && p.departments.some((m) => m.departmentId === d.id));
        return {
          key: d.key,
          name: d.name,
          people: members.length,
          managers: members.filter((p) => p.departments.some((m) => m.departmentId === d.id && m.role === "manager")).map((p) => p.name),
        };
      }),
      ai_employees: agents
        .filter((a) => a.row.status !== "archived" && canSeeDepartment(viewer, a.row.departmentId))
        .map((a) => ({
          key: a.row.slug,
          name: a.definition.name,
          department: a.row.departmentId ? (keyOf.get(a.row.departmentId) ?? null) : null,
          status: a.row.status,
          does: a.definition.summary,
          duties: describeDuties(a.definition.triggers).map((d) => d.text),
          ...(solution.employees.some((e) => e.agentId === a.row.id) ? { made_here: true } : {}),
        })),
      tables: tables
        .filter((t) => canSeeDepartment(viewer, t.departmentId))
        .map((t) => ({
          key: t.key,
          name: t.name,
          department: t.departmentId ? (keyOf.get(t.departmentId) ?? null) : null,
          records: t.records,
          fields: t.fields.map((f) => `${f.label} (${f.type})`),
          ...(solution.tables.some((s) => s.tableId === t.id) ? { made_here: true } : {}),
        })),
      apps: [
        ...apps.filter((a) => canSeeDepartment(viewer, a.departmentId)).map((a) => ({ key: a.key, name: a.name, shows: a.tables })),
        ...solution.apps.map((a) => ({ key: a.key, name: a.spec.name, shows: a.spec.tables, planned_here: true })),
      ],
      systems: systems.map((s) => ({
        key: s.key,
        name: s.name,
        kind: s.demo ? "demo, until IT connects the real one" : "connected",
        category: s.category,
        actions: s.actions.length,
      })),
      mailboxes: manages
        ? mailboxes.map((m) => ({ address: m.mailbox, emails: m.total, followed_by: followers(m.mailbox) }))
        : "Only managers and IT see the mailboxes",
      knowledge: collections.map((c) => ({ key: c.key, name: c.name, documents: c.documentCount })),
      requests_to_it: requests,
      files_added_here: solution.files,
    };
    await this.step(id, "look_around", "Looked at the company");
    return { content: json(overview) };
  }

  private async readMailbox(companyId: string, id: string, viewer: Viewer, input: Record<string, unknown>): Promise<ToolExecution> {
    const mailbox = String(input.mailbox ?? "")
      .trim()
      .toLowerCase();
    if (!mailbox) return problem("Say which mailbox.");
    if (!viewer.isAdmin && !viewer.departments.some((d) => d.role === "manager")) return problem("Only managers and IT read the mailboxes.");
    const limit = Math.min(40, Math.max(1, Number(input.limit) || 15));
    const messages = await this.platform.mail.list(companyId, { mailbox, direction: "inbound", limit });
    await this.step(
      id,
      "read_mailbox",
      messages.length ? `Read ${messages.length} email${messages.length === 1 ? "" : "s"} in ${mailbox}` : `Found no email in ${mailbox} yet`,
    );
    return {
      content: json({
        mailbox,
        emails: messages.map((m) => ({
          id: m.id,
          from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
          subject: m.subject,
          received: m.receivedAt.toISOString(),
          attachments: m.attachments.map((a) => a.name),
          status: m.status,
          text: truncate(m.bodyText.replace(/\s+/g, " ").trim(), 300),
        })),
      }),
    };
  }

  private async readEmail(companyId: string, id: string, viewer: Viewer, input: Record<string, unknown>): Promise<ToolExecution> {
    if (!viewer.isAdmin && !viewer.departments.some((d) => d.role === "manager")) return problem("Only managers and IT read the mailboxes.");
    const message = await this.platform.mail.get(companyId, String(input.id ?? ""));
    const attachments = [];
    for (const a of message.attachments.slice(0, 4)) {
      const text = await this.fileText(companyId, a.fileId).catch((e: unknown) => `(could not read it: ${e instanceof Error ? e.message : String(e)})`);
      attachments.push({ name: a.name, file_id: a.fileId, text: truncate(text, 8000) });
    }
    await this.step(id, "read_email", `Read “${truncate(message.subject || "(no subject)", 80)}”`);
    return {
      content: json({
        id: message.id,
        mailbox: message.mailbox,
        from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
        to: message.toAddresses,
        subject: message.subject,
        received: message.receivedAt.toISOString(),
        text: truncate(message.bodyText, 12_000),
        attachments,
      }),
    };
  }

  private async fileText(companyId: string, fileId: string): Promise<string> {
    const file = await this.platform.files.get(companyId, fileId);
    const doc = await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType }, { llm: this.platform.llm });
    return doc.text;
  }

  private async readFile(companyId: string, id: string, input: Record<string, unknown>): Promise<ToolExecution> {
    const solution = solutionOf(await this.row(companyId, id));
    const fileId = String(input.id ?? "");
    const file = solution.files.find((f) => f.id === fileId);
    if (!file) return problem("That file wasn't added to this conversation.");
    const text = await this.fileText(companyId, fileId);
    await this.step(id, "read_file", `Read ${file.name}`);
    return { content: `${file.name}\n\n${truncate(text, 30_000)}` };
  }

  private async lookAt(companyId: string, id: string, viewer: Viewer, raw: Record<string, unknown>): Promise<ToolExecution> {
    const input = LookAtInput.parse(raw);
    if (input.kind === "ai_employee") {
      const agent = await this.platform.agents.find(companyId, input.key);
      if (!agent || !canSeeDepartment(viewer, agent.row.departmentId)) return problem(`There is no AI employee "${input.key}" you can see.`);
      await this.step(id, "look_at", `Looked at ${agent.definition.name}`);
      return {
        content: json({
          key: agent.row.slug,
          name: agent.definition.name,
          status: agent.row.status,
          level: agent.row.probation,
          does: agent.definition.summary,
          duties: describeDuties(agent.definition.triggers).map((d) => d.text),
          may_use: abilitiesOf(agent.definition),
          asks_approval_for: agent.definition.guardrails.approvalRequiredFor,
          job: truncate(agent.definition.instructions, 12_000),
          fixed_steps: agent.definition.workflow.map((s) => s.name ?? s.id),
        }),
      };
    }
    if (input.kind === "table") {
      const table = await this.platform.tables.get(companyId, input.key).catch(() => undefined);
      if (!table || !canSeeDepartment(viewer, table.departmentId)) return problem(`There is no table "${input.key}" you can see.`);
      const { records } = await this.platform.tables.records(companyId, table.key, { limit: 5 });
      await this.step(id, "look_at", `Looked at ${table.name}`);
      return {
        content: json({
          key: table.key,
          name: table.name,
          description: table.description,
          records: table.records,
          fields: table.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            ...(f.choices ? { choices: f.choices } : {}),
            ...(f.required ? { required: true } : {}),
            ...(f.personal ? { personal: true } : {}),
          })),
          latest: records.map((r) => ({ number: r.number, ...r.values })),
        }),
      };
    }
    const system = (await this.systems(companyId)).find((s) => s.key === input.key);
    if (!system) return problem(`There is no system "${input.key}"; see look_around.`);
    const operations = system.instanceId
      ? await this.platform.connectors.operationsOf(companyId, system.instanceId)
      : (this.platform.connectors.registry.get(sandboxConnectorFor(system.category) ?? "")?.manifest.operations ?? []);
    await this.step(id, "look_at", `Looked at ${system.name}`);
    return {
      content: json({
        key: system.key,
        name: system.name,
        kind: system.demo ? "demo, until IT connects the real one" : "connected",
        actions: operations.map((o) => ({
          id: o.id,
          name: o.name,
          does: o.description,
          changes_something: o.kind === "write",
          ...(o.requiresApproval ? { always_approved_by_a_person: true } : {}),
          takes: Object.keys((o.input as { properties?: Record<string, unknown> }).properties ?? {}),
        })),
      }),
    };
  }

  private async searchKnowledge(companyId: string, id: string, input: Record<string, unknown>): Promise<ToolExecution> {
    const query = String(input.query ?? "").trim();
    if (!query) return problem("Say what to look for.");
    const hits = await this.platform.knowledge.search(companyId, query, { topK: 5 });
    await this.step(id, "search_knowledge", `Searched the knowledge for “${truncate(query, 60)}”`);
    return { content: json(hits.map((h) => ({ title: h.title, collection: h.collectionKey, text: truncate(h.content.replace(/\s+/g, " "), 800) }))) };
  }

  private async askIt(companyId: string, id: string, viewer: Viewer, raw: Record<string, unknown>): Promise<ToolExecution> {
    const input = AskItInput.parse(raw);
    const departments = await this.platform.catalog.departments(companyId);
    const it = departments.find((d) => d.key === "it");
    const item = await this.platform.work.create(companyId, {
      kind: "question",
      title: `For the Studio: ${input.system}: ${input.needed}`,
      details: [
        `${viewer.name} is building${input.for ? ` ${input.for}` : " an AI employee"} in the Studio. ${input.why}`,
        "",
        `Needed in ${input.system}: ${input.needed}`,
      ].join("\n"),
      reason: "A request to IT from the Studio",
      options: ["Done: it's connected", "Not possible"],
      departmentId: it?.id ?? null,
      data: { studio: id },
    });
    const thread = await this.row(companyId, id);
    const solution = solutionOf(thread);
    solution.requests.push({ workItemId: item.id, system: input.system, needed: input.needed, ...(input.for ? { for: input.for } : {}) });
    await this.saveSolution(id, solution);
    await this.event(id, "request", { system: input.system, needed: input.needed, workItemId: item.id });
    return { content: `Asked IT: “${item.title}”. The answer will show in look_around under requests_to_it. Tell the person.` };
  }

  private async departmentFor(companyId: string, thread: ThreadRow, key: string | undefined) {
    const departments = await this.platform.catalog.departments(companyId);
    const department = key ? departments.find((d) => d.key === key || d.id === key) : departments.find((d) => d.id === thread.departmentId);
    if (key && !department) throw new StudioError(`There is no department "${key}"; use a key from look_around.`);
    return department;
  }

  private async saveTable(companyId: string, id: string, viewer: Viewer, raw: Record<string, unknown>): Promise<ToolExecution> {
    const parsed = TableSpec.safeParse(raw);
    if (!parsed.success) return problem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const spec = parsed.data;
    const thread = await this.row(companyId, id);
    const solution = solutionOf(thread);
    const company = (await this.platform.company(companyId))!;
    const rules = rulesOf(company);
    const department = await this.departmentFor(companyId, thread, spec.department);
    if (!department) return problem("Say which department keeps it (its key).");
    if (!canBuildFor(viewer, department.id, rules))
      return problem(`${viewer.name} doesn't build for ${department.name}. They build for: see you_build_for in look_around.`);
    const existing = await this.platform.tables.list(companyId);
    const notes: string[] = [];
    const drafts: Omit<TableField, "key">[] = spec.fields.map((f) => ({
      label: f.label,
      type: f.type,
      ...(f.choices?.length ? { choices: f.choices } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.personal ? { personal: true } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(f.description ? { description: f.description } : {}),
    }));
    const mine = spec.key ? solution.tables.find((t) => t.key === spec.key) : undefined;
    if (spec.key && !mine) return problem(`You didn't make "${spec.key}" in this conversation: tables in use are changed from their page.`);
    let table: TableView;
    const others = existing.filter((t) => t.id !== mine?.tableId).map((t) => ({ key: t.key, name: t.name, fields: t.fields }));
    const fields = settle(drafts, others, notes);
    // Fields that keep their label keep their key, so records and AI employees keep working.
    if (mine) {
      const before = await this.platform.tables.get(companyId, mine.tableId);
      for (const field of fields) {
        const same = before.fields.find((f) => f.label.toLocaleLowerCase("tr") === field.label.toLocaleLowerCase("tr"));
        if (same && !fields.some((f) => f !== field && f.key === same.key)) field.key = same.key;
      }
    }
    const titleField = spec.title_field ? fields.find((f) => f.label.toLocaleLowerCase("tr") === spec.title_field!.toLocaleLowerCase("tr"))?.key : undefined;
    if (mine) {
      table = await this.platform.tables.change(companyId, mine.tableId, {
        name: spec.name,
        description: spec.description ?? "",
        fields,
        ...(titleField ? { titleField } : {}),
        departmentId: department.id,
        by: viewer.name,
        note: "Changed in the Studio",
      });
    } else {
      table = await this.platform.tables.create(
        companyId,
        {
          name: spec.name,
          description: spec.description ?? "",
          fields,
          ...(titleField ? { titleField } : {}),
          departmentId: department.id,
          settings: { studio: id },
        },
        actorOf(viewer),
      );
      solution.tables.push({ key: table.key, tableId: table.id });
      await this.saveSolution(id, solution);
    }
    await this.event(id, "part", { part: "table", key: table.key, name: table.name, changed: Boolean(mine) });
    return {
      content: json({
        key: table.key,
        name: table.name,
        saved: mine ? "changed" : "made (kept with this conversation until it is put to work)",
        fields: table.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, ...(f.choices ? { choices: f.choices } : {}) })),
        ai_employees_can: ["find", "add", "update"],
        notes,
      }),
    };
  }

  private async saveEmployee(companyId: string, id: string, viewer: Viewer, raw: Record<string, unknown>): Promise<ToolExecution> {
    const parsed = EmployeeSpec.safeParse(raw);
    if (!parsed.success) return problem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const spec = parsed.data;
    const thread = await this.row(companyId, id);
    const solution = solutionOf(thread);
    const department = await this.departmentFor(companyId, thread, spec.department);
    if (!department) return problem("Say which department it works in (its key).");
    const hires = viewer.isAdmin || viewer.departments.some((d) => d.departmentId === department.id && d.role === "manager");
    if (!hires) return problem(`${viewer.name} doesn't hire for ${department.name}: its managers do. See you_hire_for in look_around.`);
    const mine = spec.key ? solution.employees.find((e) => e.key === spec.key) : undefined;
    if (spec.key && !mine) return problem(`You didn't make "${spec.key}" in this conversation: AI employees at work are changed from their page.`);
    const compiled = compileEmployee({ ...spec, department: department.key }, await this.compileContext(companyId, mine?.key));
    if (compiled.problems.length) return problem(`Not saved: ${compiled.problems.join(" ")}`);
    let agent;
    if (mine) {
      agent = await this.platform.agents.update(companyId, mine.agentId, compiled.definition, { note: "Changed in the Studio", createdBy: viewer.name });
      if (agent.row.probation !== spec.level) agent = await this.platform.agents.setEmployment(companyId, agent.row.id, { probation: spec.level });
      mine.spec = spec;
      mine.notes = compiled.notes;
    } else {
      agent = await this.platform.agents.create(companyId, {
        definition: compiled.definition,
        status: "draft",
        source: "builder",
        departmentId: department.id,
        createdBy: actorOf(viewer),
        probation: spec.level,
        managerUserId: viewer.userId && viewer.departments.some((d) => d.departmentId === department.id && d.role === "manager") ? viewer.userId : null,
      });
      solution.employees.push({ key: agent.row.slug, agentId: agent.row.id, spec, notes: compiled.notes });
    }
    await this.saveSolution(id, solution);
    await this.event(id, "part", { part: "ai_employee", key: agent.row.slug, name: agent.definition.name, changed: Boolean(mine) });
    return {
      content: json({
        key: agent.row.slug,
        saved: mine ? "changed (still a draft)" : "made, as a draft: it works only in tries until the solution is put to work",
        duties: describeDuties(agent.definition.triggers).map((d) => d.text),
        may_use: abilitiesOf(agent.definition),
        notes: compiled.notes,
        next: "Try it on real examples with try_ai_employee.",
      }),
    };
  }

  private async saveApp(companyId: string, id: string, viewer: Viewer, raw: Record<string, unknown>): Promise<ToolExecution> {
    const parsed = AppSpec.safeParse(raw);
    if (!parsed.success) return problem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const spec = parsed.data;
    const thread = await this.row(companyId, id);
    const solution = solutionOf(thread);
    const rules = rulesOf((await this.platform.company(companyId))!);
    const department = await this.departmentFor(companyId, thread, spec.department);
    if (!department) return problem("Say which department uses it (its key).");
    if (!canBuildFor(viewer, department.id, rules)) return problem(`${viewer.name} doesn't build for ${department.name}.`);
    const tables = [];
    for (const key of spec.tables) {
      const table = await this.platform.tables.get(companyId, key).catch(() => undefined);
      if (!table) return problem(`There is no table "${key}": make it with save_table first.`);
      tables.push({ key: table.key, name: table.name, fields: table.fields, titleField: table.titleField });
    }
    const agents = [];
    for (const key of spec.ai_employees) {
      const agent = await this.platform.agents.find(companyId, key);
      if (!agent) return problem(`There is no AI employee "${key}".`);
      agents.push({ slug: agent.row.slug, name: agent.definition.name, summary: agent.definition.summary });
    }
    const mine = spec.key ? solution.apps.find((a) => a.key === spec.key) : undefined;
    if (spec.key && !mine) return problem(`You didn't plan "${spec.key}" in this conversation.`);
    const key = mine?.key ?? uniqueKey(slugify(spec.name, 40).replace(/-/g, "_"), new Set(solution.apps.map((a) => a.key)));
    const proposal = await proposeApp(this.platform.llm, { description: `${spec.name}: ${spec.description}`, tables, agents });
    // It works on the tables it was given: a proposal that wants others gives way to the plain app on them.
    const own = !proposal.tables.length;
    const notes = own ? [...proposal.notes] : ["It shows the tables as a list, a board by status and a form; say what else the screens need."];
    const design = AppDesign.parse(
      own ? { ...proposal.design, key, name: spec.name } : plainApp({ key, name: spec.name, description: spec.description, tables }),
    );
    const problems = await this.platform.apps.check(companyId, design);
    if (problems.length) return problem(`Not saved: ${problems.join(" ")}`);
    const entry = { key, spec: { ...spec, department: department.key }, design: design as unknown as Record<string, unknown>, notes };
    if (mine) Object.assign(mine, entry);
    else solution.apps.push(entry);
    await this.saveSolution(id, solution);
    await this.event(id, "part", { part: "app", key, name: spec.name, changed: Boolean(mine) });
    return {
      content: json({
        key,
        saved: "planned: it is made when the solution is put to work",
        pages: design.pages.map((p) => ({ title: p.title, shows: p.blocks.map((b) => b.type) })),
        notes,
      }),
    };
  }

  private async tryEmployee(companyId: string, id: string, viewer: Viewer, raw: Record<string, unknown>): Promise<ToolExecution> {
    const input = TryInput.parse(raw);
    const agent = await this.platform.agents.find(companyId, input.key);
    if (!agent || !canSeeDepartment(viewer, agent.row.departmentId)) return problem(`There is no AI employee "${input.key}".`);
    let example: string;
    let runInput: Record<string, unknown> = {};
    if (input.email_id) {
      const message = await this.platform.mail.get(companyId, input.email_id);
      runInput = { email: MailService.toEmailInput(message) };
      example = `the email “${truncate(message.subject || "(no subject)", 70)}”`;
    } else if (input.email) {
      const mailbox = agent.definition.triggers.find((t) => t.type === "mailbox");
      runInput = {
        email: {
          from: input.email.from,
          fromName: input.email.from_name ?? null,
          to: mailbox && mailbox.type === "mailbox" ? [mailbox.mailbox] : [],
          subject: input.email.subject,
          body: input.email.body,
          attachments: [],
          attachmentNames: [],
          receivedAt: new Date().toISOString(),
        },
      };
      example = `a made-up email, “${truncate(input.email.subject, 70)}”`;
    } else if (input.file_id) {
      const file = await this.platform.files.get(companyId, input.file_id);
      runInput = { file: { id: file.id, name: file.name } };
      example = file.name;
    } else if (input.form) {
      runInput = input.form;
      example = "its form, filled in";
    } else if (!input.request) {
      return problem("Give an example: email_id, email, file_id, form or request.");
    } else {
      example = `the request “${truncate(input.request, 70)}”`;
    }
    await this.event(id, "trying", { key: agent.row.slug, name: agent.definition.name, example });
    const run = await this.platform.engine.start(companyId, agent.row.id, runInput, {
      trigger: "test",
      isTest: true,
      wait: true,
      actor: actorOf(viewer),
      ...(input.request ? { task: input.request } : {}),
    });
    const detail = await this.platform.engine.get(companyId, run.id);
    const lines: string[] = [];
    for (const event of detail.events) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === "tool.call") {
        const said = typeof data.text === "string" && data.text.trim() ? `${truncate(data.text.trim(), 400)} → ` : "";
        lines.push(`${said}uses ${event.message}`);
      } else if (event.type === "tool.result") {
        lines.push(`  ${event.message}: ${truncate(String(data.preview ?? "").replace(/\s+/g, " "), 400)}`);
      } else if (["warning", "step.failed", "run.failed", "approval.requested"].includes(event.type) || /test run|dry run/i.test(event.message)) {
        lines.push(`${event.type}: ${event.message}`);
      }
    }
    const output = isRecord(run.output) ? run.output : {};
    const outcome = typeof output.text === "string" && output.text.trim() ? output.text.trim() : run.error ? `It failed: ${run.error}` : json(output, 3000);
    const record: TryRecord = {
      key: agent.row.slug,
      runId: run.id,
      status: run.status,
      example,
      outcome: truncate(outcome, 1200),
      at: new Date().toISOString(),
    };
    const solution = solutionOf(await this.row(companyId, id));
    solution.tries.push(record);
    await this.saveSolution(id, solution);
    await this.event(id, "try", { ...record, name: agent.definition.name });
    return {
      content: [
        `Try of ${agent.definition.name} on ${example}: ${run.status}.`,
        "What it did (tries send and change nothing):",
        ...(lines.length ? lines.slice(0, 80) : ["(no steps recorded)"]),
        "",
        "Its final words:",
        truncate(outcome, 4000),
      ].join("\n"),
    };
  }

  private async remove(companyId: string, id: string, raw: Record<string, unknown>): Promise<ToolExecution> {
    const input = RemoveInput.parse(raw);
    const solution = solutionOf(await this.row(companyId, id));
    if (input.kind === "ai_employee") {
      const mine = solution.employees.find((e) => e.key === input.key);
      if (!mine) return problem(`You didn't make "${input.key}" here.`);
      await this.platform.agents.remove(companyId, mine.agentId);
      solution.employees = solution.employees.filter((e) => e !== mine);
    } else if (input.kind === "table") {
      const mine = solution.tables.find((t) => t.key === input.key);
      if (!mine) return problem(`You didn't make "${input.key}" here.`);
      const table = await this.platform.tables.get(companyId, mine.tableId);
      if (table.records) return problem(`${table.name} has records: it stays.`);
      await this.platform.tables.remove(companyId, mine.tableId);
      solution.tables = solution.tables.filter((t) => t !== mine);
    } else {
      if (!solution.apps.some((a) => a.key === input.key)) return problem(`You didn't plan "${input.key}" here.`);
      solution.apps = solution.apps.filter((a) => a.key !== input.key);
    }
    await this.saveSolution(id, solution);
    await this.event(id, "removed", { part: input.kind, key: input.key });
    return { content: `Removed ${input.key}.` };
  }

  // -------------------------------------------------------------------------
  // The solution, and putting it to work
  // -------------------------------------------------------------------------

  private async solutionView(companyId: string, solution: SolutionState) {
    const departments = await this.platform.catalog.departments(companyId);
    const nameOf = new Map(departments.map((d) => [d.id, d.name]));
    const tableNames: Record<string, string> = {};
    const tables = [];
    for (const entry of solution.tables) {
      const table = await this.platform.tables.get(companyId, entry.tableId).catch(() => undefined);
      if (!table) continue;
      tableNames[table.key] = table.name;
      tables.push({
        key: table.key,
        name: table.name,
        department: table.departmentId ? (nameOf.get(table.departmentId) ?? null) : null,
        fields: table.fields.map((f) => ({ label: f.label, type: f.type, ...(f.personal ? { personal: true } : {}) })),
        records: table.records,
        draft: Boolean(table.settings.studio),
      });
    }
    const employees = [];
    for (const entry of solution.employees) {
      const agent = await this.platform.agents.find(companyId, entry.agentId);
      if (!agent) continue;
      const tries = solution.tries.filter((t) => t.key === agent.row.slug);
      employees.push({
        key: agent.row.slug,
        status: agent.row.status,
        department: agent.row.departmentId ? (nameOf.get(agent.row.departmentId) ?? null) : null,
        ...employeeCard(agent.definition, agent.row.probation as "shadow" | "supervised" | "trusted", { tables: tableNames }),
        notes: entry.notes,
        tries: tries.length,
        lastTry: tries.at(-1) ?? null,
      });
    }
    const requests = [];
    for (const r of solution.requests) {
      const item = await this.platform.work.get(companyId, r.workItemId).catch(() => undefined);
      requests.push({ id: r.workItemId, system: r.system, needed: r.needed, status: item?.status ?? "open", answer: item?.answer ?? null });
    }
    return {
      employees,
      tables,
      apps: solution.apps.map((a) => ({
        key: a.key,
        name: a.spec.name,
        description: a.spec.description,
        pages: ((a.design.pages as { title: string }[] | undefined) ?? []).map((p) => p.title),
        made: Boolean(solution.built?.apps.includes(a.key)),
      })),
      requests,
    };
  }

  /** Make the solution live: its AI employees start their duties, its tables and apps join their departments. */
  async putToWork(companyId: string, id: string, viewer: Viewer) {
    const row = await this.mine(companyId, id, viewer);
    if (this.running.has(id)) throw new StudioError("The Studio is still working: wait for it first", 409);
    if (row.builtAt) throw new StudioError("It is already at work", 409);
    const solution = solutionOf(row);
    if (!solution.employees.length && !solution.tables.length && !solution.apps.length) throw new StudioError("Nothing is built yet", 409);
    const company = (await this.platform.company(companyId))!;
    const rules = rulesOf(company);
    const built = { employees: [] as string[], tables: [] as string[], apps: [] as string[], at: new Date().toISOString() };
    for (const entry of solution.tables) {
      const table = await this.platform.tables.get(companyId, entry.tableId).catch(() => undefined);
      if (!table) continue;
      const live = table.settings.studio ? await this.platform.tables.change(companyId, table.id, { settings: { studio: undefined } }) : table;
      await personalDataAfterDesign(this.platform, companyId, viewer, rules, live);
      await this.platform.activity.record(companyId, {
        actor: actorOf(viewer),
        action: "table.created",
        entityType: "table",
        entityId: live.id,
        summary: `Made the table ${live.name} in the Studio`,
      });
      built.tables.push(live.key);
    }
    for (const entry of solution.apps) {
      const { key: _key, ...design } = entry.design as { key: string } & Record<string, unknown>;
      const department = entry.spec.department ? (await this.platform.catalog.departments(companyId)).find((d) => d.key === entry.spec.department) : undefined;
      const app = await this.platform.apps.create(
        companyId,
        { ...(design as Omit<AppDesign, "key">), departmentId: department?.id ?? row.departmentId ?? null },
        actorOf(viewer),
      );
      await this.platform.activity.record(companyId, {
        actor: actorOf(viewer),
        action: "app.created",
        entityType: "app",
        entityId: app.id,
        summary: `Made the app ${app.name} in the Studio`,
      });
      built.apps.push(entry.key);
    }
    const unmanaged: string[] = [];
    for (const entry of solution.employees) {
      const agent = await this.platform.agents.find(companyId, entry.agentId);
      if (!agent || agent.row.status === "archived") continue;
      if (!agent.row.managerUserId) unmanaged.push(agent.row.id);
      await this.platform.agents.setStatus(companyId, agent.row.id, "active");
      await this.platform.activity.record(companyId, {
        actor: actorOf(viewer),
        action: "agent.activated",
        entityType: "agent",
        entityId: agent.row.id,
        summary: `Hired ${agent.definition.name} in the Studio and put it to work`,
      });
      built.employees.push(agent.row.slug);
    }
    if (unmanaged.length) await this.platform.employment.assignDefaultManagers(companyId, { by: viewer.userId, agentIds: unmanaged });
    solution.built = built;
    await this.db
      .update(studioThreads)
      .set({ builtAt: new Date(), solution: solution as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(studioThreads.id, id));
    await this.event(id, "built", built);
    return this.view(companyId, id, viewer);
  }

  /** Throw a conversation away, with what it made that isn't at work (tables only while empty). */
  async discard(companyId: string, id: string, viewer: Viewer): Promise<void> {
    const row = await this.mine(companyId, id, viewer);
    if (this.running.has(id)) throw new StudioError("The Studio is still working: stop it first", 409);
    const solution = solutionOf(row);
    if (!row.builtAt) {
      for (const entry of solution.employees) {
        const agent = await this.platform.agents.find(companyId, entry.agentId);
        if (agent?.row.status === "draft") await this.platform.agents.remove(companyId, agent.row.id);
      }
      for (const entry of solution.tables) {
        const table = await this.platform.tables.get(companyId, entry.tableId).catch(() => undefined);
        if (table?.settings.studio && !table.records) await this.platform.tables.remove(companyId, table.id);
      }
    }
    await this.db.delete(studioThreads).where(eq(studioThreads.id, id));
  }
}

function uniqueKey(base: string, taken: Set<string>): string {
  const start = base || "app";
  let key = start;
  for (let n = 2; taken.has(key); n++) key = `${start}_${n}`;
  return key;
}

const VERBS: Record<string, string> = {
  look_around: "look at the company",
  read_mailbox: "read the mailbox",
  read_email: "read the email",
  read_file: "read the file",
  look_at: "look at it",
  search_knowledge: "search the knowledge",
  ask_it: "ask IT",
  save_table: "save the table",
  save_ai_employee: "save the AI employee",
  save_app: "plan the app",
  try_ai_employee: "try the AI employee",
  remove: "remove it",
};

function verbOf(tool: string): string {
  return VERBS[tool] ?? "do it";
}

export type StudioThreadView = Awaited<ReturnType<StudioService["view"]>>;
