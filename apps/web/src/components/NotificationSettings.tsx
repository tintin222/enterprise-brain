import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { timeAgo } from "../lib/format.ts";
import { useToast } from "../lib/toast.tsx";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { ErrorState, LoadingBlock } from "./Spinner.tsx";

type Deliver = "urgent" | "all" | "summary" | "off";
type Channel = "auto" | "email" | "teams" | "google-chat";

interface Preferences {
  deliver: Deliver;
  channel: Channel;
  summaryAt: string;
  timeZone: string;
}

interface NotificationView {
  preferences: Preferences;
  modes: { id: Deliver; label: string; description: string }[];
  channels: { id: Exclude<Channel, "auto">; label: string; reaches: boolean }[];
  email: string;
  recent: { kind: string; itemType: string; channel: string; status: string; createdAt: string }[];
}

const KEY = ["me", "notifications"];

const SENT_LABEL: Record<string, string> = {
  approval: "Approval",
  question: "Question",
  review: "Check",
  failure: "Stopped task",
  notice: "Notice",
  day: "Morning summary",
};

/** Every time zone the browser knows, with the current one first when it doesn't. */
export function timeZones(current: string): string[] {
  const all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return all.includes(current) ? all : [current, ...all];
}

/** What reaches the person outside the app, and where: their own choice. */
export function NotificationsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const view = useQuery({ queryKey: KEY, queryFn: () => api.get<NotificationView>("/api/me/notifications"), enabled: open });
  const [draft, setDraft] = useState<Preferences | null>(null);
  useEffect(() => {
    if (open && view.data) setDraft(view.data.preferences);
  }, [open, view.data]);
  const save = useMutation({
    mutationFn: (preferences: Preferences) => api.put<NotificationView>("/api/me/notifications", preferences),
    onSuccess: (data) => {
      queryClient.setQueryData(KEY, data);
      toast.success("Saved: this is what reaches you now");
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const zones = useMemo(() => timeZones(draft?.timeZone ?? "Europe/Istanbul"), [draft?.timeZone]);
  const data = view.data;
  const summary = draft && draft.deliver !== "off";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="What reaches you"
      description="Outside the app: by email now, and in Teams or Google Chat once your company connects them."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Save} disabled={!draft} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>
            Save
          </Button>
        </>
      }
    >
      {view.isLoading || (!draft && !view.error) ? (
        <LoadingBlock />
      ) : view.error || !data || !draft ? (
        <ErrorState error={view.error} onRetry={() => void view.refetch()} />
      ) : (
        <div className="space-y-5">
          <fieldset>
            <legend className="label">When</legend>
            <div className="space-y-2">
              {data.modes.map((mode) => (
                <label
                  key={mode.id}
                  className={clsx(
                    "flex cursor-pointer gap-3 rounded-xl border p-3",
                    draft.deliver === mode.id
                      ? "border-brand-400 bg-brand-50/60 dark:border-brand-400/50 dark:bg-brand-500/10"
                      : "border-line hover:bg-subtle/60",
                  )}
                >
                  <input
                    type="radio"
                    name="deliver"
                    className="mt-1"
                    checked={draft.deliver === mode.id}
                    onChange={() => setDraft({ ...draft, deliver: mode.id })}
                  />
                  <span>
                    <span className="block text-sm font-medium text-fg">{mode.label}</span>
                    <span className="block text-xs text-muted">{mode.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="notify-channel" className="label">
              Where
            </label>
            <select
              id="notify-channel"
              className="input"
              value={draft.channel}
              disabled={draft.deliver === "off"}
              onChange={(e) => setDraft({ ...draft, channel: e.target.value as Channel })}
            >
              <option value="auto">Where I am: Teams or Google Chat if I use it, else email</option>
              {data.channels.map((channel) => (
                <option key={channel.id} value={channel.id} disabled={!channel.reaches && channel.id !== "email"}>
                  {channel.label}
                  {channel.id === "email" ? ` (${data.email})` : channel.reaches ? "" : " (not connected for you yet)"}
                </option>
              ))}
            </select>
          </div>

          {summary && (
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <div>
                <label htmlFor="notify-at" className="label">
                  Summary at
                </label>
                <input
                  id="notify-at"
                  type="time"
                  className="input"
                  value={draft.summaryAt}
                  onChange={(e) => setDraft({ ...draft, summaryAt: e.target.value.slice(0, 5) })}
                />
              </div>
              <div>
                <label htmlFor="notify-zone" className="label">
                  Time zone
                </label>
                <select id="notify-zone" className="input" value={draft.timeZone} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {data.recent.length > 0 && (
            <div>
              <p className="label">Sent to you lately</p>
              <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                {data.recent.slice(0, 5).map((n, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-fg">{SENT_LABEL[n.itemType] ?? n.itemType}</span>
                    <span className="text-xs text-muted">
                      {data.channels.find((c) => c.id === n.channel)?.label ?? n.channel}
                      {n.status === "failed" ? " · not delivered" : n.status === "skipped" ? " · nothing to send" : ""} · {timeAgo(n.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
