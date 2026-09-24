import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, BookOpen, LibraryBig, Search as SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api, qs } from "../api.ts";
import { Badge, StatusPill } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { ErrorState, Skeleton } from "../components/Spinner.tsx";
import { useCompany } from "../lib/company.tsx";
import { humanize, truncate } from "../lib/format.ts";
import { archetypeIcon } from "../lib/icons.tsx";
import { archetypeLabel } from "../lib/labels.ts";
import { keys, useAgents } from "../lib/queries.ts";
import type { CatalogSearchResult, SearchHit, SearchResponse } from "../types.ts";

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3))];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A window of the text around the first query term, with all terms highlighted. */
export function Highlighted({ text, query, max = 320 }: { text: string; query: string; max?: number }) {
  const words = terms(query);
  const clean = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]+/g, "")
    .replace(/\s#{1,6}\s/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  let start = 0;
  if (words.length) {
    const lower = clean.toLowerCase();
    const first = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), Number.POSITIVE_INFINITY);
    if (Number.isFinite(first) && first > max / 3) start = Math.max(0, first - Math.floor(max / 3));
  }
  let snippet = clean.slice(start, start + max);
  if (start > 0) snippet = `…${snippet}`;
  if (start + max < clean.length) snippet = `${snippet}…`;
  if (!words.length) return <>{snippet}</>;
  const pattern = new RegExp(`(${words.map(escapeRegex).join("|")})`, "gi");
  const parts: ReactNode[] = snippet.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="hl">
        {part}
      </mark>
    ) : (
      part
    ),
  );
  return <>{parts}</>;
}

function catalogLink(r: CatalogSearchResult): string {
  switch (r.kind) {
    case "department":
      return `/catalog/departments/${r.id}`;
    case "process":
      return `/catalog/departments/${r.department ?? r.id.split(".")[0]}`;
    case "use-case":
      return `/catalog?tab=usecases`;
    default:
      return `/catalog?tab=agents&template=${encodeURIComponent(r.id)}`;
  }
}

const SUGGESTIONS = ["annual leave", "travel policy hotel limit", "VPN access", "purchase order", "yıllık izin"];

