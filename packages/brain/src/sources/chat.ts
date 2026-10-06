import { released, waveMoment } from "../demo/util.ts";
import type { SourceEvent, SourceRef } from "../types.ts";
import type { BrainSourceDefinition, SourceContext } from "./types.ts";

/**
 * Made-up chat of the demo company: Microsoft Teams channels at the Istanbul HQ and the Gebze plant,
 * and the Hamburg office's Slack. New messages arrive each time a source is read again.
 */

interface Message {
  channel: string;
  from: string;
  text: string;
  /** Days ago, for messages there from the first reading. */
  days: number;
  wave?: number;
}

/** What a channel is about, besides the names its messages mention. */
const CHANNEL_ABOUT: Record<string, SourceRef[]> = {
  "Quality › Petrokim 8D": [{ kind: "project", key: "petrokim-vibration" }],
  "IT › SAP upgrade": [{ kind: "project", key: "sap-upgrade" }],
  "Finance › Close": [{ kind: "process", key: "finance.month-end-close" }],
  "#nordwind-npi": [{ kind: "project", key: "nordwind-npi" }],
  "Customer Service": [],
};

const TEAMS: Message[] = [
  {
    channel: "Quality › Petrokim 8D",
    from: "merve.aksoy",
    days: -9,
    text: "Site visit at Petrokim İzmit done. 3 of the 30 ACP-80 pumps vibrate at 6.8–7.1 mm/s. Photos and readings are in the 8D folder on SharePoint.",
  },
  {
    channel: "Quality › Petrokim 8D",
    from: "kerem.yildiz",
    days: -6,
    text: "The 3 serial numbers were fine at final test (2.3 mm/s in Opcenter MES), so it happened at assembly or on site. Checking the coupling alignment next.",
  },
  {
    channel: "Quality › Petrokim 8D",
    from: "hakan.erdogan",
    days: -4,
    text: "Assembly fixture F-12 is worn, 0.3 mm off. All 3 pumps were assembled on it. I can re-align them on site once new couplings arrive.",
  },
  {
    channel: "Quality › Petrokim 8D",
    from: "selin.acar",
    days: -3,
    text: "Root cause agreed with Petrokim in today's call: coupling misalignment. Ayşe Kaya, please order 3 flexible couplings, urgent.",
  },
  { channel: "Quality › Petrokim 8D", from: "ayse.kaya", days: -3, text: "Ordered from Rheintal Hydraulik GmbH, arriving in 3 days." },
  {
    channel: "Sales TR",
    from: "ali.yildiz",
    days: -2,
    text: "Petrokim purchasing says the payment of ACM-F-00301 stays on hold until the 8D is closed. They liked how fast we reacted, though.",
  },
  {
    channel: "Gebze plant › Production",
    from: "okan.tekin",
    days: -7,
    text: "On-time delivery in September was 91%. Main reason: castings from Anadolu Döküm Sanayi came 6 days late. Ayşe, can we get a second source?",
  },
  {
    channel: "Gebze plant › Production",
    from: "ayse.kaya",
    days: -7,
    text: "Asking Lombardia Valvole for a quote for the DN80 housings. They need a supplier audit before we can order.",
  },
  {
    channel: "Gebze plant › Production",
    from: "deniz.celik",
    days: -5,
    text: "Gulf Water order: 80 of 120 pumps built. Test bench TB2 runs two shifts this week.",
  },
  {
    channel: "Gebze plant › Production",
    from: "hakan.erdogan",
    days: -2,
    text: "TB1's flow meter reads about 3% high again. Recalibrating tomorrow morning; use TB2 until 10:00.",
  },
  {
    channel: "Gebze plant › Production",
    from: "serkan.gunes",
    days: -1,
    text: "Only 1,200 of the 2,000 bearings from Nordic Bearings came for PO-4500014. Posted the partial goods receipt in SAP.",
  },
  {
    channel: "IT › SAP upgrade",
    from: "mehmet.oz",
    days: -6,
    text: "Kick-off with the SAP partner next week. We must not touch the month-end close: work starts after working day 5.",
  },
  {
    channel: "IT › SAP upgrade",
    from: "can.ozturk",
    days: -4,
    text: "Copying production to the test system needs 1.4 TB free on the cluster. Ordering 2 more disks.",
  },
  {
    channel: "Finance › Close",
    from: "selin.arslan",
    days: -4,
    text: "September close is done except the consolidation. Hande is on leave; does anyone know her mapping workbook? Without it there is no management report.",
  },
  {
    channel: "Finance › Close",
    from: "burak.sahin",
    days: -4,
    text: "I only know it roughly. Hande left notes on SharePoint › Finance; I'll try with Selin tomorrow.",
  },
  {
    channel: "Finance › Close",
    from: "elif.yilmaz",
    days: -3,
    text: "The management report will be 3 days late this month. From now on, two people must know the consolidation.",
  },
  {
    channel: "Management",
    from: "mehmet.aydin",
    days: -5,
    text: "Great reaction on Petrokim. Let's check all 27 other ACP-80 pumps built on fixture F-12 before they cause trouble at other customers.",
  },
  {
    channel: "Management",
    from: "thomas.weber",
    days: -1,
    text: "Nordwind Energy liked the prototype. They want a quote for 300 pumps a year by the end of next month.",
  },
  {
    channel: "Customer Service",
    from: "zeynep.kaya",
    days: -6,
    text: "Lots of calls this week about order status. The customer portal still shows only shipped orders; Ozan, when does tracking v2 come?",
  },
  { channel: "Customer Service", from: "ozan.kurt", days: -6, text: "Production status from Opcenter MES is next. Aiming for the end of the month." },
  { channel: "Customer Service", from: "deniz.aydin", days: -1, text: "Boğaziçi Su asked again about spare part kits for ACP-80. Quote sent for 40 kits." },
  {
    channel: "HR",
    from: "ayse.yilmaz",
    days: -3,
    text: "Two open positions in Gebze: CNC operator and quality technician. CVs come to careers@; the CV Screener ranks them.",
  },
  {
    channel: "Quality › Petrokim 8D",
    from: "hakan.erdogan",
    days: 0,
    wave: 1,
    text: "Couplings arrived. Going to Petrokim İzmit tomorrow with Kerem to re-align the 3 pumps.",
  },
  {
    channel: "Gebze plant › Production",
    from: "laura.rossi",
    days: 0,
    wave: 1,
    text: "Gulf Water's inspector can't come before the 20th. The FAT moves by a week; the shipping date holds if the FAT passes the first time.",
  },
  { channel: "IT › SAP upgrade", from: "can.ozturk", days: 0, wave: 1, text: "Disks are in. Copying production to the test system tonight." },
  {
    channel: "Finance › Close",
    from: "burak.sahin",
    days: 0,
    wave: 1,
    text: "Selin and I rebuilt the consolidation from Hande's notes; the report goes out today. Writing the steps down in the company brain so it never depends on one person again.",
  },
  {
    channel: "Customer Service",
    from: "ozan.kurt",
    days: 0,
    wave: 1,
    text: "Tracking v2 is in the test portal: in production → tested → shipped. Zeynep, can your team try it?",
  },
  { channel: "Quality › Petrokim 8D", from: "kerem.yildiz", days: 0, wave: 2, text: "All 3 pumps re-aligned: 2.1–2.6 mm/s. 8D report D5–D8 sent to Petrokim." },
  { channel: "Sales TR", from: "ali.yildiz", days: 0, wave: 2, text: "Petrokim confirmed: the payment is released next week." },
  {
    channel: "Gebze plant › Production",
    from: "deniz.celik",
    days: 0,
    wave: 2,
    text: "Checked 12 of the 27 ACP-80s from fixture F-12 at customers' sites through our service partners: all fine so far.",
  },
  {
    channel: "Customer Service",
    from: "ozan.kurt",
    days: 0,
    wave: 2,
    text: "The MES API times out for orders with more than 50 pumps (Gulf Water!). Can is looking at the SQL side.",
  },
  {
    channel: "Management",
    from: "okan.tekin",
    days: 0,
    wave: 2,
    text: "Gulf Water's FAT date is confirmed with their inspector; the first 60 pumps passed the pre-test.",
  },
  { channel: "Gebze plant › Production", from: "hakan.erdogan", days: 0, wave: 3, text: "TB1 recalibrated against the reference meter: within 0.5% now." },
  { channel: "HR", from: "can.demir", days: 0, wave: 3, text: "CNC operator: 3 good candidates on the CV Screener's shortlist, interviews on Thursday." },
  { channel: "IT › SAP upgrade", from: "mehmet.oz", days: 0, wave: 3, text: "The test system is ready. Key users can start testing on Monday." },
];

