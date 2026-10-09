import { clsx } from "clsx";
import { ArrowRight, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ButtonLink } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Segmented } from "../../components/Tabs.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { paths } from "../../lib/paths.ts";
import type { BrainGraph, BrainModel } from "../../types.ts";
import { DIMENSION_COLORS, brainPath, colorsOf, kindIcon, kindOf, useBrainEntity, useBrainGraph, useBrainModel, useBrainOverview } from "./brain.tsx";

interface Placed {
  id: string;
  kind: string;
  name: string;
  depth: number;
  x: number;
  y: number;
}

/**
 * Rings around the focus: what links to it on the first ring, grouped by kind; what links to those
 * on the second, next to the thing it hangs from.
 */
function layout(graph: BrainGraph, hidden: Set<string>, model: BrainModel | undefined): { nodes: Placed[]; size: number; parents: Map<string, string> } {
  const dimensionOf = (kind: string) => kindOf(model, kind)?.dimension ?? "";
  const visible = graph.nodes.filter((n) => n.depth === 0 || !hidden.has(dimensionOf(n.kind)));
  const ids = new Set(visible.map((n) => n.id));
  const center = visible.find((n) => n.depth === 0) ?? visible[0];
  if (!center) return { nodes: [], size: 600, parents: new Map() };
  const kindOrder = new Map((model?.kinds ?? []).map((k, i) => [k.key, i]));
  const first = visible
    .filter((n) => n.depth === 1)
    .sort((a, b) => (kindOrder.get(a.kind) ?? 0) - (kindOrder.get(b.kind) ?? 0) || a.name.localeCompare(b.name));
  const second = visible.filter((n) => n.depth >= 2);
  const r1 = first.length <= 6 ? 150 : first.length <= 12 ? 190 : first.length <= 24 ? 250 : 310;
  const r2 = r1 + Math.max(140, Math.min(260, second.length * 6));
  const size = 2 * (second.length ? r2 : r1) + 200;
  const c = size / 2;
  const placed: Placed[] = [{ ...center, x: c, y: c }];
  const angleOf = new Map<string, number>();
  first.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(first.length, 1) - Math.PI / 2;
    angleOf.set(node.id, angle);
    placed.push({ ...node, x: c + r1 * Math.cos(angle), y: c + r1 * Math.sin(angle) });
  });
  // Each second-ring thing sits near the first-ring thing it links to.
  const parentOf = new Map<string, string>();
  for (const node of second) {
    const edge = graph.edges.find((e) => (e.from === node.id && angleOf.has(e.to)) || (e.to === node.id && angleOf.has(e.from)));
    if (edge) parentOf.set(node.id, edge.from === node.id ? edge.to : edge.from);
  }
  const byParent = new Map<string, typeof second>();
  for (const node of second) {
    const parent = parentOf.get(node.id) ?? "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(node);
  }
  const step = (2 * Math.PI) / Math.max(second.length, 1);
  let cursor = -Math.PI / 2;
  for (const [parent, nodes] of [...byParent].sort((a, b) => (angleOf.get(a[0]) ?? 0) - (angleOf.get(b[0]) ?? 0))) {
    const base = angleOf.get(parent);
    const start = base !== undefined ? Math.max(cursor, base - (step * (nodes.length - 1)) / 2) : cursor;
    nodes.forEach((node, i) => {
      const angle = start + i * step;
      placed.push({ ...node, x: c + r2 * Math.cos(angle), y: c + r2 * Math.sin(angle) });
    });
    cursor = start + nodes.length * step;
  }
  return { nodes: placed.filter((p) => ids.has(p.id)), size, parents: parentOf };
}

function short(name: string, max = 22): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function radiusOf(node: Placed, scale: number): number {
  return (node.depth === 0 ? 30 : node.depth === 1 ? 20 : 14) * Math.max(1, scale * 0.8);
}

