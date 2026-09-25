import { PROBATION_LEVELS, isRecord, type AgentDefinition, type Probation, type TrustLimits } from "@enterprise-brain/core";

/** What the manager decided about an AI employee: its level and, when trusted, its limits. */
export interface Employment {
  probation: Probation;
  limits: TrustLimits;
}

export const DEFAULT_EMPLOYMENT: Employment = { probation: "supervised", limits: {} };

/** A change an AI employee wants to make: an email sent, or a write action in a connected system. */
export type WriteAction = { type: "mail.send"; to: string } | { type: "connector"; ref: string; operation: string; input: Record<string, unknown> };

export interface ApprovalCheck {
  needed: boolean;
  /** In plain words, for the approval card and the task history. */
  reason: string;
  /** The change runs without a person because the AI employee is trusted (counts towards its daily limit). */
  alone?: boolean;
}

/** Guardrail entries from before probation levels ("every email / every change asks"): the level decides those now. */
const LEVEL_DEFAULTS = new Set(["mail.send", "connector:write", "connector:*"]);

/** The starting level for a new AI employee: its job's guardrails asked for no approvals → trusted. */
export function defaultProbation(definition: AgentDefinition): Probation {
  return definition.guardrails.approvalRequiredFor.length === 0 ? "trusted" : "supervised";
}

/**
 * Must a person approve this change before it happens?
 *
 * 1. A workflow step's explicit `requiresApproval` wins. `false` means a person already approved it
 *    earlier in the workflow (the templates' "approve" steps), so it isn't asked twice.
 * 2. Shadow and Supervised: every change goes to a person.
 * 3. Trusted: changes the job always asks about (guardrails naming a system or an action), and anything
 *    above the manager's limits (amount, currency, changes a day, email domains), go to a person.
 */
export function checkApproval(
  definition: AgentDefinition,
  employment: Employment,
  action: WriteAction,
  options: { explicit?: boolean; changesToday?: number } = {},
): ApprovalCheck {
  if (options.explicit === true) return { needed: true, reason: "This step always asks a person" };
  if (options.explicit === false) return { needed: false, reason: "A person approved it earlier in this task" };
  if (employment.probation !== "trusted") {
    return { needed: true, reason: `${PROBATION_LEVELS[employment.probation].label}: every change goes to a person` };
  }
  if (action.type === "connector") {
    const always = definition.guardrails.approvalRequiredFor.find(
      (p) => !LEVEL_DEFAULTS.has(p) && (p === `connector:${action.ref}` || p === `connector:${action.ref}.${action.operation}`),
    );
    if (always) return { needed: true, reason: "Its job says to always ask a person before this" };
  }
  const limits = employment.limits;
  if (limits.maxActionsPerDay !== undefined && (options.changesToday ?? 0) >= limits.maxActionsPerDay) {
    return { needed: true, reason: `Above its limit of ${limits.maxActionsPerDay} changes a day` };
  }
  if (action.type === "mail.send") {
    const allowed = (limits.mailDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    if (allowed.length) {
      const outside = recipients(action.to).filter((address) => {
        const domain = address.split("@")[1] ?? "";
        return !allowed.some((d) => domain === d || domain.endsWith(`.${d}`));
      });
      if (outside.length) return { needed: true, reason: `${outside.join(", ")} is outside the domains it may email alone (${allowed.join(", ")})` };
    }
  } else if (limits.maxAmount !== undefined) {
    const currencies = actionCurrencies(action.input);
    const other = limits.currency ? currencies.find((c) => c !== limits.currency) : undefined;
    if (other) return { needed: true, reason: `The amount is in ${other}; its limit is in ${limits.currency}` };
    const amount = actionAmount(action.input);
    if (amount !== undefined && amount > limits.maxAmount) {
      return { needed: true, reason: `${formatAmount(amount, limits.currency)} is above its limit of ${formatAmount(limits.maxAmount, limits.currency)}` };
    }
  }
  return { needed: false, reason: "Within its limits (Trusted)", alone: true };
}

/** "a@x.com, B@y.com; c@z.com" → ["a@x.com", "b@y.com", "c@z.com"] */
function recipients(to: string): string[] {
  return to
    .split(/[,;\s]+/)
    .map((a) => a.trim().replace(/^.*</, "").replace(/>$/, "").toLowerCase())
    .filter((a) => a.includes("@"));
}

const AMOUNT_KEY = /amount|total|price|tutar|fee|cost/i;

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * The largest amount an action carries: amount-like fields (total_amount, net_amount, price…) and
 * order lines (quantity × unit price, summed). Undefined when it names no amount.
 */
export function actionAmount(input: unknown): number | undefined {
  const found: number[] = [];
  const lineTotal = (item: unknown): number | undefined => {
    if (!isRecord(item)) return undefined;
    const quantity = asNumber(item.quantity ?? item.qty);
    const price = asNumber(item.unit_price ?? item.unitPrice ?? item.price);
    return quantity !== undefined && price !== undefined ? quantity * price : undefined;
  };
  const walk = (value: unknown, key?: string) => {
    const number = key && AMOUNT_KEY.test(key) ? asNumber(value) : undefined;
    if (number !== undefined) found.push(Math.abs(number));
    else if (Array.isArray(value)) {
      const totals = value.map(lineTotal).filter((t): t is number => t !== undefined);
      if (totals.length) found.push(Math.abs(totals.reduce((a, b) => a + b, 0)));
      value.forEach((item) => walk(item));
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(input);
  return found.length ? Math.max(...found) : undefined;
}

/** Currency codes an action names ("currency": "EUR"), upper-cased. */
function actionCurrencies(input: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, key?: string) => {
    if (key && /^currency(_code)?$/i.test(key) && typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim())) found.add(value.trim().toUpperCase());
    else if (Array.isArray(value)) value.forEach((item) => walk(item));
    else if (isRecord(value)) for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(input);
  return [...found];
}

function formatAmount(amount: number, currency?: string): string {
  const text = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency ? `${text} ${currency}` : text;
}
