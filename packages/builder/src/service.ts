import { and, asc, desc, eq } from "drizzle-orm";
import {
  ARCHETYPE_LABELS,
  STAKEHOLDER_LABELS,
  nowIso,
  slugify,
  truncate,
  type AgentDefinition,
  type AgentTemplate,
  type Archetype,
  type BuilderRound,
  type BuilderStatus,
  type RequirementNode,
  type RequirementTree,
  type RoundQuestion,
  type SampleAnalysis,
  type StakeholderRole,
} from "@enterprise-brain/core";
import { builderMessages, builderSessions, stakeholderRequests } from "@enterprise-brain/db";
import { analyzeSample, extractDocument } from "@enterprise-brain/documents";
import type { Platform } from "@enterprise-brain/runtime";
import { Analyst } from "./analyst.ts";
import { generateDefinition, guessSystemCategory, requirementsDigest, type Synthesis } from "./generate.ts";
import { buildInitialNodes } from "./nodes.ts";
import { coerceAnswer, type ParsedAnswer } from "./parse.ts";
import { describeDefinition, displayValue, renderFollowUp, renderRound, renderSummary } from "./render.ts";
import { composeStakeholderRequest, newToken, stakeholderQuestion } from "./stakeholders.ts";
import {
  addNodes,
  answer,
  assume,
  createNode,
  createTree,
  defaultDelegate,
  delegate,
  delegatedNodes,
  frontier,
  getNode,
  isApplicable,
  isOpen,
  isSettled,
  markAsked,
  progress,
  reopen,
  skip,
  stateOf,
  valueOf,
  waitingOnStakeholders,
  type TreeProgress,
} from "./tree.ts";

export type SessionRow = typeof builderSessions.$inferSelect;
export type MessageRow = typeof builderMessages.$inferSelect;
export type RequestRow = typeof stakeholderRequests.$inferSelect;

interface SessionSettings {
  roundSize: number;
  notes: string[];
  /** The company's mail domain: replaces the catalog's placeholder addresses (careers@company.com). */
  mailDomain?: string;
  knowledgeCollection?: string;
  sampleObservations?: string;
}