interface Place {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

interface Label extends Place {
  text: string;
  size: number;
  /** It covers no other name or circle; the names that don't fit show on hover. */
  fits: boolean;
}

type Box = [x1: number, y1: number, x2: number, y2: number];

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Where each name goes: under its circle, above it, or beside it away from the middle, wherever it
 * covers no other name or circle and stays on the map. Names nearer the middle are placed first.
 */
function labelsOf(nodes: Placed[], size: number, scale: number): Map<string, Label> {
  const center = size / 2;
  const circles = nodes.map((n): Box => {
    const r = radiusOf(n, scale) + 4;
    return [n.x - r, n.y - r, n.x + r, n.y + r];
  });
  const taken: Box[] = [];
  const labels = new Map<string, Label>();
  for (const node of [...nodes].sort((a, b) => a.depth - b.depth)) {
    const r = radiusOf(node, scale);
    const fontSize = (node.depth === 0 ? 17 : node.depth === 1 ? 13 : 11) * scale;
    const text = short(node.name, node.depth === 0 ? 40 : node.depth === 1 ? 24 : 22);
    // A rough width: the app's sans-serif averages a little over half a font size per character.
    const width = text.length * fontSize * 0.58;
    const gap = 6 * scale;
    const below: Place = { x: 0, y: r + gap + fontSize * 0.8, anchor: "middle" };
    const above: Place = { x: 0, y: -(r + gap + fontSize * 0.3), anchor: "middle" };
    const beside: Place = node.x >= center ? { x: r + gap, y: fontSize * 0.35, anchor: "start" } : { x: -(r + gap), y: fontSize * 0.35, anchor: "end" };
    const choices = node.depth === 0 ? [below] : node.depth === 1 ? [below, above, beside] : [beside, below, above];
    const boxOf = (place: Place): Box => {
      const x1 = node.x + place.x - (place.anchor === "middle" ? width / 2 : place.anchor === "end" ? width : 0);
      const bottom = node.y + place.y + fontSize * 0.25;
      return [x1, bottom - fontSize * 1.15, x1 + width, bottom];
    };
    const own = nodes.indexOf(node);
    const fit = choices.find((place) => {
      const box = boxOf(place);
      if (box[0] < 0 || box[1] < 0 || box[2] > size || box[3] > size) return false;
      return !taken.some((t) => overlaps(t, box)) && !circles.some((c, i) => i !== own && overlaps(c, box));
    });
    const place = fit ?? choices[0]!;
    const fits = Boolean(fit) || node.depth === 0;
    if (fits) taken.push(boxOf(place));
    labels.set(node.id, { ...place, text, size: fontSize, fits });
  }
  return labels;
}

function MapLabel({ label, depth, scale }: { label: Label; depth: number; scale: number }) {
  return (
    <text
      x={label.x}
      y={label.y}
      textAnchor={label.anchor}
      fontSize={label.size}
      // A rim in the map's own colour keeps names readable over the lines.
      stroke="var(--eb-surface)"
      strokeWidth={4 * scale}
      strokeLinejoin="round"
      paintOrder="stroke"
      className={clsx("fill-current text-fg", depth === 0 ? "font-semibold" : depth === 1 ? "font-medium" : "")}
    >
      {label.text}
    </text>
  );
}

/** The map of the brain: what is linked to what, explored by clicking. */
export default function BrainMap() {
  const [params, setParams] = useSearchParams();
  const { data: model } = useBrainModel();
  const { data: overview } = useBrainOverview();
  const focus = params.get("focus") ?? overview?.company?.id ?? null;
  const [depth, setDepth] = useState<"1" | "2">("1");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const graph = useBrainGraph(focus, Number(depth));
  const focused = useBrainEntity(focus ?? undefined);
  const placed = useMemo(
    () => (graph.data ? layout(graph.data, hidden, model) : { nodes: [], size: 600, parents: new Map<string, string>() }),
    [graph.data, hidden, model],
  );
  const at = new Map(placed.nodes.map((n) => [n.id, n]));
  // Only the links that make the rings: to the focus, and from each outer thing to the one it hangs from.
  const edges = (graph.data?.edges ?? []).filter((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) return false;
    if (a.depth === 0 || b.depth === 0) return true;
    const outer = a.depth > b.depth ? a : b;
    const inner = outer === a ? b : a;
    return outer.depth === 2 && placed.parents.get(outer.id) === inner.id;
  });
  const scale = placed.size / 700;
  const labels = useMemo(() => labelsOf(placed.nodes, placed.size, scale), [placed, scale]);
  const hoverLabel = hover ? labels.get(hover) : undefined;
  const hoverNode = hover ? at.get(hover) : undefined;
  const near = hover ? new Set(edges.filter((e) => e.from === hover || e.to === hover).flatMap((e) => [e.from, e.to])) : null;
  const go = (id: string) => setParams({ focus: id });

