import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { MessageSquare, MessageSquarePlus, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router";
import { api } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { ChatPanel } from "../components/Chat.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { timeAgo } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import type { Conversation } from "../types.ts";

const SUGGESTIONS = [
  "How many days of annual leave do I get?",
  "What is the hotel limit in the travel policy?",
  "How do I request VPN access?",
  "Yıllık izin hakkım kaç gün?",
];

export default function Assistant() {
  const { company, path, info } = useCompany();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const conversations = useQuery({
    queryKey: [...keys.chat(company), "conversations", { agent: null }],
    queryFn: () => api.get<Conversation[]>(path("/chat/conversations")),
    select: (list) => list.filter((c) => !c.agentId),
  });

  const open = (id: string | null) => setParams(id ? { c: id } : {}, { replace: false });

  return (
    <div className="flex min-h-0 flex-1 lg:h-[calc(100dvh-3.5rem)] lg:flex-none lg:overflow-hidden">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h1 className="text-sm font-semibold text-fg">Company assistant</h1>
          <Button size="xs" variant="soft" icon={MessageSquarePlus} onClick={() => open(null)}>
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.isLoading && <Skeleton className="m-2 h-24" />}
          {conversations.data && conversations.data.length === 0 && <p className="px-3 py-4 text-xs text-muted">Your conversations will appear here.</p>}
          <ul className="space-y-0.5">
            {(conversations.data ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => open(c.id)}
                  className={clsx(
                    "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left",
                    selected === c.id ? "bg-brand-50 text-brand-800 dark:bg-brand-400/15 dark:text-brand-100" : "text-fg hover:bg-subtle",
                  )}
                >
                  <MessageSquare className="mt-0.5 size-4 shrink-0 text-faint" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{c.title}</span>
                    <span className="block text-[11px] text-faint">{timeAgo(c.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-line p-3 text-[11px] leading-relaxed text-muted">
          <p className="flex items-start gap-1.5">
            <ShieldCheck className="mt-px size-3.5 shrink-0" />
            Answers come from the company knowledge base and stay in your tenant.
            {!info.llm.available && " Offline mode: the assistant shows the most relevant passages instead of writing answers."}
          </p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2.5 lg:hidden">
          <select
            className="input h-8 max-w-[70%] py-1 text-[13px]"
            value={selected ?? ""}
            onChange={(e) => open(e.target.value || null)}
            aria-label="Conversation"
          >
            <option value="">New conversation</option>
            {(conversations.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <Button size="xs" variant="soft" icon={MessageSquarePlus} onClick={() => open(null)}>
            New
          </Button>
        </div>
        <ChatPanel
          key={selected ?? "new"}
          className="min-h-[70vh] flex-1 lg:min-h-0"
          conversationId={selected}
          assistantName="Company Assistant"
          suggestions={SUGGESTIONS}
          emptyTitle="Ask the company assistant"
          emptyDescription="Policies, procedures, IT how-tos — in English or Turkish. Every answer shows its sources."
          onConversationCreated={(id) => {
            void queryClient.invalidateQueries({ queryKey: [...keys.chat(company), "conversations"] });
            setParams({ c: id }, { replace: true });
          }}
        />
      </div>
    </div>
  );
}
