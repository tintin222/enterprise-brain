import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, Bot, Check, ChevronRight, Clock, Download, Gauge, Plug, Server, UserCheck, Users, Zap } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../../api.ts";
import { Badge, StatusPill } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Card, CardHeader } from "../../components/Card.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Checkbox } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { humanize } from "../../lib/format.ts";
import { archetypeIcon, categoryIcon, namedIcon } from "../../lib/icons.tsx";
import { archetypeLabel, categoryLabel } from "../../lib/labels.ts";
import { keys, useCatalog, useDepartments } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { CatalogResponse, DepartmentTemplate, ProcessStep, ProcessTemplate } from "../../types.ts";
import { TemplateDrawer } from "./TemplateDrawer.tsx";

function actorInfo(step: ProcessStep, catalog: CatalogResponse, department: DepartmentTemplate) {
  const [kind = "system", ref = ""] = step.actor.split(":");
  if (kind === "agent") return { kind, label: catalog.agents.find((a) => a.id === ref)?.name ?? humanize(ref.split(".").pop() ?? ref), ref };
  if (kind === "human") return { kind, label: department.roles.find((r) => r.id === ref)?.title ?? humanize(ref), ref };
  return { kind, label: categoryLabel(ref), ref };
}

export function StepFlow({ process, catalog, department, onAgent }: { process: ProcessTemplate; catalog: CatalogResponse; department: DepartmentTemplate; onAgent?: (id: string) => void }) {
  return (
    <ol className="flex flex-wrap items-stretch gap-y-3">
      {process.steps.map((step, i) => {
        const actor = actorInfo(step, catalog, department);
        const Icon = actor.kind === "agent" ? Bot : actor.kind === "human" ? UserCheck : Server;
        const chip = (
          <span
            className={clsx(
              "flex h-full max-w-[15rem] flex-col rounded-xl border px-3 py-2 text-left",
              actor.kind === "agent" && "border-brand-200 bg-brand-50 dark:border-brand-400/25 dark:bg-brand-400/10",
              actor.kind === "human" && "border-amber-200 bg-amber-50 dark:border-amber-400/25 dark:bg-amber-400/10",
              actor.kind === "system" && "border-line bg-subtle/70",
            )}
            title={step.description}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <Icon
                className={clsx(
                  "size-3.5 shrink-0",
                  actor.kind === "agent" && "text-brand-600 dark:text-brand-300",
                  actor.kind === "human" && "text-amber-600 dark:text-amber-300",
                  actor.kind === "system" && "text-muted",
                )}
              />
              <span className="truncate">{step.name}</span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted">
              <span className="truncate">{actor.label}</span>
              {step.sla && <span className="shrink-0">· {step.sla}</span>}
              {step.approval && (
                <span className="shrink-0 rounded bg-amber-200/70 px-1 font-semibold text-amber-900 dark:bg-amber-400/20 dark:text-amber-200">approval</span>
              )}
            </span>
          </span>
        );
        return (
          <li key={step.id} className="flex items-center">
            {actor.kind === "agent" && onAgent ? (
              <button type="button" onClick={() => onAgent(actor.ref)} className="h-full rounded-xl hover:ring-2 hover:ring-brand-400/40">
                {chip}
              </button>
            ) : (
              chip
            )}
            {i < process.steps.length - 1 && <ChevronRight className="mx-1 size-4 shrink-0 text-faint" />}
          </li>
        );
      })}
    </ol>
  );
}

