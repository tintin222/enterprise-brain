import { describe, expect, it } from "vitest";
import {
  adaptiveCard,
  googleCard,
  googleChatMessage,
  handledCard,
  itemCard,
  outcomeText,
  pickAgentCard,
  rankAgents,
  teamsActivity,
  type Person,
  type QueueEntry,
} from "../src/index.ts";

/** Cards for chat apps: what each item shows and which buttons it has, drawn as Teams Adaptive Cards. */

const person = { id: "p1", companyId: "c1", name: "Elif Arslan", email: "elif@acme.test" } as Person;
const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  type: "approval",
  id: "a1",
  companyId: "c1",
  title: "Send email to ap@kaya.example",
  details: "Subject: Overdue invoice\n\nPlease pay.",
  reason: "Supervised: every change goes to a person",
  suggestion: null,
  options: null,
  action: { type: "mail.send", to: "ap@kaya.example", subject: "Overdue invoice", body: "Dear team,\n\nPlease pay [here](http://evil.example).\n\nRegards" },
  agent: { id: "g1", slug: "reminder-clerk", name: "Reminder Clerk", managerUserId: null },
  departmentId: "d1",
  assigneeUserId: null,
  task: { id: "t1", ref: "EB-7K2Q9", title: "Remind Kaya", status: "needs_person" },
  status: "pending",
  resolvedBy: null,
  answer: null,
  createdAt: new Date(),
  ...over,
});
const links = { act: "https://brain.test/act/TOKEN", open: "https://brain.test/work/EB-7K2Q9", preferences: "https://brain.test/?notifications=1" };

describe("item cards", () => {
  it("shows an approval's reason and change, with buttons that act and ones that open pages", () => {
    const card = itemCard({ companyId: "c1", companyName: "Acme", person, entry: entry(), links });
    expect(card).toMatchObject({ summary: "Approve? Send email to ap@kaya.example", subtitle: "Approval · Reminder Clerk · EB-7K2Q9" });
    // The generated details restate the email: only the change box shows it.
    expect(card.blocks.map((b) => b.kind)).toEqual(["notice", "text", "facts", "quote", "input"]);
    expect(card.actions).toEqual([
      { kind: "submit", label: "Approve", verb: "approve", data: { eb: "act", type: "approval", id: "a1" }, style: "positive" },
      { kind: "submit", label: "Reject", verb: "reject", data: { eb: "act", type: "approval", id: "a1" }, style: "destructive" },
      { kind: "open", label: "Correct it first", url: "https://brain.test/act/TOKEN?choice=edit" },
      { kind: "open", label: "Open in the app", url: "https://brain.test/work/EB-7K2Q9" },
    ]);

    const adaptive = adaptiveCard(card);
    expect(adaptive).toMatchObject({ type: "AdaptiveCard", version: "1.5" });
    const text = JSON.stringify(adaptive);
    // A link an AI employee wrote shows its address instead of hiding it.
    expect(text).toContain("Please pay [here] (http://evil.example).");
    expect(text).not.toContain("[here](");
    expect((adaptive.actions as { type: string }[]).map((a) => a.type)).toEqual(["Action.Execute", "Action.Execute", "Action.OpenUrl", "Action.OpenUrl"]);
    expect(teamsActivity({ card })).toMatchObject({ summary: card.summary, attachments: [{ contentType: "application/vnd.microsoft.card.adaptive" }] });
  });

  it("asks a question with its options, and says how items ended", () => {
    const question = itemCard({
      companyId: "c1",
      companyName: "Acme",
      person,
      entry: entry({ type: "question", title: "Which cost centre?", options: ["4200", "4300"], action: null }),
      links,
    });
    expect(question.blocks.find((b) => b.kind === "choice")).toMatchObject({ options: ["4200", "4300"] });
    expect(question.actions.map((a) => a.label)).toEqual(["Send answer", "Dismiss", "Open in the app"]);

    expect(outcomeText({ type: "approval" }, "Elif", "corrected and approved")).toBe("Corrected and approved by Elif");
    expect(outcomeText({ type: "question" }, "Burak", "4200")).toBe("Answered by Burak: 4200");
    expect(outcomeText({ type: "approval" }, "Burak", "withdrawn: the task was stopped")).toBe("Withdrawn: the task was stopped");
    const handled = handledCard(entry({ status: "rejected" }), { by: "Burak", outcome: "rejected" }, links.open);
    expect(handled.blocks[0]).toEqual({ kind: "notice", text: "Rejected by Burak", tone: "attention" });
    expect(handled.actions).toEqual([{ kind: "open", label: "Open in the app", url: links.open }]);
  });
});

describe("choosing an AI employee", () => {
  const agents = [
    { slug: "expense-auditor", name: "Expense Auditor", summary: "Checks expense reports against the policy." },
    { slug: "reminder-clerk", name: "Reminder Clerk", summary: "Reminds customers of overdue invoices." },
    { slug: "cv-screener", name: "CV Screener", summary: "Screens applicants' CVs." },
  ];

  it("puts first the one whose job matches the request", () => {
    expect(rankAgents(agents, "Please remind Mavi Tekstil about the overdue invoice INV-31")[0]!.slug).toBe("reminder-clerk");
    expect(rankAgents(agents, "screen these CVs for the welder role")[0]!.slug).toBe("cv-screener");
    expect(rankAgents(agents, "hello there").map((a) => a.slug)).toEqual(["expense-auditor", "reminder-clerk", "cv-screener"]);
    const card = pickAgentCard(agents, "remind Mavi Tekstil");
    expect(card.blocks.find((b) => b.kind === "choice")).toMatchObject({ id: "agent", value: "reminder-clerk", compact: true });
  });
});

describe("Google Chat cards", () => {
  it("escapes what AI employees wrote, and keeps buttons' parameters", () => {
    const card = itemCard({
      companyId: "c1",
      companyName: "Acme",
      person,
      entry: entry({
        reason: "Amount <b>12,500</b> & more",
        action: { type: "mail.send", to: "a@b.example", subject: "Hi", body: "Line 1\nLine <script>2</script>" },
      }),
      links,
    });
    const google = googleCard(card);
    const text = JSON.stringify(google);
    expect(text).toContain("Amount &lt;b&gt;12,500&lt;/b&gt; &amp; more");
    expect(text).toContain("Line 1<br>Line &lt;script&gt;2&lt;/script&gt;");
    expect(google).toMatchObject({ header: { title: "Send email to ap@kaya.example", subtitle: "Approval · Reminder Clerk · EB-7K2Q9" } });
    const buttons = (google.sections as { widgets: { buttonList?: { buttons: { text: string; onClick: Record<string, unknown> }[] } }[] }[])[0]!.widgets.at(-1)!
      .buttonList!.buttons;
    expect(buttons[0]).toMatchObject({
      text: "Approve",
      onClick: {
        action: {
          function: "approve",
          parameters: [
            { key: "eb", value: "act" },
            { key: "type", value: "approval" },
            { key: "id", value: "a1" },
          ],
        },
      },
    });
    expect(buttons[3]).toEqual({ text: "Open in the app", onClick: { openLink: { url: links.open } } });
    expect(googleChatMessage({ card })).toMatchObject({ fallbackText: card.summary, cardsV2: [{ cardId: "eb" }] });
  });
});
