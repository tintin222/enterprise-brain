import { clsx } from "clsx";
import { ChevronRight, ExternalLink, KeyRound, Mail, Phone } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge, type Tone } from "../../components/Badge.tsx";
import { formatDate } from "../../lib/format.ts";
import type { BrainApi, BrainContact, BrainField, BrainMilestone, BrainModel, BrainRef, BrainStep, BrainTable } from "../../types.ts";
import { ThingChip } from "./brain.tsx";

/** How a value of a status-like field reads: green when fine, amber when at risk, red when not. */
export function toneOf(value: unknown): Tone {
  const text = String(value ?? "").toLowerCase();
  if (/^(on track|active|live|done|won|documented|approved|customer|achieved|in force|resolved|closed|expert|yes)$/.test(text)) return "green";
  if (
    /^(at risk|waiting|on hold|planned|draft|needs review|being replaced|prospect|proposal|negotiation|qualification|waiting on customer|high|read-only|on leave|in progress|open|new|can do it|moved)$/.test(
      text,
    )
  )
    return text === "in progress" || text === "open" || text === "new" || text === "planned" ? "blue" : "amber";
  if (/^(off track|blocked|lost|urgent|left|retired|cancelled|no|critical|sensitive)$/.test(text)) return "red";
  return "neutral";
}

const SHORT_LIST = 8;

function ListValue({ items }: { items: string[] }) {
  const chips = items.length <= SHORT_LIST && items.every((i) => i.length <= 32);
  if (chips) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Badge key={item} tone="neutral">
            {item}
          </Badge>
        ))}
      </div>
    );
  }
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-fg marker:text-faint">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** A name in a step that is a thing of the brain becomes a link to it. */
function Named({ name, lookup, model }: { name: string; lookup: (name: string) => BrainRef | undefined; model: BrainModel | undefined }) {
  const thing = lookup(name);
  if (thing) return <ThingChip thing={thing} model={model} />;
  return <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-medium text-muted">{name}</span>;
}

