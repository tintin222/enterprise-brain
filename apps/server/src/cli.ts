import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCatalog } from "@enterprise-brain/catalog";
import { exportCompanyPackage } from "@enterprise-brain/paperclip";

/**
 * Enterprise Brain CLI.
 *
 *   pnpm paperclip:export --out ./paperclip-acme [--departments hr,finance] [--name "Acme"] [--slug acme] [--url https://brain.acme.com]
 *
 * Exports catalog templates as a Paperclip company package (no running server needed).
 * To export a company's *installed* organisation use GET /api/companies/:company/paperclip/package.zip.
 */
async function paperclipExport(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string", default: "./paperclip-package" },
      departments: { type: "string" },
      name: { type: "string", default: "Acme Endüstri A.Ş." },
      slug: { type: "string", default: "acme" },
      url: { type: "string", default: process.env.EB_PUBLIC_URL ?? "http://localhost:3200" },
      "no-ceo": { type: "boolean", default: false },
    },
  });
  const catalog = await loadCatalog();
  const only = values.departments?.split(",").map((d) => d.trim()).filter(Boolean);
  const keep = (dept: string) => !only?.length || only.includes(dept);
  const result = exportCompanyPackage(
    {
      departments: catalog.departments.filter((d) => keep(d.id)),
      processes: catalog.processes.filter((p) => keep(p.department)),
      agents: catalog.agents.filter((a) => keep(a.department)),
    },
    {
      company: { name: values.name!, slug: values.slug! },
      enterpriseBrain: { url: values.url!, companySlug: values.slug! },
      includeCeo: !values["no-ceo"],
    },
  );
  const outDir = resolve(values.out!);
  for (const [path, content] of Object.entries(result.files)) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  console.log(`Wrote ${Object.keys(result.files).length} files to ${outDir}`);
  console.log(`  ${result.summary.departments} departments, ${result.summary.agents} agents, ${result.summary.routines} routines`);
  for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
  console.log(`\nImport into Paperclip:\n  paperclipai company import ${outDir} --include company,agents,projects,issues,skills`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "paperclip-export":
    await paperclipExport(rest);
    break;
  default:
    console.log("Usage: tsx src/cli.ts paperclip-export --out <dir> [--departments hr,finance] [--name <company>] [--slug <slug>] [--url <public url>] [--no-ceo]");
    process.exitCode = command ? 1 : 0;
}