/** Compact rendering of an output value for chat: lists show their first items, text is shortened at a word. */
function briefValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)));
    return items.length > 3 ? `${items.slice(0, 3).join(", ")} +${items.length - 3} more` : items.join(", ") || "none";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 80).replace(/\s+\S*$/, "")}…` : text;
}

export interface StartSessionInput {
  description: string;
  formDescription?: string;
  requesterName?: string;
  requesterEmail?: string;
  requesterRole?: string;
  department?: string;
  language?: string;
  roundSize?: number;
}

export interface StructuredAnswer {
  nodeId: string;
  action?: "answer" | "accept" | "delegate" | "skip";
  value?: unknown;
  delegateTo?: StakeholderRole;
}

export interface SessionView {
  session: SessionRow;
  tree: RequirementTree;
  messages: MessageRow[];
  requests: RequestRow[];
  currentRound?: BuilderRound;
  progress: TreeProgress;
  draft?: AgentDefinition;
  agent?: { id: string; slug: string; status: string; name: string };
  llm: { available: boolean; provider: string; model: string };
}

const CONFIRM = /^\s*(confirm(ed)?|yes,? (build|go)|build (it|the agent)|go ahead|looks good,? build|onayla(yorum)?|onaylıyorum|tamam,? (oluştur|kur)|oluştur|evet,? oluştur)\b/i;
const ACTIVATE = /^\s*(activate|deploy|go live|publish|yayınla|canlıya al|aktif et|devreye al)\b/i;

export class BuilderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "BuilderError";
  }
}

/**
 * The Agent Builder. Interviews a requester in grilling rounds, finds facts
 * itself (samples, connectors), routes questions it can't settle to the right
 * stakeholders, and only generates the agent after explicit confirmation.
 */
export class BuilderService {
  readonly analyst: Analyst;

  constructor(
    private readonly platform: Platform,
    private readonly options: { publicBaseUrl: string } = { publicBaseUrl: "http://localhost:3200" },
  ) {
    this.analyst = new Analyst(platform.llm, platform.catalog.catalog);
  }

  private get db() {
    return this.platform.handle.db;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async start(companyId: string, input: StartSessionInput): Promise<SessionView> {
    if (!input.description?.trim()) throw new BuilderError("Describe the agent you want to build");
    const discovery = await this.analyst.discover(input);
    const template = discovery.template;
    const company = await this.platform.company(companyId);
    const mailDomain = typeof company?.settings.mailDomain === "string" ? company.settings.mailDomain : undefined;
    const nodes = buildInitialNodes({ archetype: discovery.archetype, template, agentName: discovery.agentName, mailDomain });
    nodes.push(...discovery.extraQuestions.map((q) => createNode(q, "dynamic")));
    const tree = createTree(nodes);
    for (const p of discovery.prefilled) {
      const node = getNode(tree, p.nodeId);
      const coerced = node ? coerceAnswer(node, p.value) : undefined;
      if (!node || !coerced?.ok) continue;
      if (p.confidence >= 0.8) answer(tree, p.nodeId, coerced.value, { answeredBy: "requester", evidence: p.quote, answerText: p.quote });
      else node.recommended = coerced.value;
    }
    const nameNode = getNode(tree, "purpose.name");
    if (nameNode) nameNode.recommended = discovery.agentName;
    const language = input.language ?? discovery.language ?? "en";
    const settings: SessionSettings = { roundSize: Math.min(Math.max(input.roundSize ?? 5, 1), 10), notes: [], ...(mailDomain ? { mailDomain } : {}) };
    const [session] = await this.db
      .insert(builderSessions)
      .values({
        companyId,
        title: discovery.agentName,
        status: "interviewing",
        requesterName: input.requesterName ?? null,
        requesterEmail: input.requesterEmail ?? null,
        requesterRole: input.requesterRole ?? null,
        department: discovery.department ?? input.department ?? null,
        description: [input.description, input.formDescription ? `\n\nForm: ${input.formDescription}` : ""].join(""),
        archetype: discovery.archetype,
        templateId: template?.id ?? null,
        language,
        tree: tree as unknown as Record<string, unknown>,
        settings: settings as unknown as Record<string, unknown>,
      })
      .returning();
    await this.message(session!.id, "user", input.description + (input.formDescription ? `\n\n**Form:** ${input.formDescription}` : ""));
    const tr = language.startsWith("tr");
    await this.message(
      session!.id,
      "analyst",
      [
        tr
          ? `Anladığım kadarıyla **${discovery.agentName}** adlı, _${ARCHETYPE_LABELS[discovery.archetype]}_ tipinde bir ajan istiyorsunuz.`
          : `Here's what I understood: you want **${discovery.agentName}**, a _${ARCHETYPE_LABELS[discovery.archetype]}_ agent.`,
        template
          ? tr
            ? `Katalogdaki **${template.name}** şablonundan başlayacağım (${template.department}); sizin sürecinize göre uyarlayacağız.`
            : `I'll start from the catalog template **${template.name}** (${template.department}) and adapt it to how you work.`
          : discovery.rationale,
        this.analyst.online
          ? ""
          : tr
            ? "_Not: Çevrimdışı moddayım (LLM tanımlı değil); soruları standart kontrol listesinden soruyorum._"
            : "_Note: I'm in offline mode (no LLM configured), so I'll use the standard analyst checklist._",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    await this.factFinding(companyId, session!, tree);
    await this.saveTree(session!.id, tree);
    return this.advance(companyId, session!.id);
  }

  async list(companyId: string) {
    return this.db.select().from(builderSessions).where(eq(builderSessions.companyId, companyId)).orderBy(desc(builderSessions.updatedAt));
  }

  async get(companyId: string, sessionId: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    const tree = this.tree(session);
    const messages = await this.db.select().from(builderMessages).where(eq(builderMessages.sessionId, sessionId)).orderBy(asc(builderMessages.createdAt));
    const requests = await this.db.select().from(stakeholderRequests).where(eq(stakeholderRequests.sessionId, sessionId)).orderBy(asc(stakeholderRequests.createdAt));
    const rounds = (session.rounds ?? []) as BuilderRound[];
    const last = rounds[rounds.length - 1];
    const currentRound = last && !last.answeredAt ? { ...last, questions: last.questions.filter((q) => isOpen(tree, getNode(tree, q.nodeId)!)) } : undefined;
    let agent: SessionView["agent"];
    if (session.agentId) {
      const record = await this.platform.agents.find(companyId, session.agentId);
      if (record) agent = { id: record.row.id, slug: record.row.slug, status: record.row.status, name: record.row.name };
    }
    return {
      session,
      tree,
      messages,
      requests,
      currentRound: currentRound?.questions.length ? currentRound : undefined,
      progress: progress(tree),
      draft: (session.draft as AgentDefinition | null) ?? undefined,
      agent,
      llm: { available: this.platform.llm.available, provider: this.platform.llm.provider, model: this.platform.llm.model },
    };
  }

  /** Handle a chat message from the requester (answers, corrections, "confirm", change requests). */
  async reply(companyId: string, sessionId: string, input: { text?: string; answers?: StructuredAnswer[]; fileIds?: string[] }): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    const status = session.status as BuilderStatus;
    const text = input.text?.trim() ?? "";
    if (input.fileIds?.length) await this.addSamples(companyId, sessionId, input.fileIds, { silent: !text && !input.answers?.length });
    if (!text && !input.answers?.length) return this.get(companyId, sessionId);

    if (status === "confirming" && text && CONFIRM.test(text)) {
      await this.message(sessionId, "user", text);
      return this.confirm(companyId, sessionId);
    }
    if ((status === "testing" || status === "deployed") && text) {
      await this.message(sessionId, "user", text);
      if (ACTIVATE.test(text)) return this.activate(companyId, sessionId);
      return this.refine(companyId, sessionId, text);
    }

    const tree = this.tree(session);
    const settings = this.settings(session);
    const rounds = (session.rounds ?? []) as BuilderRound[];
    const round = rounds[rounds.length - 1];
    const questions: RoundQuestion[] = round && !round.answeredAt ? round.questions : [];
    if (text) await this.message(sessionId, "user", text, round?.number);

    const parsed: ParsedAnswer[] = (input.answers ?? []).map((a) => {
      const question = questions.find((q) => q.nodeId === a.nodeId);
      const node = getNode(tree, a.nodeId);
      return {
        nodeId: a.nodeId,
        action: a.action ?? "answer",
        value: a.action === "accept" ? (question?.recommended ?? node?.recommended) : a.value,
        text: typeof a.value === "string" ? a.value : "",
        delegateTo: a.delegateTo,
      };
    });
    let changes: { nodeId: string; value: unknown }[] = [];
    if (text) {
      const answeredIds = new Set(parsed.map((p) => p.nodeId));
      const openQuestions = questions.filter((q) => !answeredIds.has(q.nodeId) && isOpen(tree, getNode(tree, q.nodeId)!));
      const settled = tree.nodes
        .filter((n) => isSettled(stateOf(tree, n.id)) && n.answerType !== "files")
        .map((n) => ({ nodeId: n.id, title: n.title, value: displayValue(n, stateOf(tree, n.id).value) }));
      if (openQuestions.length || settled.length) {
        const interpreted = await this.analyst.interpretReply({ text, questions: openQuestions.length ? openQuestions : questions, settled, language: session.language });
        parsed.push(...interpreted.answers.filter((a) => !answeredIds.has(a.nodeId)));
        changes = interpreted.changes;
        if (interpreted.note) settings.notes.push(interpreted.note);
      }
    }

    const toDelegate = new Map<StakeholderRole, string[]>();
    const unmatched: { question?: RoundQuestion; node: RequirementNode; said: string }[] = [];
    for (const p of parsed) {
      const node = getNode(tree, p.nodeId);
      if (!node) continue;
      let value = p.value;
      if ((p.action === "answer" || p.action === "accept") && value !== undefined) {
        const coerced = coerceAnswer(node, value);
        if (!coerced.ok) {
          const said = typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : p.text;
          unmatched.push({ question: questions.find((q) => q.nodeId === node.id), node, said });
          continue;
        }
        value = coerced.value;
      }
      const wantsDelegation = p.action === "delegate" || value === "ask-it";
      if (wantsDelegation) {
        const role = p.delegateTo ?? defaultDelegate(node);
        toDelegate.set(role, [...(toDelegate.get(role) ?? []), node.id]);
      } else if (p.action === "skip") {
        skip(tree, node.id, p.text);
      } else if (value !== undefined) {
        answer(tree, node.id, value, { answeredBy: "requester", answerText: p.text, round: round?.number });
      }
    }
    for (const change of changes) {
      const node = getNode(tree, change.nodeId);
      if (!node) continue;
      const coerced = coerceAnswer(node, change.value);
      if (!coerced.ok) continue;
      reopen(tree, change.nodeId);
      answer(tree, change.nodeId, coerced.value, { answeredBy: "requester", answerText: text });
    }
    for (const [role, nodeIds] of toDelegate) await this.delegateNodes(companyId, session, tree, nodeIds, role);
    if (round && !round.answeredAt) {
      // Questions that stopped applying because of other answers are closed, not left hanging.
      for (const q of round.questions) {
        const node = getNode(tree, q.nodeId);
        if (node && isOpen(tree, node) && !isApplicable(tree, node)) skip(tree, node.id, "no longer applies");
      }
      if (round.questions.every((q) => !isOpen(tree, getNode(tree, q.nodeId)!))) round.answeredAt = nowIso();
      else if (text || unmatched.length) {
        const stillOpen = round.questions.filter((q) => isOpen(tree, getNode(tree, q.nodeId)!));
        await this.message(sessionId, "analyst", renderFollowUp({ stillOpen, unmatched, language: session.language }), round.number);
      }
    }
    await this.factFinding(companyId, session, tree);
    await this.db
      .update(builderSessions)
      .set({ tree: tree as unknown as Record<string, unknown>, rounds: rounds as unknown[], settings: settings as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(builderSessions.id, sessionId));
    return this.advance(companyId, sessionId);
  }

  /** Upload sample files: the analyst analyses them itself (facts are its job). */
  async addSamples(companyId: string, sessionId: string, fileIds: string[], options: { silent?: boolean } = {}): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    const tree = this.tree(session);
    const settings = this.settings(session);
    const samples = [...((session.samples ?? []) as SampleAnalysis[])];
    const analysed: { analysis: SampleAnalysis; text: string }[] = [];
    for (const fileId of fileIds) {
      if (samples.some((s) => s.fileId === fileId)) continue;
      const file = await this.platform.files.get(companyId, fileId);
      const doc = await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType }, { llm: this.platform.llm });
      const quick = analyzeSample(doc);
      const analysis: SampleAnalysis = {
        fileId,
        fileName: file.name,
        mimeType: file.mimeType,
        pages: doc.pageCount ?? doc.pages?.length,
        language: doc.language,
        needsOcr: doc.needsOcr,
        documentType: doc.documentType,
        detectedFields: quick.detectedFields,
        summary: quick.summary,
      };
      samples.push(analysis);
      analysed.push({ analysis, text: doc.text });
    }
    if (!analysed.length) return this.get(companyId, sessionId);

    const all = samples;
    const formats = [...new Set(all.map((s) => s.mimeType.split("/").pop()?.replace("vnd.openxmlformats-officedocument.wordprocessingml.document", "docx")))].join(", ");
    const languages = [...new Set(all.map((s) => s.language).filter(Boolean))].join(", ") || "unknown";
    const scanned = all.filter((s) => s.needsOcr).length;
    answer(tree, "inputs.samples", all.map((s) => s.fileName), { answeredBy: "requester", evidence: `${all.length} sample(s)` });
    const formatsText = `${all.length} sample(s): ${formats}; languages: ${languages}${scanned ? `; ${scanned} scanned/photographed (OCR needed)` : ""}`;
    if (getNode(tree, "inputs.formats")) answer(tree, "inputs.formats", formatsText, { answeredBy: "system", evidence: "analysed your samples" });

    const deeper = await this.analyst.analyzeSamples(analysed, String(valueOf(tree, "purpose.goal") ?? session.description));
    const detected = deeper?.fields ?? [...new Set(all.flatMap((s) => s.detectedFields ?? []))];
    if (deeper?.observations) settings.sampleObservations = deeper.observations;
    let prefilledFields = false;
    for (const id of ["docs.fields", "outputs.fields"]) {
      const node = getNode(tree, id);
      if (node && isOpen(tree, node) && detected.length && !(Array.isArray(node.recommended) && node.recommended.length)) {
        node.recommended = detected.map((f) => f.replace(/_/g, " "));
        prefilledFields = true;
      }
    }
    const docTypes = [...new Set(all.map((s) => s.documentType).filter((t) => t && t !== "unknown"))];
    const typesNode = getNode(tree, "docs.types");
    if (typesNode && isOpen(tree, typesNode) && docTypes.length) answer(tree, "docs.types", docTypes.join(", "), { answeredBy: "system", evidence: "detected in your samples" });

    const tr = session.language.startsWith("tr");
    await this.message(
      sessionId,
      "analyst",
      [
        tr ? `**${analysed.length} örneği inceledim.**` : `**I analysed ${analysed.length} sample(s).**`,
        ...analysed.map((a) => `- _${a.analysis.fileName}_: ${a.analysis.summary}`),
        deeper?.observations ? `\n${deeper.observations}` : "",
        detected.length
          ? tr
            ? `\nÖrneklerde bulduğum bilgiler: ${detected.join(", ")}${prefilledFields ? " — çıkarılacak bilgiler listesini bunlarla doldurdum." : ""}`
            : `\nInformation I found in your samples: ${detected.join(", ")}${prefilledFields ? " — I've pre-filled the extraction list with it." : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      undefined,
      { samples: analysed.map((a) => a.analysis) },
    );
    await this.db
      .update(builderSessions)
      .set({ tree: tree as unknown as Record<string, unknown>, samples: samples as unknown[], settings: settings as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(builderSessions.id, sessionId));
    if (options.silent) {
      const rounds = (session.rounds ?? []) as BuilderRound[];
      const round = rounds[rounds.length - 1];
      if (round && !round.answeredAt && round.questions.every((q) => !isOpen(tree, getNode(tree, q.nodeId)!))) {
        round.answeredAt = nowIso();
        await this.db.update(builderSessions).set({ rounds: rounds as unknown[] }).where(eq(builderSessions.id, sessionId));
      }
      return this.advance(companyId, sessionId);
    }
    return this.get(companyId, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Rounds, fact finding, confirmation gate
  // ---------------------------------------------------------------------------

  /** Settle what the analyst can find out itself: connected systems. */
  private async factFinding(companyId: string, session: SessionRow, tree: RequirementTree): Promise<void> {
    const instances = await this.platform.connectors.list(companyId);
    const real = instances.filter((i) => !i.sandbox && i.status !== "error");
    const settleIfConnected = (nodeId: string, category: string | undefined) => {
      const node = getNode(tree, nodeId);
      if (!node || !isOpen(tree, node) || !category) return;
      const match = real.find((i) => i.category === category);
      if (match) answer(tree, nodeId, "connected", { answeredBy: "system", evidence: `already connected: ${match.name}` });
    };
    settleIfConnected("integration.mail", "mail");
    settleIfConnected("integration.source_system", guessSystemCategory(String(valueOf(tree, "inputs.system") ?? "")));
    settleIfConnected("integration.target_system", guessSystemCategory(String(valueOf(tree, "outputs.system") ?? "")));
    settleIfConnected("integration.shared_folder", "dms");
    void session;
  }

  /** Ask the next round, or move to the stakeholder wait / confirmation gate. */
  private async advance(companyId: string, sessionId: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    const tree = this.tree(session);
    const settings = this.settings(session);
    const rounds = (session.rounds ?? []) as BuilderRound[];
    const draft = this.draft(session, tree);
    const last = rounds[rounds.length - 1];
    if (last && !last.answeredAt) {
      // The current round still has open questions: keep it open, just refresh the draft.
      await this.db.update(builderSessions).set({ draft: draft as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(builderSessions.id, sessionId));
      return this.get(companyId, sessionId);
    }
    const next = frontier(tree).slice(0, settings.roundSize);
    const tr = session.language.startsWith("tr");
    let status: BuilderStatus = session.status as BuilderStatus;
    if (next.length) {
      const phrased = await this.analyst.phraseRound({
        agentName: String(valueOf(tree, "purpose.name") ?? session.title),
        goal: String(valueOf(tree, "purpose.goal") ?? session.description),
        language: session.language,
        known: requirementsDigest(tree),
        nodes: next,
        roundNumber: rounds.length + 1,
      });
      const round: BuilderRound = { number: rounds.length + 1, questions: phrased.questions, intro: phrased.intro, askedAt: nowIso() };
      for (const q of phrased.questions) {
        markAsked(tree, q.nodeId, round.number);
        const node = getNode(tree, q.nodeId);
        if (node && q.recommended !== undefined) node.recommended = q.recommended;
      }
      rounds.push(round);
      status = "interviewing";
      await this.message(sessionId, "analyst", renderRound(round, session.language), round.number, { round });
    } else if (waitingOnStakeholders(tree).length || delegatedNodes(tree).length) {
      if (status !== "awaiting-stakeholders") {
        status = "awaiting-stakeholders";
        await this.message(
          sessionId,
          "analyst",
          tr
            ? "Sizin tarafınızdaki tüm soruları tamamladık. Kalanlar başka ekiplerin yanıtını bekliyor (talepleri aşağıda görebilirsiniz). İsterseniz **varsayımlarla devam** edebiliriz; ajan, entegrasyonlar hazır olana kadar manuel yükleme ve test verisiyle çalışır."
            : "That's everything on your side. The remaining points wait on other teams (see the requests below). You can **continue with assumptions** now — the agent will run on manual uploads and sandbox data until the integrations are ready.",
        );
      }
    } else {
      status = "confirming";
      await this.message(
        sessionId,
        "analyst",
        renderSummary({
          tree,
          agentName: String(valueOf(tree, "purpose.name") ?? session.title),
          goal: String(valueOf(tree, "purpose.goal") ?? session.description),
          draft,
          language: session.language,
          requestStatus: await this.requestStatuses(sessionId),
        }),
        undefined,
        { summary: true },
      );
    }
    await this.db
      .update(builderSessions)
      .set({
        status,
        title: String(valueOf(tree, "purpose.name") ?? session.title),
        tree: tree as unknown as Record<string, unknown>,
        rounds: rounds as unknown[],
        draft: draft as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(builderSessions.id, sessionId));
    return this.get(companyId, sessionId);
  }

  /** Continue without waiting for stakeholders: delegated items are assumed (requests stay open). */
  async proceedWithAssumptions(companyId: string, sessionId: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    const tree = this.tree(session);
    for (const node of delegatedNodes(tree)) {
      const fallback = node.section === "integrations" ? "manual-for-now" : (node.recommended ?? "pending stakeholder answer");
      assume(tree, node.id, fallback, { answeredBy: "default", evidence: "assumed while waiting for the stakeholder" });
    }
    await this.message(sessionId, "user", session.language.startsWith("tr") ? "Varsayımlarla devam edelim." : "Let's continue with assumptions.");
    await this.saveTree(sessionId, tree, { status: "interviewing" });
    return this.advance(companyId, sessionId);
  }

  async reopenNode(companyId: string, sessionId: string, nodeId: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    const tree = this.tree(session);
    if (!getNode(tree, nodeId)) throw new BuilderError(`Unknown requirement "${nodeId}"`, 404);
    reopen(tree, nodeId);
    const rounds = (session.rounds ?? []) as BuilderRound[];
    const last = rounds[rounds.length - 1];
    if (last && !last.answeredAt) last.answeredAt = nowIso();
    await this.db
      .update(builderSessions)
      .set({ tree: tree as unknown as Record<string, unknown>, rounds: rounds as unknown[], status: "interviewing", updatedAt: new Date() })
      .where(eq(builderSessions.id, sessionId));
    return this.advance(companyId, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Stakeholder requests
  // ---------------------------------------------------------------------------

  private technicalNotes(nodeIds: string[], tree: RequirementTree): string[] {
    const manifests = this.platform.connectors.catalog();
    const notes: string[] = [];
    const add = (type: string) => notes.push(...(manifests.find((m) => m.type === type)?.itRequirements ?? []));
    for (const id of nodeIds) {
      if (id === "integration.mail") add("microsoft-365-mail");
      if (id === "integration.shared_folder") add("sharepoint");
      if (id === "integration.source_system" || id === "integration.target_system") {
        const category = guessSystemCategory(`${valueOf(tree, "inputs.system") ?? ""} ${valueOf(tree, "outputs.system") ?? ""}`);
        const type = manifests.find((m) => m.category === category && m.maturity !== "sandbox")?.type;
        if (type) add(type);
      }
    }
    return [...new Set(notes)].slice(0, 8);
  }

  private async delegateNodes(companyId: string, session: SessionRow, tree: RequirementTree, nodeIds: string[], role: StakeholderRole) {
    const [existing] = await this.db
      .select()
      .from(stakeholderRequests)
      .where(and(eq(stakeholderRequests.sessionId, session.id), eq(stakeholderRequests.role, role), eq(stakeholderRequests.status, "draft")));
    const token = existing?.token ?? newToken();
    const newQuestions = nodeIds
      .map((id) => getNode(tree, id))
      .filter((n) => n !== undefined)
      .map((n) => stakeholderQuestion(n, tree));
    const questions = [...(existing?.questions ?? []).filter((q) => !nodeIds.includes(q.nodeId)), ...newQuestions];
    const data = composeStakeholderRequest(role, questions, {
      agentName: String(valueOf(tree, "purpose.name") ?? session.title),
      goal: String(valueOf(tree, "purpose.goal") ?? session.description),
      requesterName: session.requesterName ?? "The requester",
      requesterRole: session.requesterRole,
      requesterEmail: session.requesterEmail,
      department: session.department,
      language: session.language,
      answerUrl: `${this.options.publicBaseUrl.replace(/\/$/, "")}/answer/${token}`,
      recipientName: existing?.recipientName ?? undefined,
      technicalNotes: this.technicalNotes(questions.map((q) => q.nodeId), tree),
    });
    let requestId: string;
    if (existing) {
      await this.db
        .update(stakeholderRequests)
        .set({ subject: data.subject, body: data.body, questionnaire: data.questionnaire, questions: data.questions })
        .where(eq(stakeholderRequests.id, existing.id));
      requestId = existing.id;
    } else {
      const [row] = await this.db
        .insert(stakeholderRequests)
        .values({
          companyId,
          sessionId: session.id,
          role,
          subject: data.subject,
          body: data.body,
          questionnaire: data.questionnaire,
          questions: data.questions,
          token,
        })
        .returning();
      requestId = row!.id;
    }
    for (const id of nodeIds) delegate(tree, id, requestId);
    const tr = session.language.startsWith("tr");
    await this.message(
      session.id,
      "analyst",
      tr
        ? `**${STAKEHOLDER_LABELS[role]}** için bir talep hazırladım (${questions.length} soru). Aşağıdan alıcıyı ekleyip e-postayı gözden geçirerek gönderebilirsiniz. Yanıtlar geldiğinde tasarıma otomatik işlenecek.`
        : `I've drafted a request for **${STAKEHOLDER_LABELS[role]}** (${questions.length} question${questions.length > 1 ? "s" : ""}). Add the recipient, review the email and send it — their answers flow straight back into the design.`,
      undefined,
      { requestId },
    );
  }

  async updateRequest(companyId: string, requestId: string, patch: { recipientName?: string; recipientEmail?: string; subject?: string; body?: string }) {
    const request = await this.request(companyId, requestId);
    let body = patch.body ?? request.body;
    if (patch.recipientName && !patch.body) {
      body = body.replace(/^(Hello|Merhaba)[^\n]*,/, (m) => (m.startsWith("Merhaba") ? `Merhaba ${patch.recipientName},` : `Hello ${patch.recipientName},`));
    }
    const [row] = await this.db
      .update(stakeholderRequests)
      .set({
        recipientName: patch.recipientName ?? request.recipientName,
        recipientEmail: patch.recipientEmail ?? request.recipientEmail,
        subject: patch.subject ?? request.subject,
        body,
      })
      .where(eq(stakeholderRequests.id, requestId))
      .returning();
    return row!;
  }

  /** The requester explicitly sends the request: through the company mail connector, or marks it as sent manually. */
  async sendRequest(companyId: string, requestId: string, options: { via: "mail" | "manual" }) {
    const request = await this.request(companyId, requestId);
    if (options.via === "mail") {
      if (!request.recipientEmail) throw new BuilderError("Add the recipient's email address first");
      await this.platform.mail.send(companyId, { to: request.recipientEmail, subject: request.subject, body: request.body });
    }
    const [row] = await this.db
      .update(stakeholderRequests)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(stakeholderRequests.id, requestId))
      .returning();
    const session = await this.session(companyId, request.sessionId);
    await this.message(
      request.sessionId,
      "system",
      session.language.startsWith("tr")
        ? `Talep ${request.recipientName ?? request.recipientEmail ?? STAKEHOLDER_LABELS[request.role as StakeholderRole]} kişisine gönderildi.`
        : `Request sent to ${request.recipientName ?? request.recipientEmail ?? STAKEHOLDER_LABELS[request.role as StakeholderRole]}.`,
    );
    await this.platform.activity.record(companyId, {
      actor: session.requesterEmail ?? "user",
      action: "stakeholder_request.sent",
      entityType: "stakeholder_request",
      entityId: requestId,
      summary: `Sent "${request.subject}"`,
    });
    return row!;
  }

  /** Public view for the stakeholder answer page (no internal data). */
  async requestByToken(token: string) {
    const [request] = await this.db.select().from(stakeholderRequests).where(eq(stakeholderRequests.token, token));
    if (!request) throw new BuilderError("This link is invalid or has expired", 404);
    const [session] = await this.db.select().from(builderSessions).where(eq(builderSessions.id, request.sessionId));
    return {
      id: request.id,
      status: request.status,
      role: request.role,
      subject: request.subject,
      agentName: session?.title ?? "",
      requesterName: session?.requesterName ?? "",
      requesterRole: session?.requesterRole ?? "",
      goal: session ? String(valueOf(this.tree(session), "purpose.goal") ?? session.description) : "",
      questions: request.questions,
      language: session?.language ?? "en",
    };
  }

  async answerRequest(token: string, input: { answers: { nodeId: string; answer: string }[]; answeredBy?: string; note?: string }) {
    const [request] = await this.db.select().from(stakeholderRequests).where(eq(stakeholderRequests.token, token));
    if (!request) throw new BuilderError("This link is invalid or has expired", 404);
    if (request.status === "answered") throw new BuilderError("These questions were already answered — thank you!", 409);
    const session = await this.session(request.companyId, request.sessionId);
    const tree = this.tree(session);
    const answered = new Map(input.answers.filter((a) => a.answer?.trim()).map((a) => [a.nodeId, a.answer.trim()]));
    for (const [nodeId, value] of answered) {
      const node = getNode(tree, nodeId);
      if (!node) continue;
      const normalized = node.section === "integrations" ? "arranged-by-stakeholder" : value;
      answer(tree, nodeId, node.answerType === "single" && node.section !== "integrations" ? value : normalized, {
        answeredBy: "stakeholder",
        answerText: value,
        evidence: `${input.answeredBy ?? STAKEHOLDER_LABELS[request.role as StakeholderRole]}: ${truncate(value, 200)}`,
      });
    }
    const questions = request.questions.map((q) => ({ ...q, answer: answered.get(q.nodeId) ?? q.answer }));
    await this.db
      .update(stakeholderRequests)
      .set({ status: "answered", answeredAt: new Date(), answeredBy: input.answeredBy ?? null, questions })
      .where(eq(stakeholderRequests.id, request.id));
    const stillPending = (await this.db.select().from(stakeholderRequests).where(eq(stakeholderRequests.sessionId, session.id))).filter(
      (r) => r.id !== request.id && r.status !== "answered" && r.status !== "cancelled",
    );
    await this.message(
      session.id,
      "system",
      [
        session.language.startsWith("tr")
          ? `**${input.answeredBy ?? STAKEHOLDER_LABELS[request.role as StakeholderRole]}** yanıtladı:`
          : `**${input.answeredBy ?? STAKEHOLDER_LABELS[request.role as StakeholderRole]}** answered:`,
        ...questions.filter((q) => q.answer).map((q) => `- ${truncate(q.question, 120)}\n  → ${q.answer}`),
        ...(input.note ? [`\n${input.note}`] : []),
        ...(stillPending.length
          ? [
              session.language.startsWith("tr")
                ? `\nHâlâ beklenen: ${stillPending.map((r) => STAKEHOLDER_LABELS[r.role as StakeholderRole]).join(", ")}.`
                : `\nStill waiting on: ${stillPending.map((r) => STAKEHOLDER_LABELS[r.role as StakeholderRole]).join(", ")}.`,
            ]
          : []),
      ].join("\n"),
    );
    // advance() moves on: a new round if the answers opened questions, the summary if nothing is left.
    await this.saveTree(session.id, tree);
    await this.platform.activity.record(session.companyId, {
      actor: `stakeholder:${input.answeredBy ?? request.role}`,
      action: "stakeholder_request.answered",
      entityType: "stakeholder_request",
      entityId: request.id,
      summary: `Answered "${request.subject}"`,
    });
    return this.advance(session.companyId, session.id);
  }

  // ---------------------------------------------------------------------------
  // Generation, testing, refinement, deployment
  // ---------------------------------------------------------------------------

  private draft(session: SessionRow, tree: RequirementTree, synthesis?: Synthesis, knowledgeCollection?: string): AgentDefinition | undefined {
    try {
      return generateDefinition({
        description: session.description,
        archetype: session.archetype as Archetype,
        template: this.template(session),
        department: session.department,
        requesterName: session.requesterName,
        requesterRole: session.requesterRole,
        tree,
        samples: (session.samples ?? []) as SampleAnalysis[],
        synthesis,
        knowledgeCollection,
        mailDomain: this.settings(session).mailDomain,
      });
    } catch (error) {
      console.warn("[builder] draft generation failed:", error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  /** The confirmation gate passed: generate the agent, create it in "testing" and run it on the samples. */
  async confirm(companyId: string, sessionId: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    if (!["confirming", "awaiting-stakeholders"].includes(session.status)) {
      throw new BuilderError("The interview isn't finished yet — answer the open questions first.", 409);
    }
    const tree = this.tree(session);
    const settings = this.settings(session);
    await this.db.update(builderSessions).set({ status: "generating", updatedAt: new Date() }).where(eq(builderSessions.id, sessionId));
    const name = String(valueOf(tree, "purpose.name") ?? session.title);
    const tr = session.language.startsWith("tr");

    let knowledgeCollection: string | undefined;
    if (valueOf(tree, "processing.reference") || valueOf(tree, "chat.sources")) {
      knowledgeCollection = `${slugify(name)}-knowledge`;
      await this.platform.knowledge.ensureCollection(companyId, {
        key: knowledgeCollection,
        name: `${name} — reference`,
        description: String(valueOf(tree, "processing.reference") ?? valueOf(tree, "chat.sources") ?? ""),
      });
    }
    const synthesis = await this.analyst.synthesize({
      agentName: name,
      goal: String(valueOf(tree, "purpose.goal") ?? session.description),
      archetype: session.archetype as Archetype,
      requirements: [requirementsDigest(tree), ...settings.notes.map((n) => `- Note: ${n}`), settings.sampleObservations ? `- Samples: ${settings.sampleObservations}` : ""].join("\n"),
      template: this.template(session),
      language: session.language,
    });
    const definition = this.draft(session, tree, synthesis, knowledgeCollection);
    if (!definition) {
      await this.db.update(builderSessions).set({ status: "confirming" }).where(eq(builderSessions.id, sessionId));
      throw new BuilderError("I couldn't assemble a valid agent from these answers. Please review the summary and adjust.");
    }
    const department = definition.department ? (await this.platform.catalog.departments(companyId)).find((d) => d.key === definition.department) : undefined;
    const agent = session.agentId
      ? await this.platform.agents.update(companyId, session.agentId, definition, { note: "Regenerated by the Agent Builder", createdBy: "builder" })
      : await this.platform.agents.create(companyId, {
          definition,
          status: "testing",
          source: "builder",
          templateId: definition.templateId,
          departmentId: department?.id ?? null,
          builderSessionId: sessionId,
          createdBy: session.requesterEmail ?? "builder",
        });
    await this.db
      .update(builderSessions)
      .set({ agentId: agent.row.id, draft: agent.definition as unknown as Record<string, unknown>, status: "testing", settings: { ...settings, knowledgeCollection } as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(builderSessions.id, sessionId));
    await this.platform.activity.record(companyId, {
      actor: session.requesterEmail ?? "builder",
      action: "agent.generated",
      entityType: "agent",
      entityId: agent.row.id,
      summary: `Agent Builder generated ${agent.definition.name}`,
      data: { sessionId },
    });
    await this.message(
      sessionId,
      "analyst",
      [
        tr ? `✅ **${agent.definition.name}** oluşturuldu (test modunda).` : `✅ **${agent.definition.name}** is built (in testing).`,
        "",
        describeDefinition(agent.definition),
        "",
        agent.definition.tests.length
          ? tr
            ? `Şimdi ${agent.definition.tests.length} örneğiniz üzerinde test ediyorum…`
            : `Now testing it on your ${agent.definition.tests.length} sample(s)…`
          : tr
            ? "Test için örnek dosya yok; ajan ekranından deneyebilirsiniz."
            : "There are no sample files to test with — try it from the agent's screen.",
      ].join("\n"),
      undefined,
      { agentId: agent.row.id },
    );
    await this.runTests(companyId, sessionId, agent.row.id, agent.definition);
    return this.get(companyId, sessionId);
  }

  private async runTests(companyId: string, sessionId: string, agentId: string, definition: AgentDefinition) {
    if (!definition.tests.length) return;
    const lines: string[] = [];
    const highlight = definition.ui.highlight?.length ? definition.ui.highlight : definition.outputs.slice(0, 3).map((f) => f.key);
    for (const test of definition.tests) {
      try {
        const run = await this.platform.engine.start(companyId, agentId, test.input, { trigger: "test", isTest: true, wait: true });
        const out = (run.output ?? {}) as Record<string, unknown>;
        const label = (key: string) => definition.outputs.find((f) => f.key === key)?.label ?? key.replace(/_/g, " ");
        const shown = highlight.map((k) => `${label(k)}: ${briefValue(out[k])}`).join(" · ");
        lines.push(`- **${test.name}** — ${run.status === "succeeded" ? shown : `${run.status}${run.error ? `: ${run.error}` : ""}`} ([run](/runs/${run.id}))`);
      } catch (error) {
        lines.push(`- **${test.name}** — error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const session = await this.session(companyId, sessionId);
    const tr = session.language.startsWith("tr");
    await this.message(
      sessionId,
      "analyst",
      [
        tr ? "**Test sonuçları:**" : "**Test results:**",
        ...lines,
        "",
        tr
          ? "Sonuçlar beklediğiniz gibi mi? Değiştirmek istediğinizi yazın (ör. \"İngilizce seviyesini zorunlu yap\"), ya da **\"devreye al\"** diyerek ajanı aktif edin."
          : "Do these look right? Tell me what to change (e.g. \"make English a must-have\"), or say **\"activate\"** to put the agent live.",
      ].join("\n"),
    );
  }

  async refine(companyId: string, sessionId: string, instruction: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    if (!session.agentId) throw new BuilderError("Generate the agent first", 409);
    const agent = await this.platform.agents.get(companyId, session.agentId);
    const tr = session.language.startsWith("tr");
    let refined: Awaited<ReturnType<Analyst["refine"]>>;
    try {
      refined = await this.analyst.refine(agent.definition, instruction);
    } catch (error) {
      await this.message(sessionId, "analyst", `${tr ? "Bu değişikliği uygulayamadım" : "I couldn't apply that change"}: ${error instanceof Error ? error.message : String(error)}`);
      return this.get(companyId, sessionId);
    }
    if (!refined) {
      await this.message(
        sessionId,
        "analyst",
        tr
          ? "Çevrimdışı moddayım; değişikliği ajan ekranındaki tanımı düzenleyerek yapabilirsiniz ya da ilgili soruyu yeniden açabilirim."
          : "I'm in offline mode, so I can't rewrite the agent from a free-text request. Edit the definition on the agent's page, or reopen the relevant question in the summary.",
      );
      return this.get(companyId, sessionId);
    }
    let updated;
    try {
      updated = await this.platform.agents.update(companyId, session.agentId, refined.definition as AgentDefinition, { note: `Refined: ${truncate(instruction, 120)}`, createdBy: "builder" });
    } catch (error) {
      await this.message(sessionId, "analyst", `${tr ? "Bu değişikliği uygulayamadım" : "I couldn't apply that change"}: ${error instanceof Error ? error.message : String(error)}`);
      return this.get(companyId, sessionId);
    }
    await this.db.update(builderSessions).set({ draft: updated.definition as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(builderSessions.id, sessionId));
    await this.message(sessionId, "analyst", `${refined.explanation}\n\n${tr ? `Sürüm ${updated.row.version} kaydedildi; yeniden test ediyorum…` : `Saved as version ${updated.row.version}; re-testing…`}`);
    await this.runTests(companyId, sessionId, updated.row.id, updated.definition);
    return this.get(companyId, sessionId);
  }

  async activate(companyId: string, sessionId: string): Promise<SessionView> {
    const session = await this.session(companyId, sessionId);
    if (!session.agentId) throw new BuilderError("Generate the agent first", 409);
    const agent = await this.platform.agents.setStatus(companyId, session.agentId, "active");
    await this.db.update(builderSessions).set({ status: "deployed", updatedAt: new Date() }).where(eq(builderSessions.id, sessionId));
    const tr = session.language.startsWith("tr");
    const pending = (await this.db.select().from(stakeholderRequests).where(eq(stakeholderRequests.sessionId, sessionId))).filter((r) => r.status !== "answered");
    await this.message(
      sessionId,
      "analyst",
      [
        tr ? `🚀 **${agent.definition.name}** artık aktif.` : `🚀 **${agent.definition.name}** is live.`,
        tr ? `Ekranı: [/apps/${agent.row.slug}](/apps/${agent.row.slug})` : `Its screen: [/apps/${agent.row.slug}](/apps/${agent.row.slug})`,
        pending.length
          ? tr
            ? `Bekleyen ${pending.length} talep yanıtlandığında entegrasyonları bağlayacağız; o zamana kadar manuel yükleme ve test verisi kullanılır.`
            : `${pending.length} stakeholder request(s) are still open; until they're answered the agent uses manual uploads and sandbox systems.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await this.platform.activity.record(companyId, {
      actor: session.requesterEmail ?? "user",
      action: "agent.activated",
      entityType: "agent",
      entityId: agent.row.id,
      summary: `Activated ${agent.definition.name}`,
    });
    return this.get(companyId, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private async session(companyId: string, sessionId: string): Promise<SessionRow> {
    const [row] = await this.db
      .select()
      .from(builderSessions)
      .where(and(eq(builderSessions.companyId, companyId), eq(builderSessions.id, sessionId)));
    if (!row) throw new BuilderError(`Builder session ${sessionId} not found`, 404);
    return row;
  }

  private async request(companyId: string, requestId: string): Promise<RequestRow> {
    const [row] = await this.db
      .select()
      .from(stakeholderRequests)
      .where(and(eq(stakeholderRequests.companyId, companyId), eq(stakeholderRequests.id, requestId)));
    if (!row) throw new BuilderError(`Request ${requestId} not found`, 404);
    return row;
  }

  private async requestStatuses(sessionId: string): Promise<Map<string, string>> {
    const rows = await this.db.select().from(stakeholderRequests).where(eq(stakeholderRequests.sessionId, sessionId));
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  private tree(session: SessionRow): RequirementTree {
    const raw = session.tree as unknown as RequirementTree;
    return { nodes: raw.nodes ?? [], states: raw.states ?? {} };
  }

  private settings(session: SessionRow): SessionSettings {
    const raw = session.settings as Partial<SessionSettings>;
    return { roundSize: raw.roundSize ?? 5, notes: raw.notes ?? [], knowledgeCollection: raw.knowledgeCollection, sampleObservations: raw.sampleObservations };
  }

  private template(session: SessionRow): AgentTemplate | undefined {
    return session.templateId ? this.platform.catalog.catalog.agents.find((a) => a.id === session.templateId) : undefined;
  }

  private async saveTree(sessionId: string, tree: RequirementTree, extra: Partial<Pick<SessionRow, "status">> = {}) {
    await this.db
      .update(builderSessions)
      .set({ tree: tree as unknown as Record<string, unknown>, ...extra, updatedAt: new Date() })
      .where(eq(builderSessions.id, sessionId));
  }

  private async message(sessionId: string, role: "user" | "analyst" | "system", content: string, round?: number, data: Record<string, unknown> = {}) {
    await this.db.insert(builderMessages).values({ sessionId, role, content, round: round ?? null, data });
  }

  /** Upload helper for the chat: store files and attach them as samples. */
  async uploadSamples(companyId: string, sessionId: string, files: { name: string; data: Buffer; mimeType?: string }[]) {
    const ids: string[] = [];
    for (const f of files) {
      const stored = await this.platform.files.put(companyId, { name: f.name, data: f.data, mimeType: f.mimeType, source: "builder", metadata: { sessionId } });
      ids.push(stored.id);
    }
    return this.reply(companyId, sessionId, { fileIds: ids });
  }

  /** Ingest reference documents (e.g. job descriptions, policies) into the agent's knowledge collection. */
  async addReference(companyId: string, sessionId: string, fileIds: string[]) {
    const session = await this.session(companyId, sessionId);
    const settings = this.settings(session);
    const key = settings.knowledgeCollection ?? `${slugify(session.title)}-knowledge`;
    await this.platform.knowledge.ensureCollection(companyId, { key, name: `${session.title} — reference` });
    for (const fileId of fileIds) {
      const file = await this.platform.files.get(companyId, fileId);
      const doc = await extractDocument({ data: file.data, fileName: file.name, mimeType: file.mimeType }, { llm: this.platform.llm });
      await this.platform.knowledge.ingestText(companyId, key, { title: file.name, text: doc.text, source: "builder", fileId, mimeType: file.mimeType });
    }
    await this.db
      .update(builderSessions)
      .set({ settings: { ...settings, knowledgeCollection: key } as unknown as Record<string, unknown> })
      .where(eq(builderSessions.id, sessionId));
    const tree = this.tree(session);
    if (getNode(tree, "processing.reference") && isOpen(tree, getNode(tree, "processing.reference")!)) {
      answer(tree, "processing.reference", `Uploaded: ${fileIds.length} reference document(s)`, { answeredBy: "requester" });
      await this.saveTree(sessionId, tree);
    }
    await this.message(sessionId, "system", `Added ${fileIds.length} reference document(s) to the knowledge base (${key}).`);
    return this.get(companyId, sessionId);
  }
}
