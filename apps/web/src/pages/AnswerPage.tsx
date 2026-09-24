import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, Info, Lock, Send, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import { api, isApiError } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { Logo } from "../components/Logo.tsx";
import { ErrorState, LoadingBlock } from "../components/Spinner.tsx";
import { stakeholderLabel } from "../lib/labels.ts";
import type { PublicRequest } from "../types.ts";

const TEXT = {
  en: {
    asked: (who: string, agent: string) => (
      <>
        {who} asked for your input on <span className="whitespace-nowrap">“{agent}”</span>
      </>
    ),
    intro: "They're setting up an AI agent and need a few answers only you can give. It takes a couple of minutes — thank you!",
    goal: "What the agent is for",
    why: "Why this matters",
    placeholder: "Your answer",
    name: "Your name",
    namePlaceholder: "e.g. Murat Yılmaz, IT Director",
    note: "Anything else they should know?",
    optional: "optional",
    submit: "Send answers",
    atLeastOne: "Please answer at least one question.",
    thanks: "Thank you — your answers were sent",
    thanksBody: (who: string) => `${who} can now continue building the agent with your input. You can close this page.`,
    closed: "These questions were already answered",
    closedBody: "Thank you! The requester has received the answers. If something changed, reply to their email.",
    invalid: "This link is invalid or has expired",
    invalidBody: "Ask the person who sent it for a new link.",
    secure: "Only the answers you type here are shared with the requester's Agent Builder session.",
    role: "Asked as",
  },
  tr: {
    asked: (who: string, agent: string) => (
      <>
        {who}, <span className="whitespace-nowrap">“{agent}”</span> için görüşünüzü istiyor
      </>
    ),
    intro: "Bir yapay zekâ ajanı kuruluyor ve yalnızca sizin yanıtlayabileceğiniz birkaç soru var. Birkaç dakikanızı alır — teşekkürler!",
    goal: "Ajanın amacı",
    why: "Neden önemli",
    placeholder: "Yanıtınız",
    name: "Adınız",
    namePlaceholder: "ör. Murat Yılmaz, BT Direktörü",
    note: "Eklemek istediğiniz bir şey var mı?",
    optional: "isteğe bağlı",
    submit: "Yanıtları gönder",
    atLeastOne: "Lütfen en az bir soruyu yanıtlayın.",
    thanks: "Teşekkürler — yanıtlarınız iletildi",
    thanksBody: (who: string) => `${who} artık yanıtlarınızla ajanı oluşturmaya devam edebilir. Bu sayfayı kapatabilirsiniz.`,
    closed: "Bu sorular zaten yanıtlandı",
    closedBody: "Teşekkürler! Yanıtlar talep sahibine iletildi. Bir şey değiştiyse e-postasını yanıtlayabilirsiniz.",
    invalid: "Bu bağlantı geçersiz ya da süresi dolmuş",
    invalidBody: "Bağlantıyı gönderen kişiden yenisini isteyin.",
    secure: "Yalnızca burada yazdığınız yanıtlar talep sahibinin Agent Builder oturumuyla paylaşılır.",
    role: "Sorulan rol",
  },
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2.5 px-4">
          <Logo className="size-7" />
          <span className="text-sm font-semibold text-fg">Enterprise Brain</span>
          <span className="ml-auto flex items-center gap-1 text-xs text-muted">
            <Lock className="size-3.5" /> Secure answer link
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}

function Message({ icon: Icon, title, body, tone }: { icon: typeof CircleCheck; title: string; body: string; tone: "green" | "amber" }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
      <div
        className={
          tone === "green"
            ? "mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300"
            : "mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300"
        }
      >
        <Icon className="size-7" />
      </div>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>
    </div>
  );
}

