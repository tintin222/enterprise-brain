import { clsx } from "clsx";
import { Ban, Check, Circle, CircleDot, Hourglass, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { SECTION_LABELS, SECTION_ORDER, stakeholderLabel } from "../../lib/labels.ts";
import type { NodeState, RequirementNode, SessionView } from "../../types.ts";
import type { SessionActions } from "./actions.ts";
import { formatAnswer, isRelevant, isSettled, stateOf } from "./utils.ts";

function StateIcon({ state }: { state: NodeState }) {
  switch (state.status) {
    case "answered":
      return (
        <span
          className="flex size-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300"
          title="Answered"
        >
          <Check className="size-3.5" />
        </span>
      );
    case "assumed":
      return (
        <span
          className="flex size-5 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
          title="Assumed"
        >
          <span className="text-sm leading-none font-bold">~</span>
        </span>
      );
    case "delegated":
      return (
        <span
          className="flex size-5 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
          title="Waiting on someone else"
        >
          <Hourglass className="size-3" />
        </span>
      );
    case "skipped":
      return (
        <span className="flex size-5 items-center justify-center rounded-full bg-subtle text-faint" title="Skipped">
          <Ban className="size-3" />
        </span>
      );
    case "asked":
      return (
        <span className="flex size-5 items-center justify-center text-brand-500" title="Asked — waiting for your answer">
          <CircleDot className="size-4" />
        </span>
      );
    default:
      return (
        <span className="flex size-5 items-center justify-center text-faint" title="Open">
          <Circle className="size-4" />
        </span>
      );
  }
}

function stateText(view: SessionView, node: RequirementNode, state: NodeState): string {
  switch (state.status) {
    case "answered":
    case "assumed":
      return formatAnswer(node, state.value);
    case "delegated": {
      const request = view.requests.find((r) => r.id === state.delegationId);
      return `Waiting on ${stakeholderLabel(request?.role ?? node.owner)}${request ? ` (${request.status})` : ""}`;
    }
    case "skipped":
      return state.answerText ? `Skipped — ${state.answerText}` : "Skipped";
    case "asked":
      return state.round ? `Asked in round ${state.round}` : "Asked";
    default:
      return "Not asked yet";
  }
}

function NodeRow({ view, node, actions }: { view: SessionView; node: RequirementNode; actions: SessionActions }) {
  const [open, setOpen] = useState(false);
  const state = stateOf(view.tree, node.id);
  const settled = isSettled(state);
  const locked = ["generating", "testing", "deployed"].includes(view.session.status);
  const text = stateText(view, node, state);
  return (
    <li className={clsx("rounded-lg", open && "bg-subtle/60")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-subtle/60"
        aria-expanded={open}
      >
        <StateIcon state={state} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg">{node.title}</span>
          <span className={clsx("block text-xs", settled ? "text-muted" : "text-faint", state.status === "assumed" && "italic")}>{text}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2.5 pl-9 text-xs text-muted">
          <p className="text-fg">{node.question}</p>
          {state.answerText && state.answerText !== text && <p>Your words: “{state.answerText}”</p>}
          {state.evidence && <p>Evidence: {state.evidence}</p>}
          {state.answeredBy && state.answeredBy !== "requester" && (
            <p>Settled by: {state.answeredBy === "system" ? "the analyst" : state.answeredBy === "default" ? "assumption" : state.answeredBy}</p>
          )}
          {settled && !locked && (
            <Button
              size="xs"
              variant="secondary"
              icon={RotateCcw}
              loading={actions.reopen.isPending && actions.reopen.variables === node.id}
              onClick={() => actions.reopen.mutate(node.id)}
            >
              Reopen
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** The requirement tree grouped by section, with each node's state. */
export function RequirementsPanel({ view, actions }: { view: SessionView; actions: SessionActions }) {
  const { tree, progress } = view;
  const nodes = tree.nodes.filter((n) => isRelevant(tree, n));
  const sections = SECTION_ORDER.map((section) => ({ section, nodes: nodes.filter((n) => n.section === section) })).filter((s) => s.nodes.length);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Check className="size-3.5 text-emerald-600" /> answered
        </span>
        <span className="flex items-center gap-1">
          <span className="font-bold text-amber-600">~</span> assumed
        </span>
        <span className="flex items-center gap-1">
          <Hourglass className="size-3 text-amber-600" /> waiting on others
        </span>
        <span className="flex items-center gap-1">
          <Circle className="size-3.5" /> open
        </span>
      </div>
      {sections.map(({ section, nodes: list }) => {
        const stats = progress.bySection[section];
        return (
          <section key={section}>
            <div className="mb-1 flex items-center justify-between px-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{SECTION_LABELS[section]}</h3>
              {stats && (
                <span className={clsx("text-[11px] tabular-nums", stats.settled === stats.total ? "text-emerald-600 dark:text-emerald-400" : "text-faint")}>
                  {stats.settled}/{stats.total}
                </span>
              )}
            </div>
            <ul className="space-y-0.5">
              {list.map((node) => (
                <NodeRow key={node.id} view={view} node={node} actions={actions} />
              ))}
            </ul>
          </section>
        );
      })}
      <p className="px-2 text-xs text-faint">Click a settled requirement to see where the answer came from, or reopen it.</p>
    </div>
  );
}
