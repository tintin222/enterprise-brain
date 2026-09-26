import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Blocks, Hammer, Save, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { ReviewList } from "../../components/Building.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, CardHeader, PageHeader } from "../../components/Card.tsx";
import { Chip, Field } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { keys, useBuilding, useDepartments, usePeople } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { useToast } from "../../lib/toast.tsx";
import type { Builders, BuiltInventory, BuiltItem } from "../../types.ts";

const WHO: { value: Builders; label: string; hint: string }[] = [
  { value: "managers", label: "Managers, for their departments", hint: "The usual start: a department's managers make its tables, apps and calculations." },
  {
    value: "everyone",
    label: "Everyone, for their own department",
    hint: "Anyone makes them for their department; each changes their own, and managers all of them.",
  },
  { value: "it", label: "Only IT", hint: "IT makes them, with the people named below." },
];

const KINDS: { value: BuiltItem["type"] | "all"; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "table", label: "Tables" },
  { value: "app", label: "Apps" },
  { value: "calculation", label: "Calculations" },
  { value: "ai-employee", label: "AI employees" },
  { value: "recurring", label: "Recurring work" },
];

const KIND_LABEL: Record<BuiltItem["type"], string> = {
  table: "Table",
  app: "App",
  calculation: "Calculation",
  "ai-employee": "AI employee",
  recurring: "Recurring work",
};

