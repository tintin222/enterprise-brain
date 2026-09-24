import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, ExternalLink, Lock, Plug, ShieldCheck, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Drawer } from "../../components/Dialog.tsx";
import { Checkbox } from "../../components/Form.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { WorkflowView } from "../../components/WorkflowView.tsx";
import { useCompany } from "../../lib/company.tsx";
import { humanize } from "../../lib/format.ts";
import { approvalRuleLabel, archetypeLabel, categoryLabel, describeTrigger, PERSONAL_DATA_LABELS } from "../../lib/labels.ts";
import { keys, useAgents, useDepartmentName } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AgentRow, AgentTemplate, FieldSpec } from "../../types.ts";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Fields({ fields }: { fields: FieldSpec[] }) {
  if (!fields.length) return <p className="text-sm text-faint">None</p>;
  return (
    <ul className="space-y-1">
      {fields.map((f) => (
        <li key={f.key} className="flex items-start justify-between gap-2 text-sm">
          <span className="min-w-0">
            <span className="font-medium text-fg">{f.label ?? humanize(f.key)}</span>
            {f.required && <span className="text-red-500">*</span>}
            {f.description && <span className="block text-xs text-muted">{f.description}</span>}
          </span>
          <Badge size="xs">{f.type}</Badge>
        </li>
      ))}
    </ul>
  );
}

export function useInstallTemplate() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, activate }: { id: string; activate: boolean }) => api.post<AgentRow>(path(`/catalog/agents/${encodeURIComponent(id)}/install`), { activate }),
    onSuccess: (row) => {
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      void queryClient.invalidateQueries({ queryKey: keys.departments(company) });
      void queryClient.invalidateQueries({ queryKey: keys.dashboard(company) });
      toast.success(`${row.name} installed`, { link: { to: `/agents/${row.slug}`, label: "Open agent" } });
    },
    onError: (e) => toast.error(e),
  });
}

/** Full agent template: what it does, its data, workflow, systems and guardrails — with Install / Customize. */
export function TemplateDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [activate, setActivate] = useState(true);
  const install = useInstallTemplate();
  const agents = useAgents();
  const departmentName = useDepartmentName();
  const template = useQuery({
    queryKey: ["catalog", "agent", id],
    queryFn: () => api.get<AgentTemplate>(`/api/catalog/agents/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
  });
  const t = template.data;
  const installed = t ? agents.data?.find((a) => a.templateId === t.id && a.status !== "archived") : undefined;

  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      width="lg"
      title={t?.name ?? "Agent template"}
      description={
        t ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="brand">{archetypeLabel(t.archetype)}</Badge>
            <Badge>{departmentName(t.department)}</Badge>
            {t.title && <span className="text-xs text-muted">{t.title}</span>}
          </span>
        ) : undefined
      }
      footer={
        t ? (
          <>
            {installed ? (
              <ButtonLink to={`/agents/${installed.slug}`} icon={ExternalLink}>
                Installed — open agent
              </ButtonLink>
            ) : (
              <div className="mr-auto">
                <Checkbox checked={activate} onChange={setActivate} label="Activate after install" />
              </div>
            )}
            <ButtonLink to={`/builder/new?template=${encodeURIComponent(t.id)}`} icon={Sparkles}>
              Customize with the Agent Builder
            </ButtonLink>
            {!installed && (
              <Button variant="primary" icon={Download} loading={install.isPending} onClick={() => install.mutate({ id: t.id, activate })}>
                Install
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {template.isLoading && <Skeleton className="h-64" />}
      {template.error && <ErrorState error={template.error} />}
      {t && (
        <div className="space-y-6">
          <p className="text-sm text-fg">{t.summary}</p>
          {installed && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
              <Check className="size-4" /> Installed in this company as “{installed.name}” ({installed.status})
            </p>
          )}
          <Section title="Starts when">
            <ul className="space-y-1 text-sm text-fg">
              {t.triggers.map((tr, i) => (
                <li key={i}>• {describeTrigger(tr)}</li>
              ))}
            </ul>
          </Section>
          <div className="grid gap-6 sm:grid-cols-2">
            <Section title="Inputs">
              <Fields fields={t.inputs} />
            </Section>
            <Section title="Outputs">
              <Fields fields={t.outputs} />
            </Section>
          </div>
          <Section title="Workflow">
            <WorkflowView steps={t.workflow} />
          </Section>
          <Section title="Systems">
            {t.connectors.length ? (
              <ul className="space-y-1.5">
                {t.connectors.map((c) => (
                  <li key={c.ref} className="flex items-start gap-2 text-sm">
                    <Plug className="mt-0.5 size-4 shrink-0 text-muted" />
                    <span>
                      <span className="font-medium text-fg">{categoryLabel(c.category)}</span>
                      {c.purpose && <span className="text-muted"> — {c.purpose}</span>}
                      {c.operations?.length ? <span className="block text-xs text-faint">{c.operations.join(", ")}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No business systems needed.</p>
            )}
          </Section>
          <Section title="Guardrails">
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-1.5">
                {t.guardrails.approvalRequiredFor.map((r) => (
                  <Badge key={r} tone="amber" icon={ShieldCheck}>
                    {approvalRuleLabel(r)}
                  </Badge>
                ))}
              </div>
              <p className="flex items-center gap-2 text-fg">
                <Lock className="size-4 text-muted" /> {PERSONAL_DATA_LABELS[t.guardrails.personalData] ?? t.guardrails.personalData}
                {t.guardrails.retentionDays ? <span className="text-muted">· {t.guardrails.retentionDays} days retention</span> : null}
              </p>
              {t.guardrails.notes?.map((n, i) => (
                <p key={i} className="text-xs text-muted">
                  • {n}
                </p>
              ))}
            </div>
          </Section>
          {t.kpis.length > 0 && (
            <Section title="KPIs">
              <div className="flex flex-wrap gap-1.5">
                {t.kpis.map((k) => (
                  <Badge key={k.id} tone="green">
                    {k.name}
                    {k.target ? ` ${k.target}` : ""}
                  </Badge>
                ))}
              </div>
            </Section>
          )}
          <Section title="Instructions">
            <div className="rounded-xl border border-line bg-subtle/40 p-4">
              <Markdown compact>{t.instructions}</Markdown>
            </div>
          </Section>
        </div>
      )}
    </Drawer>
  );
}
