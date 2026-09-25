import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lightbulb, LibraryBig, Sparkles, WandSparkles } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { Card } from "../../components/Card.tsx";
import { Chip, Field } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { Logo } from "../../components/Logo.tsx";
import { Callout, Spinner } from "../../components/Spinner.tsx";
import { Segmented } from "../../components/Tabs.tsx";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { LANGUAGES } from "../../lib/labels.ts";
import { keys } from "../../lib/queries.ts";
import { readJson, writeJson } from "../../lib/storage.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AgentTemplate, SessionView } from "../../types.ts";
import { useDocumentTitle } from "../../lib/title.ts";

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "CV screener",
    text: "I'm an HR manager. Every week we get dozens of CVs by email and through our careers page. I want an AI employee that reads them, scores candidates against the open position and shortlists the best ones for me to review.",
  },
  {
    label: "Supplier invoice processing",
    text: "In accounts payable we receive 300+ supplier invoices a month as PDF attachments, some of them scanned. I want an AI employee that reads each invoice, extracts supplier, invoice number, amounts and the PO number, checks them against the purchase order in our ERP and prepares the posting for approval.",
  },
  {
    label: "Customer email triage",
    text: "Our support@ mailbox gets about 150 emails a day: complaints, delivery questions, returns and spam. I want an AI employee that classifies every email, looks up the customer's order and drafts a reply in the customer's language for my team to approve.",
  },
  {
    label: "HR policy assistant",
    text: "Employees keep asking HR the same questions about annual leave, travel expenses and benefits. I want an assistant that answers from our HR policies with sources, in Turkish and English, and hands over to HR when it isn't sure.",
  },
  {
    label: "Month-end Excel reconciliation",
    text: "Every month-end I reconcile the bank statement export with our ledger export in Excel. I want an AI employee that matches the transactions, lists open items and differences, and gives me a clean Excel report with an explanation.",
  },
];

const ROUND_SIZES = [
  { value: "1", label: "One at a time" },
  { value: "3", label: "A few" },
  { value: "5", label: "Standard" },
  { value: "8", label: "Many" },
];

interface Requester {
  name: string;
  role: string;
  email: string;
}

const REQUESTER_KEY = "eb.requester";

