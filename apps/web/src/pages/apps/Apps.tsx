import { Archive, Globe, LayoutGrid, Plus, Table2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, PageHeader, SectionTitle } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { NewTableDialog, useTableDepartments } from "../../components/tables/NewTableDialog.tsx";
import { plural, timeAgo } from "../../lib/format.ts";
import { useDepartments, useTables } from "../../lib/queries.ts";
import type { TableView } from "../../types.ts";

function TableCard({ table }: { table: TableView }) {
  return (
    <Link to={`/tables/${table.key}`} className="group block">
      <Card className="h-full p-4 transition-colors group-hover:border-brand-300 dark:group-hover:border-brand-400/40">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300">
            <Table2 className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 truncate font-medium text-fg">
              {table.name}
              {table.settings.visibility === "company" && table.departmentId && (
                <Badge size="xs" tone="blue" icon={Globe}>
                  Shared
                </Badge>
              )}
            </p>
            {table.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{table.description}</p>}
            <p className="mt-2 text-xs text-faint">
              {plural(table.records, "record")} · {plural(table.fields.length, "field")} · changed {timeAgo(table.updatedAt)}
            </p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

/** Apps: the tables (and, next, the apps) the viewer's departments keep. */
export default function Apps() {
  const [archived, setArchived] = useState(false);
  const tables = useTables(archived);
  const departments = useDepartments();
  const { departments: mine, companyWide } = useTableDepartments();
  const canMake = companyWide || mine.length > 0;
  const [making, setMaking] = useState(false);
  const name = new Map((departments.data ?? []).map((d) => [d.id, d.name]));
  const groups = new Map<string, TableView[]>();
  for (const table of tables.data ?? []) {
    const group = table.departmentId ? (name.get(table.departmentId) ?? "A department") : "The whole company";
    groups.set(group, [...(groups.get(group) ?? []), table]);
  }

  return (
    <Page>
      <PageHeader
        icon={LayoutGrid}
        title="Apps"
        description="What your departments keep track of. Say what you need in plain words and the Studio makes the table; your AI employees can file into it too."
        actions={
          canMake && (
            <Button variant="primary" icon={Plus} onClick={() => setMaking(true)}>
              New table
            </Button>
          )
        }
      />
      {tables.error && <ErrorState error={tables.error} onRetry={() => void tables.refetch()} />}
      {tables.isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      {tables.data?.length === 0 &&
        (archived ? (
          <EmptyState icon={Archive} title="No archived tables" compact />
        ) : (
          <EmptyState
            icon={Table2}
            title="No tables yet"
            description='Describe what to keep track of, for example "supplier complaints: supplier, order number, problem, status, owner". Nobody needs to think about a database.'
            action={
              canMake ? (
                <Button variant="primary" icon={Plus} onClick={() => setMaking(true)}>
                  New table
                </Button>
              ) : undefined
            }
          />
        ))}
      <div className="space-y-6">
        {[...groups.entries()].map(([group, list]) => (
          <section key={group}>
            <SectionTitle>{group}</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((table) => (
                <TableCard key={table.id} table={table} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="mt-8">
        <Button variant="ghost" size="sm" icon={Archive} onClick={() => setArchived((a) => !a)}>
          {archived ? "Back to the tables in use" : "Archived tables"}
        </Button>
      </div>
      <NewTableDialog open={making} onClose={() => setMaking(false)} />
    </Page>
  );
}
