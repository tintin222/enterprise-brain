import { useMutation } from "@tanstack/react-query";
import { ArrowRight, WandSparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { PageHeader } from "../../components/Card.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState } from "../../components/Spinner.tsx";
import { useViewer } from "../../lib/auth.tsx";
import { useCompany } from "../../lib/company.tsx";
import { paths } from "../../lib/paths.ts";
import { useDepartments } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import type { StudioThreadView } from "../../types.ts";

/** Tell the Studio what you need: it looks around, asks what only you can say, builds and tries it. */
export function StudioStart() {
  const { path } = useCompany();
  const navigate = useNavigate();
  const viewer = useViewer();
  const departments = useDepartments();
  const [text, setText] = useState("");
  const hiresFor = (departments.data ?? []).filter((d) => !viewer || viewer.isAdmin || viewer.departments.some((m) => m.id === d.id && m.role === "manager"));
  const [department, setDepartment] = useState("");
  const chosen = department || (hiresFor.length === 1 ? hiresFor[0]!.id : "");
  const start = useMutation({
    mutationFn: () => api.post<StudioThreadView>(path("/studio/threads"), { text: text.trim(), departmentId: chosen || null }),
    onSuccess: (view) => navigate(paths.studioConversation(view.id)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) start.mutate();
  };
  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-surface p-5 shadow-xs sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 text-white shadow-sm">
          <WandSparkles className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">Tell the Studio what you need</h2>
          <p className="mt-0.5 text-sm text-muted">
            In your own words: where the work comes from, what should happen with it, who is involved. The Studio looks at your mailboxes and systems, asks what
            only you can say, builds the AI employees, tables and screens, and tries them on real examples before anything goes to work.
          </p>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        autoFocus
        placeholder="e.g. Supplier complaints come to quality@. I want each one handled: logged, the supplier asked for an 8D report, and followed up until it's closed."
        aria-label="What you need"
        className="input mt-4 w-full resize-y"
      />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {hiresFor.length > 1 && (
          <select className="input h-9 w-auto py-1.5" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="For which department">
            <option value="">For which department?</option>
            {hiresFor.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" variant="primary" icon={ArrowRight} loading={start.isPending} disabled={!text.trim()}>
          Start
        </Button>
      </div>
      {start.error && <ErrorState error={start.error} className="mt-3" />}
    </form>
  );
}

/** A new conversation with the Studio agent. */
export default function StudioStartPage() {
  useDocumentTitle("Tell the Studio");
  return (
    <Page className="max-w-4xl">
      <PageHeader
        icon={WandSparkles}
        title="The Studio agent"
        description="It builds a whole solution in one conversation: AI employees, their tables and screens, tried on your real examples."
      />
      <StudioStart />
    </Page>
  );
}
