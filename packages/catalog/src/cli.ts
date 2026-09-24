/**
 * Catalog CLI.
 *
 *   tsx src/cli.ts validate [--root <dir>]      counts + schema and cross-reference problems (exit 1 on problems)
 *   tsx src/cli.ts list [--root <dir>]          departments -> processes -> agents
 *   tsx src/cli.ts search <text> [--root <dir>] rank templates for a description (as the Agent Builder does)
 */
import type { Catalog } from "@enterprise-brain/core";
import { agentsForProcess, processesForDepartment } from "./finders.ts";
import { CatalogError, DEFAULT_CATALOG_DIR, loadCatalog } from "./loader.ts";
import { searchCatalog } from "./search.ts";
import { validateCatalog } from "./validate.ts";

const USAGE = `Usage: catalog <command> [--root <dir>]

Commands:
  validate        Load and validate the catalog; prints counts and problems (exit code 1 on problems)
  list            Print departments -> processes -> agents
  search <text>   Rank templates for a free-text description (EN/TR)`;

function parseArgs(argv: string[]): { command?: string; rest: string[]; root: string } {
  const rest: string[] = [];
  let root = DEFAULT_CATALOG_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--root") root = argv[++i] ?? root;
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else rest.push(arg);
  }
  const [command, ...args] = rest;
  return { command, rest: args, root };
}

function counts(catalog: Catalog): string {
  const pad = (label: string, n: number) => `  ${label.padEnd(12)} ${String(n).padStart(3)}`;
  return [
    pad("departments", catalog.departments.length),
    pad("processes", catalog.processes.length),
    pad("agents", catalog.agents.length),
    pad("use cases", catalog.useCases.length),
  ].join("\n");
}

async function load(root: string): Promise<Catalog | undefined> {
  try {
    return await loadCatalog(root);
  } catch (error) {
    if (error instanceof CatalogError) {
      console.error(`Catalog at ${error.rootDir} could not be loaded (${error.errors.length} problem${error.errors.length === 1 ? "" : "s"}):`);
      for (const e of error.errors) console.error(`  - ${e}`);
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const { command, rest, root } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "validate": {
      const catalog = await load(root);
      if (!catalog) return 1;
      console.log(`Catalog: ${root}\n${counts(catalog)}`);
      const problems = validateCatalog(catalog);
      if (problems.length) {
        console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
        for (const p of problems) console.error(`  - ${p}`);
        return 1;
      }
      console.log("\nNo problems found.");
      return 0;
    }
    case "list": {
      const catalog = await load(root);
      if (!catalog) return 1;
      for (const department of catalog.departments) {
        console.log(`${department.name} (${department.id})`);
        for (const process of processesForDepartment(catalog, department.id)) {
          const agents = agentsForProcess(catalog, process.id).map((a) => `${a.id} [${a.archetype}]`);
          console.log(`  - ${process.id}: ${process.name}${agents.length ? ` -> ${agents.join(", ")}` : ""}`);
        }
      }
      console.log(`\n${counts(catalog)}`);
      return 0;
    }
    case "search": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.error("search needs a description, e.g.: search \"an agent that screens CVs\"");
        return 2;
      }
      const catalog = await load(root);
      if (!catalog) return 1;
      const results = searchCatalog(catalog, text);
      if (!results.length) console.log("No matching templates.");
      for (const r of results) {
        console.log(`${r.score.toFixed(2).padStart(7)}  ${r.kind.padEnd(10)} ${r.id.padEnd(40)} ${r.matched.slice(0, 5).join(", ")}`);
      }
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

// Piping into `head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

process.exitCode = await main();
