import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Card, PageHeader } from "../../components/Card.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { Segmented } from "../../components/Tabs.tsx";
import { useCompany } from "../../lib/company.tsx";
import { plural, timeAgo } from "../../lib/format.ts";
import { paths } from "../../lib/paths.ts";
import { keys, useProjects } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ProjectStatus, ProjectSummary, ProjectView } from "../../types.ts";
import { PROJECT_STATUSES, STATUS_LABELS, STATUS_TONES } from "./shared.tsx";

/** Starts a project: its name, who it is for, a line about it. */
export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const create = useMutation({
    mutationFn: () => api.post<ProjectView>(path("/projects"), { name: name.trim(), client: client.trim() || null, summary: summary.trim(), status }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: keys.projects(company) });
      toast.success("Project started", { description: `${project.name}: its channel #${project.channel?.name ?? project.slug} is ready.` });
      onClose();
      navigate(paths.project(project.slug));
    },
    onError: (error) => toast.error(error),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="A project gathers what you design for a client: the AI employees, what they use from the brain, your tasks, and the development package."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="new-project" variant="primary" icon={Plus} loading={create.isPending} disabled={!name.trim()}>
            Start the project
          </Button>
        </>
      }
    >
      <form id="new-project" onSubmit={submit} className="space-y-4">
        <Field label="Name" required>
          {(id) => (
            <input
              id={id}
              className="input w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Petrokim supplier portal agents"
              autoFocus
              required
            />
          )}
        </Field>
        <Field label="Client" optional hint="A client the brain knows is linked to the project.">
          {(id) => <input id={id} className="input w-full" value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Petrokim" />}
        </Field>
        <Field label="What it is about" optional>
          {(id) => (
            <textarea
              id={id}
              className="input w-full"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One or two sentences."
            />
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <select id={id} className="input w-full" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const bits = [
    project.client ? `for ${project.client}` : null,
    plural(project.counts.assets, "asset"),
    plural(project.counts.designs, "design"),
    project.counts.openTodos ? `${project.counts.openTodos} open task${project.counts.openTodos === 1 ? "" : "s"} for you` : null,
  ].filter(Boolean);
  return (
    <li>
      <Link to={paths.project(project.slug)} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-subtle/60">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
          <FolderKanban className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{project.name}</span>
            <Badge tone={STATUS_TONES[project.status]} size="xs">
              {STATUS_LABELS[project.status]}
            </Badge>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted">{bits.join(" · ")}</span>
        </span>
        <span className="hidden shrink-0 text-xs text-faint sm:block">{timeAgo(project.updatedAt)}</span>
      </Link>
    </li>
  );
}

/** Projects: client work and the AI employees designed for it. */
export default function Projects() {
  useDocumentTitle("Projects");
  const [scope, setScope] = useState<"open" | "all">("open");
  const projects = useProjects({ status: scope });
  const [starting, setStarting] = useState(false);
  const list = projects.data ?? [];
  return (
    <Page>
      <PageHeader
        icon={FolderKanban}
        title="Projects"
        description="Each project gathers what you design for a client: the AI employees, what they use from the company brain, your tasks, and the development package Claude Code builds from."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setStarting(true)}>
            New project
          </Button>
        }
      />
      <div className="mb-4">
        <Segmented<"open" | "all">
          value={scope}
          onChange={setScope}
          options={[
            { value: "open", label: "In progress" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {projects.error && <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />}
      {projects.isLoading && <Skeleton className="h-40" />}
      {projects.data && list.length === 0 && (
        <EmptyState
          icon={FolderKanban}
          title={scope === "open" ? "No project in progress" : "No projects yet"}
          description="Start one for a client or for your own work. The Studio designs inside it, and the development package comes out of it."
          action={
            <Button variant="primary" icon={Plus} onClick={() => setStarting(true)}>
              New project
            </Button>
          }
        />
      )}
      {list.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </ul>
        </Card>
      )}
      <NewProjectDialog open={starting} onClose={() => setStarting(false)} />
    </Page>
  );
}
