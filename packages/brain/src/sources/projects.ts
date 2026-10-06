import type { BrainMilestone } from "@enterprise-brain/core";
import { byWave, dayOffset, released } from "../demo/util.ts";
import type { SourceEntity, SourceLink, SourceRef } from "../types.ts";
import type { BrainSourceDefinition } from "./types.ts";

/**
 * A made-up project tool (standing in for Jira) of the demo company: its projects and their tasks,
 * who leads and works on them, and where each stands. It moves on a little each time it is read:
 * tasks get done, a project's health changes, new tasks appear.
 */

type Waves<T> = T | readonly T[];

interface Task {
  key: string;
  name: string;
  who: string;
  status: Waves<string>;
  due: number;
  priority?: string;
  wave?: number;
}

interface Project {
  key: string;
  name: string;
  summary: string;
  type: string;
  status: Waves<string>;
  health: Waves<string>;
  progress: Waves<number>;
  start: number;
  end: number;
  budget?: string;
  now: Waves<string>;
  next: Waves<string[]>;
  milestones: [name: string, due: number, status: Waves<string>][];
  risks?: string[];
  lessons?: string[];
  client?: string;
  lead: string;
  team: [local: string, role: string][];
  uses?: string[];
  suppliers?: string[];
  tasks: Task[];
}

