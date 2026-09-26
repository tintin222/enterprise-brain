import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { CircleCheck, Download, ExternalLink, MessagesSquare, PlugZap, TriangleAlert, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { ButtonAnchor, ButtonLink } from "../../components/Button.tsx";
import { Card, PageHeader, SectionTitle } from "../../components/Card.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Layout.tsx";
import { Callout, ErrorState, LoadingBlock } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { timeAgo } from "../../lib/format.ts";

interface ChannelsView {
  publicUrl: string;
  https: boolean;
  teams: {
    connected: boolean;
    connectionId: string | null;
    appId: string | null;
    problem: string | null;
    messagingEndpoint: string;
    accounts: { name: string | null; email: string | null; person: string | null; since: string; lastSeenAt: string }[];
  };
}

function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={clsx(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300" : "bg-subtle text-muted",
        )}
      >
        {done ? <CircleCheck className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 pb-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children && <div className="mt-1 space-y-2 text-sm text-muted">{children}</div>}
      </div>
    </li>
  );
}

/**
 * Settings → Teams and Chat: how IT connects Microsoft Teams (the bot, its messaging endpoint and the
 * Teams app), and who already uses it.
 */
export default function Channels() {
  const { company, path } = useCompany();
  const view = useQuery({ queryKey: [company, "channels"], queryFn: () => api.get<ChannelsView>(path("/channels")) });
  const data = view.data;
  const teams = data?.teams;
  const linked = teams?.accounts.filter((a) => a.person).length ?? 0;

  return (
    <Page>
      <PageHeader
        icon={MessagesSquare}
        title="Teams and Chat"
        description="Where people meet their AI employees outside the app. They give work by message, and approvals, questions and a morning summary arrive there as cards with buttons."
      />
      {view.isLoading && <LoadingBlock />}
      {view.error && <ErrorState error={view.error} onRetry={() => void view.refetch()} />}
      {data && teams && (
        <>
          {!data.https && (
            <Callout tone="warning" icon={TriangleAlert} className="mb-6" title="Teams needs an https address">
              Microsoft calls this installation at its public address, which must start with https://. Set EB_PUBLIC_URL to it (now: {data.publicUrl}).
            </Callout>
          )}
          <SectionTitle>Microsoft Teams</SectionTitle>
          <Card className="mb-8 p-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg">Microsoft Teams</span>
                {teams.connected && !teams.problem ? (
                  <Badge tone="green" size="xs">
                    Connected
                  </Badge>
                ) : teams.problem ? (
                  <Badge tone="red" size="xs">
                    Needs attention
                  </Badge>
                ) : (
                  <Badge size="xs">Not connected</Badge>
                )}
              </div>
              {teams.connected && (
                <span className="text-xs text-muted">
                  {linked} {linked === 1 ? "person uses" : "people use"} it
                </span>
              )}
            </div>
            {teams.problem && (
              <Callout tone="danger" className="mb-5" title="The Teams connection has a problem">
                {teams.problem}
              </Callout>
            )}
            <ol className="space-y-4">
              <Step n={1} done={teams.connected} title="Create an Azure Bot for your tenant">
                <p>
                  In the Azure portal, create an Azure Bot of type single tenant, then turn on its Microsoft Teams channel.{" "}
                  <a
                    href="https://learn.microsoft.com/azure/bot-service/bot-service-quickstart-registration"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-brand-600 hover:underline dark:text-brand-300"
                  >
                    How <ExternalLink className="size-3" />
                  </a>
                </p>
              </Step>
              <Step n={2} title="Set its messaging endpoint to this address">
                <div className="flex max-w-full items-center gap-2 rounded-lg border border-line bg-subtle/60 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{teams.messagingEndpoint}</code>
                  <CopyButton text={teams.messagingEndpoint} />
                </div>
              </Step>
              <Step n={3} done={teams.connected && !teams.problem} title="Connect the bot here">
                <p>Its Microsoft App ID, a client secret of its app registration, and your tenant ID. Messages from other tenants are refused.</p>
                {teams.connected ? (
                  <p className="text-xs">
                    App ID <span className="font-mono">{teams.appId ?? "—"}</span> ·{" "}
                    <Link to="/settings/connections" className="text-brand-600 hover:underline dark:text-brand-300">
                      change it in Connections
                    </Link>
                  </p>
                ) : (
                  <ButtonLink to="/settings/connections?connect=microsoft-teams" variant="primary" size="sm" icon={PlugZap}>
                    Connect Teams
                  </ButtonLink>
                )}
              </Step>
              <Step n={4} title="Upload the Teams app">
                <p>
                  Download it, then upload it in the Teams admin center (Teams apps → Manage apps → Upload new app). A setup policy can install it for everyone
                  who works with AI employees.
                </p>
                {teams.connected && teams.appId ? (
                  <ButtonAnchor href={`/api/companies/${encodeURIComponent(company)}/channels/teams/app`} size="sm" icon={Download} download>
                    Download the Teams app
                  </ButtonAnchor>
                ) : (
                  <p className="text-xs">Available once the bot is connected: the app names it.</p>
                )}
              </Step>
              <Step n={5} done={linked > 0} title="People write to it">
                <p>
                  Each person is linked by their email the first time they write to the app or install it. Someone whose email has no account here is told whom
                  to ask.
                </p>
              </Step>
            </ol>
          </Card>

          <SectionTitle>People in Teams</SectionTitle>
          <Card className="overflow-hidden">
            {teams.accounts.length === 0 ? (
              <EmptyState compact className="m-4" icon={Users} title="Nobody yet" description="People appear here once they write to the app in Teams." />
            ) : (
              <ul className="divide-y divide-line">
                {teams.accounts.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{a.person ?? a.name ?? a.email ?? "Unknown"}</p>
                      <p className="truncate text-xs text-muted">{a.email ?? "no email"}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      {a.person ? (
                        <Badge tone="green" size="xs">
                          Linked
                        </Badge>
                      ) : (
                        <Badge tone="amber" size="xs">
                          No account with this email
                        </Badge>
                      )}
                      <span>last seen {timeAgo(a.lastSeenAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="mt-6 text-xs text-muted">Google Chat comes next, set up the same way.</p>
        </>
      )}
    </Page>
  );
}
