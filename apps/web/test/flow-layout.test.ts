import { describe, expect, it } from "vitest";
import { layoutFlow, type FlowLayout } from "../src/lib/flow-layout.ts";
import type { AgentDefinition, WorkflowStep } from "../src/types.ts";

/** A job drawn as a flow: decisions' cases side by side, loops framed round their steps, and the agent shape. */

const base: Pick<AgentDefinition, "triggers" | "tools" | "connectors" | "guardrails"> = {
  triggers: [{ type: "mailbox", mailbox: "orders@acme.com" }, { type: "manual" }],
  tools: [],
  connectors: [],
  guardrails: { approvalRequiredFor: ["mail.send"], personalData: "none" },
};

const workflow: WorkflowStep[] = [
  { id: "read", type: "extract", from: "{{ input.email.attachments }}" },
  {
    id: "route",
    type: "branch",
    cases: [
      { when: "input.total > 1000", steps: [{ id: "approve", type: "approval", title: "Big order" }] },
      { when: "input.country == 'TR'", steps: [{ id: "local", type: "output", value: { local: true } }] },
    ],
  },
  {
    id: "lines",
    type: "each",
    over: "{{ input.lines }}",
    steps: [
      { id: "check", type: "llm.generate", prompt: "Check {{ item }}" },
      { id: "keep", type: "output", value: { ok: true } },
    ],
  },
  { id: "result", type: "output", value: { done: true } },
];

/** Two boxes overlap. */
function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function nodeOf(layout: FlowLayout, id: string) {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

describe("a job as a flow", () => {
  const layout = layoutFlow({ ...base, workflow });

  it("starts with what starts it, and runs its steps top to bottom to the end", () => {
    const starts = layout.nodes.filter((n) => n.kind === "trigger").map((n) => n.title);
    expect(starts).toEqual(["Email to orders@acme.com", "People give it work"]);
    expect(nodeOf(layout, "read").y).toBeGreaterThan(layout.nodes.find((n) => n.kind === "trigger")!.y);
    expect(nodeOf(layout, "route").y).toBeGreaterThan(nodeOf(layout, "read").y);
    expect(nodeOf(layout, "result").y).toBeGreaterThan(nodeOf(layout, "route").y);
    expect(nodeOf(layout, "end").y).toBeGreaterThan(nodeOf(layout, "result").y);
    for (const start of layout.nodes.filter((n) => n.kind === "trigger")) {
      expect(layout.edges.some((e) => e.from === start.id && e.to === "read")).toBe(true);
    }
  });

  it("puts a decision's cases side by side, labelled with their conditions, with an otherwise lane", () => {
    const approve = nodeOf(layout, "approve");
    const local = nodeOf(layout, "local");
    expect(approve.y).toBe(local.y);
    expect(approve.x).toBeLessThan(local.x);
    const labels = layout.edges.filter((e) => e.from === "route").map((e) => e.label);
    expect(labels).toEqual(["‹total› > 1000", "‹country› == 'TR'", "Otherwise"]);
    expect(nodeOf(layout, "route-2-nothing").kind).toBe("nothing");
    expect(approve.tone).toBe("amber");
  });

  it("frames a loop round its steps", () => {
    const frame = layout.groups.find((g) => g.stepId === "lines")!;
    expect(frame.title).toBe("For each item of ‹lines›");
    for (const id of ["check", "keep"]) {
      const node = nodeOf(layout, id);
      expect(node.x).toBeGreaterThanOrEqual(frame.x);
      expect(node.y).toBeGreaterThanOrEqual(frame.y);
      expect(node.x + node.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(node.y + node.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
    expect(layout.edges.some((e) => e.from === "check" && e.to === "keep")).toBe(true);
  });

  it("never lays two nodes over each other, and fits them all", () => {
    for (const [i, a] of layout.nodes.entries()) {
      for (const b of layout.nodes.slice(i + 1)) expect(overlaps(a, b), `${a.id} and ${b.id}`).toBe(false);
      expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
      expect(a.y + a.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("draws a job without fixed steps as the AI employee working each task out, and what it asks a person first", () => {
    const agent = layoutFlow({ ...base, workflow: [], tools: ["documents.read", "mail.send"], connectors: [{ ref: "erp", category: "erp", purpose: "SAP" }] });
    expect(agent.nodes.map((n) => n.kind)).toEqual(["trigger", "trigger", "agent", "asks", "end"]);
    expect(nodeOf(agent, "agent").subtitle).toBe("reads files · sends email · uses SAP");
    expect(nodeOf(agent, "asks").subtitle).toBe("sending email");
  });

  it("says what started a run instead of the duties", () => {
    const run = layoutFlow({ ...base, workflow }, { starts: ["Webhook"] });
    expect(run.nodes.filter((n) => n.kind === "trigger").map((n) => n.title)).toEqual(["Webhook"]);
  });
});