function Thinking() {
  const steps = ["Reading your description", "Matching it with department templates", "Preparing the first questions"];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setActive((a) => Math.min(a + 1, steps.length - 1)), 2200);
    return () => window.clearInterval(t);
  }, [steps.length]);
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md text-center" role="status" aria-live="polite">
        <Logo className="mx-auto size-14 animate-pulse" />
        <h2 className="mt-5 text-lg font-semibold text-fg">The analyst is reading your request…</h2>
        <p className="mt-1 text-sm text-muted">This takes a few seconds, a little longer when the AI model is connected.</p>
        <ol className="mx-auto mt-6 inline-flex flex-col gap-2 text-left">
          {steps.map((s, i) => (
            <li key={s} className={i <= active ? "flex items-center gap-2 text-sm text-fg" : "flex items-center gap-2 text-sm text-faint"}>
              {i < active ? <span className="w-4 text-center text-emerald-500">✓</span> : i === active ? <Spinner size="sm" /> : <span className="w-4" />}
              {s}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function BuilderNew() {
  const { company, path } = useCompany();
  useDocumentTitle("Hire in the Studio");
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const templateId = params.get("template");

  const [description, setDescription] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [requester, setRequester] = useState<Requester>(() => readJson<Requester>(REQUESTER_KEY, { name: "", role: "", email: "" }));
  const viewer = useViewer();
  // Signed in, the server knows who hires: their name, title and the department they manage.
  const signedIn = viewer?.kind === "session";
  const managed = (viewer?.departments ?? []).filter((d) => d.role === "manager").map((d) => d.name);
  const [language, setLanguage] = useState("en");
  const [roundSize, setRoundSize] = useState("5");
  const [department, setDepartment] = useState<string | undefined>(undefined);

  const template = useQuery({
    queryKey: ["catalog", "agent", templateId],
    queryFn: () => api.get<AgentTemplate>(`/api/catalog/agents/${encodeURIComponent(templateId ?? "")}`),
    enabled: Boolean(templateId),
  });

  useEffect(() => {
    const t = template.data;
    if (!t) return;
    setDescription(
      `I'd like an AI employee based on the “${t.name}” template: ${t.summary.trim()} Please adapt it to how we work — ask me about our process, our systems and our rules.`,
    );
    setDepartment(t.department);
  }, [template.data]);

  const start = useMutation({
    mutationFn: () =>
      api.post<SessionView>(path("/builder/sessions"), {
        description: description.trim(),
        formDescription: formDescription.trim() || undefined,
        requesterName: requester.name.trim() || undefined,
        requesterRole: requester.role.trim() || undefined,
        requesterEmail: requester.email.trim() || undefined,
        department,
        language,
        roundSize: Number(roundSize),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData(keys.session(company, view.session.id), view);
      void queryClient.invalidateQueries({ queryKey: keys.builder(company) });
      navigate(`/hire/studio/${view.session.id}`);
    },
    onError: (error) => toast.error(error),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (description.trim().length < 3) return;
    writeJson(REQUESTER_KEY, requester);
    start.mutate();
  };

  if (start.isPending) return <Thinking />;

  return (
    <Page className="max-w-4xl">
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-brand-600 via-brand-600 to-violet-600 px-6 py-8 text-white shadow-sm sm:px-8">
        <div className="bg-dots absolute inset-0 opacity-20" aria-hidden="true" />
        <div className="relative">
          <p className="flex items-center gap-2 text-sm font-medium text-white/80">
            <WandSparkles className="size-4" /> Studio
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Describe the job</h1>
          <p className="mt-2 max-w-2xl text-[15px] text-white/85">
            Write it the way you'd explain it to a new colleague. An AI requirements analyst will ask you a few rounds of questions — each with a recommended
            answer — and involve IT or legal only where needed. Nothing is built until you confirm.
          </p>
        </div>
      </div>

      {templateId && template.data && (
        <Callout tone="brand" icon={LibraryBig} className="mb-6" title={`Starting from the “${template.data.name}” template`}>
          The analyst will adapt it to your process instead of starting from scratch.{" "}
          <Link to="/hire/ready-made?tab=agents" className="font-medium underline">
            Browse other templates
          </Link>
        </Callout>
      )}

      <form onSubmit={submit} className="space-y-6">
        <Card className="p-5 sm:p-6">
          <Field label="What should it do?" required hint="Mention who sends what, what you do with it today, and what a good result looks like.">
            {(id) => (
              <textarea
                id={id}
                rows={7}
                autoFocus
                className="input text-[15px] leading-relaxed"
                placeholder="I'm an HR manager. Every week we get dozens of CVs by email and through our careers page. I want an AI employee that reads them, scores candidates against the open position and shortlists the best ones…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <div className="mt-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
              <Lightbulb className="size-3.5 text-amber-500" /> Try an example
            </p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <Chip key={ex.label} selected={description === ex.text} onClick={() => setDescription(ex.text)}>
                  {ex.label}
                </Chip>
              ))}
            </div>
          </div>
          <Field
            className="mt-6"
            label="Do you already have a form in mind?"
            optional
            hint="E.g. the fields your team fills in today, or a screen you'd like to see."
          >
            {(id) => (
              <textarea
                id={id}
                rows={3}
                className="input"
                placeholder="Upload the CV, pick the open position, optionally paste notes from the phone screen…"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            )}
          </Field>
        </Card>

        <Card className="p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-fg">About you</h2>
          {signedIn ? (
            <p className="mt-0.5 text-[13px] text-muted">
              You hire it as <span className="font-medium text-fg">{viewer.name}</span>
              {managed.length ? (
                <>
                  {" "}
                  for <span className="font-medium text-fg">{managed.join(", ")}</span>
                </>
              ) : null}
              , and you become its manager. Emails the analyst drafts for IT or data protection are signed with your name.
            </p>
          ) : (
            <p className="mt-0.5 text-[13px] text-muted">Used to sign the emails the analyst drafts for your colleagues (e.g. IT or data protection).</p>
          )}
          <div className={signedIn ? "hidden" : "mt-4 grid gap-4 sm:grid-cols-3"}>
            <Field label="Your name">
              {(id) => (
                <input
                  id={id}
                  className="input"
                  placeholder="Ayşe Demir"
                  value={requester.name}
                  onChange={(e) => setRequester({ ...requester, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Your role">
              {(id) => (
                <input
                  id={id}
                  className="input"
                  placeholder="HR Manager"
                  value={requester.role}
                  onChange={(e) => setRequester({ ...requester, role: e.target.value })}
                />
              )}
            </Field>
            <Field label="Your email">
              {(id) => (
                <input
                  id={id}
                  type="email"
                  className="input"
                  placeholder="ayse.demir@company.com"
                  value={requester.email}
                  onChange={(e) => setRequester({ ...requester, email: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-[12rem_1fr]">
            <Field label="Language">
              {(id) => (
                <select id={id} className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div>
              <span className="label">Questions per round</span>
              <Segmented value={roundSize} onChange={setRoundSize} options={ROUND_SIZES} />
              <p className="hint">Fewer questions per round feels more like a conversation; more is faster.</p>
            </div>
          </div>
        </Card>

        <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Sparkles className="size-3.5" /> You stay in control: every answer can be changed, and nothing goes live without you.
          </p>
          <Button type="submit" variant="primary" size="lg" iconRight={ArrowRight} disabled={description.trim().length < 3}>
            Start the interview
          </Button>
        </div>
      </form>
    </Page>
  );
}
