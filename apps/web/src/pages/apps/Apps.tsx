import { Archive, Calculator, Globe, LayoutGrid, Plus, Table2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { NewAppDialog } from "../../components/apps/NewAppDialog.tsx";
import { NewCalculationDialog } from "../../components/calculations/NewCalculationDialog.tsx";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, PageHeader, SectionTitle } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { NewTableDialog, useTableDepartments } from "../../components/tables/NewTableDialog.tsx";
import { plural, timeAgo } from "../../lib/format.ts";
import { namedIcon } from "../../lib/icons.tsx";
import { useApps, useCalculations, useDepartments, useTables } from "../../lib/queries.ts";
import type { AppView, CalculationView, TableView } from "../../types.ts";

function Tile({
  to,
  icon,
  tone,
  title,
  shared,
  description,
  meta,
}: {
  to: string;
  icon: ReactNode;
  tone: "app" | "table" | "calculation";
  title: string;
  shared?: boolean;
  description?: string;
  meta: string;
}) {
  return (
    <Link to={to} className="group block">
      <Card className="h-full p-4 transition-colors group-hover:border-brand-300 dark:group-hover:border-brand-400/40">
        <div className="flex items-start gap-3">
          <span
            className={
              tone === "app"
                ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300"
                : tone === "table"
                  ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300"
                  : "flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"
            }
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 truncate font-medium text-fg">
              {title}
              {shared && (
                <Badge size="xs" tone="blue" icon={Globe}>
                  Shared
                </Badge>
              )}
            </p>
            {description && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{description}</p>}
            <p className="mt-2 text-xs text-faint">{meta}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function AppTile({ app }: { app: AppView }) {
  const Icon = namedIcon(app.icon, LayoutGrid);
  return (
    <Tile
      to={`/apps/${app.key}`}
      tone="app"
      icon={<Icon className="size-[18px]" />}
      title={app.name}
      shared={app.settings.visibility === "company" && Boolean(app.departmentId)}
      description={app.description}
      meta={`${plural(app.pages.length, "page")} · changed ${timeAgo(app.updatedAt)}`}
    />
  );
}

function TableTile({ table }: { table: TableView }) {
  return (
    <Tile
      to={`/tables/${table.key}`}
      tone="table"
      icon={<Table2 className="size-[18px]" />}
      title={table.name}
      shared={table.settings.visibility === "company" && Boolean(table.departmentId)}
      description={table.description}
      meta={`${plural(table.records, "record")} · ${plural(table.fields.length, "field")} · changed ${timeAgo(table.updatedAt)}`}
    />
  );
}

const RUNS: Record<string, string> = { daily: "every day", weekly: "every Monday", monthly: "every month" };

function CalculationTile({ calculation }: { calculation: CalculationView }) {
  const last = calculation.last;
  return (
    <Tile
      to={`/calculations/${calculation.key}`}
      tone="calculation"
      icon={<Calculator className="size-[18px]" />}
      title={calculation.name}
      description={calculation.rule}
      meta={[
        calculation.schedule ? `Runs ${RUNS[calculation.schedule]}` : "Runs when asked",
        last ? `${last.status === "failed" ? "last run failed" : "worked out"} ${timeAgo(last.createdAt)}` : "not worked out yet",
      ].join(" · ")}
    />
  );
}

/** By department (or the whole company), in the order people meet them. */
function byDepartment<T extends { departmentId: string | null }>(items: T[], name: Map<string, string>): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = item.departmentId ? (name.get(item.departmentId) ?? "A department") : "The whole company";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return [...groups.entries()];
}

/** Apps: the apps and tables the viewer's departments keep. */
export default function Apps() {
  const [archived, setArchived] = useState(false);
  const apps = useApps(archived);
  const tables = useTables(archived);
  const calculations = useCalculations(archived);
  const departments = useDepartments();
  const { departments: mine, companyWide } = useTableDepartments();
  const canMake = companyWide || mine.length > 0;
  const [making, setMaking] = useState<"app" | "table" | "calculation" | null>(null);
  const name = new Map((departments.data ?? []).map((d) => [d.id, d.name]));
  const loading = apps.isLoading || tables.isLoading;
  const empty = apps.data?.length === 0 && tables.data?.length === 0 && calculations.data?.length === 0;

  return (
    <Page>
      <PageHeader
        icon={LayoutGrid}
        title="Apps"
        description="What your departments keep track of, and the screens they work it on. Say what you need in plain words: the Studio makes the app and its table, and your AI employees can file into it too."
        actions={
          canMake && (
            <>
              <Button icon={Table2} onClick={() => setMaking("table")}>
                New table
              </Button>
              {(tables.data?.length ?? 0) > 0 && (
                <Button icon={Calculator} onClick={() => setMaking("calculation")}>
                  New calculation
                </Button>
              )}
              <Button variant="primary" icon={Plus} onClick={() => setMaking("app")}>
                New app
              </Button>
            </>
          )
        }
      />
      {(apps.error || tables.error) && <ErrorState error={apps.error ?? tables.error} onRetry={() => void apps.refetch()} />}
      {loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      {empty &&
        (archived ? (
          <EmptyState icon={Archive} title="Nothing archived" compact />
        ) : (
          <EmptyState
            icon={LayoutGrid}
            title="No apps yet"
            description='Describe what you need, for example "supplier complaints: supplier, order number, problem, owner; log a complaint, see the open ones by supplier, close them". Nobody needs to think about a database.'
            action={
              canMake ? (
                <Button variant="primary" icon={Plus} onClick={() => setMaking("app")}>
                  New app
                </Button>
              ) : undefined
            }
          />
        ))}
      <div className="space-y-8">
        {(apps.data?.length ?? 0) > 0 && (
          <section className="space-y-5">
            {byDepartment(apps.data ?? [], name).map(([group, list]) => (
              <div key={group}>
                <SectionTitle>{`Apps · ${group}`}</SectionTitle>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((app) => (
                    <AppTile key={app.id} app={app} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
        {(calculations.data?.length ?? 0) > 0 && (
          <section className="space-y-5">
            {byDepartment(calculations.data ?? [], name).map(([group, list]) => (
              <div key={group}>
                <SectionTitle>{`Calculations · ${group}`}</SectionTitle>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((calculation) => (
                    <CalculationTile key={calculation.id} calculation={calculation} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
        {(tables.data?.length ?? 0) > 0 && (
          <section className="space-y-5">
            {byDepartment(tables.data ?? [], name).map(([group, list]) => (
              <div key={group}>
                <SectionTitle>{`Tables · ${group}`}</SectionTitle>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((table) => (
                    <TableTile key={table.id} table={table} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="mt-8">
        <Button variant="ghost" size="sm" icon={Archive} onClick={() => setArchived((a) => !a)}>
          {archived ? "Back to the ones in use" : "Archived apps and tables"}
        </Button>
      </div>
      <NewAppDialog open={making === "app"} onClose={() => setMaking(null)} />
      <NewTableDialog open={making === "table"} onClose={() => setMaking(null)} />
      <NewCalculationDialog open={making === "calculation"} onClose={() => setMaking(null)} />
    </Page>
  );
}
