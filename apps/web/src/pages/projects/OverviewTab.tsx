import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Brain, CircleCheck, Layers, Package, WandSparkles } from "lucide-react";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { Card, CardBody, CardHeader } from "../../components/Card.tsx";
import { KeyValue } from "../../components/KeyValue.tsx";
import { useCompany } from "../../lib/company.tsx";
import { formatDate, formatDateTime, plural } from "../../lib/format.ts";
import { useTodos } from "../../lib/queries.ts";
import type { BrainEvent, ProjectView } from "../../types.ts";
import { brainKeys, useBrainModel } from "../brain/brain.tsx";
import { EventItem } from "../brain/EventItem.tsx";
import { STATUS_LABELS } from "./shared.tsx";

type Tab = "overview" | "assets" | "designs" | "tasks" | "package";

/** The project at a glance: its details, what it holds, its open tasks for the person, and what the brain saw happen. */
export function OverviewTab({ project, onTab }: { project: ProjectView; onTab: (tab: Tab) => void }) {
  const { company, path } = useCompany();
  const model = useBrainModel();
  const todos = useTodos("open", { projectId: project.id });
  const events = useQuery({
    queryKey: [...brainKeys.all(company), "events", "about", project.thingId ?? ""],
    queryFn: () => api.get<BrainEvent[]>(path(`/brain/events?about=${encodeURIComponent(project.thingId ?? "")}&limit=20`)),
    enabled: Boolean(project.thingId),
  });
  const open = todos.data ?? [];
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <KeyValue
              items={[
                ["Status", STATUS_LABELS[project.status]],
                ["Client", project.client ?? "—"],
                ["Owner", project.owner?.name ?? "—"],
                ["Channel", project.channel ? `#${project.channel.name ?? ""}${project.channel.status === "archived" ? " (archived)" : ""}` : "—"],
                ["Started", formatDate(project.createdAt)],
                [
                  "Package",
                  project.lastExportedAt ? `Last exported ${formatDateTime(project.lastExportedAt)} (${plural(project.exports, "time")})` : "Not exported yet",
                ],
              ]}
            />
          </CardBody>
        </Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-2">
          {[
            { tab: "assets" as Tab, icon: Layers, label: plural(project.counts.assets, "asset"), hint: "from the brain and your systems" },
            { tab: "designs" as Tab, icon: WandSparkles, label: plural(project.counts.designs, "design"), hint: "Studio conversations and interviews" },
            { tab: "tasks" as Tab, icon: CircleCheck, label: plural(open.length, "open task"), hint: "what you must do yourself" },
            {
              tab: "package" as Tab,
              icon: Package,
              label: "The package",
              hint: project.lastExportedAt ? `exported ${formatDate(project.lastExportedAt)}` : "what Claude Code builds from",
            },
          ].map(({ tab, icon: Icon, label, hint }) => (
            <button
              key={tab}
              type="button"
              onClick={() => onTab(tab)}
              className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-xs transition-colors hover:border-brand-300 dark:hover:border-brand-400/40"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-fg">{label}</span>
                <span className="block truncate text-xs text-muted">{hint}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-faint" />
            </button>
          ))}
        </div>
        <Card>
          <CardHeader
            title="Your tasks for it"
            icon={CircleCheck}
            actions={
              <Button size="xs" variant="ghost" iconRight={ArrowRight} onClick={() => onTab("tasks")}>
                All
              </Button>
            }
          />
          {open.length === 0 ? (
            <CardBody>
              <p className="text-sm text-muted">Nothing open. Add what you must do yourself under Tasks; the Studio adds what it needs from you.</p>
            </CardBody>
          ) : (
            <ul className="divide-y divide-line">
              {open.slice(0, 5).map((todo) => (
                <li key={todo.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span className="truncate text-fg">{todo.title}</span>
                  {todo.dueAt && <span className="shrink-0 text-xs text-muted">{formatDate(todo.dueAt)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader title="What the brain saw" icon={Brain} subtitle="Changes, exports and notes about the project" />
        {!project.thingId ? (
          <CardBody>
            <p className="text-sm text-muted">This project has no thing in the brain.</p>
          </CardBody>
        ) : events.data?.length ? (
          <CardBody>
            <ul className="divide-y divide-line">
              {events.data.map((event) => (
                <EventItem key={event.id} event={event} model={model.data} hide={project.thingId ?? undefined} />
              ))}
            </ul>
          </CardBody>
        ) : (
          <CardBody>
            <p className="text-sm text-muted">{events.isLoading ? "Looking…" : "Nothing yet."}</p>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
