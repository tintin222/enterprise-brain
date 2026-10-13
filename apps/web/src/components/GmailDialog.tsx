import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw, Unplug } from "lucide-react";
import { useLocation } from "react-router";
import { api } from "../api.ts";
import { Badge } from "../components/Badge.tsx";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, plural, timeAgo } from "../lib/format.ts";
import { keys, useMyMail } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { MailAccountView } from "../types.ts";
import { Button, ButtonAnchor } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { Switch } from "./Form.tsx";
import { ErrorState, LoadingBlock } from "./Spinner.tsx";

/** Where Google sends the person back: the page they were on, with ?gmail=connected. */
export function gmailStartUrl(returnTo: string): string {
  return `/api/me/mail/gmail/start?returnTo=${encodeURIComponent(returnTo)}`;
}

function Connected({ account, onClose }: { account: MailAccountView; onClose: () => void }) {
  const { company } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: keys.myMail }), queryClient.invalidateQueries({ queryKey: keys.todos(company) })]);
  const check = useMutation({
    mutationFn: () => api.post<{ checked: number; made: number; first: boolean }>("/api/me/mail/check"),
    onSuccess: async (result) => {
      toast.success(
        result.first ? "Connected: reading starts now" : result.made ? `${plural(result.made, "new task")} from your mail` : "Nothing new that needs you",
        { description: result.first ? "Older mail is left alone; new emails become tasks from here on." : `${plural(result.checked, "new email")} looked at.` },
      );
      await refresh();
    },
    onError: (error) => toast.error(error),
  });
  const toggle = useMutation({
    mutationFn: (tasksEnabled: boolean) => api.patch<MailAccountView>("/api/me/mail", { tasksEnabled }),
    onSuccess: refresh,
    onError: (error) => toast.error(error),
  });
  const disconnect = useMutation({
    mutationFn: () => api.del("/api/me/mail/gmail"),
    onSuccess: async () => {
      toast.success("Gmail disconnected", { description: "The tasks it made stay yours." });
      await refresh();
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-line p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
          <Mail className="size-4" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
            <span className="truncate">{account.address}</span>
            <Badge tone={account.status === "ok" ? "green" : "red"} size="xs">
              {account.status === "ok" ? "Connected" : "Needs attention"}
            </Badge>
          </p>
          <p className="text-xs text-muted">
            {account.lastCheckedAt ? `Last checked ${timeAgo(account.lastCheckedAt)}` : "Not checked yet"} · {plural(account.checked, "email")} read ·{" "}
            {plural(account.made, "task")} made
          </p>
          {account.lastError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{account.lastError}</p>}
          <p className="mt-1 text-xs text-faint">
            Connected {formatDateTime(account.connectedAt)}. Only you see these tasks; nothing of your mail reaches anyone else.
          </p>
        </div>
      </div>
      <Switch
        checked={account.tasksEnabled}
        onChange={(checked) => toggle.mutate(checked)}
        disabled={toggle.isPending}
        label="Tasks from new mail"
        description="Every few minutes, each new email that needs something from you becomes a task under My tasks."
      />
      {account.quietSenders.length > 0 && (
        <p className="text-xs text-muted">No tasks from: {account.quietSenders.join(", ")} (you said “Not a task” on their mail).</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button icon={RefreshCw} loading={check.isPending} onClick={() => check.mutate()}>
          Check now
        </Button>
        <Button
          variant="ghost"
          icon={Unplug}
          loading={disconnect.isPending}
          onClick={() => {
            if (window.confirm("Disconnect your Gmail? The tasks it made stay; no new ones come from it.")) disconnect.mutate();
          }}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

/** A person's own Gmail, read for their tasks: connect with Google, check, switch off, disconnect. */
export function GmailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mail = useMyMail({ enabled: open });
  const { pathname, search } = useLocation();
  const data = mail.data;
  return (
    <Dialog open={open} onClose={onClose} title="Gmail tasks" description="Emails that need something from you become tasks, for you alone." size="md">
      {mail.isLoading ? (
        <LoadingBlock />
      ) : mail.error || !data ? (
        <ErrorState error={mail.error} onRetry={() => void mail.refetch()} />
      ) : data.account ? (
        <Connected account={data.account} onClose={onClose} />
      ) : (
        <div className="space-y-4 text-sm text-muted">
          <p>
            Connect your Gmail with Google. Enterprise Brain reads new emails as they arrive, and each one that asks something of you (an answer, a decision, a
            file to send) becomes a task under <span className="font-medium text-fg">My tasks</span>, with a link back to the email. Newsletters and automatic
            mail make nothing. Older mail is left alone.
          </p>
          <p>Only you see these tasks. Your mail never reaches the shared mailboxes, the AI employees or the company brain.</p>
          {data.configured ? (
            <ButtonAnchor href={gmailStartUrl(`${pathname}${search}`)} variant="primary" icon={Mail}>
              Connect Gmail with Google
            </ButtonAnchor>
          ) : (
            <div className="rounded-xl border border-dashed border-line-strong p-3 text-xs">
              <p className="font-medium text-fg">Not possible yet: Google sign-in is not set up on this installation.</p>
              <p className="mt-1">What IT must do:</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>Set up Google sign-in (Settings → People and roles, or the EB_AUTH_GOOGLE_* variables).</li>
                <li>Enable the Gmail API on that Google Cloud project, and add the gmail.readonly scope to its consent screen.</li>
                <li>
                  Register this redirect URI on the OAuth client: <span className="font-mono text-fg break-all">{data.redirectUri}</span>
                </li>
              </ol>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
