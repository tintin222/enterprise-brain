import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, Info, LogIn, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { api, isApiError } from "../api.ts";
import { Button, ButtonLink } from "../components/Button.tsx";
import { buildRunForm, FieldForm, missingRequired, type FieldValue, type FormValues } from "../components/FieldForm.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { PublicMessage, PublicShell } from "../components/PublicShell.tsx";
import { Callout, ErrorState, LoadingBlock } from "../components/Spinner.tsx";
import { useDocumentTitle } from "../lib/title.ts";
import type { FieldSpec } from "../types.ts";

/** What the form's link shows. */
interface PublicForm {
  company: { name: string };
  agent: { name: string };
  title: string;
  intro: string;
  fields: FieldSpec[];
  submitLabel: string;
  signIn: boolean;
  viewer: { name: string; email: string | null } | null;
  /** The field people never see (bots fill it in). */
  honeypot: string;
}

interface Sent {
  ok: boolean;
  taskRef: string | null;
  thanks: string;
}

/**
 * An AI employee's public form: anyone with the link fills it in (or the company's people, signed in,
 * when it asks), files included; sending it starts the work, and the page gives back its reference.
 */
export default function PublicFormPage() {
  const { token = "" } = useParams();
  const form = useQuery({
    queryKey: ["public-form", token],
    queryFn: () => api.get<PublicForm>(`/api/public/forms/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [values, setValues] = useState<FormValues>({});
  const [email, setEmail] = useState("");
  const [trap, setTrap] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const data = form.data;
  useDocumentTitle(data?.title ?? "Form");

  const send = useMutation({
    mutationFn: async () => {
      const body = await buildRunForm(data!.fields, values, async () => {
        throw new Error("Choose the files again");
      });
      if (email.trim()) body.append("email", email.trim());
      if (trap) body.append(data!.honeypot, trap);
      return api.upload<Sent>(`/api/public/forms/${encodeURIComponent(token)}`, body);
    },
  });

  if (form.isLoading) {
    return (
      <PublicShell note="Form">
        <LoadingBlock />
      </PublicShell>
    );
  }
  if (form.error || !data) {
    return (
      <PublicShell note="Form">
        {isApiError(form.error, 404) ? (
          <PublicMessage
            icon={Info}
            tone="amber"
            title="This form is not open"
            body="The link may be old, or the form was closed. Ask whoever sent it to you."
          />
        ) : (
          <ErrorState error={form.error} onRetry={() => void form.refetch()} />
        )}
      </PublicShell>
    );
  }

  if (send.isSuccess) {
    return (
      <PublicShell company={data.company.name} note="Form">
        <PublicMessage
          icon={CircleCheck}
          tone="green"
          title={send.data.thanks}
          body={
            send.data.taskRef ? (
              <>
                Your reference is <span className="font-mono font-semibold text-fg">{send.data.taskRef}</span>: mention it when you write about this request.
              </>
            ) : (
              "You can close this page."
            )
          }
        />
      </PublicShell>
    );
  }

  const needsSignIn = data.signIn && !data.viewer;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const miss = missingRequired(data.fields, values);
    setMissing(miss);
    if (!miss.length) send.mutate();
  };
  const setValue = (key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setMissing([]);
  };

  return (
    <PublicShell company={data.company.name} note={data.viewer ? `Signed in as ${data.viewer.name}` : "Form"}>
      <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-8">
        <p className="text-xs font-medium tracking-wide text-brand-600 uppercase dark:text-brand-300">{data.agent.name}</p>
        <h1 className="mt-1 text-xl font-semibold text-fg sm:text-2xl">{data.title}</h1>
        {data.intro && (
          <Markdown compact className="mt-2 text-sm text-muted">
            {data.intro}
          </Markdown>
        )}
        {needsSignIn ? (
          <Callout
            tone="info"
            icon={LogIn}
            className="mt-6"
            title="Sign in to send this form"
            actions={
              <ButtonLink size="sm" variant="primary" to={`/signin?returnTo=${encodeURIComponent(`/f/${token}`)}`}>
                Sign in
              </ButtonLink>
            }
          >
            It is for the people of {data.company.name}.
          </Callout>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-5">
            <FieldForm fields={data.fields} values={values} onChange={setValue} disabled={send.isPending} />
            {!data.viewer && (
              <div>
                <label htmlFor="form-email" className="label">
                  Your email <span className="font-normal text-muted">(optional, to hear back)</span>
                </label>
                <input id="form-email" type="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            )}
            {/* People never see this field; bots fill it in. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="form-website">Website</label>
              <input id="form-website" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
            </div>
            {missing.length > 0 && <p className="text-sm text-red-600 dark:text-red-400">Please fill in: {missing.join(", ")}</p>}
            {send.error && <ErrorState error={send.error} />}
            <div className="border-t border-line pt-4">
              <Button type="submit" variant="primary" icon={Send} loading={send.isPending}>
                {data.submitLabel}
              </Button>
            </div>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
