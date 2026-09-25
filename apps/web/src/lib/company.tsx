import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, ServerCrash } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, companyPath, errorMessage, getApiKey, isApiError, setApiKey } from "../api.ts";
import { Logo } from "../components/Logo.tsx";
import type { Company, Info } from "../types.ts";
import { readStorage, writeStorage } from "./storage.ts";

const COMPANY_STORAGE = "eb.company";

interface CompanyContextValue {
  info: Info;
  /** Selected company slug. */
  company: string;
  companyName: string;
  companies: Company[];
  setCompany: (slug: string) => void;
  /** Build `/api/companies/:company/...` for the selected company. */
  path: (sub?: string) => string;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function useInfoQuery() {
  return useQuery({ queryKey: ["info"], queryFn: () => api.get<Info>("/api/info"), staleTime: 60_000, retry: 1 });
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const info = useInfoQuery();
  const [stored, setStored] = useState<string | null>(() => readStorage(COMPANY_STORAGE));
  const needsKey = Boolean(info.data?.authRequired && !getApiKey());
  const companies = useQuery({
    queryKey: ["companies"],
    queryFn: () => api.get<Company[]>("/api/companies"),
    enabled: Boolean(info.data) && !needsKey,
    staleTime: 60_000,
    retry: (count, error) => !isApiError(error, 401) && count < 1,
  });

  const setCompany = useCallback(
    (slug: string) => {
      writeStorage(COMPANY_STORAGE, slug);
      setStored(slug);
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const value = useMemo<CompanyContextValue | null>(() => {
    if (!info.data) return null;
    const list = companies.data ?? [];
    const slug = stored && (list.length === 0 || list.some((c) => c.slug === stored)) ? stored : info.data.defaultCompany;
    const name = list.find((c) => c.slug === slug)?.name ?? slug;
    return {
      info: info.data,
      company: slug,
      companyName: name,
      companies: list,
      setCompany,
      path: (sub = "") => companyPath(slug, sub),
    };
  }, [info.data, companies.data, stored, setCompany]);

  if (info.isLoading) return <Splash />;
  if (info.error || !value) return <ServerDown error={info.error} onRetry={() => void info.refetch()} />;
  if (needsKey || isApiError(companies.error, 401)) {
    // With accounts, a 401 means the session ended: the sign-in gate takes over.
    if (info.data?.auth?.mode === "accounts") return <Splash />;
    return <ApiKeyGate invalid={isApiError(companies.error, 401) && Boolean(getApiKey())} />;
  }
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany(): CompanyContextValue {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error("useCompany must be used inside <CompanyProvider>");
  return ctx;
}

export function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-muted">
        <Logo className="size-12 animate-pulse" />
        <p className="text-sm">Connecting to Enterprise Brain…</p>
      </div>
    </div>
  );
}

function ServerDown({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300">
          <ServerCrash className="size-6" />
        </div>
        <h1 className="text-lg font-semibold">Can't reach the Enterprise Brain server</h1>
        <p className="mt-2 text-sm text-muted">
          {error ? errorMessage(error) : "The API did not answer."} Start it with <code className="rounded bg-subtle px-1.5 py-0.5 text-xs">pnpm dev</code> and
          try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          <RefreshCw className="size-4" /> Try again
        </button>
      </div>
    </div>
  );
}

function ApiKeyGate({ invalid }: { invalid: boolean }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setApiKey(key.trim());
    void queryClient.resetQueries();
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-10" />
          <div>
            <h1 className="text-lg font-semibold">Enterprise Brain</h1>
            <p className="text-sm text-muted">This instance is protected with an API key.</p>
          </div>
        </div>
        <label className="label" htmlFor="api-key">
          Console API key
        </label>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input id="api-key" type="password" autoFocus className="input pl-9" placeholder="EB_API_KEY" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        {invalid && <p className="mt-2 text-sm text-red-600 dark:text-red-400">That key was rejected. Check the value of EB_API_KEY.</p>}
        <p className="hint">The key is stored only in this browser.</p>
        <button type="submit" className="mt-6 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700">
          Continue
        </button>
      </form>
    </div>
  );
}
