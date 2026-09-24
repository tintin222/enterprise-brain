import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { CatalogError, loadCatalog, splitFrontmatter, validateCatalog } from "../src/index.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const tempDirs: string[] = [];

async function writeCatalog(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eb-catalog-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function loadErrors(root: string): Promise<string[]> {
  try {
    await loadCatalog(root);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogError);
    return (error as CatalogError).errors;
  }
  throw new Error("expected the catalog to be rejected");
}

const DEPARTMENT = `id: demo
name: Demo
summary: A demo department.
mission: Test the loader.
roles:
  - id: demo-manager
    title: Demo Manager
processes: [demo.intake, demo.missing]
`;

const PROCESS = `id: demo.intake
department: demo
name: Intake
summary: Intake of demo requests.
trigger:
  type: manual
  description: Started by hand.
steps:
  - {id: run, name: Run, actor: "agent:demo.worker"}
  - {id: ghost, name: Ghost, actor: "agent:demo.ghost"}
  - {id: approve, name: Approve, actor: "human:demo-manager", approval: true}
  - {id: robot, name: Robot, actor: "system:mainframe"}
agents: [demo.worker]
useCases: [teleportation]
`;

const AGENT = `---
id: demo.worker
slug: demo-worker
name: Worker
summary: Test agent.
department: demo
process: demo.intake
archetype: process-automation
capabilities: [connector:erp.search_suppliers, connector:erp.update_supplier_invoice_status, teleport]
connectors:
  - {ref: erp, category: erp, operations: [search_suppliers, update_supplier_invoice_status]}
inputs:
  - {key: query, type: string}
outputs:
  - {key: answer, type: string}
workflow:
  - id: early
    type: llm.generate
    prompt: "Use {{ steps.late.text }} and {{ input.missing }} and {{ stepz.x }}"
  - id: lookup
    type: connector
    connector: erp
    operation: delete_everything
  - id: ticket
    type: connector
    connector: itsm
    operation: create_ticket
  - id: block
    type: connector
    connector: erp
    operation: update_supplier_invoice_status
    requiresApproval: false
    input:
      invoice_number: "{{ input.query }}"
      status: shredded
      colour: blue
  - id: judge
    type: llm.evaluate
    from: "{{ input.query }}"
    criteria:
      - {id: permit, label: Permit, kind: knockout, keywords: [work permit], blockers: [work permit, needs sponsorship]}
  - id: late
    type: llm.generate
    prompt: "Hello {{ input.query | shout }}"
    fallback: Hi
tools: [teleport]
builder:
  questions:
    - {id: demo.channels, section: inputs, title: Channels, question: Where from?, replaces: [inputs.channels]}
    - {id: demo.criteria, section: processing, title: Criteria, question: How to judge?, answerType: criteria, replaces: [docs.criteria, demo.channels]}
---
Instructions for the demo worker.
`;

describe("loadCatalog on a broken catalog", () => {
  it("collects every schema error with its file path in one CatalogError", async () => {
    const root = await writeCatalog({
      "departments/sales/department.yaml": "id: sales\nname: [unclosed\n",
      "departments/hr/department.yaml": "id: hr\nname: HR\nsummary: People.\nmissoin: typo\n",
      "departments/hr/processes/recruitment.yaml": [
        "id: hr.recruitment",
        "department: hr",
        "name: Recruitment",
        "summary: Hiring.",
        "trigger: {type: carrier-pigeon, description: Birds}",
        "steps:",
        "  - {id: screen, name: Screen, actor: robot:screener}",
      ].join("\n"),
      "departments/hr/agents/cv-screener.md": "No frontmatter here.\n",
      "departments/hr/agents/bad-step.md": [
        "---",
        "id: hr.bad-step",
        "slug: hr-bad-step",
        "name: Bad",
        "summary: Broken steps.",
        "department: hr",
        "archetype: document-processing",
        "workflow:",
        "  - {id: read, type: extractt, from: x}",
        "  - id: judge",
        "    type: llm.evaluate",
        "    from: x",
        "    criteria: [{id: c, label: C, kind: must-have}]",
        "---",
        "Instructions.",
      ].join("\n"),
      "departments/hr/agents/elsewhere.md": "---\nid: finance.elsewhere\nslug: finance-elsewhere\nname: E\nsummary: S\ndepartment: finance\narchetype: search\n---\nBody.\n",
      "use-cases/demo.yaml": "id: other-id\nname: Demo\narchetype: search\nsummary: S\ndescription: D\n",
    });
    const errors = await loadErrors(root);
    const find = (path: string, text: string) => errors.find((e) => e.startsWith(path) && e.includes(text));

    expect(find("departments/sales/department.yaml", "YAML syntax error at line")).toBeDefined();
    expect(find("departments/hr/department.yaml", "mission: required")).toBeDefined();
    expect(find("departments/hr/department.yaml", "missoin: unknown key")).toBeDefined();
    expect(find("departments/hr/processes/recruitment.yaml", "trigger.type: Invalid option")).toBeDefined();
    expect(find("departments/hr/processes/recruitment.yaml", "steps[0](screen).actor")).toBeDefined();
    expect(find("departments/hr/agents/cv-screener.md", "missing YAML frontmatter")).toBeDefined();
    expect(find("departments/hr/agents/bad-step.md", "workflow[0](read).type")).toBeDefined();
    expect(find("departments/hr/agents/bad-step.md", "workflow[1](judge).criteria[0](c).kind")).toBeDefined();
    expect(find("departments/hr/agents/elsewhere.md", 'must be "hr.elsewhere"')).toBeDefined();
    expect(find("use-cases/demo.yaml", 'must match its file name "demo"')).toBeDefined();
  });

  it("formats a readable message and rejects a missing directory", async () => {
    const root = await writeCatalog({ "departments/x/department.yaml": "id: x\n" });
    await expect(loadCatalog(root)).rejects.toThrow(/Invalid catalog at .* \(\d+ problems?\):\n {2}- departments\/x\/department.yaml: name: required/);
    await expect(loadCatalog(join(root, "nope"))).rejects.toThrow(/catalog directory not found/);
  });
});

