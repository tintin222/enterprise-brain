import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Download, FileSpreadsheet, ScanText, Sparkles } from "lucide-react";
import { api } from "../api.ts";
import { AgentAppView } from "../components/AgentAppView.tsx";
import { Badge } from "../components/Badge.tsx";
import { Button, ButtonLink } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, LoadingBlock } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { categoryLabel } from "../lib/labels.ts";
import { keys, useAgent, useAgents, useCatalog } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { AgentRow } from "../types.ts";
import { useDocumentTitle } from "../lib/title.ts";

const CONFIG = {
  documents: {
    useCase: "document-processing",
    template: "shared-services.document-processor",
    icon: ScanText,
    title: "Documents & OCR",
    tagline:
      "Upload any document — PDF, Word, a scan or a phone photo. The agent recognises what it is, extracts the data you need and prepares the next step.",
    points: ["Reads scans and photos with OCR", "Classifies the document type", "Extracts fields with confidence", "Validates against your systems"],
  },
  excel: {
    useCase: "excel-automation",
    template: "shared-services.excel-analyst",
    icon: FileSpreadsheet,
    title: "Excel automation",
    tagline:
      "Upload a spreadsheet and say what you need: totals, pivots, reconciliations, clean-ups or anomaly checks. You get a new workbook plus an explanation.",
    points: ["Totals, pivots and top-N", "Reconciliations and differences", "Duplicate and anomaly checks", "A clean result workbook"],
  },
} as const;

function InstalledApp({ agent }: { agent: AgentRow }) {
  const detail = useAgent(agent.slug);
  if (detail.isLoading) return <LoadingBlock />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  return <AgentAppView detail={detail.data} showHeader={false} />;
}

export default function UseCaseApp({ kind }: { kind: keyof typeof CONFIG }) {
  const config = CONFIG[kind];
  useDocumentTitle(config.title);
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog();
  const agents = useAgents();
  const useCase = catalog.data?.useCases.find((u) => u.id === config.useCase);
  const templateId = useCase?.defaultAgent ?? config.template;
  const installed =
    agents.data?.find((a) => a.templateId === templateId && a.status !== "archived") ??
    agents.data?.find((a) => a.templateId === config.template && a.status !== "archived");

  const install = useMutation({
    mutationFn: () => api.post<{ useCase: unknown; agent: AgentRow | null }>(path(`/catalog/use-cases/${config.useCase}/install`)),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      if (res.agent) toast.success(`${res.agent.name} installed and active`);
      else toast.info("This use case has no default agent in the catalog yet");
    },
    onError: (e) => toast.error(e),
  });

  const Icon = config.icon;
  return (
    <Page>
      <div className="mb-6 flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 shadow-xs sm:p-6 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
            <Icon className="size-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{useCase?.name ?? config.title}</h1>
              {installed && (
                <Badge tone="green" icon={Check}>
                  {installed.name}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted">{config.tagline}</p>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              {config.points.map((p) => (
                <li key={p} className="flex items-center gap-1.5 text-xs text-muted">
                  <Check className="size-3.5 text-emerald-500" /> {p}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {installed && (
          <div className="flex shrink-0 gap-2">
            <ButtonLink to={`/agents/${installed.slug}`} size="sm">
              Agent details
            </ButtonLink>
            <ButtonLink to={`/builder/new?template=${encodeURIComponent(templateId)}`} size="sm" variant="soft" icon={Sparkles}>
              Customize
            </ButtonLink>
          </div>
        )}
      </div>

      {agents.isLoading && <LoadingBlock />}
      {agents.error && <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />}
      {agents.data && installed && <InstalledApp agent={installed} />}
      {agents.data && !installed && (
        <Card className="p-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
            <Download className="size-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-fg">Install the {useCase?.name ?? config.title} agent</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted">
            {useCase?.description ?? "A ready-made agent from the catalog powers this use case."} It's installed active and can be customised afterwards with
            the Agent Builder.
          </p>
          {useCase?.examples.length ? (
            <ul className="mx-auto mt-5 max-w-lg space-y-1.5 text-left">
              {useCase.examples.slice(0, 4).map((ex) => (
                <li key={ex} className="rounded-lg border border-line bg-subtle/50 px-3 py-2 text-[13px] text-muted">
                  “{ex}”
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={Download} loading={install.isPending} onClick={() => install.mutate()}>
              Install
            </Button>
            <ButtonLink to={`/builder/new?template=${encodeURIComponent(templateId)}`} icon={Sparkles}>
              Customize with the Agent Builder
            </ButtonLink>
          </div>
          {useCase?.connectors.length ? (
            <p className="mt-4 text-xs text-faint">Works with: {useCase.connectors.map((c) => categoryLabel(c)).join(", ")}</p>
          ) : null}
        </Card>
      )}
    </Page>
  );
}
