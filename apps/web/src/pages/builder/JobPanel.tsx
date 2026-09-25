import { BriefcaseBusiness, CalendarClock, FileSearch, KeyRound, OctagonX, ShieldCheck, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type Tone } from "../../components/Badge.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { useDepartmentName } from "../../lib/queries.ts";
import type { NeedStatus, SessionView } from "../../types.ts";

const NEED: Record<NeedStatus, { tone: Tone; text: (who: string) => string }> = {
  ready: { tone: "green", text: () => "ready" },
  "to-ask": { tone: "amber", text: (who) => `to ask ${who}` },
  asked: { tone: "blue", text: (who) => `asked ${who}` },
  answered: { tone: "green", text: (who) => `${who} answered` },
  yours: { tone: "neutral", text: () => "you arrange it" },
  manual: { tone: "neutral", text: () => "by hand for now" },
  open: { tone: "neutral", text: () => "not decided yet" },
};

function Row({ icon: Icon, label, children }: { icon: typeof UserRound; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_5.5rem_1fr] items-start gap-2 py-2.5">
      <Icon className="mt-0.5 size-4 text-muted" />
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * The job description the Studio builds as the manager answers: its duties, what it needs from
 * others, what it must never do, how much it does alone at first, and the samples it was tried on.
 */
export function JobPanel({ view }: { view: SessionView }) {
  const departmentName = useDepartmentName();
  const job = view.job;
  if (!job) {
    return <EmptyState compact icon={BriefcaseBusiness} title="The job description appears as you answer" />;
  }
  const name = view.draft?.name ?? view.session.title;
  const byline = [
    view.draft?.title,
    view.session.department ? departmentName(view.session.department) : null,
    job.manager ? `manager: ${job.manager}` : null,
  ].filter(Boolean);
  return (
    <div>
      <div className="mb-3">
        <h2 className="text-base font-semibold text-fg">{name}</h2>
        {byline.length > 0 && <p className="text-sm text-muted">{byline.join(" · ")}</p>}
      </div>
      <dl className="divide-y divide-line">
        <Row icon={CalendarClock} label="Duty">
          {job.duties.length ? (
            <ul className="space-y-1">
              {job.duties.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">Works when people give it work</span>
          )}
        </Row>
        <Row icon={KeyRound} label="Needs">
          {job.needs.length ? (
            <ul className="space-y-1.5">
              {job.needs.map((n) => (
                <li key={n.text} className="flex flex-wrap items-center gap-2">
                  <span className="break-words">{n.text}</span>
                  <Badge size="xs" tone={NEED[n.status].tone}>
                    {NEED[n.status].text(n.who)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">Nothing from other teams</span>
          )}
        </Row>
        <Row icon={OctagonX} label="Never">
          {job.never.length ? job.never.join("; ") : <span className="text-muted">Not discussed yet</span>}
        </Row>
        <Row icon={ShieldCheck} label="At first">
          <span className="font-medium">{job.level.label}</span>
          <span className="block text-xs text-muted">
            Alone: {job.level.alone.toLowerCase()}. Asks a person: {job.level.person.toLowerCase()}.
          </span>
        </Row>
        <Row icon={FileSearch} label="Samples">
          {job.samples ? `${job.samples} analysed; they become its test cases` : <span className="text-muted">None yet</span>}
        </Row>
      </dl>
    </div>
  );
}