export default function Search() {
  const { company, path } = useCompany();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);

  const knowledge = useQuery({
    queryKey: [...keys.knowledge(company), "search", q],
    queryFn: () => api.post<SearchResponse>(path("/knowledge/search"), { query: q, topK: 10 }),
    enabled: Boolean(q),
  });
  const catalog = useQuery({
    queryKey: ["catalog", "search", q],
    queryFn: () => api.get<CatalogSearchResult[]>(`/api/catalog/search${qs({ q })}`),
    enabled: Boolean(q),
  });
  const agents = useAgents();
  // The same passage often lives in several collections: show it once, with every collection.
  const hits = useMemo(() => {
    const groups = new Map<string, { hit: SearchHit; collections: string[] }>();
    for (const h of knowledge.data?.hits ?? []) {
      const key = `${h.title}|${h.content.slice(0, 160)}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.collections.includes(h.collectionKey)) existing.collections.push(h.collectionKey);
        if (h.score > existing.hit.score) existing.hit = h;
      } else groups.set(key, { hit: h, collections: [h.collectionKey] });
    }
    return [...groups.values()];
  }, [knowledge.data]);
  const agentHits = useMemo(() => {
    const words = terms(q);
    if (!words.length) return [];
    return (agents.data ?? [])
      .map((a) => {
        const hay = `${a.name} ${a.summary} ${a.title ?? ""} ${a.department ?? ""}`.toLowerCase();
        return { agent: a, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.agent);
  }, [agents.data, q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = input.trim();
    setParams(value ? { q: value } : {});
  };

  return (
    <Page className="max-w-5xl">
      <div className="mx-auto max-w-3xl pt-2 pb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Search the company</h1>
        <p className="mt-2 text-sm text-muted">Policies, procedures and documents in the knowledge base — plus agents and templates that can do the job.</p>
        <form onSubmit={submit} className="relative mt-6">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-faint" />
          <input
            autoFocus
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What are you looking for?"
            aria-label="Search"
            className="h-14 w-full rounded-2xl border border-line-strong bg-surface pr-28 pl-12 text-base text-fg shadow-sm outline-none placeholder:text-faint focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15"
          />
          <Button type="submit" variant="primary" className="absolute top-1/2 right-2 -translate-y-1/2">
            Search
          </Button>
        </form>
        {!q && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setParams({ q: s })}
                className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-muted hover:border-brand-400 hover:text-fg"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {q && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section aria-label="Knowledge results">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
              <BookOpen className="size-4 text-muted" /> Knowledge
              {knowledge.data && <span className="font-normal text-muted">· {hits.length} results in {knowledge.data.tookMs} ms</span>}
            </h2>
            {knowledge.isLoading && (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-24" />
                ))}
              </div>
            )}
            {knowledge.error && <ErrorState error={knowledge.error} />}
            {knowledge.data && hits.length === 0 && (
              <EmptyState
                compact
                icon={SearchIcon}
                title="Nothing in the knowledge base"
                description="Try other words, or add the document to a collection."
                action={
                  <Link to="/knowledge" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">
                    Open the knowledge base
                  </Link>
                }
              />
            )}
            <div className="space-y-3">
              {hits.map(({ hit: h, collections }) => (
                <Card key={h.chunkId} className="p-4 transition-colors hover:border-brand-300 dark:hover:border-brand-400/40">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/knowledge?collection=${encodeURIComponent(h.collectionKey)}&doc=${encodeURIComponent(h.documentId)}`}
                      className="text-[15px] font-semibold text-brand-700 hover:underline dark:text-brand-300"
                    >
                      {h.title}
                    </Link>
                    {collections.slice(0, 3).map((c) => (
                      <Badge key={c} size="xs">
                        {c}
                      </Badge>
                    ))}
                    {collections.length > 3 && <span className="text-[11px] text-faint">+{collections.length - 3} collections</span>}
                    <span className="ml-auto text-xs text-faint tabular-nums" title="Relevance (fused vector + full-text score)">
                      {Math.round(h.score * 100)}% match
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">
                    <Highlighted text={h.content} query={q} />
                  </p>
                </Card>
              ))}
            </div>
          </section>

          <aside className="space-y-8">
            <section aria-label="Agents">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
                <Bot className="size-4 text-muted" /> Your agents
              </h2>
              {agentHits.length === 0 ? (
                <p className="text-sm text-muted">No installed agent matches.</p>
              ) : (
                <ul className="space-y-2">
                  {agentHits.map((a) => {
                    const Icon = archetypeIcon(a.archetype);
                    return (
                      <li key={a.id}>
                        <Link to={`/apps/${a.slug}`} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 hover:border-brand-300 dark:hover:border-brand-400/40">
                          <Icon className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-300" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-fg">{a.name}</span>
                              <StatusPill status={a.status} size="xs" />
                            </span>
                            <span className="line-clamp-2 text-xs text-muted">{a.summary}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <section aria-label="Templates">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
                <LibraryBig className="size-4 text-muted" /> Templates
              </h2>
              {catalog.isLoading && <Skeleton className="h-24" />}
              {catalog.data && catalog.data.length === 0 && <p className="text-sm text-muted">No matching templates.</p>}
              <ul className="space-y-2">
                {catalog.data?.slice(0, 6).map((r) => (
                  <li key={`${r.kind}-${r.id}`}>
                    <Link to={catalogLink(r)} className="block rounded-xl border border-line bg-surface p-3 hover:border-brand-300 dark:hover:border-brand-400/40">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{r.name}</span>
                        <Badge size="xs" tone={r.kind === "agent" ? "brand" : "neutral"}>
                          {humanize(r.kind)}
                        </Badge>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{truncate(r.summary, 140)}</span>
                      {r.archetype && <span className="mt-1 block text-[11px] text-faint">{archetypeLabel(r.archetype)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
              {q && (
                <Link to={`/builder/new`} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
                  Nothing fits? Build an agent <ArrowRight className="size-3" />
                </Link>
              )}
            </section>
          </aside>
        </div>
      )}
    </Page>
  );
}
