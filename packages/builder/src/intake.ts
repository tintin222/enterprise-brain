import { AgentDefinition, type FieldSpec, type Probation, type TableField } from "@enterprise-brain/core";

/**
 * An AI employee that files a table's records from email: the job most tables need first ("each
 * supplier complaint emailed to quality@ goes into the register"). It needs one answer, the mailbox,
 * so it is made without an interview: it reads each email sent there, picks out the table's fields
 * (with Claude from any wording; offline from "Label: value" lines), takes the day the email came as
 * its date, and adds the record through the Tables connection, at first with a person's approval.
 */

export interface IntakeTable {
  key: string;
  name: string;
  fields: TableField[];
  /** The field that names a record. */
  titleField?: string;
  /** The table's department (its key), whose AI employee it becomes. */
  department?: string;
}

/** The job in plain words, as the Studio shows one. */
export interface IntakeJob {
  duty: string;
  /** What it picks out of each email. */
  picks: string[];
  /** What it takes from the email itself. */
  takes: string[];
  /** Fields that start as their list's first value. */
  startsAs: string[];
  /** Fields it leaves for people. */
  leaves: string[];
  never: string[];
  level: Probation;
  levelText: string;
}

export interface IntakePlan {
  definition: AgentDefinition;
  job: IntakeJob;
}

/** A date field about when a record came in: the day the email came. */
const RECEIVED = /(received|arriv|came in|reported|logged|opened|date|geliş|alındı|bildir|kayıt|tarih)/i;
/** An email field about who wrote: the sender, unless the email names another address. */
const SENDER = /(from|sender|reported by|contact|e-?mail|e-?posta|gönderen)/i;

const LEVEL_TEXT: Record<Probation, string> = {
  shadow: "It proposes each record; a person adds it",
  supervised: "At first, a person approves each record it adds",
  trusted: "It adds records on its own",
};

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase("tr") + w.slice(1))
    .join(" ");
}

function specOf(field: TableField): FieldSpec | undefined {
  const base = { key: field.key, label: field.label, ...(field.description ? { description: field.description } : {}) };
  switch (field.type) {
    case "text":
    case "url":
    case "link":
      return { ...base, type: "string" };
    case "long_text":
      return { ...base, type: "text" };
    case "number":
    case "money":
      return { ...base, type: "number" };
    case "date":
      return { ...base, type: "date" };
    case "yes_no":
      return { ...base, type: "boolean" };
    case "email":
      return { ...base, type: "email" };
    case "choice":
      return { ...base, type: "select", options: (field.choices ?? []).map((value) => ({ value })) };
    default:
      // People of the company and files are for people to fill.
      return undefined;
  }
}

export function intakeAgent(
  table: IntakeTable,
  options: { mailbox: string; level?: Probation; /** The company's, for the day an email came. */ timeZone?: string },
): IntakePlan {
  const mailbox = options.mailbox.trim().toLowerCase();
  const level = options.level ?? "supervised";
  const receivedField = table.fields.find((f) => f.type === "date" && RECEIVED.test(f.label));
  const picks: FieldSpec[] = [];
  const input: Record<string, string> = {};
  const job: IntakeJob = {
    duty: `Reads every email sent to ${mailbox}, and adds each one to ${table.name}`,
    picks: [],
    takes: [],
    startsAs: [],
    leaves: [],
    never: ["Never changes or removes records", "Never answers the email"],
    level,
    levelText: LEVEL_TEXT[level],
  };
  for (const field of table.fields) {
    if (field === receivedField) {
      input[field.key] = options.timeZone ? `{{ input.email.receivedAt | date:'${options.timeZone}' }}` : "{{ input.email.receivedAt | date }}";
      job.takes.push(`${field.label}: the day the email came`);
      continue;
    }
    if (field.type === "choice" && field.default !== undefined) {
      job.startsAs.push(`${field.label} starts as ${field.default}`);
      continue;
    }
    const spec = specOf(field);
    if (!spec) {
      job.leaves.push(field.label);
      continue;
    }
    picks.push(spec);
    job.picks.push(field.label);
    input[field.key] =
      field.type === "email" && SENDER.test(field.label) ? `{{ steps.fields.${field.key} || input.email.from }}` : `{{ steps.fields.${field.key} }}`;
    if (field.type === "email" && SENDER.test(field.label)) job.takes.push(`${field.label}: the sender, unless the email names another`);
  }
  const name = `${titleCase(table.name)} Clerk`;
  const slug = `${table.key.replace(/_/g, "-")}-clerk`;
  const record = table.name.toLowerCase();
  const definition = AgentDefinition.parse({
    slug,
    name,
    title: `Files ${record} from email`,
    summary: `${job.duty}${job.picks.length ? `, with ${job.picks.join(", ")}` : ""}.`,
    ...(table.department ? { department: table.department } : {}),
    archetype: "mail-triage",
    instructions: [
      `You file ${record} from the emails sent to ${mailbox}. Each email is one record of ${table.name}.`,
      "",
      `From each email, pick out: ${picks.map((f) => `${f.label}${f.description ? ` (${f.description})` : ""}`).join("; ") || "nothing: the table's fields are for people"}.`,
      "Take only what the email says; leave out anything it doesn't. Never guess a value.",
      "You never change or remove records, and you never answer the email.",
    ].join("\n"),
    inputs: [
      {
        key: "email",
        label: "Email",
        type: "object",
        required: true,
        fields: [
          { key: "from", type: "email" },
          { key: "fromName", type: "string" },
          { key: "subject", type: "string" },
          { key: "body", type: "text" },
          { key: "receivedAt", type: "string" },
        ],
      },
    ],
    outputs: [
      { key: "record", label: "Record", type: "string" },
      { key: "title", label: "What it is", type: "string" },
    ],
    workflow: [
      ...(picks.length
        ? [
            {
              id: "fields",
              name: `Pick out the ${record}`,
              type: "llm.extract" as const,
              from: "From: {{ input.email.fromName }} <{{ input.email.from }}>\nSubject: {{ input.email.subject }}\n\n{{ input.email.body }}",
              fields: picks,
              instructions: "Take only what the email says; leave out anything it doesn't. Never guess.",
            },
          ]
        : []),
      {
        id: "record",
        name: `Add it to ${table.name}`,
        type: "connector" as const,
        connector: "tables",
        operation: `add_${table.key}`,
        input,
      },
      {
        id: "result",
        type: "output" as const,
        value: { record: "#{{ steps.record.number }}", title: `{{ steps.record.${table.titleField ?? table.fields[0]?.key ?? "number"} }}` },
      },
    ],
    triggers: [{ type: "mailbox", mailbox }, { type: "manual" }],
    connectors: [{ ref: "tables", category: "tables", purpose: `Adds records to ${table.name}`, operations: [`add_${table.key}`] }],
    guardrails: {
      approvalRequiredFor: ["connector:write"],
      personalData: table.fields.some((f) => f.personal) ? "contains" : "none",
    },
    ui: { layout: "inbox", highlight: ["record", "title"] },
  });
  return { definition, job };
}
