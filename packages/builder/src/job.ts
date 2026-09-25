import {
  PROBATION_LEVELS,
  STAKEHOLDER_LABELS,
  describeDuties,
  type AgentDefinition,
  type Probation,
  type RequirementTree,
  type StakeholderRole,
} from "@enterprise-brain/core";
import { probationOf } from "./generate.ts";
import { getNode, isApplicable, stateOf, valueOf } from "./tree.ts";

/**
 * Where something the AI employee needs stands: already there, being asked for (draft or sent to
 * another team), answered, arranged by the manager, worked around by hand for now, or still open.
 */
export type NeedStatus = "ready" | "to-ask" | "asked" | "answered" | "yours" | "manual" | "open";

/** The job description the Studio builds as the manager answers, in the words of the Hire screen. */
export interface JobDescription {
  /** What it does on its own: "Reads every email sent to careers@acme.com.tr with an attachment". */
  duties: string[];
  /** What it needs from others (mostly access from IT), and where each stands. */
  needs: { text: string; status: NeedStatus; who: string }[];
  /** What it must never do on its own. */
  never: string[];
  /** How much it does alone at first. */
  level: { value: Probation; label: string; alone: string; person: string };
  /** Real examples the analyst analysed; they become its test cases. */
  samples: number;
  /** Who hires it and becomes its manager. */
  manager: string | null;
}

/** An answer as a name: "Our applicant tracking system (ATS)." → "Our applicant tracking system (ATS)". */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[.;,\s]+$/, "") : "";
}

/** Who is asked, as the Hire screen says it: "asked IT". */
const WHO: Partial<Record<StakeholderRole, string>> = {
  it: "IT",
  security: "information security",
  dpo: "the data protection officer",
  legal: "legal",
  finance: "finance",
  "process-owner": "the process owner",
  "data-owner": "the data owner",
  management: "management",
};

/** What each access question is about, in a few words. */
const NEED_TEXT: Record<string, (tree: RequirementTree) => string> = {
  "integration.mail": (tree) => text(valueOf(tree, "inputs.mailbox")) || "the mailbox",
  "integration.source_system": (tree) => `${text(valueOf(tree, "inputs.system")) || "the source system"} (read)`,
  "integration.target_system": (tree) => `${text(valueOf(tree, "outputs.system")) || "the target system"} (write)`,
  "integration.shared_folder": () => "the shared folder",
  "integration.web_form": () => "the website form",
};

export function jobDescription(input: {
  tree: RequirementTree;
  draft?: AgentDefinition;
  requests: { id: string; status: string }[];
  samples: number;
  requesterName: string | null;
}): JobDescription {
  const { tree, draft } = input;
  const requestStatus = new Map(input.requests.map((r) => [r.id, r.status]));

  let duties = draft ? describeDuties(draft.triggers).map((d) => d.text) : [];
  if (!duties.length && text(valueOf(tree, "inputs.mailbox"))) duties = [`Reads every email sent to ${text(valueOf(tree, "inputs.mailbox"))}`];

  const needs: JobDescription["needs"] = [];
  for (const [id, describe] of Object.entries(NEED_TEXT)) {
    const node = getNode(tree, id);
    if (!node || !isApplicable(tree, node)) continue;
    const state = stateOf(tree, id);
    const who = WHO[node.owner] ?? STAKEHOLDER_LABELS[node.owner];
    let status: NeedStatus = "open";
    // Asked of another team (also when the manager went on with assumptions meanwhile): where the request stands.
    const request = state.delegationId ? requestStatus.get(state.delegationId) : undefined;
    if (state.status === "delegated" || (state.status === "assumed" && request)) {
      status = request === "answered" ? "answered" : request === "sent" ? "asked" : "to-ask";
    } else if (state.status === "answered" || state.status === "assumed") {
      if (state.answeredBy === "stakeholder") status = "answered";
      else if (state.answeredBy === "system") status = "ready";
      else status = state.value === "i-will-arrange" ? "yours" : state.value === "manual-for-now" ? "manual" : state.value === "ask-it" ? "to-ask" : "ready";
    } else if (state.status === "skipped") continue;
    needs.push({ text: describe(tree), status, who });
  }

  const never = [text(valueOf(tree, "purpose.out_of_scope"))].filter(Boolean);
  const level = probationOf(tree);
  return {
    duties,
    needs,
    never,
    level: { value: level, ...PROBATION_LEVELS[level] },
    samples: input.samples,
    manager: input.requesterName,
  };
}
