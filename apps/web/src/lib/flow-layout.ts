import type { AgentDefinition, TriggerSpec, WorkflowStep } from "../types.ts";
import { describeStep, describeTrigger, plainCondition, plainTemplate } from "./labels.ts";

/**
 * A job drawn as a flow, laid out from its definition: what starts it in a row at the top, its steps
 * top to bottom, a decision's cases side by side (merging below), a loop as a frame around its steps,
 * and the end. A job without fixed steps draws as what starts it, the AI employee working each task out
 * with what it may use, and what it asks a person first. Pure: positions only, in pixels.
 */

export type FlowTone = "neutral" | "brand" | "amber" | "violet" | "green" | "sky";

export interface FlowNode {
  id: string;
  kind: "trigger" | "step" | "decision" | "end" | "agent" | "asks" | "nothing";
  /** The step it draws (selection, a run's colours). */
  stepId?: string;
  stepType?: WorkflowStep["type"];
  title: string;
  subtitle?: string;
  tone: FlowTone;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A loop's frame around its steps. */
export interface FlowGroup {
  id: string;
  stepId: string;
  title: string;
  subtitle?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** A decision's case, written on the way into its lane. */
  label?: string;
  labelAt?: { x: number; y: number };
  points: { x: number; y: number }[];
}

export interface FlowLayout {
  nodes: FlowNode[];
  groups: FlowGroup[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

export interface FlowOptions {
  /** Narrower nodes (a small card, a phone). */
  compact?: boolean;
  /** What starts it, instead of its duties (a run: what started that run). */
  starts?: string[];
}

interface Metrics {
  W: number;
  H: number;
  GAP_Y: number;
  GAP_X: number;
  LANE_TOP: number;
  PAD: number;
  HEADER: number;
  MARGIN: number;
}

const FULL: Metrics = { W: 232, H: 60, GAP_Y: 36, GAP_X: 28, LANE_TOP: 64, PAD: 16, HEADER: 34, MARGIN: 16 };
const COMPACT: Metrics = { W: 176, H: 52, GAP_Y: 28, GAP_X: 18, LANE_TOP: 56, PAD: 12, HEADER: 30, MARGIN: 8 };

/** A place edges start from (its bottom) or end at (its top). */
interface Anchor {
  id: string;
  cx: number;
  top: number;
  bottom: number;
}

interface Placed {
  entries: Anchor[];
  exits: Anchor[];
}

const TONES: Partial<Record<WorkflowStep["type"], FlowTone>> = {
  approval: "amber",
  wait: "violet",
  output: "green",
  respond: "green",
  call: "sky",
  "chat.send": "sky",
  "mail.send": "sky",
  agent: "brand",
};

function stepTitle(step: WorkflowStep): string {
  return step.name ? plainTemplate(step.name) : describeStep(step);
}

/** What the AI employee may use, in a few words each (the agent shape's subtitle). */
function abilities(definition: Pick<AgentDefinition, "tools" | "connectors">): string[] {
  const tools = new Set(definition.tools);
  const out: string[] = [];
  if (tools.has("documents.read")) out.push("reads files");
  if (tools.has("excel.read") || tools.has("excel.write")) out.push("works with Excel");
  if (tools.has("knowledge.search")) out.push("searches knowledge");
  if (tools.has("mail.send")) out.push("sends email");
  else if (tools.has("mail.draft")) out.push("drafts email");
  if (tools.has("web.search")) out.push("searches the web");
  if (tools.has("company.lookup")) out.push("asks the company brain");
  for (const binding of definition.connectors) out.push(binding.ref === "tables" ? "keeps tables" : `uses ${binding.purpose ?? binding.ref}`);
  return out;
}

/** The ways work reaches it, once each ("People give it work" for the app and Chat). */
function startsOf(triggers: TriggerSpec[]): string[] {
  const out: string[] = [];
  for (const trigger of triggers) {
    const text = trigger.type === "manual" || trigger.type === "chat" ? "People give it work" : describeTrigger(trigger);
    if (!out.includes(text)) out.push(text);
  }
  return out.length ? out : ["People give it work"];
}

export function layoutFlow(
  definition: Pick<AgentDefinition, "workflow" | "triggers" | "tools" | "connectors" | "guardrails">,
  options: FlowOptions = {},
): FlowLayout {
  const m = options.compact ? COMPACT : FULL;
  const nodes: FlowNode[] = [];
  const groups: FlowGroup[] = [];
  const edges: FlowEdge[] = [];
  let edgeCount = 0;

  const connect = (from: Anchor, to: Anchor, label?: string) => {
    const mid = from.bottom + Math.min(m.GAP_Y / 2, Math.max(8, (to.top - from.bottom) / 2));
    const points =
      from.cx === to.cx
        ? [
            { x: from.cx, y: from.bottom },
            { x: to.cx, y: to.top },
          ]
        : [
            { x: from.cx, y: from.bottom },
            { x: from.cx, y: mid },
            { x: to.cx, y: mid },
            { x: to.cx, y: to.top },
          ];
    edges.push({
      id: `e${edgeCount++}`,
      from: from.id,
      to: to.id,
      points,
      ...(label ? { label, labelAt: { x: to.cx, y: to.top - 12 } } : {}),
    });
  };

  // ---- measuring -----------------------------------------------------------
  const sizes = new Map<WorkflowStep, { width: number; height: number }>();

  const measureSequence = (steps: readonly WorkflowStep[]): { width: number; height: number } => {
    if (!steps.length) return { width: m.W, height: m.H - 18 };
    let width = 0;
    let height = 0;
    for (const step of steps) {
      const size = measure(step);
      width = Math.max(width, size.width);
      height += size.height;
    }
    return { width, height: height + m.GAP_Y * (steps.length - 1) };
  };

  const lanesOf = (step: Extract<WorkflowStep, { type: "branch" }>) => [
    ...step.cases.map((c) => ({ label: plainCondition(c.when), steps: c.steps })),
    { label: "Otherwise", steps: step.else ?? [] },
  ];

  const measure = (step: WorkflowStep): { width: number; height: number } => {
    const known = sizes.get(step);
    if (known) return known;
    let size: { width: number; height: number };
    if (step.type === "branch") {
      const lanes = lanesOf(step).map((lane) => measureSequence(lane.steps));
      const lanesWidth = lanes.reduce((sum, l) => sum + l.width, 0) + m.GAP_X * (lanes.length - 1);
      size = { width: Math.max(m.W, lanesWidth), height: m.H + m.LANE_TOP + Math.max(...lanes.map((l) => l.height)) };
    } else if (step.type === "each") {
      const inner = measureSequence(step.steps);
      size = { width: inner.width + 2 * m.PAD, height: m.HEADER + inner.height + m.PAD };
    } else {
      size = { width: m.W, height: m.H };
    }
    sizes.set(step, size);
    return size;
  };

  // ---- placing --------------------------------------------------------------
  const anchorOf = (node: FlowNode): Anchor => ({ id: node.id, cx: node.x + node.width / 2, top: node.y, bottom: node.y + node.height });

  const addNode = (node: FlowNode): Anchor => {
    nodes.push(node);
    return anchorOf(node);
  };

  const placeSequence = (steps: readonly WorkflowStep[], x: number, y: number, width: number, key: string): Placed => {
    if (!steps.length) {
      const anchor = addNode({
        id: `${key}-nothing`,
        kind: "nothing",
        title: "Nothing more",
        tone: "neutral",
        x: x + (width - m.W) / 2,
        y,
        width: m.W,
        height: m.H - 18,
      });
      return { entries: [anchor], exits: [anchor] };
    }
    let first: Anchor[] = [];
    let previous: Anchor[] = [];
    let top = y;
    for (const [i, step] of steps.entries()) {
      const size = measure(step);
      const placed = place(step, x + (width - size.width) / 2, top);
      if (i === 0) first = placed.entries;
      else for (const from of previous) for (const to of placed.entries) connect(from, to);
      previous = placed.exits;
      top += size.height + m.GAP_Y;
    }
    return { entries: first, exits: previous };
  };

  const place = (step: WorkflowStep, x: number, y: number): Placed => {
    const size = measure(step);
    if (step.type === "branch") {
      const decision = addNode({
        id: step.id,
        kind: "decision",
        stepId: step.id,
        stepType: step.type,
        title: step.name ? plainTemplate(step.name) : "Decide",
        subtitle: `${step.cases.length + 1} ways on`,
        tone: "brand",
        x: x + (size.width - m.W) / 2,
        y,
        width: m.W,
        height: m.H,
      });
      const lanes = lanesOf(step);
      const widths = lanes.map((lane) => measureSequence(lane.steps).width);
      const lanesWidth = widths.reduce((sum, w) => sum + w, 0) + m.GAP_X * (lanes.length - 1);
      let laneX = x + (size.width - lanesWidth) / 2;
      const exits: Anchor[] = [];
      lanes.forEach((lane, i) => {
        const placed = placeSequence(lane.steps, laneX, y + m.H + m.LANE_TOP, widths[i]!, `${step.id}-${i}`);
        for (const entry of placed.entries) connect(decision, entry, lane.label);
        exits.push(...placed.exits);
        laneX += widths[i]! + m.GAP_X;
      });
      return { entries: [decision], exits };
    }
    if (step.type === "each") {
      const group: FlowGroup = {
        id: `${step.id}-frame`,
        stepId: step.id,
        title: step.name ? plainTemplate(step.name) : `For each ${step.as ?? "item"} of ${plainTemplate(step.over)}`,
        subtitle: [step.batchSize ? `in batches of ${step.batchSize}` : "", `at most ${step.maxItems ?? 200}`].filter(Boolean).join(" · "),
        x,
        y,
        width: size.width,
        height: size.height,
      };
      groups.push(group);
      placeSequence(step.steps, x + m.PAD, y + m.HEADER, size.width - 2 * m.PAD, step.id);
      const anchor: Anchor = { id: group.id, cx: x + size.width / 2, top: y, bottom: y + size.height };
      return { entries: [anchor], exits: [anchor] };
    }
    const anchor = addNode({
      id: step.id,
      kind: "step",
      stepId: step.id,
      stepType: step.type,
      title: stepTitle(step),
      subtitle: step.when ? `Only when ${plainCondition(step.when)}` : step.name ? describeStep(step) : undefined,
      tone: TONES[step.type] ?? "neutral",
      x,
      y,
      width: m.W,
      height: m.H,
    });
    return { entries: [anchor], exits: [anchor] };
  };

  // ---- the whole job ------------------------------------------------------------
  const starts = options.starts?.length ? options.starts : startsOf(definition.triggers);
  const workflow = definition.workflow;
  const asks = definition.guardrails.approvalRequiredFor
    .map((rule) => (rule === "mail.send" ? "sending email" : rule.startsWith("connector") ? "changes in systems" : rule))
    .filter((v, i, all) => all.indexOf(v) === i);
  const body = workflow.length ? measureSequence(workflow) : { width: m.W, height: m.H * (asks.length ? 2 : 1) + (asks.length ? m.GAP_Y : 0) };
  // What starts it: pills as wide as a step when they fit above the steps, else narrower ones.
  const rowOf = (w: number) => starts.length * w + (starts.length - 1) * m.GAP_X;
  const startW = rowOf(m.W) <= Math.max(body.width, m.W) ? m.W : Math.round(m.W * 0.8);
  const startsWidth = rowOf(startW);
  const width = Math.max(body.width, startsWidth) + 2 * m.MARGIN;

  let startX = (width - startsWidth) / 2;
  const startAnchors = starts.map((title, i) => {
    const anchor = addNode({ id: `start-${i}`, kind: "trigger", title, tone: "neutral", x: startX, y: m.MARGIN, width: startW, height: m.H - 12 });
    startX += startW + m.GAP_X;
    return anchor;
  });
  let y = m.MARGIN + (m.H - 12) + m.GAP_Y;

  let exits: Anchor[];
  if (workflow.length) {
    const placed = placeSequence(workflow, (width - body.width) / 2, y, body.width, "job");
    for (const from of startAnchors) for (const to of placed.entries) connect(from, to);
    exits = placed.exits;
    y += body.height + m.GAP_Y;
  } else {
    const can = abilities(definition);
    const agent = addNode({
      id: "agent",
      kind: "agent",
      title: "Works out each task with its tools",
      subtitle: can.length ? can.slice(0, 4).join(" · ") + (can.length > 4 ? " …" : "") : "With its instructions",
      tone: "brand",
      x: (width - m.W) / 2,
      y,
      width: m.W,
      height: m.H,
    });
    for (const from of startAnchors) connect(from, agent);
    exits = [agent];
    y += m.H + m.GAP_Y;
    if (asks.length) {
      const asking = addNode({
        id: "asks",
        kind: "asks",
        title: "Asks a person first",
        subtitle: asks.join(", "),
        tone: "amber",
        x: (width - m.W) / 2,
        y,
        width: m.W,
        height: m.H,
      });
      connect(agent, asking);
      exits = [asking];
      y += m.H + m.GAP_Y;
    }
  }
  const end = addNode({ id: "end", kind: "end", title: "Done", tone: "neutral", x: (width - m.W / 2) / 2, y, width: m.W / 2, height: m.H - 24 });
  for (const from of exits) connect(from, end);

  return { nodes, groups, edges, width, height: y + (m.H - 24) + m.MARGIN };
}
