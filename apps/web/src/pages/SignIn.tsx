import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogIn, ServerCrash, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api, errorMessage } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { Logo } from "../components/Logo.tsx";
import { useAuthState } from "../lib/auth.tsx";
import { Splash } from "../lib/company.tsx";
import { initials } from "../lib/format.ts";
import { useDocumentTitle } from "../lib/title.ts";
import type { AuthState, DemoPerson } from "../types.ts";

/** Only paths inside this app (the server applies the same rule). */
function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") && !value.startsWith("/signin") ? value : "/";
}

/**
 * Sign-in: Microsoft / Google, email and password, and, on demo installations, one click as one of
 * the demo people. On the very first start it asks for the admin account instead.
 */
export default function SignIn() {
  const auth = useAuthState();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const state = auth.data;
  useDocumentTitle(state?.setupRequired ? "Set up" : "Sign in");

  if (auth.isLoading) return <Splash />;
  if (!state) {
    return (
      <Frame>
        <Card>
          <div className="flex items-start gap-3 text-sm">
            <ServerCrash className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
            <p>Can't reach the Enterprise Brain server. {auth.error ? errorMessage(auth.error) : ""}</p>
          </div>
        </Card>
      </Frame>
    );
  }
  if (state.mode === "open" || state.viewer) return <Navigate to={returnTo} replace />;
  if (state.setupRequired) {
    return (
      <Frame>
        <Setup state={state} />
      </Frame>
    );
  }
  return (
    <Frame wide={state.demo.length > 0}>
      <div className={state.demo.length ? "grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]" : ""}>
        <SignInCard state={state} returnTo={returnTo} error={params.get("error")} />
        {state.demo.length > 0 && <DemoPeople people={state.demo} returnTo={returnTo} />}
      </div>
    </Frame>
  );
}

function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50/60 to-transparent p-4 sm:p-6 dark:from-brand-500/5">
      <div className={wide ? "w-full max-w-5xl" : "w-full max-w-md"}>{children}</div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">{children}</div>;
}

function Header({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <Logo className="size-10" />
      <div className="min-w-0">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

/** Signs in with a request that sets the session cookie, then opens the app where the person was going. */
function useSignIn(returnTo: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setError(null);
    try {
      await api.post(path, body);
      queryClient.clear();
      navigate(returnTo, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function SignInCard({ state, returnTo, error: redirectError }: { state: AuthState; returnTo: string; error: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSignIn(returnTo);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim() && password) void run("password", "/api/auth/signin", { email, password });
  };
  const query = returnTo !== "/" ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
  return (
    <Card>
      <Header title="Sign in" subtitle={state.company ? `to ${state.company.name}'s Enterprise Brain` : "to Enterprise Brain"} />
      {redirectError && (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {redirectError}
        </p>
      )}
      {state.providers.length > 0 && (
        <>
          <div className="space-y-2">
            {state.providers.map((provider) => (
              <a
                key={provider.id}
                href={`/api/auth/oidc/${encodeURIComponent(provider.id)}/start${query}`}
                className="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-line-strong bg-surface text-sm font-medium shadow-xs hover:bg-subtle focus-visible:outline-2 focus-visible:outline-brand-500"
              >
                <ProviderIcon id={provider.id} />
                Continue with {provider.label}
              </a>
            ))}
          </div>
          <div className="my-5 flex items-center gap-3 text-xs text-faint">
            <span className="h-px flex-1 bg-line" />
            or with a password
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="signin-email">
            Email
          </label>
          <input
            id="signin-email"
            type="email"
            autoComplete="username"
            autoFocus={state.providers.length === 0}
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="signin-password">
            Password
          </label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" icon={LogIn} loading={busy === "password"} disabled={!email.trim() || !password} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-5 text-xs text-muted">No account yet? Ask your Enterprise Brain admin to add you.</p>
    </Card>
  );
}

function DemoPeople({ people, returnTo }: { people: DemoPerson[]; returnTo: string }) {
  const { busy, error, run } = useSignIn(returnTo);
  return (
    <Card>
      <h2 className="text-base font-semibold">Try it as one of the demo people</h2>
      <p className="mt-1 text-sm text-muted">
        This is a demo installation. Each person sees their own departments: managers run their AI employees, workers handle the work handed to them.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {people.map((person) => (
          <li key={person.email}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run(person.email, "/api/auth/demo", {
                  email: person.email,
                })
              }
              className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/50 disabled:opacity-60 dark:hover:border-brand-400/40 dark:hover:bg-brand-500/5"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                {initials(person.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{person.name}</span>
                  {person.isAdmin && <ShieldCheck className="size-3.5 shrink-0 text-brand-600 dark:text-brand-300" aria-label="Admin" />}
                </span>
                <span className="block truncate text-xs text-muted">{person.title ?? person.email}</span>
                <span className="block truncate text-xs text-faint">{person.departments.map((d) => `${d.name} ${d.role}`).join(" · ") || "No department"}</span>
              </span>
              {busy === person.email && <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Setup({ state }: { state: AuthState }) {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const { busy, error, run } = useSignIn("/");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run("setup", "/api/auth/setup", form);
  };
  const ready = form.name.trim() && form.email.trim() && form.password.length >= 8;
  return (
    <Card>
      <Header title="Set up Enterprise Brain" subtitle={state.company?.name ?? "First start"} />
      <p className="mb-5 text-sm text-muted">
        Nobody has an account yet. Create yours: you become the admin, and you add your colleagues and turn on Microsoft or Google sign-in afterwards.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="setup-name">
            Your name
          </label>
          <input
            id="setup-name"
            autoFocus
            autoComplete="name"
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="setup-email">
            Work email
          </label>
          <input
            id="setup-email"
            type="email"
            autoComplete="username"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="setup-password">
            Password
          </label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              className="input pl-9"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <p className="hint">At least 8 characters.</p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy === "setup"} disabled={!ready} className="w-full">
          Create the admin account
        </Button>
      </form>
    </Card>
  );
}

function ProviderIcon({ id }: { id: string }) {
  if (id === "microsoft") {
    return (
      <svg viewBox="0 0 21 21" className="size-[18px]" aria-hidden="true">
        <path fill="#f25022" d="M1 1h9v9H1z" />
        <path fill="#7fba00" d="M11 1h9v9h-9z" />
        <path fill="#00a4ef" d="M1 11h9v9H1z" />
        <path fill="#ffb900" d="M11 11h9v9h-9z" />
      </svg>
    );
  }
  if (id === "google") {
    return (
      <svg viewBox="0 0 48 48" className="size-[18px]" aria-hidden="true">
        <path
          fill="#FFC107"
          d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9Z"
        />
        <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7Z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44Z" />
        <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9Z" />
      </svg>
    );
  }
  return <KeyRound className="size-[18px] text-muted" />;
}