  return (
    <Page wide>
      <PageHeader
        icon={Share2}
        title="Map"
        description="How the company's things link together. Click a circle to move to it; open it to read everything about it."
        actions={
          <Segmented
            value={depth}
            onChange={setDepth}
            options={[
              { value: "1", label: "Direct links" },
              { value: "2", label: "Two steps" },
            ]}
          />
        }
      />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {model?.dimensions.map((d) => {
          const off = hidden.has(d.key);
          return (
            <button
              key={d.key}
              type="button"
              onClick={() =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (next.has(d.key)) next.delete(d.key);
                  else next.add(d.key);
                  return next;
                })
              }
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
                off ? "text-faint ring-line line-through" : DIMENSION_COLORS[d.key]?.chip,
              )}
            >
              <span className={clsx("size-2 rounded-full", off ? "bg-slate-300" : DIMENSION_COLORS[d.key]?.dot)} />
              {d.name}
            </button>
          );
        })}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden">
          {graph.error ? (
            <ErrorState error={graph.error} className="m-4" />
          ) : !graph.data ? (
            <Skeleton className="m-4 h-[560px]" />
          ) : placed.nodes.length === 0 ? (
            <p className="p-6 text-sm text-muted">Nothing to show yet: fill the brain in Sources.</p>
          ) : (
            <svg
              viewBox={`0 0 ${placed.size} ${placed.size}`}
              className="h-auto max-h-[78vh] w-full bg-[radial-gradient(circle,var(--eb-line)_1px,transparent_1px)] [background-size:22px_22px]"
              role="img"
              aria-label="Map of the company brain"
            >
              <g>
                {edges.map((edge) => {
                  const a = at.get(edge.from)!;
                  const b = at.get(edge.to)!;
                  const lit = near ? near.has(edge.from) && near.has(edge.to) && (edge.from === hover || edge.to === hover) : false;
                  return (
                    <line
                      key={edge.id}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className={clsx("transition-opacity", lit ? "stroke-brand-500" : "stroke-slate-300 dark:stroke-slate-600")}
                      strokeWidth={lit ? 2 : 1}
                      opacity={near && !lit ? 0.25 : 0.9}
                    >
                      <title>{`${a.name} — ${edge.label.toLowerCase()} → ${b.name}${edge.detail ? ` (${edge.detail})` : ""}`}</title>
                    </line>
                  );
                })}
              </g>
              <g>
                {placed.nodes.map((node) => {
                  const Icon = kindIcon(node.kind);
                  const colors = colorsOf(model, node.kind);
                  const r = radiusOf(node, scale);
                  const label = labels.get(node.id);
                  const dim = near && !near.has(node.id) && node.id !== hover;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${node.x} ${node.y})`}
                      className="cursor-pointer"
                      opacity={dim ? 0.35 : 1}
                      onClick={() => go(node.id)}
                      onMouseEnter={() => setHover(node.id)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <title>{`${kindOf(model, node.kind)?.name ?? node.kind}: ${node.name}`}</title>
                      <circle r={r + 4} className={clsx(colors.soft)} />
                      <circle r={r} className={clsx(colors.fill)} />
                      <Icon x={-r * 0.55} y={-r * 0.55} width={r * 1.1} height={r * 1.1} className="text-white" strokeWidth={2} />
                      {label?.fits && <MapLabel label={label} depth={node.depth} scale={scale} />}
                    </g>
                  );
                })}
              </g>
              {/* A name that didn't fit, over everything while its circle is pointed at. */}
              {hoverNode && hoverLabel && !hoverLabel.fits && (
                <g transform={`translate(${hoverNode.x} ${hoverNode.y})`} pointerEvents="none">
                  <MapLabel label={hoverLabel} depth={hoverNode.depth} scale={scale} />
                </g>
              )}
            </svg>
          )}
          {graph.data && graph.data.more > 0 && (
            <p className="border-t border-line px-4 py-2 text-xs text-muted">{graph.data.more} more links are not drawn; move to a thing to see its own.</p>
          )}
        </Card>
        <div className="space-y-4">
          {focused.data && (
            <Card className="p-4">
              <p className="text-xs font-medium text-muted">{kindOf(model, focused.data.kind)?.name}</p>
              <p className="mt-0.5 text-base font-semibold text-fg">{focused.data.name}</p>
              {focused.data.summary && <p className="mt-1 line-clamp-4 text-[13px] text-muted">{focused.data.summary}</p>}
              <ButtonLink to={brainPath(focused.data.id)} size="sm" variant="primary" iconRight={ArrowRight} className="mt-3">
                Open
              </ButtonLink>
              <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
                {Object.entries(
                  focused.data.links.reduce<Record<string, number>>((acc, link) => {
                    acc[link.label] = (acc[link.label] ?? 0) + 1;
                    return acc;
                  }, {}),
                ).map(([label, n]) => (
                  <li key={label} className="flex justify-between text-xs">
                    <span className="text-muted">{label}</span>
                    <span className="text-fg tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="p-4">
            <p className="mb-2 text-xs font-medium text-muted">Start from</p>
            <div className="flex flex-wrap gap-1.5">
              {overview?.company && (
                <button type="button" onClick={() => go(overview.company!.id)} className="rounded-full bg-subtle px-2.5 py-1 text-xs text-fg hover:bg-line">
                  {overview.company.name}
                </button>
              )}
              {overview?.projects.slice(0, 4).map((p) => (
                <button key={p.id} type="button" onClick={() => go(p.id)} className="rounded-full bg-subtle px-2.5 py-1 text-xs text-fg hover:bg-line">
                  {short(p.name, 30)}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted">
              Or open any thing and choose{" "}
              <Link to={paths.brain.kind("system")} className="underline">
                Map
              </Link>
              .
            </p>
          </Card>
        </div>
      </div>
    </Page>
  );
}
