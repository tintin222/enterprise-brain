import { asc, eq } from "drizzle-orm";
import type { BrainEntityView } from "@enterprise-brain/brain";
import {
  PACKAGE_LAYOUT,
  fileStem,
  probationOf,
  renderAgentSpec,
  renderApp,
  renderCalculation,
  renderClaudeMd,
  renderConnection,
  renderDocument,
  renderInterview,
  renderMcpJson,
  renderPlan,
  renderProjectJson,
  renderReadme,
  renderTable,
  renderTests,
  renderThing,
  renderThingsJson,
  renderTranscript,
  requirementsDigest,
  uniquePath,
  type PackageAgent,
  type PackageFiles,
  type PackageFolder,
  type PackageProject,
  type PackageQuestion,
  type PackageTodo,
} from "@enterprise-brain/builder";
import type { AgentDefinition } from "@enterprise-brain/core";
import { studioEvents, studioThreads } from "@enterprise-brain/db";
import { employmentOf, type AgentRecord, type CompanyRow, type ProjectRow } from "@enterprise-brain/runtime";
import { canSeeAsset, type Viewer } from "./auth/viewer.ts";
import type { AppContext } from "./context.ts";
import { mayOpenInterview } from "./routes/builder.ts";

/** The machine key's name, as CLAUDE.md and .mcp.json say it; the key itself is never in a package. */
export const PACKAGE_KEY_NAME = "EB_API_KEY";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SAMPLE_ROWS = 50;

export interface DevPackageSummary {
  folders: PackageFolder[];
  files: number;
  bytes: number;
  agents: { slug: string; name: string; source: string }[];
  warnings: string[];
  mcpUrl: string;
  exportedAt: string;
}

export interface DevPackage {
  files: PackageFiles;
  summary: DevPackageSummary;
}

/** What a Studio conversation keeps of its work, as the package reads it. */
interface ThreadSolution {
  employees?: { key: string; agentId: string; spec: Record<string, unknown>; notes: string[] }[];
  tries?: { key: string; status: string; example: string; outcome: string; at: string }[];
  requests?: { workItemId: string; system: string; needed: string }[];
}

/** An AI employee of the package with the pages that go beside its spec. */
interface AgentEntry {
  agent: PackageAgent;
  extras: Record<string, string>;
}

/** A file name that stays a file name: no path separators, nothing hidden. */
function safeFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return clean || "file";
}

/**
 * Collects a project's development package: the AI employees designed in it (with how they were
 * designed and what they were tried on), what it uses from the brain and the company's systems (as the
 * viewer may see it), its documents and files, the open tasks and questions, and the top-level pages
 * that tell Claude Code what to build. Pure rendering lives in @enterprise-brain/builder.
 */
