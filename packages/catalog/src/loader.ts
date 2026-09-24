import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import {
  AgentTemplate,
  DepartmentTemplate,
  ProcessTemplate,
  UseCase,
  isRecord,
  type Catalog,
} from "@enterprise-brain/core";
import { FrontmatterError, splitFrontmatter } from "./frontmatter.ts";
import { setSource } from "./sources.ts";
import { validateCatalog } from "./validate.ts";

/** The repository's `catalog/` directory. */
export const DEFAULT_CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/** Presentation order of the standard departments and use cases (others follow alphabetically). */
export const DEPARTMENT_ORDER = [
  "hr",
  "finance",
  "sales",
  "marketing",
  "customer-service",
  "procurement",
  "it",
  "legal",
  "operations",
  "management",
  "shared-services",
] as const;

export const USE_CASE_ORDER = [
  "conversational-ai",
  "excel-automation",
  "enterprise-search",
  "knowledge-base",
  "mail-triage",
  "document-processing",
] as const;

/** All problems found while loading a catalog, each prefixed with the file it concerns. */
export class CatalogError extends Error {
  readonly errors: string[];
  readonly rootDir: string;

  constructor(errors: string[], rootDir: string) {
    super(
      `Invalid catalog at ${rootDir} (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n${errors
        .map((e) => `  - ${e}`)
        .join("\n")}`,
    );
    this.name = "CatalogError";
    this.errors = errors;
    this.rootDir = rootDir;
  }
}

export interface LoadCatalogOptions {
  /** Also run the cross-reference checks of `validateCatalog` and throw when they find problems. */
  validate?: boolean;
}

// ---------------------------------------------------------------------------
// Schema validation helpers
// ---------------------------------------------------------------------------

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
}

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
  /** Present on object schemas: used to name unknown top-level keys even when validation fails. */
  readonly shape?: object;
}

/** "workflow[3](evaluation).criteria[0](skills).kind" — array items are labelled with their id/key/ref. */
function formatPath(path: readonly PropertyKey[], data: unknown): string {
  let out = "";
  let current: unknown = data;
  for (const segment of path) {
    if (typeof segment === "number") {
      const item: unknown = Array.isArray(current) ? current[segment] : undefined;
      const label = isRecord(item) ? [item.id, item.key, item.ref].find((v) => typeof v === "string") : undefined;
      out += `[${segment}]${label ? `(${label})` : ""}`;
      current = item;
    } else {
      const key = String(segment);
      out += out ? `.${key}` : key;
      current = isRecord(current) ? current[key] : undefined;
    }
  }
  return out || "(root)";
}

function issueMessage(issue: Issue): string {
  if (issue.code === "invalid_type" && /received undefined$/.test(issue.message)) {
    const expected = issue.message.match(/expected (\w+)/)?.[1];
    return `required${expected ? ` (${expected})` : ""}`;
  }
  return issue.message;
}

/** Keys present in the raw data that the schema dropped (typos such as `workfow:` would otherwise vanish silently). */
function unknownKeys(raw: unknown, parsed: unknown, path: PropertyKey[] = [], out: PropertyKey[][] = []): PropertyKey[][] {
  if (isRecord(raw) && isRecord(parsed)) {
    for (const key of Object.keys(raw)) {
      if (!(key in parsed)) out.push([...path, key]);
      else unknownKeys(raw[key], parsed[key], [...path, key], out);
    }
  } else if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((item, index) => unknownKeys(item, parsed[index], [...path, index], out));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

class LoadContext {
  readonly errors: string[] = [];

  constructor(readonly root: string) {}

  rel(path: string): string {
    return relative(this.root, path).split(sep).join("/");
  }

  error(path: string, message: string): void {
    this.errors.push(`${this.rel(path)}: ${message}`);
  }

  async entries(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Parse YAML text; syntax errors are recorded with their (file) line numbers. */
  parseYaml(text: string, file: string, lineOffset = 0): unknown {
    const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
    if (doc.errors.length) {
      for (const err of doc.errors) {
        const pos = err.linePos?.[0];
        const reason = (err.message.split("\n")[0] ?? err.message).replace(/ at line \d+, column \d+:?\s*$/, "");
        this.error(file, `YAML syntax error${pos ? ` at line ${pos.line + lineOffset}, column ${pos.col}` : ""}: ${reason}`);
      }
      return undefined;
    }
    const data: unknown = doc.toJS();
    if (!isRecord(data)) {
      this.error(file, data === null || data === undefined ? "file is empty" : "expected a YAML mapping (key: value pairs) at the top level");
      return undefined;
    }
    return data;
  }

  /** Validate against a core schema, reporting every issue plus keys the schema does not know. */
  check<T>(schema: Schema<T>, data: unknown, file: string, what: string): T | undefined {
    const result = schema.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) this.error(file, `${formatPath(issue.path, data)}: ${issueMessage(issue)}`);
      if (schema.shape && isRecord(data)) {
        for (const key of Object.keys(data)) {
          if (!(key in schema.shape)) this.error(file, `${key}: unknown key (not part of the ${what} schema)`);
        }
      }
      return undefined;
    }
    const unknown = unknownKeys(data, result.data);
    for (const path of unknown) this.error(file, `${formatPath(path, data)}: unknown key (not part of the ${what} schema)`);
    return unknown.length ? undefined : result.data;
  }
}