export default function AnswerPage() {
  const { token = "" } = useParams();
  const request = useQuery({
    queryKey: ["public-request", token],
    queryFn: () => api.get<PublicRequest>(`/api/public/requests/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: (body: { answers: { nodeId: string; answer: string }[]; answeredBy?: string; note?: string }) =>
      api.post<{ ok: boolean }>(`/api/public/requests/${encodeURIComponent(token)}/answers`, body),
  });

  const data = request.data;
  const t = data?.language?.startsWith("tr") ? TEXT.tr : TEXT.en;

  if (request.isLoading) {
    return (
      <Shell>
        <LoadingBlock />
      </Shell>
    );
  }
  if (isApiError(request.error, 404)) {
    return (
      <Shell>
        <Message icon={Info} tone="amber" title={t.invalid} body={t.invalidBody} />
      </Shell>
    );
  }
  if (request.error || !data) {
    return (
      <Shell>
        <ErrorState error={request.error} onRetry={() => void request.refetch()} />
      </Shell>
    );
  }
  const requester = data.requesterName ? `${data.requesterName}${data.requesterRole ? ` (${data.requesterRole})` : ""}` : "A colleague";
  if (submit.isSuccess) {
    return (
      <Shell>
        <Message icon={CircleCheck} tone="green" title={t.thanks} body={t.thanksBody(data.requesterName || "The requester")} />
      </Shell>
    );
  }
  if (data.status === "answered" || isApiError(submit.error, 409)) {
    return (
      <Shell>
        <Message icon={CircleCheck} tone="green" title={t.closed} body={t.closedBody} />
      </Shell>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const filled = data.questions.map((q) => ({ nodeId: q.nodeId, answer: (answers[q.nodeId] ?? "").trim() })).filter((a) => a.answer);
    if (!filled.length) {
      setFormError(t.atLeastOne);
      return;
    }
    setFormError(null);
    submit.mutate({ answers: filled, answeredBy: name.trim() || undefined, note: note.trim() || undefined });
  };

  return (
    <Shell>
      <div className="mb-6">
        <p className="text-xs font-medium tracking-wide text-brand-600 uppercase dark:text-brand-300">
          {t.role}: {stakeholderLabel(data.role)}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">{t.asked(requester, data.agentName)}</h1>
        <p className="mt-2 text-[15px] text-muted">{t.intro}</p>
      </div>
      {data.goal && (
        <div className="mb-6 rounded-xl border border-line bg-surface p-4 shadow-xs">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t.goal}</p>
          <p className="mt-1 text-sm whitespace-pre-line text-fg">{data.goal}</p>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        {data.questions.map((q, i) => (
          <div key={q.nodeId} className="rounded-xl border border-line bg-surface p-5 shadow-xs">
            <label htmlFor={`q-${q.nodeId}`} className="block text-[15px] font-medium text-fg">
              <span className="mr-2 text-brand-600 dark:text-brand-300">{i + 1}.</span>
              {q.question}
            </label>
            {q.why && (
              <p className="mt-1.5 flex gap-1.5 text-[13px] text-muted">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">{t.why}:</span> {q.why}
                </span>
              </p>
            )}
            <textarea
              id={`q-${q.nodeId}`}
              rows={3}
              className="input mt-3"
              placeholder={t.placeholder}
              value={answers[q.nodeId] ?? ""}
              onChange={(e) => setAnswers({ ...answers, [q.nodeId]: e.target.value })}
            />
          </div>
        ))}
        <div className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-xs">
          <div>
            <label htmlFor="answered-by" className="label">
              {t.name}
            </label>
            <input id="answered-by" className="input" placeholder={t.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="note" className="label">
              {t.note} <span className="text-xs font-normal text-faint">{t.optional}</span>
            </label>
            <textarea id="note" rows={2} className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        {submit.error && !isApiError(submit.error, 409) && <ErrorState error={submit.error} />}
        <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck className="size-3.5 shrink-0" /> {t.secure}
          </p>
          <Button type="submit" variant="primary" size="lg" icon={Send} loading={submit.isPending}>
            {t.submit}
          </Button>
        </div>
      </form>
    </Shell>
  );
}