export default function DepartmentDetail() {
  const { id = "" } = useParams();
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const template = params.get("template");
  const catalog = useCatalog();
  const installed = useDepartments();
  const [activate, setActivate] = useState(true);

  const install = useMutation({
    mutationFn: () => api.post<{ department: unknown; processes: unknown[]; agents: unknown[] }>(path(`/catalog/departments/${encodeURIComponent(id)}/install`), { activate }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.departments(company) });
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      void queryClient.invalidateQueries({ queryKey: keys.dashboard(company) });
      toast.success("Department installed", {
        description: `${res.processes.length} processes and ${res.agents.length} agents${activate ? ", active" : ""}.`,
        link: { to: "/departments", label: "View departments" },
      });
    },
    onError: (e) => toast.error(e),
  });

  if (catalog.isLoading) return <LoadingBlock className="flex-1" />;
  if (catalog.error || !catalog.data) {
    return (
      <Page>
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      </Page>
    );
  }
  const data = catalog.data;
  const department = data.departments.find((d) => d.id === id);
  if (!department) {
    return (
      <Page>
        <EmptyState
          title="Department template not found"
          action={
            <ButtonLink to="/catalog" variant="primary">
              Back to the catalog
            </ButtonLink>
          }
        />
      </Page>
    );
  }
  const Icon = namedIcon(department.icon);
  const processes = department.processes.map((pid) => data.processes.find((p) => p.id === pid)).filter((p): p is ProcessTemplate => Boolean(p));
  const agents = data.agents.filter((a) => a.department === department.id);
  const isInstalled = (installed.data ?? []).some((d) => d.key === department.id);
  const hours = processes.reduce((n, p) => n + (p.value?.hoursSavedPerMonth ?? 0), 0);
  const openTemplate = (tid: string | null) => {
    const next = new URLSearchParams(params);
    if (tid) next.set("template", tid);
    else next.delete("template");
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <div className="mb-2 text-sm">
        <Link to="/catalog" className="text-muted hover:text-fg">
          Catalog
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <span className="text-fg">{department.name}</span>
      </div>
      <div className="mb-8 flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6 shadow-xs lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
            <Icon className="size-7" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-fg">{department.name}</h1>
              {isInstalled && (
                <Badge tone="green" icon={Check}>
                  Installed
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">{department.summary}</p>
            <p className="mt-3 border-l-2 border-brand-300 pl-3 text-sm text-fg italic dark:border-brand-400/50">{department.mission}</p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
              <span>{processes.length} processes</span>
              <span>{agents.length} agents</span>
              <span>{department.roles.length} human roles</span>
              {hours > 0 && <span className="font-medium text-emerald-700 dark:text-emerald-300">≈ {hours} hours saved per month</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-line bg-subtle/50 p-4 lg:w-72">
          <p className="text-sm font-semibold text-fg">{isInstalled ? "Installed in this company" : "Install this department"}</p>
          <p className="text-xs text-muted">Creates the department, its processes and agents. Knowledge collections are created empty.</p>
          <Checkbox checked={activate} onChange={setActivate} label="Activate agents" description="Automatic triggers start working right away." />
          <Button variant="primary" icon={Download} loading={install.isPending} onClick={() => install.mutate()} className="mt-1">
            {isInstalled ? "Install missing parts" : "Install department"}
          </Button>
          {isInstalled && (
            <Link to="/departments" className="text-center text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
              View installed departments →
            </Link>
          )}
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-fg">Processes</h2>
      <div className="space-y-4">
        {processes.map((p) => (
          <Card key={p.id} className="p-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-fg">{p.name}</h3>
                  <StatusPill status={p.maturity} size="xs" />
                </div>
                <p className="mt-1 text-sm text-muted">{p.summary}</p>
              </div>
              {p.value?.hoursSavedPerMonth ? (
                <Badge tone="green" icon={Clock} className="shrink-0">
                  {p.value.hoursSavedPerMonth} h/month saved
                </Badge>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Zap className="size-3.5" /> {humanize(p.trigger.type)}: {p.trigger.description}
              </span>
              {p.frequency && <span>{p.frequency}</span>}
            </div>
            <div className="mt-4 overflow-x-auto pb-1">
              <StepFlow process={p} catalog={data} department={department} onAgent={(aid) => openTemplate(aid)} />
            </div>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-3 text-xs">
              {p.integrations.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Plug className="size-3.5 text-muted" />
                  {p.integrations.map((i) => (
                    <Badge key={i.category} size="xs" tone={i.required ? "violet" : "neutral"} title={i.purpose}>
                      {categoryLabel(i.category)}
                      {i.required ? "" : " (optional)"}
                    </Badge>
                  ))}
                </div>
              )}
              {p.kpis.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Gauge className="size-3.5 text-muted" />
                  {p.kpis.map((k) => (
                    <Badge key={k.id} size="xs" tone="green" title={k.description}>
                      {k.name} {k.target}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            {p.value?.description && <p className="mt-2 text-xs text-muted">{p.value.description}</p>}
          </Card>
        ))}
        <div className="flex flex-wrap gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-brand-200 bg-brand-50 dark:border-brand-400/25 dark:bg-brand-400/10" /> Agent
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-amber-200 bg-amber-50 dark:border-amber-400/25 dark:bg-amber-400/10" /> Person (with approval marker)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-line bg-subtle" /> Business system
          </span>
        </div>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Agents" icon={Bot} subtitle="Click one for its full definition." />
          <ul className="divide-y divide-line">
            {agents.map((a) => {
              const AIcon = archetypeIcon(a.archetype);
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => openTemplate(a.id)} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-subtle/60">
                    <AIcon className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg">{a.name}</span>
                      <span className="block text-xs text-muted">{archetypeLabel(a.archetype)}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{a.summary}</span>
                    </span>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-faint" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="KPIs" icon={Gauge} />
            <ul className="divide-y divide-line">
              {department.kpis.map((k) => (
                <li key={k.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-sm text-fg">{k.name}</span>
                    {k.description && <span className="block text-xs text-muted">{k.description}</span>}
                  </span>
                  {k.target && (
                    <Badge tone="green" className="shrink-0">
                      {k.target} {k.unit}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Human roles" icon={Users} />
            <ul className="divide-y divide-line">
              {department.roles.map((r) => (
                <li key={r.id} className="px-5 py-2.5">
                  <p className="text-sm font-medium text-fg">{r.title}</p>
                  {r.description && <p className="text-xs text-muted">{r.description}</p>}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Typical systems" icon={Server} />
            <ul className="divide-y divide-line">
              {department.systems.map((s) => {
                const SIcon = categoryIcon(s.category);
                return (
                  <li key={s.category} className="flex gap-3 px-5 py-2.5">
                    <SIcon className="mt-0.5 size-4 shrink-0 text-muted" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-fg">{categoryLabel(s.category)}</p>
                      {s.purpose && <p className="text-xs text-muted">{s.purpose}</p>}
                      <p className="mt-0.5 text-xs text-faint">{s.examples.join(" · ")}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      </div>
      <TemplateDrawer id={template} onClose={() => openTemplate(null)} />
    </Page>
  );
}
