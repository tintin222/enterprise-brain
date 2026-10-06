import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleQuestion, MessageSquarePlus } from "lucide-react";
import { useSearchParams } from "react-router";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ChatPanel } from "../../components/Chat.tsx";
import { useCompany } from "../../lib/company.tsx";
import { keys } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import type { Conversation } from "../../types.ts";

const SUGGESTIONS = [
  "Who knows the 8D complaint process, and who is the backup?",
  "What is happening with Petrokim this week?",
  "Which of our systems have an API for sales orders, and can AI employees reach them?",
  "What are the tables of the MES database, and can I connect to it?",
  "Which projects are at risk, and why?",
  "Who should I ask about an SAP invoice posting error?",
];

/** Questions to the company assistant, which looks in the brain (and the knowledge base) to answer. */
export default function BrainAsk() {
  const { company, path, info } = useCompany();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const question = params.get("q") ?? undefined;
  useDocumentTitle("Ask the brain");
  const conversations = useQuery({
    queryKey: [...keys.chat(company), "conversations", { agent: null }],
    queryFn: () => api.get<Conversation[]>(path("/chat/conversations")),
    select: (list) => list.filter((c) => !c.agentId),
  });
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <MessageCircleQuestion className="size-5 text-brand-600 dark:text-brand-300" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-fg">Ask the brain</h1>
          <p className="text-xs text-muted">
            {info.llm.available
              ? "Claude looks in the company brain and the knowledge base, and links what it names."
              : "Offline: no AI model is connected, so you get the closest things in the brain instead of an answer."}
          </p>
        </div>
        <select
          className="input h-8 w-56 py-1 text-[13px]"
          value={selected ?? ""}
          onChange={(e) => setParams(e.target.value ? { c: e.target.value } : {})}
          aria-label="Earlier conversations"
        >
          <option value="">New question</option>
          {(conversations.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="soft" icon={MessageSquarePlus} onClick={() => setParams({})}>
          New
        </Button>
      </div>
      <ChatPanel
        key={selected ?? `new-${question ?? ""}`}
        className="min-h-[60vh] flex-1"
        conversationId={selected}
        assistantName="Company brain"
        suggestions={SUGGESTIONS}
        initialQuestion={selected ? undefined : question}
        emptyTitle="Ask anything about the company"
        emptyDescription="Who does what and who knows what, how processes work, which systems there are, clients, projects, what is happening."
        onConversationCreated={(id) => {
          void queryClient.invalidateQueries({ queryKey: [...keys.chat(company), "conversations"] });
          setParams({ c: id }, { replace: true });
        }}
      />
    </div>
  );
}
