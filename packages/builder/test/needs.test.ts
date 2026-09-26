import { describe, expect, it } from "vitest";
import { describeRepeat } from "@enterprise-brain/core";
import { ScriptedLlm, UnavailableLlm } from "@enterprise-brain/llm";
import { scheduleFromWords, understandNeed, type NeedMaterials } from "../src/index.ts";

/** The one box: a request in plain words, read as the thing to do. */

const offline = new UnavailableLlm();

const materials: NeedMaterials = {
  agents: [
    {
      slug: "mail-triage",
      name: "Mail Triage",
      summary: "Sorts customer emails into complaints, questions and orders, and drafts replies",
      duties: ["Reads every email sent to info@acme.com.tr"],
    },
    {
      slug: "cv-screener",
      name: "CV Screener",
      summary: "Scores CVs against the job's criteria",
      duties: ["Reads every email sent to careers@acme.com.tr with an attachment"],
    },
  ],
  tables: [{ key: "supplier_complaints", name: "Supplier complaints", fields: [{ key: "supplier", label: "Supplier" }] }],
  apps: [{ key: "complaint_desk", name: "Complaint desk" }],
  calculations: [{ key: "supplier_ranking", name: "Supplier ranking", rule: "Rank suppliers by complaints last month" }],
};

const read = (text: string, as?: Parameters<typeof understandNeed>[1]["as"]) => understandNeed(offline, { text, materials, ...(as ? { as } : {}) });

describe("when it repeats, from the words", () => {
  it("reads days, weekdays, months and times, and leaves the rest", () => {
    const cases: [string, string, string][] = [
      ["Every Monday at 9, send me the open complaints", "every Monday at 09:00", "Send me the open complaints"],
      ["Send me the open complaints every Friday afternoon", "every Friday at 13:00", "Send me the open complaints"],
      ["every weekday at 17:30 check the parcels", "every weekday at 17:30", "Check the parcels"],
      ["Each month, rank suppliers by complaints", "on day 1 of every month at 08:00", "Rank suppliers by complaints"],
      ["On the 15th of every month send the report at 7pm", "on day 15 of every month at 19:00", "Send the report"],
      ["her pazartesi saat 10'da açık şikayetleri gönder", "every Monday at 10:00", "Açık şikayetleri gönder"],
      ["Check the shared folder daily", "every day at 08:00", "Check the shared folder"],
    ];
    for (const [text, when, rest] of cases) {
      const found = scheduleFromWords(text);
      expect(found.schedule && describeRepeat(found.schedule), text).toBe(when);
      expect(found.rest, text).toBe(rest);
    }
    expect(scheduleFromWords("Answer every email from suppliers").schedule).toBeUndefined();
  });
});