describe("validateCatalog on an inconsistent catalog", () => {
  it("reports cross-reference, connector and template problems with file paths", async () => {
    const root = await writeCatalog({
      "departments/demo/department.yaml": DEPARTMENT,
      "departments/demo/processes/intake.yaml": PROCESS,
      "departments/demo/agents/worker.md": AGENT,
    });
    const catalog = await loadCatalog(root);
    const problems = validateCatalog(catalog);
    const agentFile = "departments/demo/agents/worker.md";
    const has = (path: string, text: string) =>
      expect(problems.some((p) => p.startsWith(path) && p.includes(text)), `${path}: ${text}\n${problems.join("\n")}`).toBe(true);

    has("departments/demo/department.yaml", 'process "demo.missing" does not exist');
    has("departments/demo/processes/intake.yaml", 'actor "agent:demo.ghost" is not an agent template');
    has("departments/demo/processes/intake.yaml", 'actor "system:mainframe" is not a known system category');
    has("departments/demo/processes/intake.yaml", 'use case "teleportation" does not exist');
    has(agentFile, 'references "steps.late", which has not run yet');
    has(agentFile, 'references "input.missing", which is not a declared input');
    has(agentFile, 'unknown reference "stepz.x"');
    has(agentFile, 'workflow step "early": llm.generate needs a fallback');
    has(agentFile, 'has no operation "delete_everything"');
    has(agentFile, 'connector "itsm" is not declared in connectors');
    has(agentFile, 'status "shredded" is not allowed');
    has(agentFile, 'unknown input "colour"');
    has(agentFile, "requiresApproval is false but the step is not conditioned on an earlier approval step");
    has(agentFile, 'unknown filter "shout"');
    has(agentFile, 'unknown capability "teleport"');
    has(agentFile, 'workflow must end with an "output" step');
    has(agentFile, 'criterion "permit" lists "work permit" both as keyword and as blocker');
    has(agentFile, 'builder.questions.demo.channels: must not replace "inputs.channels"');
    has(agentFile, 'builder.questions.demo.criteria: replaces "demo.channels", which is a question of this template');

    await expect(loadCatalog(root, { validate: true })).rejects.toBeInstanceOf(CatalogError);
  });
});

describe("splitFrontmatter", () => {
  it("splits YAML frontmatter from the Markdown body", () => {
    const doc = splitFrontmatter("﻿---\r\nid: a.b\r\n---\r\n\r\n# Title\r\nBody\r\n");
    expect(doc.frontmatter).toBe("id: a.b");
    expect(doc.body).toBe("# Title\nBody");
  });

  it("rejects files without a closing line", () => {
    expect(() => splitFrontmatter("---\nid: a.b\n")).toThrow(/unterminated/);
  });
});

describe("cli", () => {
  it("validates the shipped catalog and fails on a broken one", async () => {
    const ok = await run(process.execPath, ["--import", "tsx", CLI, "validate"], { cwd: REPO_ROOT });
    expect(ok.stdout).toMatch(/agents\s+\d+/);
    expect(ok.stdout).toContain("No problems found.");

    const root = await writeCatalog({
      "departments/demo/department.yaml": DEPARTMENT,
      "departments/demo/processes/intake.yaml": PROCESS,
      "departments/demo/agents/worker.md": AGENT,
    });
    const failed = await run(process.execPath, ["--import", "tsx", CLI, "validate", "--root", root], { cwd: REPO_ROOT }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain("problems:");
  });
});
