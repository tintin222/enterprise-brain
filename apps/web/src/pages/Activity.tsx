import { useQuery } from "@tanstack/react-query";
import { ScrollText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api, qs } from "../api.ts";
import { Badge, type Tone } from "../components/Badge.tsx";
import { Card, PageHeader } from "../components/Card.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, Skeleton } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, timeAgo } from "../lib/format.ts";
import { activityIcon } from "../lib/icons.tsx";
import { keys, useAgents } from "../lib/queries.ts";
import type { ActivityEntry } from "../types.ts";

function actionTone(action: string): Tone {
  if (/failed|rejected|removed|deleted/.test(action)) return "red";
  if (/approved|succeeded|activated|installed|answered|connected|created/.test(action)) return "green";
  if (/requested|paused|sent/.test(action)) return "amber";
  if (/generated|builder/.test(action)) return "brand";
  return "neutral";
}

export default function Activity() {
  const { company, path } = useCompany();
  const [limit, setLimit] = useState(100);
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState("");
  const agents = useAgents();
  const activity = useQuery({
    queryKey: [...keys.activity(company), limit],
    queryFn: () => api.get<ActivityEntry[]>(path(`/activity${qs({ limit })}`)),
    refetchInterval: 30_000,
  });
  const entities = useMemo(() => [...new Set((activity.data ?? []).map((a) => a.entityType))].sort(), [activity.data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (activity.data ?? []).filter((a) => (!entity || a.entityType === entity) && (!q || `${a.summary} ${a.actor} ${a.action}`.toLowerCase().includes(q)));
  }, [activity.data, query, entity]);

  const linkFor = (a: ActivityEntry): string | null => {
    if (!a.entityId) return null;
    if (a.entityType === "run") return `/runs/${a.entityId}`;
    if (a.entityType === "agent") {
      const slug = agents.data?.find((x) => x.id === a.entityId)?.slug;
      return slug ? `/agents/${slug}` : null;
    }
    if (a.entityType === "approval") return "/approvals";
    if (a.entityType === "connector") return "/connectors";
    if (a.entityType === "department") return "/departments";
    if (a.entityType === "collection") return `/knowledge?collection=${encodeURIComponent(a.entityId)}`;
    return null;
  };

  return (
    <Page>
      <PageHeader icon={ScrollText} title="Activity" description="The audit log: who did what, when — people, agents, stakeholders and the system." />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input className="input pl-9" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter activity" />
          </div>
          <select className="input w-auto" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entity type">
            <option value="">Everything</option>
            {entities.map((e) => (
              <option key={e} value={e}>
                {e.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select className="input w-auto sm:ml-auto" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Entries">
            {[100, 250, 500].map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
          </select>
        </div>
        {activity.error && <ErrorState error={activity.error} className="m-4" onRetry={() => void activity.refetch()} />}
        {activity.isLoading && <Skeleton className="m-4 h-60" />}
        {activity.data && filtered.length === 0 && <EmptyState compact className="m-4" icon={ScrollText} title="No activity" description="Actions in the console, runs and approvals are recorded here." />}
        {filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-subtle/50 text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Actor</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((a) => {
                  const Icon = activityIcon(a.action);
                  const link = linkFor(a);
                  return (
                    <tr key={a.id} className="align-top hover:bg-subtle/40">
                      <td className="px-4 py-2.5 whitespace-nowrap text-muted" title={formatDateTime(a.createdAt)}>
                        {timeAgo(a.createdAt)}
                      </td>
                      <td className="max-w-[12rem] truncate px-4 py-2.5 text-fg">{a.actor}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Badge size="xs" tone={actionTone(a.action)} icon={Icon}>
                          {a.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-fg">
                        {link ? (
                          <Link to={link} className="hover:underline">
                            {a.summary}
                          </Link>
                        ) : (
                          a.summary
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
