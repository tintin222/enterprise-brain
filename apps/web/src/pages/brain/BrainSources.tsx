import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  BookOpen,
  Bot,
  Cable,
  CircleAlert,
  Factory,
  Handshake,
  Hash,
  Kanban,
  LifeBuoy,
  Mail,
  MessageSquare,
  Plug,
  RefreshCw,
  Server,
  Sparkles,
  Unplug,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Page } from "../../components/Layout.tsx";
import { Callout, ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";
import { useToast } from "../../lib/toast.tsx";
import type { BrainSource, BrainSyncResult } from "../../types.ts";
import { brainKeys, kindOf, lowerName, useBrainModel, useBrainSources, useMayEditBrain } from "./brain.tsx";

const SOURCE_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  users: Users,
  server: Server,
  "book-open": BookOpen,
  handshake: Handshake,
  factory: Factory,
  "life-buoy": LifeBuoy,
  kanban: Kanban,
  "message-square": MessageSquare,
  hash: Hash,
  mail: Mail,
};

function resultWords(result: BrainSyncResult, kindName: (kind: string, n: number) => string): string {
  const parts: string[] = [];
  const kinds = Object.entries(result.byKind).filter(([, n]) => n > 0);
  if (kinds.length) parts.push(kinds.map(([kind, n]) => `${n} ${kindName(kind, n)}`).join(", ") + " new");
  else if (result.added) parts.push(`${result.added} new`);
  if (result.updated) parts.push(`${result.updated} updated`);
  if (result.links.added) parts.push(`${result.links.added} links`);
  if (result.events) parts.push(`${result.events} messages and updates`);
  if (result.changes) parts.push(`${result.changes} changes`);
  return parts.length ? parts.join(" · ") : "Nothing new";
}

function SourceCard({ source }: { source: BrainSource }) {
  const { company, path } = useCompany();
  const { data: model } = useBrainModel();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mayEdit = useMayEditBrain();
  const Icon = SOURCE_ICONS[source.icon] ?? Plug;
  const [busy, setBusy] = useState<string | null>(null);
  const kindName = (kind: string, n: number) => lowerName((n === 1 ? kindOf(model, kind)?.name : kindOf(model, kind)?.plural) ?? kind);
  const act = async (action: "sync" | "disconnect") => {
    setBusy(action);
    try {
      const { result } = await api.post<{ result: BrainSyncResult | null }>(path(`/brain/sources/${source.key}/${action}`));
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      if (action === "sync" && result) toast.success(`${source.name}: ${resultWords(result, kindName)}`);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            source.status === "connected" ? "bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300" : "bg-subtle text-muted",
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-semibold text-fg">{source.name}</p>
            {source.status === "connected" ? (
              <Badge tone="green" size="xs" dot>
                Connected
              </Badge>
            ) : source.status === "off" ? (
              <Badge size="xs">Off</Badge>
            ) : null}
          </div>
          <p className="text-[11px] text-muted">{source.demo ? `Made-up data standing in for ${source.system}` : source.system}</p>
        </div>
      </div>
      <p className="mt-3 text-[13px] text-muted">{source.description}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {source.brings.map((b) => (
          <Badge key={b} size="xs" tone="neutral">
            {b}
          </Badge>
        ))}
      </div>
      <div className="mt-auto pt-3">
        {source.lastError ? (
          <p className="mb-2 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
            <CircleAlert className="mt-px size-3.5 shrink-0" /> {source.lastError}
          </p>
        ) : source.lastResult && source.lastSyncAt ? (
          <p className="mb-2 text-xs text-muted">
            Read {timeAgo(source.lastSyncAt)}: {resultWords(source.lastResult, kindName)}
          </p>
        ) : null}
        {mayEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={source.status === "connected" ? "secondary" : "primary"}
              icon={source.status === "connected" ? RefreshCw : Plug}
              loading={busy === "sync"}
              onClick={() => void act("sync")}
            >
              {source.status === "connected" ? "Read now" : "Connect and read"}
            </Button>
            {source.status === "connected" && (
              <Button size="sm" variant="ghost" icon={Unplug} loading={busy === "disconnect"} onClick={() => void act("disconnect")}>
                Turn off
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** The systems the brain learns from: demo integrations for now, each read on demand and every hour. */
export default function BrainSources() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mayEdit = useMayEditBrain();
  const sources = useBrainSources();
  const all = useMutation({
    mutationFn: () => api.post<{ sources: BrainSource[] }>(path("/brain/sources/sync-all")),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      toast.success("All sources read");
    },
    onError: (error) => toast.error(error),
  });
  const connected = (sources.data ?? []).filter((s) => s.status === "connected").length;
  return (
    <Page wide>
      <PageHeader
        icon={Cable}
        title="Sources"
        description="The systems the brain learns from. These are demo integrations with made-up data of the demo company; each reading brings what changed, and connected sources are read again every hour."
        actions={
          mayEdit ? (
            <Button variant="primary" icon={Sparkles} onClick={() => all.mutate()} loading={all.isPending}>
              {connected ? "Read all again" : "Connect and read all"}
            </Button>
          ) : undefined
        }
      />
      <Callout tone="info" className="mb-5">
        Demo sources stand in for the real systems (SuccessFactors, Salesforce, SAP, Jira, Teams, Slack…) until IT connects them. They read the same demo CRM,
        ERP and service desk the AI employees use, so what AI employees change there shows up here too. Read a source again to see new messages, task changes
        and project news arrive.
      </Callout>
      {sources.error ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : !sources.data ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sources.data.map((source) => (
            <SourceCard key={source.key} source={source} />
          ))}
        </div>
      )}
    </Page>
  );
}