const SLACK: Message[] = [
  {
    channel: "#export-emea",
    from: "laura.rossi",
    days: -8,
    text: "Gulf Water wants the FAT witnessed by their inspector, as always. I'll book him two weeks ahead.",
  },
  {
    channel: "#export-emea",
    from: "laura.rossi",
    days: -5,
    text: "Hansa Pumpen complains again about English delivery notes. Ece, please use the German template from SharePoint › Sales.",
  },
  { channel: "#nordwind-npi", from: "thomas.weber", days: -10, text: "The ACP-65-NW prototype is on the endurance test in Gebze. 500 hours done." },
  {
    channel: "#nordwind-npi",
    from: "thomas.weber",
    days: -1,
    text: "Nordwind's engineering lead visited: they want 300 pumps a year, quote by the end of next month.",
  },
  {
    channel: "#export-emea",
    from: "laura.rossi",
    days: -3,
    text: "Price calculator updated with the new steel prices from Kaya Çelik. Discounts for EPC customers unchanged.",
  },
  {
    channel: "#hamburg-office",
    from: "thomas.weber",
    days: -2,
    text: "Vistula Water Engineering (Gdańsk) asked for a call about pumps for a new treatment plant. Laura, can you take it?",
  },
  { channel: "#export-emea", from: "laura.rossi", days: -2, text: "Rhône Aqua Services: the tender documents arrived, deadline in 3 weeks." },
  { channel: "#export-emea", from: "laura.rossi", days: 0, wave: 1, text: "Gulf Water's inspector can't come before the 20th. Telling Okan." },
  {
    channel: "#nordwind-npi",
    from: "thomas.weber",
    days: 0,
    wave: 1,
    text: "Starting the Nordwind quote. Laura, I need the price calculator run for 300 pumps.",
  },
  {
    channel: "#export-emea",
    from: "laura.rossi",
    days: 0,
    wave: 2,
    text: "Vistula call done: they need 24 ACP-80s, delivery in Q1. Opening a deal in Salesforce.",
  },
  { channel: "#nordwind-npi", from: "thomas.weber", days: 0, wave: 2, text: "Draft quote ready: 300 pumps at 2,850 EUR each." },
];