const YAML_EXTENSIONS = [".yaml", ".yml"];

function isYaml(name: string): boolean {
  return YAML_EXTENSIONS.includes(extname(name).toLowerCase());
}

async function loadDepartmentDir(ctx: LoadContext, dir: string, dirName: string, catalog: Catalog): Promise<void> {
  const entries = await ctx.entries(dir);
  const departmentFile = entries.find((e) => !e.isDirectory && isYaml(e.name) && basename(e.name, extname(e.name)) === "department");
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry === departmentFile) continue;
    if (entry.isDirectory && (entry.name === "processes" || entry.name === "agents")) continue;
    if (entry.isDirectory) ctx.error(path, "unexpected directory (a department folder holds department.yaml, processes/ and agents/)");
    else if (isYaml(entry.name) || extname(entry.name) === ".md") {
      ctx.error(path, "unexpected file (processes go in processes/<process>.yaml, agents in agents/<agent>.md)");
    }
  }

  if (!departmentFile) {
    ctx.error(dir, "missing department.yaml");
  } else {
    const file = join(dir, departmentFile.name);
    const raw = ctx.parseYaml(await readFile(file, "utf8"), file);
    const department = raw === undefined ? undefined : ctx.check(DepartmentTemplate, raw, file, "DepartmentTemplate");
    if (department) {
      if (department.id !== dirName) {
        ctx.error(file, `id "${department.id}" must match its folder name "${dirName}"`);
      } else {
        setSource(department, ctx.rel(file));
        catalog.departments.push(department);
      }
    }
  }

  const processesDir = join(dir, "processes");
  for (const entry of await ctx.entries(processesDir)) {
    const file = join(processesDir, entry.name);
    if (entry.isDirectory || !isYaml(entry.name)) {
      ctx.error(file, "unexpected entry (process templates are YAML files)");
      continue;
    }
    const raw = ctx.parseYaml(await readFile(file, "utf8"), file);
    const process = raw === undefined ? undefined : ctx.check(ProcessTemplate, raw, file, "ProcessTemplate");
    if (!process) continue;
    const expected = `${dirName}.${basename(entry.name, extname(entry.name))}`;
    const mismatches = [
      process.id !== expected ? `id "${process.id}" must be "${expected}" (<department folder>.<file name>)` : undefined,
      process.department !== dirName ? `department "${process.department}" must be "${dirName}" (its folder)` : undefined,
    ].filter((m): m is string => Boolean(m));
    if (mismatches.length) {
      for (const m of mismatches) ctx.error(file, m);
      continue;
    }
    setSource(process, ctx.rel(file));
    catalog.processes.push(process);
  }

  const agentsDir = join(dir, "agents");
  for (const entry of await ctx.entries(agentsDir)) {
    const file = join(agentsDir, entry.name);
    if (entry.isDirectory || extname(entry.name) !== ".md") {
      ctx.error(file, "unexpected entry (agent templates are Markdown files with YAML frontmatter)");
      continue;
    }
    const agent = await loadAgentFile(ctx, file);
    if (!agent) continue;
    const expected = `${dirName}.${basename(entry.name, ".md")}`;
    const mismatches = [
      agent.id !== expected ? `id "${agent.id}" must be "${expected}" (<department folder>.<file name>)` : undefined,
      agent.department !== dirName ? `department "${agent.department}" must be "${dirName}" (its folder)` : undefined,
    ].filter((m): m is string => Boolean(m));
    if (mismatches.length) {
      for (const m of mismatches) ctx.error(file, m);
      continue;
    }
    setSource(agent, ctx.rel(file));
    catalog.agents.push(agent);
  }
}

