import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Lightbulb, Link2, Pencil, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Callout } from "../../components/Spinner.tsx";
import { useCompany } from "../../lib/company.tsx";
import { useToast } from "../../lib/toast.tsx";
import type { BrainLearnApplied, BrainLearnChange, BrainLearnProposal } from "../../types.ts";
import { brainKeys, kindOf, lowerName, useBrainModel, useMayEditBrain } from "./brain.tsx";

const EXAMPLES = [
  "Kerem Yıldız is the one who knows how to read the vibration data in MES. He learned it from Hakan.",
  "When Uyumsoft is down, send invoices as PDF by email and upload them the next day; the tax office accepts that for 2 days.",
  "Gulf Water always asks for the test certificates in English and Arabic.",
];

function ChangeRow({ change, checked, locked, onToggle }: { change: BrainLearnChange; checked: boolean; locked: boolean; onToggle: () => void }) {
  const { data: model } = useBrainModel();
  const kind = kindOf(model, change.type === "knowhow" ? "knowhow" : change.kind);
  const relation = model?.relations.find((r) => r.key === change.relation);
  const Icon = change.type === "add" ? Plus : change.type === "update" ? Pencil : change.type === "link" ? Link2 : Lightbulb;
  const fields = Object.entries(change.fields).filter(([, v]) => v.trim());
  return (
    <li>
      <label className={clsx("flex gap-3 rounded-lg border border-line p-3", locked ? "opacity-60" : "cursor-pointer hover:bg-subtle/60")}>
        <input type="checkbox" className="mt-1 size-4 accent-brand-600" checked={checked && !locked} disabled={locked} onChange={onToggle} />
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200">
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium text-fg">
            {change.type === "add" && `Add ${lowerName(kind?.name ?? change.kind)}: ${change.name}`}
            {change.type === "update" && `Change ${change.name}`}
            {change.type === "link" &&
              `${change.name} — ${relation?.label.toLowerCase() ?? change.relation} → ${change.to.name}${change.detail ? ` (${change.detail})` : ""}`}
            {change.type === "knowhow" && `Keep as know-how: ${change.name}`}
          </span>
          {change.summary && <span className="mt-0.5 block text-xs text-muted">{change.summary}</span>}
          {fields.length > 0 && (
            <span className="mt-1 block space-y-0.5 text-xs text-muted">
              {fields.map(([key, value]) => (
                <span key={key} className="block whitespace-pre-line">
                  <span className="font-medium text-fg">{kind?.fields.find((f) => f.key === key)?.label ?? key}:</span> {value}
                </span>
              ))}
            </span>
          )}
          {change.type === "knowhow" && change.about.length > 0 && (
            <span className="mt-1 block text-xs text-muted">About: {change.about.map((a) => a.name).join(", ")}</span>
          )}
          {change.why && <span className="mt-1 block text-[11px] text-faint italic">“{change.why}”</span>}
          {locked && <span className="mt-1 block text-[11px] text-amber-700 dark:text-amber-300">A manager or an admin can add this.</span>}
        </span>
      </label>
    </li>
  );
}

/**
 * "Tell the brain": someone writes what they know; Claude proposes what to add or change, and they
 * keep what is right. Opened from a thing's page, it is about that thing.
 */
export function TellTheBrain({ open, onClose, about }: { open: boolean; onClose: () => void; about?: { id: string; name: string } }) {
  const { company, path, info } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mayEdit = useMayEditBrain();
  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<BrainLearnProposal | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BrainLearnApplied | null>(null);

  const reset = () => {
    setText("");
    setProposal(null);
    setSkip(new Set());
    setResult(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const read = async () => {
    setBusy(true);
    try {
      setProposal(await api.post<BrainLearnProposal>(path("/brain/learn"), { text, about: about?.id }));
      setSkip(new Set());
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const keep = async () => {
    if (!proposal) return;
    const changes = proposal.changes.filter((c, i) => !skip.has(i) && (mayEdit || c.type === "knowhow"));
    if (!changes.length) return;
    setBusy(true);
    try {
      const applied = await api.post<BrainLearnApplied>(path("/brain/learn/apply"), { changes });
      setResult(applied);
      await queryClient.invalidateQueries({ queryKey: brainKeys.all(company) });
      if (applied.done.length) toast.success(applied.done.length === 1 ? applied.done[0]! : `The brain learned ${applied.done.length} things`);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const chosen = proposal ? proposal.changes.filter((c, i) => !skip.has(i) && (mayEdit || c.type === "knowhow")).length : 0;

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={about ? `Tell the brain about ${about.name}` : "Tell the brain"}
      description="Write what you know, in your own words: who does what, how something is really done, what to watch for. It stays in the company."
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={reset}>
              Tell it more
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : proposal ? (
          <>
            <Button variant="ghost" onClick={() => setProposal(null)}>
              Back
            </Button>
            <Button variant="primary" onClick={keep} loading={busy} disabled={chosen === 0}>
              Keep {chosen === 1 ? "this" : `these ${chosen}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={Sparkles} onClick={read} loading={busy} disabled={text.trim().length < 3}>
              {info.llm.available ? "Read it" : "Keep it"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm">
          {result.done.length > 0 && (
            <Callout tone="success" title="Kept">
              <ul className="list-disc pl-4">
                {result.done.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </Callout>
          )}
          {result.skipped.length > 0 && (
            <Callout tone="warning" title="Not kept">
              <ul className="list-disc pl-4">
                {result.skipped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      ) : proposal ? (
        <div className="space-y-3">
          {proposal.understood && <p className="text-sm text-muted">{proposal.understood}</p>}
          {proposal.changes.length === 0 ? (
            <Callout tone="info">Nothing to add from that. Say who, what or which system, and try again.</Callout>
          ) : (
            <ul className="space-y-2">
              {proposal.changes.map((change, i) => (
                <ChangeRow
                  key={i}
                  change={change}
                  checked={!skip.has(i)}
                  locked={!mayEdit && change.type !== "knowhow"}
                  onToggle={() =>
                    setSkip((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <textarea
            className="input min-h-36"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="For example: Hakan is the only one who can calibrate the test benches; the steps are on a paper list in his office."
            autoFocus
          />
          {!text && (
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setText(example)}
                  className="rounded-full border border-line px-2.5 py-1 text-left text-xs text-muted hover:bg-subtle hover:text-fg"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
          {!info.llm.available && <p className="text-xs text-muted">No AI model is connected, so it is kept as know-how as you wrote it.</p>}
        </div>
      )}
    </Dialog>
  );
}