export function StepsView({ steps, lookup, model }: { steps: BrainStep[]; lookup: (name: string) => BrainRef | undefined; model: BrainModel | undefined }) {
  return (
    <ol className="relative space-y-0">
      {steps.map((step, i) => (
        <li key={`${step.name}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-line" aria-hidden />}
          <span className="relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium text-fg">{step.name}</p>
            {step.does && <p className="mt-0.5 text-[13px] text-muted">{step.does}</p>}
            {(step.who || step.system) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                {step.who && (
                  <>
                    <span>who</span>
                    <Named name={step.who} lookup={lookup} model={model} />
                  </>
                )}
                {step.system && (
                  <>
                    <span>{step.who ? "in" : "system"}</span>
                    <Named name={step.system} lookup={lookup} model={model} />
                  </>
                )}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

const METHOD_TONES: Record<string, string> = {
  GET: "text-emerald-700 dark:text-emerald-300",
  POST: "text-sky-700 dark:text-sky-300",
  PATCH: "text-amber-700 dark:text-amber-300",
  PUT: "text-amber-700 dark:text-amber-300",
  DELETE: "text-red-700 dark:text-red-300",
};

function Endpoint({ text }: { text: string }) {
  const [, method = "", rest = text] = text.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.*)$/) ?? [];
  const [path, what] = rest.split(/\s+—\s+/);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
      {method && <span className={clsx("w-12 shrink-0 font-mono text-[11px] font-semibold", METHOD_TONES[method])}>{method}</span>}
      <code className="font-mono text-xs break-all text-fg">{path}</code>
      {what && <span className="text-xs text-muted">— {what}</span>}
    </li>
  );
}

export function ApisView({ apis }: { apis: BrainApi[] }) {
  return (
    <div className="space-y-3">
      {apis.map((api) => (
        <div key={api.name} className="rounded-lg border border-line bg-subtle/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-fg">{api.name}</p>
            <Badge tone="violet" size="xs">
              {api.style}
            </Badge>
            {api.docs && (
              <a
                href={api.docs}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-300"
              >
                Docs <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          {api.url && <code className="mt-1.5 block font-mono text-xs break-all text-muted">{api.url}</code>}
          {api.auth && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-muted">
              <KeyRound className="mt-px size-3.5 shrink-0" /> {api.auth}
            </p>
          )}
          {api.endpoints.length > 0 && (
            <ul className="mt-2 divide-y divide-line/60 border-t border-line/60">
              {api.endpoints.map((e) => (
                <Endpoint key={e} text={e} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export function TablesView({ tables }: { tables: BrainTable[] }) {
  const [open, setOpen] = useState<string | null>(tables[0]?.name ?? null);
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {tables.map((table) => {
        const expanded = open === table.name;
        return (
          <div key={table.name}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : table.name)}
              className="flex w-full items-center gap-2 bg-subtle/40 px-3 py-2 text-left hover:bg-subtle"
              aria-expanded={expanded}
            >
              <ChevronRight className={clsx("size-4 shrink-0 text-faint transition-transform", expanded && "rotate-90")} />
              <code className="font-mono text-[13px] font-semibold text-fg">{table.name}</code>
              <span className="truncate text-xs text-muted">{table.description}</span>
              <span className="ml-auto shrink-0 text-[11px] text-faint">{table.columns.length} columns</span>
            </button>
            {expanded && table.columns.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[11px] tracking-wide text-faint uppercase">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Column</th>
                      <th className="px-3 py-1.5 font-medium">Type</th>
                      <th className="px-3 py-1.5 font-medium">Key</th>
                      <th className="px-3 py-1.5 font-medium">Holds</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {table.columns.map((column) => (
                      <tr key={column.name}>
                        <td className="px-3 py-1.5 font-mono font-medium text-fg">{column.name}</td>
                        <td className="px-3 py-1.5 font-mono text-muted">{column.type}</td>
                        <td className="px-3 py-1.5">
                          {column.key && (
                            <Badge tone={column.key.startsWith("PK") ? "amber" : "blue"} size="xs">
                              {column.key}
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-muted">{column.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ContactsView({ contacts }: { contacts: BrainContact[] }) {
  return (
    <ul className="divide-y divide-line/70">
      {contacts.map((c) => (
        <li key={`${c.name}-${c.email}`} className="py-2 first:pt-0 last:pb-0">
          <p className="text-sm font-medium text-fg">{c.name}</p>
          {c.title && <p className="text-xs text-muted">{c.title}</p>}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {c.email && (
              <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-300">
                <Mail className="size-3" /> {c.email}
              </a>
            )}
            {c.phone && (
              <a href={`tel:${c.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 text-muted hover:text-fg">
                <Phone className="size-3" /> {c.phone}
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MilestonesView({ milestones }: { milestones: BrainMilestone[] }) {
  return (
    <ul className="space-y-1.5">
      {milestones.map((m) => (
        <li key={m.name} className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={clsx(
              "size-2 shrink-0 rounded-full",
              m.status === "Done" ? "bg-emerald-500" : m.status === "Moved" ? "bg-amber-500" : "bg-slate-300 dark:bg-slate-600",
            )}
          />
          <span className={clsx("text-fg", m.status === "Done" && "text-muted line-through decoration-faint")}>{m.name}</span>
          {m.due && <span className="text-xs text-faint">{formatDate(m.due)}</span>}
          {m.status && (
            <Badge tone={toneOf(m.status)} size="xs">
              {m.status}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function Progress({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-40 overflow-hidden rounded-full bg-subtle">
        <div className={clsx("h-full rounded-full", width >= 100 ? "bg-emerald-500" : "bg-brand-500")} style={{ width: `${width}%` }} />
      </div>
      <span className="text-sm text-fg tabular-nums">{value}%</span>
    </div>
  );
}

/** One field's value, shown the way its type reads best. */
export function FieldValue({
  field,
  value,
  data,
  lookup,
  model,
}: {
  field: BrainField;
  value: unknown;
  data: Record<string, unknown>;
  lookup: (name: string) => BrainRef | undefined;
  model: BrainModel | undefined;
}): ReactNode {
  switch (field.type) {
    case "list":
      return <ListValue items={value as string[]} />;
    case "steps":
      return <StepsView steps={value as BrainStep[]} lookup={lookup} model={model} />;
    case "apis":
      return <ApisView apis={value as BrainApi[]} />;
    case "tables":
      return <TablesView tables={value as BrainTable[]} />;
    case "contacts":
      return <ContactsView contacts={value as BrainContact[]} />;
    case "milestones":
      return <MilestonesView milestones={value as BrainMilestone[]} />;
    case "percent":
      return <Progress value={Number(value)} />;
    case "money":
      return (
        <span className="text-sm text-fg tabular-nums">
          {Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} {typeof data.currency === "string" ? data.currency : ""}
        </span>
      );
    case "number":
      return <span className="text-sm text-fg tabular-nums">{Number(value).toLocaleString("en-US")}</span>;
    case "date":
      return <span className="text-sm text-fg">{formatDate(String(value))}</span>;
    case "choice":
      return <Badge tone={toneOf(value)}>{String(value)}</Badge>;
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm break-all text-brand-600 hover:underline dark:text-brand-300"
        >
          {String(value).replace(/^https?:\/\//, "")} <ExternalLink className="size-3 shrink-0" />
        </a>
      );
    case "email":
      return (
        <a href={`mailto:${String(value)}`} className="text-sm text-brand-600 hover:underline dark:text-brand-300">
          {String(value)}
        </a>
      );
    case "phone":
      return (
        <a href={`tel:${String(value).replace(/\s+/g, "")}`} className="text-sm text-fg hover:underline">
          {String(value)}
        </a>
      );
    case "long_text":
      return <p className="text-sm whitespace-pre-line text-fg">{String(value)}</p>;
    default:
      return <span className="text-sm text-fg">{String(value)}</span>;
  }
}