export async function buildDevPackage(ctx: AppContext, viewer: Viewer, company: CompanyRow, project: ProjectRow): Promise<DevPackage> {
  const { platform } = ctx;
  const companyId = company.id;
  const files: PackageFiles = {};
  const taken = new Set<string>();
  const warnings: string[] = [];
  const put = (path: string, content: string | Buffer) => {
    files[uniquePath(path, taken)] = content;
  };
  const exportedAt = new Date().toISOString();
  const owner = project.ownerUserId ? await platform.people.get(companyId, project.ownerUserId).catch(() => undefined) : undefined;
  const pkgProject: PackageProject = {
    slug: project.slug,
    name: project.name,
    summary: project.summary,
    status: project.status,
    client: project.client,
    owner: owner?.name ?? null,
    company: company.name,
    createdAt: project.createdAt.toISOString(),
    exportedAt,
  };

  // Names in words: departments, tables, systems, people.
  const departments = new Map((await platform.catalog.departments(companyId)).map((d) => [d.id, d.name]));
  const tables = await platform.tables.list(companyId);
  const tableNames = Object.fromEntries(tables.map((t) => [t.key, t.name]));
  const connections = await platform.connectors.list(companyId);
  const connectionName = (id: string | undefined) => (id ? connections.find((c) => c.id === id)?.name : undefined);
  const agentsOfCompany = await platform.agents.list(companyId);
  const people = new Map<string, string>();
  const personName = async (userId: string) => {
    if (!people.has(userId)) people.set(userId, (await platform.people.get(companyId, userId).catch(() => undefined))?.name ?? "someone");
    return people.get(userId)!;
  };
  const appNames = {
    table: (key: string) => tableNames[key] ?? key,
    field: (table: string, key: string) => tables.find((t) => t.key === table)?.fields.find((f) => f.key === key)?.label ?? key,
    agent: (slug: string) => agentsOfCompany.find((a) => a.row.slug === slug)?.definition.name ?? slug,
  };
  const packageAgent = (
    record: AgentRecord,
    source: PackageAgent["source"],
    notes: string[],
    tries: PackageAgent["tries"],
    design?: Record<string, unknown>,
  ): PackageAgent => ({
    slug: record.row.slug,
    definition: record.definition,
    probation: employmentOf(record.row).probation,
    source,
    department: record.row.departmentId ? (departments.get(record.row.departmentId) ?? null) : null,
    status: record.row.status,
    notes,
    tries,
    names: {
      tables: tableNames,
      systems: Object.fromEntries(record.definition.connectors.map((c) => [c.ref, connectionName(c.instanceId) ?? c.purpose ?? c.ref])),
    },
    ...(design ? { design } : {}),
  });

  // What the project uses, as the viewer may see it.
  const entries: AgentEntry[] = [];
  const all = await platform.projects.assets(companyId, project.id);
  const visible = all.filter((a) => canSeeAsset(viewer, a));
  if (visible.length < all.length)
    warnings.push(
      `${all.length - visible.length} asset${all.length - visible.length === 1 ? "" : "s"} of departments you are not in ${all.length - visible.length === 1 ? "was" : "were"} left out.`,
    );
  const things: BrainEntityView[] = [];
  for (const asset of visible) {
    if (!asset.exists) {
      warnings.push(`${asset.kind} "${asset.name}" no longer exists and was left out.`);
      continue;
    }
    try {
      switch (asset.kind) {
        case "thing": {
          const view = await platform.brain.get(companyId, asset.ref);
          things.push(view);
          put(`brain/${view.kind}/${fileStem(view.key || view.name)}.md`, renderThing(view));
          break;
        }
        case "table": {
          const table = await platform.tables.get(companyId, asset.ref);
          const { records } = await platform.tables.records(companyId, table.key, { limit: SAMPLE_ROWS });
          const rendered = renderTable(table, records);
          put(`data/tables/${table.key}/README.md`, rendered.readme);
          put(`data/tables/${table.key}/schema.json`, rendered.schema);
          put(`data/tables/${table.key}/sample.csv`, rendered.csv);
          break;
        }
        case "app": {
          const app = await platform.apps.get(companyId, asset.ref);
          put(`data/apps/${app.key}.md`, renderApp(app, appNames));
          put(
            `data/apps/${app.key}.json`,
            `${JSON.stringify({ key: app.key, name: app.name, description: app.description, icon: app.icon, pages: app.pages, settings: app.settings }, null, 2)}\n`,
          );
          break;
        }
        case "calculation": {
          const calculation = await platform.calculations.get(companyId, asset.ref);
          const code = viewer.isAdmin ? await platform.calculations.code(companyId, calculation.key) : undefined;
          put(`data/calculations/${calculation.key}.md`, renderCalculation(calculation, code));
          if (code !== undefined) put(`data/calculations/${calculation.key}.js`, `${code.trim()}\n`);
          break;
        }
        case "document": {
          const document = await platform.knowledge.getDocument(companyId, asset.ref);
          if (!document) throw new Error("not found");
          const collection = await platform.knowledge.getCollection(companyId, document.collectionId);
          put(
            `knowledge/${collection?.key ?? "documents"}/${fileStem(document.title)}.md`,
            renderDocument(
              {
                title: document.title,
                collection: collection?.name ?? "documents",
                source: document.source,
                uri: document.uri,
                createdAt: document.createdAt.toISOString(),
              },
              document.chunks.map((c) => c.content).join("\n\n"),
            ),
          );
          break;
        }
        case "file": {
          const file = await platform.files.get(companyId, asset.ref);
          if (file.size > MAX_FILE_BYTES) {
            warnings.push(`The file "${file.name}" is larger than 25 MB and was left out.`);
            break;
          }
          put(`files/${safeFileName(file.name)}`, file.data);
          break;
        }
        case "connection": {
          // A built-in demo system has no row: its page comes from its manifest.
          const demo = platform.connectors.demoSystem(asset.ref);
          const view = demo
            ? { id: demo.type, type: demo.type, name: demo.name, category: demo.category, config: {}, secretFields: [], status: "demo", sandbox: true }
            : await platform.connectors.get(companyId, asset.ref);
          const operations = demo ? demo.operations : await platform.connectors.operationsOf(companyId, view.id);
          put(
            `connections/${fileStem(view.name)}.md`,
            renderConnection(
              view,
              operations.map((op) => ({ id: op.id, name: op.name, description: op.description, kind: op.kind, input: op.input })),
            ),
          );
          break;
        }
        case "agent": {
          const record = await platform.agents.find(companyId, asset.ref);
          if (record) entries.push({ agent: packageAgent(record, "attached", [], []), extras: {} });
          break;
        }
      }
    } catch (error) {
      warnings.push(`${asset.kind} "${asset.name}" could not be exported: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (things.length) {
    put("brain/things.json", renderThingsJson(things));
    put(
      "brain/README.md",
      [
        `# What the company brain knows, for ${project.name}`,
        "",
        "One file per thing, by kind; things.json holds the same with their links. The live brain may be newer: ask it over MCP (company_open).",
        "",
        ...things.map((t) => `- ${t.kind}/${fileStem(t.key || t.name)}.md: ${t.name}${t.summary ? ` — ${t.summary.replace(/\s+/g, " ").slice(0, 120)}` : ""}`),
        "",
      ].join("\n"),
    );
  }

  // The designs: Studio conversations and interviews, with the AI employees they made.
  const questions: PackageQuestion[] = [];
  const designs = await platform.projects.designs(companyId, project.id);
  for (const thread of designs.threads) {
    const [row] = await platform.handle.db.select().from(studioThreads).where(eq(studioThreads.id, thread.id));
    if (!row) continue;
    const solution = row.solution as ThreadSolution;
    const canOpen = viewer.isAdmin || (Boolean(row.ownerId) && row.ownerId === viewer.userId);
    let transcript: string | undefined;
    if (canOpen) {
      const events = await platform.handle.db.select().from(studioEvents).where(eq(studioEvents.threadId, thread.id)).orderBy(asc(studioEvents.seq));
      transcript = renderTranscript(
        row.title,
        events.map((e) => ({ kind: e.kind, data: e.data, at: e.createdAt.toISOString() })),
      );
    } else {
      warnings.push(`The Studio conversation "${row.title}" is ${thread.owner || "someone else"}'s: its transcript is not in your export.`);
    }
    for (const entry of solution.employees ?? []) {
      const record = await platform.agents.find(companyId, entry.agentId);
      if (!record) continue;
      const tries = (solution.tries ?? [])
        .filter((t) => t.key === record.row.slug)
        .map((t) => ({ example: t.example, status: t.status, outcome: t.outcome, at: t.at }));
      entries.push({
        agent: packageAgent(record, "studio", entry.notes ?? [], tries, entry.spec),
        extras: transcript ? { "conversation.md": transcript } : {},
      });
    }
    if (!(solution.employees ?? []).length && transcript) put(`agents/${fileStem(row.title)}/conversation.md`, transcript);
    const pending = row.pending as { questions?: { question: string }[] } | null;
    for (const q of pending?.questions ?? []) questions.push({ about: `The Studio asked, in "${row.title}"`, text: q.question, status: "unanswered" });
    for (const r of solution.requests ?? []) {
      const item = await platform.work.get(companyId, r.workItemId).catch(() => undefined);
      questions.push({
        about: `Asked IT about ${r.system}`,
        text: r.needed,
        status: item?.status === "done" ? `answered: ${item.answer ?? "done"}` : "waiting for IT",
      });
    }
  }
  for (const interview of designs.interviews) {
    const session = await ctx.builder.find(companyId, interview.id);
    if (!mayOpenInterview(viewer, session)) {
      warnings.push(`The interview "${session.title}" is its hiring manager's: it is not in your export.`);
      continue;
    }
    const view = await ctx.builder.get(companyId, interview.id);
    const record = view.session.agentId ? await platform.agents.find(companyId, view.session.agentId) : undefined;
    // While the interview is still asking, its draft is a placeholder: the agent is one to build only once the interview is through.
    const settled = !["interviewing", "awaiting-stakeholders"].includes(view.session.status);
    const definition: AgentDefinition | undefined = record?.definition ?? (settled ? view.draft : undefined);
    const page = renderInterview({
      title: view.session.title,
      digest: requirementsDigest(view.tree),
      job: view.job,
      messages: view.messages.map((m) => ({ role: m.role, content: m.content, at: m.createdAt.toISOString() })),
    });
    if (record) entries.push({ agent: packageAgent(record, "interview", [], []), extras: { "interview.md": page } });
    else if (definition)
      entries.push({
        agent: {
          slug: definition.slug,
          definition,
          probation: probationOf(view.tree),
          source: "interview",
          department: view.session.department,
          status: "draft (not saved on the platform yet)",
          notes: [],
          tries: [],
          names: {
            tables: tableNames,
            systems: Object.fromEntries(definition.connectors.map((c) => [c.ref, connectionName(c.instanceId) ?? c.purpose ?? c.ref])),
          },
        },
        extras: { "interview.md": page },
      });
    else put(`agents/${fileStem(view.session.title)}/interview.md`, page);
    for (const need of view.job.needs.filter((n) => n.status !== "ready" && n.status !== "answered"))
      questions.push({ about: `Interview "${view.session.title}", ${need.who}`, text: need.text, status: need.status });
  }

  // One folder per AI employee.
  const agents: PackageAgent[] = [];
  for (const { agent, extras } of entries) {
    if (agents.some((a) => a.slug === agent.slug)) continue;
    agents.push(agent);
    const dir = `agents/${agent.slug}`;
    put(`${dir}/SPEC.md`, renderAgentSpec(agent));
    put(`${dir}/definition.json`, `${JSON.stringify(agent.definition, null, 2)}\n`);
    put(`${dir}/tests.md`, renderTests(agent));
    if (agent.design) put(`${dir}/design.json`, `${JSON.stringify(agent.design, null, 2)}\n`);
    for (const [name, content] of Object.entries(extras)) put(`${dir}/${name}`, content);
  }

  // The plan: the open tasks of the project's people, and what is still waiting.
  const todos: PackageTodo[] = [];
  for (const todo of await platform.todos.openInProject(companyId, project.id))
    todos.push({ title: todo.title, details: todo.details, dueAt: todo.dueAt?.toISOString() ?? null, who: await personName(todo.userId) });
  put("tasks/PLAN.md", renderPlan({ project: pkgProject, agents, todos, questions }));

  // The top of the package.
  const mcpUrl = `${ctx.config.publicUrl.replace(/\/$/, "")}/mcp/${company.slug}`;
  const folders: PackageFolder[] = PACKAGE_LAYOUT.map((l) => ({ ...l, files: Object.keys(files).filter((p) => p.startsWith(l.folder)).length }));
  put("README.md", renderReadme(pkgProject, { agents, folders }));
  put("CLAUDE.md", renderClaudeMd({ project: pkgProject, agents, folders, mcp: { url: mcpUrl, keyName: PACKAGE_KEY_NAME } }));
  put(".mcp.json", renderMcpJson(mcpUrl, PACKAGE_KEY_NAME));
  put("project.json", renderProjectJson(pkgProject, agents, folders));
  const bytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  return {
    files,
    summary: {
      folders,
      files: Object.keys(files).length,
      bytes,
      agents: agents.map((a) => ({ slug: a.slug, name: a.definition.name, source: a.source })),
      warnings,
      mcpUrl,
      exportedAt,
    },
  };
}
