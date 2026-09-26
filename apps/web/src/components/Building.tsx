import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, History, ShieldCheck, Undo2, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime, timeAgo } from "../lib/format.ts";
import { keys, useBuilding, useReviews } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { Review, VersionEntry } from "../types.ts";
import { Button } from "./Button.tsx";
import { Card, CardHeader } from "./Card.tsx";
import { Callout, ErrorState, Skeleton } from "./Spinner.tsx";

/**
 * The rules for building, where people meet them: every version of what they built (and going back
 * to one), what waits for a decision, and the decisions the data protection officer and IT make.
 */

/** Every version, newest first, with what changed; going back makes a new version. */
export function VersionList({ path, canRestore, onRestored }: { path: string; canRestore: boolean; onRestored?: () => void }) {
  const { path: at } = useCompany();
  const toast = useToast();
  const versions = useQuery({ queryKey: ["versions", path], queryFn: () => api.get<VersionEntry[]>(at(`${path}/versions`)) });
  const restore = useMutation({
    mutationFn: (version: number) => api.post(at(`${path}/versions/${version}/restore`)),
    onSuccess: async (_done, version) => {
      toast.success(`Back to version ${version}`, { description: "As a new version: the one before is kept too." });
      await versions.refetch();
      onRestored?.();
    },
    onError: (error) => toast.error(error),
  });
  if (versions.error) return <ErrorState error={versions.error} />;
  if (!versions.data) return <Skeleton className="h-16" />;
  if (!versions.data.length) return <p className="text-sm text-muted">Its versions are kept from its next change.</p>;
  return (
    <ol className="space-y-2">
      {versions.data.map((v) => (
        <li key={v.version} className="rounded-lg border border-line bg-surface p-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg">Version {v.version}</span>
            {v.current && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                Now
              </span>
            )}
            <span className="text-xs text-muted" title={formatDateTime(v.createdAt)}>
              {[v.by, timeAgo(v.createdAt)].filter(Boolean).join(" · ")}
            </span>
            {canRestore && !v.current && (
              <Button
                className="ml-auto"
                size="xs"
                variant="ghost"
                icon={Undo2}
                loading={restore.isPending && restore.variables === v.version}
                onClick={() => restore.mutate(v.version)}
              >
                Go back to it
              </Button>
            )}
          </div>
          {v.note && <p className="mt-0.5 text-xs text-muted">{v.note}</p>}
          <ul className="mt-1 list-disc pl-5 text-xs text-muted">
            {v.summary.length ? v.summary.map((line) => <li key={line}>{line}</li>) : <li>Nothing that shows</li>}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** A collapsible "Versions" section for a design drawer or page. */
export function VersionsSection(props: { path: string; canRestore: boolean; onRestored?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded-xl border border-line bg-subtle/40 p-4 text-sm" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-fg">
        <History className="size-4 text-muted" /> Versions and a way back
      </summary>
      <div className="mt-3">{open && <VersionList {...props} />}</div>
    </details>
  );
}

/** What waits for a decision on something, in plain words (on its page). */
export function WaitingNotes({
  reviews,
  personalWaiting,
  fieldLabel,
}: {
  reviews?: Review[];
  personalWaiting?: string[];
  fieldLabel?: (key: string) => string;
}) {
  const building = useBuilding();
  const dpo = building.data?.dpo?.name ?? "IT";
  const sharing = reviews?.some((r) => r.kind === "sharing" && r.status === "waiting");
  const personal = personalWaiting?.length ? personalWaiting.map((k) => fieldLabel?.(k) ?? k) : [];
  if (!sharing && !personal.length) return null;
  return (
    <Callout tone="info" className="mb-4" title="Waiting for a decision">
      <ul className="list-disc space-y-0.5 pl-4">
        {personal.length > 0 && (
          <li>
            {personal.join(", ")} {personal.length === 1 ? "keeps" : "keep"} personal data: {personal.length === 1 ? "it takes" : "they take"} values once the
            data protection officer ({dpo}) approves.
          </li>
        )}
        {sharing && <li>It is shared with the whole company once IT agrees; until then, its department sees it.</li>}
      </ul>
    </Callout>
  );
}

/** One request: what is asked, by whom; approve or decline with a note, for whoever decides. */
function ReviewItem({ review }: { review: Review }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.post<Review>(path(`/reviews/${review.id}/${approve ? "approve" : "decline"}`), note.trim() ? { note: note.trim() } : {}),
    onSuccess: async (done) => {
      toast.success(done.status === "approved" ? "Approved" : "Declined", { description: done.what });
      await queryClient.invalidateQueries({ queryKey: keys.reviews(company) });
      await queryClient.invalidateQueries({ queryKey: keys.tables(company) });
      await queryClient.invalidateQueries({ queryKey: keys.apps(company) });
      await queryClient.invalidateQueries({ queryKey: ["built"] });
    },
    onError: (error) => toast.error(error),
  });
  return (
    <li className="space-y-2 px-5 py-3">
      <p className="text-sm text-fg">{review.what}</p>
      <p className="text-xs text-muted">
        Asked by {review.requestedBy} · {timeAgo(review.createdAt)}
        {review.kind === "personal-data" ? " · for the data protection officer" : " · for IT"}
      </p>
      {review.canDecide && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input flex-1"
            placeholder="A note (optional): why, how long it is kept…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="A note"
          />
          <div className="flex gap-2">
            <Button size="sm" icon={X} loading={decide.isPending && decide.variables === false} onClick={() => decide.mutate(false)}>
              Decline
            </Button>
            <Button size="sm" variant="primary" icon={Check} loading={decide.isPending && decide.variables === true} onClick={() => decide.mutate(true)}>
              Approve
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Requests the viewer decides (Home, for the data protection officer and IT). */
export function DecisionsForYou() {
  const reviews = useReviews();
  const mine = (reviews.data ?? []).filter((r) => r.canDecide);
  if (!mine.length) return null;
  return (
    <Card>
      <CardHeader title="Decisions for you" icon={ShieldCheck} subtitle="The rules for building ask you before these go ahead." />
      <ul className="divide-y divide-line">
        {mine.map((r) => (
          <ReviewItem key={r.id} review={r} />
        ))}
      </ul>
    </Card>
  );
}

export function ReviewList({ reviews, empty }: { reviews: Review[]; empty: string }) {
  if (!reviews.length) return <p className="px-5 py-4 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {reviews.map((r) => (
        <ReviewItem key={r.id} review={r} />
      ))}
    </ul>
  );
}