const PROJECTS: Project[] = [
  {
    key: "petrokim-vibration",
    name: "Petrokim ACP-80 vibration fix",
    summary: "Three ACP-80 pumps at Petrokim's İzmit refinery vibrate above the limit. Find the cause, fix the pumps on site, and get the payment released.",
    type: "Customer project",
    status: "Active",
    health: ["At risk", "At risk", "On track"],
    progress: [45, 65, 85],
    start: -10,
    end: 12,
    now: [
      "Root cause found: coupling misalignment from a worn assembly fixture (F-12). New couplings are ordered; Petrokim holds the payment of invoice ACM-F-00301 until the fix.",
      "Couplings arrived; Hakan and Kerem re-align the 3 pumps on site this week.",
      "All 3 pumps re-aligned and measured at 2.1–2.6 mm/s. The 8D report is with Petrokim; they release the payment next week.",
    ],
    next: [
      ["Re-align the 3 pumps at Petrokim İzmit with new couplings", "Send the 8D report (D5–D8)", "Get the payment released"],
      ["Re-align the 3 pumps on site", "Send the 8D report (D5–D8)", "Check the 27 other ACP-80s built on fixture F-12"],
      ["Payment release next week", "Check the 27 other ACP-80s built on fixture F-12"],
    ],
    milestones: [
      ["Site inspection", -8, "Done"],
      ["Root cause agreed with Petrokim", -3, "Done"],
      ["Pumps fixed on site", 5, ["Planned", "Planned", "Done"]],
      ["8D report closed", 10, ["Planned", "Planned", "Done"]],
    ],
    risks: ["2.4 million TRY payment on hold until Petrokim accepts the fix", "The same fixture was used for 27 other ACP-80 pumps in 2026"],
    client: "Petrokim Rafineri A.Ş.",
    lead: "merve.aksoy",
    team: [
      ["kerem.yildiz", "8D report"],
      ["deniz.celik", "Assembly checks"],
      ["hakan.erdogan", "Coupling alignment"],
      ["ali.yildiz", "Customer contact"],
    ],
    uses: ["opcenter-mes", "sap-s4hana"],
    suppliers: ["Rheintal Hydraulik GmbH"],
    tasks: [
      { key: "PKV-1", name: "Site inspection at Petrokim İzmit", who: "merve.aksoy", status: "Done", due: -8 },
      { key: "PKV-2", name: "Root cause analysis (D4)", who: "kerem.yildiz", status: ["In progress", "Done"], due: -1, priority: "High" },
      { key: "PKV-3", name: "Order new flexible couplings", who: "ayse.kaya", status: ["Waiting", "Done"], due: 1 },
      {
        key: "PKV-4",
        name: "Re-align and replace couplings on 3 pumps",
        who: "hakan.erdogan",
        status: ["To do", "In progress", "Done"],
        due: 5,
        priority: "High",
      },
      { key: "PKV-5", name: "Check the 27 other ACP-80 pumps built on fixture F-12", who: "deniz.celik", status: ["To do", "To do", "In progress"], due: 14 },
      { key: "PKV-6", name: "8D report D5–D8 to Petrokim", who: "kerem.yildiz", status: ["To do", "In progress", "Done"], due: 10 },
      { key: "PKV-7", name: "Agree the payment release with Petrokim purchasing", who: "ali.yildiz", status: ["Waiting", "Waiting", "In progress"], due: 12 },
    ],
  },
  {
    key: "gulf-water-desalination",
    name: "Gulf Water desalination pumps (120 units)",
    summary: "120 pumps for Gulf Water's desalination plant in the UAE, in two shipments, after a factory acceptance test witnessed by their inspector.",
    type: "Customer project",
    status: "Active",
    health: ["On track", "At risk", "On track"],
    progress: [55, 62, 70],
    start: -60,
    end: 38,
    budget: "4.6 million USD order",
    now: [
      "80 of 120 pumps built. The FAT for the first 60 is planned in two weeks with Gulf Water's inspector.",
      "The FAT moves by a week: Gulf Water's inspector can't come before the 20th. The shipping date holds if the FAT passes the first time.",
      "FAT date confirmed with the inspector; the first 60 pumps passed the pre-test.",
    ],
    next: [
      ["Book the FAT with Gulf Water's inspector", "Build the remaining 40 pumps", "Book sea freight to Jebel Ali"],
      ["Confirm the new FAT date", "Build the remaining 40 pumps"],
      ["FAT for the first 60 pumps", "Export documents"],
    ],
    milestones: [
      ["Order confirmed", -60, "Done"],
      ["Half of the pumps built", -20, "Done"],
      ["FAT, first 60 pumps", 14, ["Planned", "Moved", "Planned"]],
      ["First shipment", 24, "Planned"],
      ["Second shipment", 38, "Planned"],
    ],
    risks: ["The inspector's availability decides the FAT date", "Export documents for the UAE need a chamber of commerce stamp (3 days)"],
    client: "Gulf Water Solutions LLC",
    lead: "laura.rossi",
    team: [
      ["okan.tekin", "Production plan"],
      ["deniz.celik", "Test and FAT"],
      ["murat.kilic", "Shipping and documents"],
      ["serkan.gunes", "Packing"],
    ],
    uses: ["sap-s4hana", "opcenter-mes", "pumptest-pro"],
    tasks: [
      { key: "GWD-1", name: "Build the remaining 40 pumps", who: "deniz.celik", status: "In progress", due: 20 },
      {
        key: "GWD-2",
        name: "Book the FAT with Gulf Water's inspector",
        who: "laura.rossi",
        status: ["In progress", "Blocked", "Done"],
        due: 2,
        priority: "High",
      },
      { key: "GWD-3", name: "FAT documents and test certificates", who: "deniz.celik", status: ["To do", "To do", "In progress"], due: 13 },
      { key: "GWD-4", name: "Export documents and chamber of commerce stamp", who: "murat.kilic", status: "To do", due: 22 },
      { key: "GWD-5", name: "Book sea freight to Jebel Ali", who: "murat.kilic", status: ["To do", "In progress", "Done"], due: 18 },
    ],
  },
  {
    key: "nordwind-npi",
    name: "Nordwind cooling pump (new product)",
    summary: "A new cooling pump, ACP-65-NW, for Nordwind Energy's wind turbines: prototype, endurance test, a new seal, then series production.",
    type: "Product development",
    status: "Active",
    health: "On track",
    progress: [30, 35, 40],
    start: -45,
    end: 90,
    now: [
      "The ACP-65-NW prototype passed 500 hours of the endurance test. Nordwind wants a quote for 300 pumps a year.",
      "Endurance test at 750 hours, no findings. The quote for 300 pumps a year is being prepared.",
    ],
    next: [["Endurance test to 1,000 hours", "Qualify the new seal from Nordic Bearings", "Quote for 300 pumps a year"]],
    milestones: [
      ["Prototype built", -10, "Done"],
      ["1,000-hour endurance test", 20, "Planned"],
      ["Quote to Nordwind", 30, "Planned"],
      ["Series production", 90, "Planned"],
    ],
    risks: ["The new seal is from a new supplier: qualification takes 6 weeks"],
    client: "Nordwind Energy A/S",
    lead: "thomas.weber",
    team: [
      ["deniz.celik", "Design changes"],
      ["ayse.kaya", "The new seal's supplier"],
      ["selin.acar", "Qualification tests"],
    ],
    suppliers: ["Nordic Bearings AB"],
    tasks: [
      { key: "NW-1", name: "Endurance test to 1,000 hours", who: "deniz.celik", status: "In progress", due: 20 },
      { key: "NW-2", name: "Qualify Nordic Bearings' new seal", who: "ayse.kaya", status: "In progress", due: 15 },
      { key: "NW-3", name: "Quote for 300 pumps a year", who: "thomas.weber", status: ["To do", "In progress", "In progress"], due: 30 },
      { key: "NW-4", name: "Control plan for ACP-65-NW", who: "selin.acar", status: "To do", due: 60 },
    ],
  },
  {
    key: "sap-upgrade",
    name: "SAP S/4HANA upgrade to the 2025 release",
    summary: "Upgrade SAP to the 2025 release, tested by key users, without touching the month-end close.",
    type: "IT project",
    status: ["Planned", "Active"],
    health: "On track",
    progress: [10, 15, 25],
    start: 5,
    end: 75,
    budget: "1.8 million TRY",
    now: [
      "Kick-off with the SAP partner next week. The test system copy needs more disk space.",
      "Production is being copied to the test system.",
      "The test system is ready; key users start testing on Monday.",
    ],
    next: [["Copy production to the test system", "Test plan with key users"]],
    milestones: [
      ["Test system ready", 10, ["Planned", "Planned", "Done"]],
      ["Key user tests", 40, "Planned"],
      ["Go-live (after the month-end close)", 75, "Planned"],
    ],
    risks: ["Must not overlap the month-end close (first 5 working days)", "The MES interface must be tested again"],
    lead: "mehmet.oz",
    team: [
      ["can.ozturk", "System and database"],
      ["selin.arslan", "Finance tests"],
      ["elif.arslan", "Invoice tests"],
    ],
    uses: ["sap-s4hana"],
    tasks: [
      { key: "SAP-1", name: "Copy production to the test system", who: "can.ozturk", status: ["To do", "In progress", "Done"], due: 10 },
      { key: "SAP-2", name: "Test plan with key users", who: "mehmet.oz", status: "In progress", due: 5 },
      { key: "SAP-3", name: "Test the MES interface again", who: "can.ozturk", status: "To do", due: 40 },
      { key: "SAP-4", name: "Finance test cases", who: "selin.arslan", status: "To do", due: 45 },
    ],
  },
  {
    key: "portal-tracking",
    name: "Customer portal: order tracking v2",
    summary: "Customers see where their order is (in production, tested, shipped) and download test certificates per pump.",
    type: "IT project",
    status: "Active",
    health: ["On track", "On track", "At risk"],
    progress: [50, 65, 70],
    start: -40,
    end: 20,
    now: [
      "Order status comes from SAP every hour; production progress from MES is next.",
      "Production progress from MES shows in the test portal: in production, tested, shipped.",
      "The MES API times out for big orders (Gulf Water); Can and Ozan are on it. The release moves by a week.",
    ],
    next: [
      ["Read production status from MES", "Test certificates per serial number"],
      ["Customer Service tries the test portal", "Test certificates per serial number"],
      ["Fix the MES API timeouts", "Release"],
    ],
    milestones: [
      ["Status from SAP", -20, "Done"],
      ["Production progress from MES", 3, ["Planned", "Done"]],
      ["Release to customers", 20, "Planned"],
    ],
    risks: ["The MES API is slow for big orders"],
    lead: "ozan.kurt",
    team: [
      ["zeynep.kaya", "What customers need"],
      ["can.ozturk", "MES and SQL"],
    ],
    uses: ["customer-portal", "opcenter-mes", "sap-s4hana"],
    tasks: [
      { key: "PT-1", name: "Read production status from MES", who: "ozan.kurt", status: ["In progress", "Done"], due: 3 },
      { key: "PT-2", name: "Show test certificates per serial number", who: "ozan.kurt", status: ["To do", "In progress"], due: 12 },
      { key: "PT-3", name: "Customer Service tries the test portal", who: "zeynep.kaya", status: ["To do", "In progress", "Done"], due: 8, wave: 1 },
      { key: "PT-4", name: "Fix MES API timeouts for big orders", who: "can.ozturk", status: "In progress", due: 5, priority: "High", wave: 2 },
    ],
  },
  {
    key: "ai-employees-rollout",
    name: "AI employees rollout",
    summary: "AI employees in every department, and a company brain they and the people share.",
    type: "Internal",
    status: "Active",
    health: "On track",
    progress: [40, 45, 50],
    start: -120,
    end: 85,
    now: [
      "AI employees work in Finance, HR, Customer Service and IT. Operations builds its first one with the Studio; the company brain is being filled from the systems.",
    ],
    next: [["Fill the company brain from the systems", "Operations' first AI employee", "Review the first month of each AI employee"]],
    milestones: [
      ["Finance, HR, Customer Service and IT at work", -60, "Done"],
      ["Company brain filled", 7, ["Planned", "Done"]],
      ["Operations' first AI employee", 14, "Planned"],
    ],
    lead: "mehmet.oz",
    team: [
      ["burak.sahin", "Finance"],
      ["ayse.yilmaz", "HR"],
      ["selin.acar", "Operations"],
      ["zeynep.kaya", "Customer Service"],
    ],
    tasks: [
      { key: "AI-1", name: "Fill the company brain from the systems", who: "mehmet.oz", status: ["In progress", "Done"], due: 7 },
      { key: "AI-2", name: "Operations: first AI employee for supplier complaints", who: "selin.acar", status: ["To do", "In progress"], due: 14 },
      { key: "AI-3", name: "Review the AI employees' first month", who: "mehmet.oz", status: "To do", due: 21 },
    ],
  },
  {
    key: "iso-9001-audit",
    name: "ISO 9001 surveillance audit",
    summary: "The yearly surveillance audit of the quality system by the certification body.",
    type: "Internal",
    status: "Planned",
    health: "On track",
    progress: [10, 20, 30],
    start: 25,
    end: 27,
    now: ["Audit days agreed with the certification body. Open corrective actions are being closed."],
    next: [["Internal audit of the 8D process", "Close open corrective actions"]],
    milestones: [["Audit", 26, "Planned"]],
    lead: "selin.acar",
    team: [["kerem.yildiz", "Internal audit"]],
    tasks: [
      { key: "ISO-1", name: "Internal audit of the 8D process", who: "kerem.yildiz", status: ["To do", "In progress"], due: 10 },
      { key: "ISO-2", name: "Close open corrective actions", who: "selin.acar", status: "In progress", due: 15 },
    ],
  },
  {
    key: "hamburg-salesforce",
    name: "Hamburg sales to Salesforce",
    summary: "The Hamburg office's customers and deals moved from Excel to Salesforce.",
    type: "IT project",
    status: "Done",
    health: "On track",
    progress: 100,
    start: -420,
    end: -330,
    now: "Done: Hamburg works in Salesforce since last year.",
    next: [[]],
    milestones: [["Go-live in Hamburg", -330, "Done"]],
    lessons: ["Clean customer data before moving it, not after", "Train people in their own language (German)", "One owner for each client"],
    lead: "thomas.weber",
    team: [["laura.rossi", "Key user"]],
    uses: ["salesforce"],
    tasks: [],
  },
  {
    key: "test-bench-2",
    name: "Second pump test bench (TB2)",
    summary: "A second test bench, so every pump can be tested.",
    type: "Improvement",
    status: "Done",
    health: "On track",
    progress: 100,
    start: -600,
    end: -480,
    now: "Done: TB2 runs since last year.",
    next: [[]],
    milestones: [["TB2 in use", -480, "Done"]],
    lessons: ["Order the flow meters 4 months ahead", "Calibrate both benches against the same reference meter"],
    lead: "deniz.celik",
    team: [["hakan.erdogan", "Installation and calibration"]],
    uses: ["pumptest-pro"],
    tasks: [],
  },
];

