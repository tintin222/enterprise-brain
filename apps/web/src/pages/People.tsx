import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api.ts";
import { Badge } from "../components/Badge.tsx";
import { Button, IconButton } from "../components/Button.tsx";
import { Card, CardBody, CardHeader, PageHeader } from "../components/Card.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Page } from "../components/Layout.tsx";
import { Callout, ErrorState, Skeleton } from "../components/Spinner.tsx";
import { useViewer } from "../lib/auth.tsx";
import { useCompany } from "../lib/company.tsx";
import { initials, timeAgo } from "../lib/format.ts";
import { keys, useDepartments, usePeople } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { MembershipRole, Person, SignInSettings } from "../types.ts";

const PROVIDER_LABELS: Record<string, string> = { microsoft: "Microsoft", google: "Google", password: "Password", demo: "Demo" };

/** People: who works here, in which departments, and as what. Admins add people and set up sign-in. */
export default function PeoplePage() {
  const viewer = useViewer();
  const { info } = useCompany();
  const people = usePeople();
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const isAdmin = Boolean(viewer?.isAdmin);
  const accounts = info.auth?.mode === "accounts";
  return (
    <Page>
      <PageHeader
        icon={Users}
        title="People"
        description="Who works here and in which departments. Managers run their department's AI employees; workers handle the work the AI employees hand over."
        actions={
          isAdmin ? (
            <Button variant="primary" icon={UserPlus} onClick={() => setEditing("new")}>
              Add person
            </Button>
          ) : undefined
        }
      />
      {!accounts && (
        <Callout tone="warning" title="Sign-in is off" className="mb-6">
          This installation runs with <code>EB_AUTH=open</code>: everyone who opens it acts as the owner. Remove that setting to have people sign in with their
          own accounts.
        </Callout>
      )}
      {people.error && <ErrorState error={people.error} onRetry={() => void people.refetch()} />}
      {people.isLoading && <Skeleton className="h-64" />}
      {people.data?.length === 0 && (
        <EmptyState
          icon={Users}
          title="Nobody here yet"
          description="Add the managers and workers of each department. They sign in with Microsoft, Google or a password."
          action={
            isAdmin ? (
              <Button variant="primary" icon={UserPlus} onClick={() => setEditing("new")}>
                Add person
              </Button>
            ) : undefined
          }
        />
      )}
      {people.data && people.data.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {people.data.map((person) => (
              <li key={person.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                    {initials(person.name)}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{person.name}</span>
                      {person.id === viewer?.id && <Badge size="xs">You</Badge>}
                      {person.role === "admin" && (
                        <Badge tone="brand" size="xs" icon={ShieldCheck}>
                          Admin
                        </Badge>
                      )}
                      {person.status === "disabled" && (
                        <Badge tone="red" size="xs">
                          Disabled
                        </Badge>
                      )}
                    </p>
                    <p className="truncate text-[13px] text-muted">{[person.title, person.email].filter(Boolean).join(" · ")}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 sm:w-72 sm:justify-end">
                  {person.departments.length === 0 && <span className="text-xs text-faint">No department</span>}
                  {person.departments.map((d) => (
                    <Badge key={d.departmentId} tone={d.role === "manager" ? "violet" : "neutral"} size="xs">
                      {d.name} · {d.role}
                    </Badge>
                  ))}
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-3 sm:w-56 sm:justify-end">
                    <span className="text-xs text-muted">
                      {person.lastSignInAt
                        ? `${PROVIDER_LABELS[person.authProvider ?? ""] ?? "Signed in"} · ${timeAgo(person.lastSignInAt)}`
                        : "Never signed in"}
                    </span>
                    <IconButton icon={Pencil} label={`Edit ${person.name}`} size="sm" onClick={() => setEditing(person)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {isAdmin && <SignInSettingsCard />}
      {editing && <PersonDialog person={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

interface PersonForm {
  name: string;
  email: string;
  title: string;
  role: "admin" | "member";
  password: string;
  departments: Record<string, MembershipRole | "">;
}

function PersonDialog({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const { company, path } = useCompany();
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const toast = useToast();
  const departments = useDepartments();
  const [form, setForm] = useState<PersonForm>(() => ({
    name: person?.name ?? "",
    email: person?.email ?? "",
    title: person?.title ?? "",
    role: person?.role ?? "member",
    password: "",
    departments: Object.fromEntries((person?.departments ?? []).map((d) => [d.departmentId, d.role])),
  }));
  const [error, setError] = useState<string | null>(null);
  const memberships = Object.entries(form.departments)
    .filter(([, role]) => role)
    .map(([departmentId, role]) => ({ departmentId, role: role as MembershipRole }));
  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: keys.people(company) });
    void queryClient.invalidateQueries({ queryKey: ["auth"] });
    toast.success(message);
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      person
        ? api.put<Person>(path(`/people/${person.id}`), {
            name: form.name,
            title: form.title || null,
            role: form.role,
            departments: memberships,
            ...(form.password ? { password: form.password } : {}),
          })
        : api.post<Person>(path("/people"), {
            ...form,
            title: form.title || undefined,
            password: form.password || undefined,
            departments: memberships,
          }),
    onSuccess: (saved) => done(person ? `Saved ${saved.name}` : `Added ${saved.name}`),
    onError: (e) => setError(errorMessage(e)),
  });
  const setStatus = useMutation({
    mutationFn: (status: "active" | "disabled") => api.put<Person>(path(`/people/${person!.id}`), { status }),
    onSuccess: (saved) => done(saved.status === "disabled" ? `${saved.name} can no longer sign in` : `${saved.name} can sign in again`),
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(path(`/people/${person!.id}`)),
    onSuccess: () => done(`Removed ${person!.name}`),
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };
  const self = person?.id === viewer?.id;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={person ? `Edit ${person.name}` : "Add a person"}
      description={person ? person.email : "They sign in with Microsoft or Google using this email, or with the password you set."}
      footer={
        <>
          {person && !self && (
            <div className="mr-auto flex gap-2">
              <Button variant="ghost" loading={setStatus.isPending} onClick={() => setStatus.mutate(person.status === "disabled" ? "active" : "disabled")}>
                {person.status === "disabled" ? "Enable" : "Disable"}
              </Button>
              <Button
                variant="ghost"
                className="text-red-600 dark:text-red-400"
                loading={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Remove ${person.name}? Their sign-in stops working. AI employees they managed stay.`)) remove.mutate();
                }}
              >
                Remove
              </Button>
            </div>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="person-form" loading={save.isPending} disabled={!form.name.trim() || !form.email.trim()}>
            {person ? "Save" : "Add person"}
          </Button>
        </>
      }
    >
      <form id="person-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="person-name">
              Name
            </label>
            <input id="person-name" autoFocus className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="person-email">
              Work email
            </label>
            <input
              id="person-email"
              type="email"
              className="input"
              disabled={Boolean(person)}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor="person-title">
              Job title
            </label>
            <input
              id="person-title"
              className="input"
              placeholder="e.g. Recruitment Specialist"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor="person-role">
              Access
            </label>
            <select id="person-role" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as PersonForm["role"] })}>
              <option value="member">Member: their departments</option>
              <option value="admin">Admin: everything, including people and connections</option>
            </select>
          </div>
        </div>
        <div>
          <p className="label">Departments</p>
          {departments.isLoading && <Skeleton className="h-20" />}
          {departments.data?.length === 0 && <p className="text-sm text-muted">No departments installed yet.</p>}
          <div className="divide-y divide-line rounded-lg border border-line">
            {departments.data?.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{d.name}</span>
                <select
                  aria-label={`Role in ${d.name}`}
                  className="input w-36 py-1"
                  value={form.departments[d.id] ?? ""}
                  onChange={(e) => setForm({ ...form, departments: { ...form.departments, [d.id]: e.target.value as MembershipRole | "" } })}
                >
                  <option value="">Not in it</option>
                  <option value="worker">Worker</option>
                  <option value="manager">Manager</option>
                </select>
              </div>
            ))}
          </div>
          <p className="hint">Managers hire and run the department's AI employees. Workers see them and handle what they hand over.</p>
        </div>
        <div>
          <label className="label" htmlFor="person-password">
            {person?.hasPassword ? "New password" : "Password"} <span className="font-normal text-muted">(optional)</span>
          </label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              id="person-password"
              type="password"
              autoComplete="new-password"
              className="input pl-9"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <p className="hint">
            {person?.hasPassword ? "Leave empty to keep the current password." : "Only for people who don't sign in with Microsoft or Google."} At least 8
            characters.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sign-in settings (admins)
// ---------------------------------------------------------------------------

interface ProviderForm {
  clientId: string;
  secret: string;
  extra: string;
}

function SignInSettingsCard() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: [company, "sign-in"], queryFn: () => api.get<SignInSettings>(path("/sign-in")) });
  const [microsoft, setMicrosoft] = useState<ProviderForm>({ clientId: "", secret: "", extra: "" });
  const [google, setGoogle] = useState<ProviderForm>({ clientId: "", secret: "", extra: "" });
  const [domains, setDomains] = useState("");
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    if (!settings.data) return;
    setMicrosoft({ clientId: settings.data.microsoft.clientId, secret: "", extra: settings.data.microsoft.tenant });
    setGoogle({ clientId: settings.data.google.clientId, secret: "", extra: settings.data.google.hostedDomain });
    setDomains(settings.data.autoJoinDomains.join(", "));
    setDemo(settings.data.demo);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => {
      const current = settings.data!;
      // Sent only when changed; emptying the client id removes a provider saved here.
      const provider = (form: ProviderForm, saved: SignInSettings["microsoft"] | SignInSettings["google"], savedExtra: string) => {
        if (!form.clientId.trim()) return saved.source === "settings" ? null : undefined;
        const changed = form.clientId.trim() !== saved.clientId || form.secret !== "" || form.extra.trim() !== savedExtra;
        return changed ? { clientId: form.clientId, secret: form.secret || undefined } : undefined;
      };
      const ms = provider(microsoft, current.microsoft, current.microsoft.tenant);
      const g = provider(google, current.google, current.google.hostedDomain);
      return api.put<SignInSettings>(path("/sign-in"), {
        microsoft: ms ? { ...ms, tenant: microsoft.extra || undefined } : ms,
        google: g ? { ...g, hostedDomain: google.extra || undefined } : g,
        autoJoinDomains: domains.split(/[\s,;]+/).filter(Boolean),
        demo,
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData([company, "sign-in"], saved);
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
      toast.success("Sign-in settings saved");
    },
    onError: (e) => toast.error(e),
  });
  const data = settings.data;
  return (
    <Card className="mt-8">
      <CardHeader
        icon={KeyRound}
        title="Sign-in"
        subtitle="Let people use their Microsoft 365 or Google Workspace accounts. Passwords keep working for everyone who has one."
      />
      <CardBody>
        {settings.error && <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />}
        {!data && settings.isLoading && <Skeleton className="h-48" />}
        {data && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="space-y-6"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <ProviderFields
                title="Microsoft Entra ID"
                help="An app registration in the customer's Entra ID (Azure AD), type Web, with this redirect URI."
                settings={data.microsoft}
                redirectUri={data.redirectUris.microsoft}
                value={microsoft}
                onChange={setMicrosoft}
                extraLabel="Tenant"
                extraHint="Your organisation's directory (tenant) ID or primary domain, e.g. acme.com.tr. Only accounts of this organisation can sign in."
              />
              <ProviderFields
                title="Google Workspace"
                help="An OAuth client of type Web application in Google Cloud, with this redirect URI."
                settings={data.google}
                redirectUri={data.redirectUris.google}
                value={google}
                onChange={setGoogle}
                extraLabel="Workspace domain"
                extraHint="Only accounts of this domain (e.g. acme.com.tr). Empty: any Google account that has been added here."
              />
            </div>
            <div>
              <label className="label" htmlFor="auto-join">
                Let colleagues join by themselves
              </label>
              <input id="auto-join" className="input" placeholder="acme.com.tr" value={domains} onChange={(e) => setDomains(e.target.value)} />
              <p className="hint">
                People whose Microsoft or Google email is in one of these domains get an account on their first sign-in, as members without a department. Empty:
                only people added here can sign in.
              </p>
            </div>
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
              <span>
                <span className="font-medium">Demo sign-in</span>
                <span className="block text-muted">
                  Show the demo people on the sign-in page, one click each. Turn this off before real people use the installation.
                </span>
              </span>
            </label>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={save.isPending}>
                Save sign-in settings
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function ProviderFields({
  title,
  help,
  settings,
  redirectUri,
  value,
  onChange,
  extraLabel,
  extraHint,
}: {
  title: string;
  help: string;
  settings: SignInSettings["microsoft"] | SignInSettings["google"];
  redirectUri: string;
  value: ProviderForm;
  onChange: (value: ProviderForm) => void;
  extraLabel: string;
  extraHint: string;
}) {
  const id = title.toLowerCase().replace(/\W+/g, "-");
  return (
    <fieldset className="space-y-3 rounded-xl border border-line p-4">
      <legend className="flex items-center gap-2 px-1 text-sm font-semibold">
        {title}
        {settings.configured ? (
          <Badge tone="green" size="xs">
            {settings.source === "environment" ? "On (environment)" : "On"}
          </Badge>
        ) : (
          <Badge size="xs">Off</Badge>
        )}
      </legend>
      <p className="text-xs text-muted">{help}</p>
      <div>
        <p className="label">Redirect URI</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-subtle px-2.5 py-1.5 text-xs">{redirectUri}</code>
          <CopyButton text={redirectUri} iconOnly />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-client`}>
          Client ID
        </label>
        <input id={`${id}-client`} className="input" value={value.clientId} onChange={(e) => onChange({ ...value, clientId: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-secret`}>
          Client secret
        </label>
        <input
          id={`${id}-secret`}
          type="password"
          autoComplete="off"
          className="input"
          placeholder={settings.source === "settings" ? "Saved. Type a new one to replace it." : ""}
          value={value.secret}
          onChange={(e) => onChange({ ...value, secret: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-extra`}>
          {extraLabel}
        </label>
        <input id={`${id}-extra`} className="input" value={value.extra} onChange={(e) => onChange({ ...value, extra: e.target.value })} />
        <p className="hint">{extraHint}</p>
      </div>
      {settings.source === "environment" && <p className="text-xs text-muted">Set with environment variables. Saving it here overrides them.</p>}
    </fieldset>
  );
}
