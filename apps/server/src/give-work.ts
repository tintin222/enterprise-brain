import { plainText, truncate, type Actor } from "@enterprise-brain/core";
import { agentActor, isCompanyBrain, type Platform, type RunRow, type TaskRow } from "@enterprise-brain/runtime";
import { actorOf, canSeeDepartment, type Viewer } from "./auth/viewer.ts";
import { HttpError } from "./http.ts";
import { checkMentions } from "./mentions.ts";

export interface GiveWorkInput {
  /** The AI employee it is for (id or slug). Without it: the one the words name with "@". */
  agent?: string;
  /** Who gets it when the words name nobody: the AI employee of the talk it was written in. */
  defaultAgent?: string | null;
  text: string;
  fileIds?: string[];
  /** request: Give work, the Home box · chat: "Give as work" in a conversation (`triggerRef` names it). */
  trigger: "request" | "chat";
  triggerRef?: string | null;
  wait?: boolean;
}

export interface GivenWork {
  task: TaskRow;
  run: RunRow;
  to: Actor;
  title: string;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Give work to an AI employee, from words a person wrote: a task. "@" names in the words count only as
 * far as the person may see them; the AI employee gets a card for each, and the files that came along.
 */
export async function giveWork(platform: Platform, viewer: Viewer, companyId: string, input: GiveWorkInput): Promise<GivenWork> {
  const mentions = await checkMentions(platform, viewer, companyId, input.text);
  let ref = input.agent;
  if (!ref) {
    const named: string[] = [];
    for (const id of new Set(mentions.filter((m) => m.allowed && m.kind === "ai_employee").map((m) => m.id))) {
      const found = await platform.agents.find(companyId, id);
      if (found && !isCompanyBrain(found.row)) named.push(found.row.id);
    }
    if (named.length > 1) throw new HttpError(400, "Name one AI employee to give the work to");
    ref = named[0] ?? input.defaultAgent ?? undefined;
  }
  if (!ref) throw new HttpError(400, "Name the AI employee to give the work to, with @");
  const agent = await platform.agents.find(companyId, ref);
  if (!agent || isCompanyBrain(agent.row) || !canSeeDepartment(viewer, agent.row.departmentId)) {
    throw new HttpError(404, `AI employee "${ref}" not found`);
  }

  // The work in the person's words, without the AI employee's own name in front of it.
  const own = new RegExp(`@\\[[^\\]\\n]{1,120}\\]\\(ai_employee:(?:${escapeRegExp(agent.row.id)}|${escapeRegExp(agent.row.slug)})\\)[,:]?\\s*`, "g");
  const stripped = input.text.replace(own, "").trim();
  const work = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  if (plainText(work).trim().length < 3) throw new HttpError(400, "Say what the work is");
  const title =
    truncate(
      plainText(work)
        .split("\n")[0]!
        .replace(/^#+\s*/, "")
        .trim(),
      120,
    ) || agent.definition.name;

  const files = [];
  for (const id of new Set(input.fileIds ?? [])) {
    const file = await platform.files.meta(companyId, id).catch(() => undefined);
    if (!file) throw new HttpError(400, "A file is not there any more: attach it again");
    files.push(file);
  }
  const request = files.length
    ? `${work}\n\nFiles given with it (read them with documents_read or excel_read):\n${files.map((f) => `- ${f.name} (file id: ${f.id})`).join("\n")}`
    : work;
  const others = mentions.filter((m) => m.allowed && !(m.kind === "ai_employee" && m.id === agent.row.id));
  const cards = others.length ? await platform.mentionCards.cards(companyId, others) : [];
  const brief = cards.length ? `${request}\n\nThings named in it:\n\n${cards.join("\n\n")}` : request;

  const run = await platform.engine.start(
    companyId,
    agent.row.id,
    {},
    {
      task: brief,
      request,
      title,
      trigger: input.trigger,
      triggerRef: input.triggerRef ?? null,
      actor: actorOf(viewer),
      requestedBy: viewer.kind === "session" ? viewer.name : null,
      wait: input.wait ?? false,
    },
  );
  const task = await platform.tasks.get(companyId, run.taskId!);
  return { task, run, to: agentActor(agent), title };
}