export const projectsSource: BrainSourceDefinition = {
  key: "projects",
  name: "Project tool (demo)",
  system: "Jira",
  description:
    "Ongoing and past projects, their tasks, who leads and works on them, milestones, risks and lessons learned. Projects move on a little each time it is read.",
  brings: ["Projects", "Tasks and who does them", "Milestones and risks", "Lessons learned"],
  icon: "kanban",
  demo: true,
  priority: 50,
  async read({ domain, now, syncs }) {
    const person = (local: string): SourceRef => ({ kind: "person", email: `${local}@${domain}` });
    const entities: SourceEntity[] = [];
    const links: SourceLink[] = [];
    for (const project of PROJECTS) {
      const me: SourceRef = { kind: "project", key: project.key };
      const milestones: BrainMilestone[] = project.milestones.map(([name, due, status]) => ({ name, due: dayOffset(now, due), status: byWave(status, syncs) }));
      entities.push({
        kind: "project",
        ref: project.key,
        key: project.key,
        name: project.name,
        summary: project.summary,
        data: {
          status: byWave(project.status, syncs),
          health: byWave(project.health, syncs),
          type: project.type,
          start: dayOffset(now, project.start),
          end: dayOffset(now, project.end),
          progress: byWave(project.progress, syncs),
          budget: project.budget,
          now: byWave(project.now, syncs),
          next_steps: byWave(project.next, syncs),
          milestones,
          risks: project.risks ?? [],
          lessons: project.lessons ?? [],
        },
      });
      links.push({ from: person(project.lead), relation: "leads", to: me });
      links.push({ from: person(project.lead), relation: "works_on", to: me, detail: "Lead" });
      for (const [local, role] of project.team) links.push({ from: person(local), relation: "works_on", to: me, detail: role });
      if (project.client) links.push({ from: me, relation: "for_client", to: { kind: "client", name: project.client } });
      for (const system of project.uses ?? []) links.push({ from: me, relation: "uses", to: { kind: "system", key: system } });
      for (const supplier of project.suppliers ?? []) links.push({ from: { kind: "supplier", name: supplier }, relation: "supplies", to: me });
      for (const task of released(project.tasks, syncs)) {
        const status = byWave(task.status, syncs - (task.wave ?? 0));
        entities.push({
          kind: "task",
          ref: task.key,
          key: task.key.toLowerCase(),
          name: task.name,
          aliases: [task.key],
          data: { status, due: dayOffset(now, task.due), priority: task.priority ?? "Medium", source: `Jira ${task.key}` },
        });
        const ref: SourceRef = { kind: "task", key: task.key.toLowerCase() };
        links.push({ from: ref, relation: "part_of", to: me });
        links.push({ from: ref, relation: "assigned_to", to: person(task.who) });
        if (project.client) links.push({ from: ref, relation: "for_client", to: { kind: "client", name: project.client } });
      }
    }
    return { entities, links };
  },
};
