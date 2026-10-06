import { clsx } from "clsx";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { timeAgo } from "../../lib/format.ts";
import { KindIcon, ThingChip, brainPath, kindIcon, kindOf, lowerName, useBrainEntities, useBrainModel, useMayEditBrain } from "./brain.tsx";
import { EntityForm } from "./EntityForm.tsx";
import { TellTheBrain } from "./TellTheBrain.tsx";
import { toneOf } from "./values.tsx";

/** Every thing of one kind: people, processes, systems… with their main values, to filter and search. */
export default function BrainList() {
  const { kind: kindKey = "" } = useParams();
  const { data: model } = useBrainModel();
  const kind = kindOf(model, kindKey);
  const mayEdit = useMayEditBrain();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useBrainEntities(kindKey, q, { links: true });
  const rows = list.data ?? [];

  // The first status-like field (status, stage, health…) filters the list.
  const choiceField = kind?.fields.find((f) => f.brief && f.type === "choice");
  const choiceValues = useMemo(() => {
    if (!choiceField) return [];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = row.brief.find(([label]) => label === choiceField.label)?.[1];
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => (choiceField.choices?.indexOf(a[0]) ?? 0) - (choiceField.choices?.indexOf(b[0]) ?? 0));
  }, [rows, choiceField]);
  const shown = filter && choiceField ? rows.filter((r) => r.brief.some(([label, value]) => label === choiceField.label && value === filter)) : rows;
  const columns = (kind?.fields ?? []).filter((f) => f.brief && f.key !== choiceField?.key);
  const linkColumns = [...new Set(rows.flatMap((r) => Object.keys(r.keyLinks ?? {})))];
  const Icon = kindIcon(kindKey);
  const canAdd = mayEdit ? kindKey !== "ai_employee" : kindKey === "knowhow";

  return (
    <Page wide>
      <PageHeader
        icon={Icon}
        eyebrow={model?.dimensions.find((d) => d.key === kind?.dimension)?.name}
        title={kind?.plural ?? "…"}
        description={kind?.description}
        actions={
          canAdd && kind ? (
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add {lowerName(kind.name)}
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
          <input
            className="input h-9 pl-8 text-[13px]"
            placeholder={`Search ${lowerName(kind?.plural ?? "")}…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {choiceValues.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setFilter(null)}
              className={clsx(
                "rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
                !filter ? "bg-fg text-canvas ring-fg" : "text-muted ring-line-strong hover:bg-subtle",
              )}
            >
              All {rows.length}
            </button>
            {choiceValues.map(([value, n]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(filter === value ? null : value)}
                className={clsx(
                  "rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
                  filter === value ? "bg-fg text-canvas ring-fg" : "text-muted ring-line-strong hover:bg-subtle",
                )}
              >
                {value} {n}
              </button>
            ))}
          </div>
        )}
      </div>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <Skeleton className="h-64" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Icon}
          title={q ? "Nothing found" : `No ${lowerName(kind?.plural ?? "things")} yet`}
          description={q ? "Try other words." : "Fill the brain from its sources, or add them by hand."}
          action={
            canAdd && kind && !q ? (
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                Add {lowerName(kind.name)}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-subtle/50 text-[11px] tracking-wide text-faint uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  {choiceField && <th className="px-4 py-2 font-medium">{choiceField.label}</th>}
                  {columns.map((f) => (
                    <th key={f.key} className="px-4 py-2 font-medium">
                      {f.label}
                    </th>
                  ))}
                  {linkColumns.map((label) => (
                    <th key={label} className="px-4 py-2 font-medium">
                      {label}
                    </th>
                  ))}
                  <th className="hidden px-4 py-2 font-medium 2xl:table-cell">About</th>
                  <th className="hidden px-4 py-2 text-right font-medium xl:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((row) => {
                  const choice = choiceField ? row.brief.find(([label]) => label === choiceField.label)?.[1] : undefined;
                  return (
                    <tr key={row.id} className="hover:bg-subtle/50">
                      <td className="min-w-64 px-4 py-2.5">
                        <Link to={brainPath(row.id)} className="flex items-center gap-2.5 font-medium text-fg hover:underline">
                          <KindIcon kind={row.kind} model={model} size="sm" />
                          <span className="min-w-0">{row.name}</span>
                        </Link>
                      </td>
                      {choiceField && <td className="px-4 py-2.5">{choice && <Badge tone={toneOf(choice)}>{choice}</Badge>}</td>}
                      {columns.map((f) => (
                        <td key={f.key} className="px-4 py-2.5 text-[13px] whitespace-nowrap text-muted">
                          {row.brief.find(([label]) => label === f.label)?.[1] ?? ""}
                        </td>
                      ))}
                      {linkColumns.map((label) => {
                        const things = row.keyLinks?.[label] ?? [];
                        return (
                          <td key={label} className="px-4 py-2.5">
                            <div className="flex max-w-52 flex-wrap gap-1">
                              {things.slice(0, 2).map((thing) => (
                                <ThingChip key={thing.id} thing={thing} model={model} className="!text-[11px]" />
                              ))}
                              {things.length > 2 && <span className="text-[11px] text-faint">+{things.length - 2}</span>}
                            </div>
                          </td>
                        );
                      })}
                      <td className="hidden max-w-md px-4 py-2.5 text-xs text-muted 2xl:table-cell">
                        <span className="line-clamp-2">{row.summary}</span>
                      </td>
                      <td className="hidden px-4 py-2.5 text-right text-xs whitespace-nowrap text-faint xl:table-cell">{timeAgo(row.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {adding && kindKey === "knowhow" && !mayEdit ? (
        <TellTheBrain open onClose={() => setAdding(false)} />
      ) : adding ? (
        <EntityForm open onClose={() => setAdding(false)} kind={kindKey} />
      ) : null}
    </Page>
  );
}
