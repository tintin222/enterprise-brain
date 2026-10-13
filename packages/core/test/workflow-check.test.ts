import { describe, expect, it } from "vitest";
import { WorkflowStep, walkSteps, type WorkflowStepInput } from "../src/agent.ts";
import { checkWorkflow } from "../src/workflow-check.ts";

/** A procedure with every kind of step that holds steps or reshapes data, as a job would write it. */
const procedure: WorkflowStepInput[] = [
  {
    id: "lines",
    type: "transform",
    from: "{{ input.order.lines }}",
    ops: [
      { op: "filter", where: "item.qty > 0" },
      { op: "sort", by: "sku" },
    ],
  },
  {
    id: "route",
    type: "branch",
    cases: [
      { id: "big", when: "sum(steps.lines.items, 'total') > vars.limit", steps: [{ id: "ask", type: "approval", title: "Approve {{ input.order.ref }}" }] },
    ],
    else: [{ id: "note", type: "chat.send", to: "#finance", text: "Order {{ input.order.ref }} is small" }],
  },
  {
    id: "each_line",
    type: "each",
    over: "{{ steps.lines.items }}",
    as: "line",
    steps: [
      { id: "price", type: "code", code: "return ctx.item.qty * ctx.item.price;", input: { sku: "{{ line.sku }}" } },
      { id: "book", type: "connector", connector: "erp", operation: "post", input: { amount: "{{ steps.price }}", index: "{{ index }}" } },
    ],
    collect: { sku: "{{ item.sku }}", price: "{{ steps.price }}" },
  },
  { id: "result", type: "output", value: { lines: "{{ steps.each_line.items }}" } },
];

describe("procedures", () => {
  it("parse with steps inside branches and loops, and walk them in order", () => {
    const steps = procedure.map((s) => WorkflowStep.parse(s));
    expect([...walkSteps(steps)].map((v) => `${"  ".repeat(v.depth)}${v.step.id}${v.inLoop ? " (each)" : ""}`)).toEqual([
      "lines",
      "route",
      "  ask",
      "  note",
      "each_line",
      "  price (each)",
      "  book (each)",
      "result",
    ]);
    // Defaults fill in inside nested steps too.
    const book = [...walkSteps(steps)].find((v) => v.step.id === "book")!.step;
    expect(book.type === "connector" && book.input.index).toBe("{{ index }}");
  });

  it("finds nothing wrong in a sound procedure", () => {
    const steps = procedure.map((s) => WorkflowStep.parse(s));
    expect(checkWorkflow(steps, { inputs: ["order"] })).toEqual([]);
  });

  it("says what is wrong: repeated ids, steps not run yet, item outside a loop, unknown functions and filters", () => {
    const steps = [
      { id: "a", type: "output", value: { x: "{{ steps.b.total }}" } },
      { id: "b", type: "transform", from: "{{ item.lines }}", ops: [{ op: "set", fields: { y: "{{ shout(item.x) }}" } }] },
      { id: "loop", type: "each", over: "{{ input.rows }}", steps: [{ id: "a", type: "output", value: { z: "{{ item | yell }}" } }] },
    ].map((s) => WorkflowStep.parse(s));
    const problems = checkWorkflow(steps, { inputs: ["rows"] });
    expect(problems).toEqual(
      expect.arrayContaining([
        'workflow: duplicate step id "a"',
        expect.stringContaining('workflow step "a": value.x: references "steps.b", which has not run yet'),
        expect.stringContaining('workflow step "b": from: unknown reference "item.lines"'),
        expect.stringContaining('unknown function "shout"'),
        expect.stringContaining('unknown filter "yell"'),
      ]),
    );
  });
});