function messages(source: "teams" | "slack", list: Message[], { domain, now, syncs }: SourceContext): SourceEvent[] {
  return released(list, syncs).map((message, index) => ({
    ref: `${source}:${list.indexOf(message)}`,
    at: waveMoment(now, message.wave ?? 0, message.days, index),
    kind: "message",
    title: message.text.length > 110 ? `${message.text.slice(0, 109)}…` : message.text,
    body: message.text,
    actor: `${message.from}@${domain}`,
    place: message.channel,
    about: CHANNEL_ABOUT[message.channel] ?? [],
  }));
}

export const teamsSource: BrainSourceDefinition = {
  key: "teams",
  name: "Microsoft Teams (demo)",
  system: "Microsoft Teams",
  description:
    "Messages in the channels of the Istanbul HQ and the Gebze plant: what people work on, decide and worry about. New messages each time it is read.",
  brings: ["Channel messages", "What is happening now"],
  icon: "message-square",
  demo: true,
  priority: 40,
  async read(ctx) {
    return { events: messages("teams", TEAMS, ctx) };
  },
};

export const slackSource: BrainSourceDefinition = {
  key: "slack",
  name: "Slack (demo)",
  system: "Slack",
  description: "The Hamburg sales office's channels: export customers, tenders and the Nordwind project. New messages each time it is read.",
  brings: ["Channel messages", "Sales news from Hamburg"],
  icon: "hash",
  demo: true,
  priority: 40,
  async read(ctx) {
    return { events: messages("slack", SLACK, ctx) };
  },
};