describe("the one box, from the words alone", () => {
  it("gives work to the AI employee it names, or whose job fits", async () => {
    expect(await read("Mail Triage: reply to Akın Metal about the late parcel")).toMatchObject({
      kind: "task",
      agent: "mail-triage",
      work: "Reply to Akın Metal about the late parcel",
    });
    expect(await read("Ask the CV Screener to look at the new applications again")).toMatchObject({
      kind: "task",
      agent: "cv-screener",
      work: "Look at the new applications again",
    });
    expect(await read("Draft a reply to the customer complaint from Kaya Çelik")).toMatchObject({ kind: "task", agent: "mail-triage" });
  });

  it("makes it recurring when it says when", async () => {
    const need = await read("Can you send me the open customer complaints every Monday morning?");
    expect(need).toMatchObject({
      kind: "recurring",
      agent: "mail-triage",
      work: "Send me the open customer complaints",
      schedule: { every: "week", weekday: 1, time: "08:00" },
    });
    expect(need.alternatives).toEqual(["task", "ai-employee"]);
  });

  it("answers questions from the company's knowledge, and works out the ones about the tables", async () => {
    expect(await read("How many days of annual leave do I get?")).toMatchObject({ kind: "answer", description: "How many days of annual leave do I get?" });
    expect(await read("How many supplier complaints did we get last month?")).toMatchObject({
      kind: "calculation",
      description: "How many supplier complaints did we get last month",
    });
    expect(await read("Rank suppliers by complaints per 100 deliveries")).toMatchObject({ kind: "calculation" });
    expect(await read("Every month, rank suppliers by complaints")).toMatchObject({
      kind: "calculation",
      description: "Rank suppliers by complaints last month",
      schedule: { every: "month" },
    });
  });

  it("makes tables, apps and AI employees", async () => {
    expect(await read("I need a register of supplier complaints: supplier, order number, problem, status, owner")).toMatchObject({
      kind: "app",
      description: "I need a register of supplier complaints: supplier, order number, problem, status, owner",
      alternatives: ["table"],
    });
    expect(await read("Keep track of visitor badges: visitor, host, date, badge number")).toMatchObject({ kind: "table" });
    expect(await read("File the supplier complaints that come in by email into the register")).toMatchObject({ kind: "ai-employee" });
    expect(await read("An AI employee that answers supplier emails")).toMatchObject({ kind: "ai-employee" });
  });

  it("changes what the company has", async () => {
    expect(await read("Add Root cause to the Supplier complaints table")).toMatchObject({
      kind: "change",
      target: { type: "table", key: "supplier_complaints" },
      change: "Add Root cause",
    });
    expect(await read("Supplier ranking: this year instead")).toMatchObject({
      kind: "change",
      target: { type: "calculation", key: "supplier_ranking" },
      change: "this year instead",
    });
    expect(await read("Add a chart of complaints by month to Complaint desk")).toMatchObject({
      kind: "change",
      target: { type: "app" },
      change: "Add a chart of complaints by month",
    });
    expect(await read("Change Mail Triage so it replies in Turkish to Turkish emails")).toMatchObject({
      kind: "change",
      target: { type: "agent", key: "mail-triage" },
      change: "Change Mail Triage so it replies in Turkish to Turkish emails",
    });
  });

  it("asks when it can't tell, and reads it as the person says", async () => {
    expect(await read("Akın Metal")).toMatchObject({ kind: "unclear", question: expect.stringMatching(/^What should happen/) });
    expect(await read("Send me the open complaints", "recurring")).toMatchObject({
      kind: "recurring",
      schedule: { every: "week", weekday: 1, time: "08:00" },
      notes: ["When wasn't said: every Monday at 08:00 unless you choose another time."],
    });
    expect(await read("I need a register of supplier complaints", "table")).toMatchObject({ kind: "table" });
  });
});

describe("the one box, with the model", () => {
  it("keeps only the AI employees and keys the company has", async () => {
    const llm = new ScriptedLlm({
      "studio.need": {
        structured: () => ({
          kind: "recurring",
          agent: "mail-triage",
          work: "send me the open complaints",
          description: "",
          every: "week",
          weekday: 5,
          day: 0,
          time: "16:00",
          targetType: "",
          target: "",
          change: "",
          question: "",
          alternatives: ["task", "app"],
        }),
      },
    });
    const need = await understandNeed(llm, { text: "Fridays at four, send me the open complaints", materials });
    expect(need).toMatchObject({ kind: "recurring", agent: "mail-triage", schedule: { every: "week", weekday: 5, time: "16:00" }, drafted: "model" });
    expect(need.alternatives).toEqual(["task", "ai-employee"]);

    const unknown = new ScriptedLlm({
      "studio.need": {
        structured: () => ({
          kind: "change",
          agent: "",
          work: "",
          description: "",
          every: "",
          weekday: -1,
          day: 0,
          time: "",
          targetType: "table",
          target: "invoices",
          change: "add a field",
          question: "",
          alternatives: [],
        }),
      },
    });
    expect(await understandNeed(unknown, { text: "add a field to invoices", materials })).toMatchObject({ kind: "unclear" });
  });
});