async function loadAgentFile(ctx: LoadContext, file: string): Promise<AgentTemplate | undefined> {
  let parts;
  try {
    parts = splitFrontmatter(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof FrontmatterError) {
      ctx.error(file, error.message);
      return undefined;
    }
    throw error;
  }
  const raw = ctx.parseYaml(parts.frontmatter, file, parts.frontmatterLine - 1);
  if (raw === undefined) return undefined;
  if (isRecord(raw) && "instructions" in raw) {
    ctx.error(file, "instructions: must be the Markdown body after the frontmatter, not a frontmatter key");
    return undefined;
  }
  if (!parts.body) {
    ctx.error(file, "instructions (the Markdown body after the frontmatter) are empty");
    return undefined;
  }
  return ctx.check(AgentTemplate, { ...(raw as Record<string, unknown>), instructions: parts.body }, file, "AgentTemplate");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function rank(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? order.length : index;
}

function sortCatalog(catalog: Catalog): void {
  const deptRank = (id: string) => rank(DEPARTMENT_ORDER, id);
  const departments = new Map(catalog.departments.map((d) => [d.id, d]));
  const processRank = (departmentId: string, processId: string | undefined) => {
    const list = departments.get(departmentId)?.processes ?? [];
    return processId === undefined ? list.length : rank(list, processId);
  };
  const processes = new Map(catalog.processes.map((p) => [p.id, p]));
  const byText = (a: string, b: string) => a.localeCompare(b);

  catalog.departments.sort((a, b) => deptRank(a.id) - deptRank(b.id) || byText(a.id, b.id));
  catalog.processes.sort(
    (a, b) =>
      deptRank(a.department) - deptRank(b.department) ||
      byText(a.department, b.department) ||
      processRank(a.department, a.id) - processRank(b.department, b.id) ||
      byText(a.id, b.id),
  );
  const agentRank = (agent: AgentTemplate) => {
    const list = agent.process ? (processes.get(agent.process)?.agents ?? []) : [];
    return rank(list, agent.id);
  };
  catalog.agents.sort(
    (a, b) =>
      deptRank(a.department) - deptRank(b.department) ||
      byText(a.department, b.department) ||
      processRank(a.department, a.process) - processRank(b.department, b.process) ||
      agentRank(a) - agentRank(b) ||
      byText(a.id, b.id),
  );
  catalog.useCases.sort((a, b) => rank(USE_CASE_ORDER, a.id) - rank(USE_CASE_ORDER, b.id) || byText(a.id, b.id));
}

/**
 * Load the template catalog: departments/<dept>/department.yaml,
 * departments/<dept>/processes/*.yaml, departments/<dept>/agents/*.md (YAML
 * frontmatter + Markdown instructions) and use-cases/*.yaml.
 *
 * Every file is validated against the core schemas; all problems are collected
 * (with file paths) and thrown together as one `CatalogError`. Cross-reference
 * checks live in `validateCatalog` (or pass `{ validate: true }`).
 */
export async function loadCatalog(rootDir: string = DEFAULT_CATALOG_DIR, options: LoadCatalogOptions = {}): Promise<Catalog> {
  const root = resolve(rootDir);
  if (!(await isDirectory(root))) throw new CatalogError([`catalog directory not found: ${root}`], root);
  const ctx = new LoadContext(root);
  const catalog: Catalog = { departments: [], processes: [], agents: [], useCases: [] };

  const departmentsDir = join(root, "departments");
  for (const entry of await ctx.entries(departmentsDir)) {
    const path = join(departmentsDir, entry.name);
    if (!entry.isDirectory) {
      if (isYaml(entry.name) || extname(entry.name) === ".md") {
        ctx.error(path, "unexpected file (each department is a folder: departments/<dept>/department.yaml)");
      }
      continue;
    }
    await loadDepartmentDir(ctx, path, entry.name, catalog);
  }

  const useCasesDir = join(root, "use-cases");
  for (const entry of await ctx.entries(useCasesDir)) {
    const file = join(useCasesDir, entry.name);
    if (entry.isDirectory || !isYaml(entry.name)) {
      ctx.error(file, "unexpected entry (use cases are YAML files)");
      continue;
    }
    const raw = ctx.parseYaml(await readFile(file, "utf8"), file);
    const useCase = raw === undefined ? undefined : ctx.check(UseCase, raw, file, "UseCase");
    if (!useCase) continue;
    const expected = basename(entry.name, extname(entry.name));
    if (useCase.id !== expected) {
      ctx.error(file, `id "${useCase.id}" must match its file name "${expected}"`);
      continue;
    }
    setSource(useCase, ctx.rel(file));
    catalog.useCases.push(useCase);
  }

  if (ctx.errors.length) throw new CatalogError(ctx.errors, root);
  sortCatalog(catalog);
  if (options.validate) {
    const problems = validateCatalog(catalog);
    if (problems.length) throw new CatalogError(problems, root);
  }
  return catalog;
}