/** IT decides who builds and names the data protection officer. */
function Rules() {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const building = useBuilding();
  const people = usePeople();
  const [who, setWho] = useState<Builders>("managers");
  const [builders, setBuilders] = useState<string[]>([]);
  const [dpo, setDpo] = useState("");
  useEffect(() => {
    if (!building.data) return;
    setWho(building.data.who);
    setBuilders(building.data.builders.map((b) => b.id));
    setDpo(building.data.dpo?.id ?? "");
  }, [building.data]);
  const save = useMutation({
    mutationFn: () => api.put(path("/building"), { who, builders, dpo: dpo || null }),
    onSuccess: async () => {
      toast.success("The rules for building are saved");
      await queryClient.invalidateQueries({ queryKey: keys.building(company) });
      await queryClient.invalidateQueries({ queryKey: ["built"] });
    },
    onError: (error) => toast.error(error),
  });
  if (!building.data) return <Skeleton className="h-48" />;
  const everyone = (people.data ?? []).filter((p) => p.status !== "disabled");
  return (
    <Card>
      <CardHeader title="Who builds" icon={Hammer} subtitle="Tables, apps and calculations. AI employees are hired by managers in the Studio." />
      <div className="space-y-5 p-5">
        <div className="space-y-2" role="radiogroup" aria-label="Who builds">
          {WHO.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50/50 dark:has-[:checked]:bg-brand-400/10"
            >
              <input type="radio" name="who" className="mt-1" checked={who === option.value} onChange={() => setWho(option.value)} />
              <span>
                <span className="block text-sm font-medium text-fg">{option.label}</span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Also allowed to build, for their own departments" hint="Whatever the rule above says.">
          <div className="flex flex-wrap gap-1.5">
            {everyone.map((p) => (
              <Chip
                key={p.id}
                role="checkbox"
                selected={builders.includes(p.id)}
                onClick={() => setBuilders(builders.includes(p.id) ? builders.filter((b) => b !== p.id) : [...builders, p.id])}
              >
                {p.name}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Data protection officer" hint="Decides on tables that keep personal data (KVKK/GDPR). With none named, IT decides.">
          {(id) => (
            <select id={id} className="input max-w-sm" value={dpo} onChange={(e) => setDpo(e.target.value)}>
              <option value="">None named: IT decides</option>
              {everyone.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.title ? ` · ${p.title}` : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className="text-xs text-muted">
          Sharing a table or an app with the whole company always waits for IT. Everything built keeps its versions, and can go back to one.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" icon={Save} loading={save.isPending} onClick={() => save.mutate()}>
            Save the rules
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Everything people built: what, whose, where, which version, and what waits. */
function Inventory({ inventory }: { inventory: BuiltInventory }) {
  const installed = useDepartments();
  const departmentName = (id: string) => installed.data?.find((d) => d.id === id)?.name ?? "A department";
  const [kind, setKind] = useState<BuiltItem["type"] | "all">("all");
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    return inventory.items
      .filter((i) => kind === "all" || i.type === kind)
      .filter((i) => !department || (i.departmentId ?? "company") === department)
      .filter((i) => !words || `${i.name} ${i.owner}`.toLowerCase().includes(words))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [inventory.items, kind, search, department]);
  const departments = [...new Set(inventory.items.map((i) => i.departmentId ?? "company"))];
  return (
    <Card>
      <CardHeader title="Everything built" icon={Blocks} subtitle={`${inventory.items.length} in all, with who made each and where it belongs.`} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        {KINDS.map((k) => (
          <Chip key={k.value} selected={kind === k.value} onClick={() => setKind(k.value)}>
            {k.label}
          </Chip>
        ))}
        <select className="input ml-auto w-auto" aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">Every department</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d === "company" ? "The whole company" : departmentName(d)}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
          <input className="input w-52 pl-8" placeholder="Name or owner" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-5 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Kind</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">Department</th>
              <th className="px-3 py-2.5 font-medium">Owner</th>
              <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Version</th>
              <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Changed</th>
              <th className="px-3 py-2.5 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {shown.map((item) => (
              <tr key={`${item.type}-${item.id}`} className={clsx(item.archived && "opacity-60")}>
                <td className="max-w-72 px-5 py-2.5">
                  <Link to={item.link} className="font-medium text-fg hover:underline">
                    {item.name}
                  </Link>
                  <span className="block truncate text-xs text-muted">{item.detail}</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted">{KIND_LABEL[item.type]}</td>
                <td className="hidden px-3 py-2.5 whitespace-nowrap text-muted md:table-cell">
                  {item.departmentId ? departmentName(item.departmentId) : "The whole company"}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-fg">{item.owner || "—"}</td>
                <td className="hidden px-3 py-2.5 text-muted lg:table-cell">{item.version}</td>
                <td className="hidden px-3 py-2.5 whitespace-nowrap text-muted lg:table-cell">{timeAgo(item.updatedAt)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {item.archived && <Badge size="xs">Archived</Badge>}
                    {item.shared && (
                      <Badge size="xs" tone="blue">
                        Whole company
                      </Badge>
                    )}
                    {item.personal.length > 0 && (
                      <Badge size="xs" tone={item.personal.every((p) => p.approved) ? "green" : "amber"}>
                        Personal data: {item.personal.map((p) => p.label).join(", ")}
                      </Badge>
                    )}
                    {item.waiting.length > 0 && (
                      <Badge size="xs" tone="amber">
                        Waiting for a decision
                      </Badge>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="px-5 py-4 text-sm text-muted">
                  Nothing like that yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The rules for building, what waits for a decision, and everything built: for IT. */
export default function BuildingPage() {
  useDocumentTitle("Building");
  const { path } = useCompany();
  const inventory = useQuery({ queryKey: ["built", path("")], queryFn: () => api.get<BuiltInventory>(path("/built")) });
  return (
    <Page>
      <PageHeader
        icon={Hammer}
        eyebrow="Settings"
        title="Building"
        description="Who builds tables, apps and calculations, who decides on personal data and sharing, and everything people have built."
      />
      <div className="space-y-6">
        <Rules />
        <Card>
          <CardHeader title="Waiting for a decision" icon={ShieldCheck} />
          {inventory.data ? <ReviewList reviews={inventory.data.reviews} empty="Nothing waits for a decision." /> : <Skeleton className="m-4 h-12" />}
        </Card>
        {inventory.error && <ErrorState error={inventory.error} />}
        {inventory.data ? <Inventory inventory={inventory.data} /> : <Skeleton className="h-64" />}
      </div>
    </Page>
  );
}
