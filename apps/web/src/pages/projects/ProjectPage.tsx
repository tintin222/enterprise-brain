import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, CircleCheck, FolderKanban, Hash, Layers, LayoutDashboard, Pencil, Trash2, WandSparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../api.ts";
import { Badge } from "../../components/Badge.tsx";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Field } from "../../components/Form.tsx";
import { Page } from "../../components/Layout.tsx";
import { ErrorState, Skeleton } from "../../components/Spinner.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { useCompany } from "../../lib/company.tsx";
import { paths } from "../../lib/paths.ts";
import { keys, useProject, useTodos } from "../../lib/queries.ts";
import { useDocumentTitle } from "../../lib/title.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ProjectStatus, ProjectView } from "../../types.ts";
import { AssetsTab } from "./AssetsTab.tsx";
import { DesignsTab } from "./DesignsTab.tsx";
import { OverviewTab } from "./OverviewTab.tsx";
import { PROJECT_STATUSES, STATUS_LABELS, STATUS_TONES } from "./shared.tsx";
import { TasksTab } from "./TasksTab.tsx";

type Tab = "overview" | "assets" | "designs" | "tasks";

function ChangeDialog({ project, open, onClose }: { project: ProjectView; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [client, setClient] = useState(project.client ?? "");
  const [summary, setSummary] = useState(project.summary);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const save = useMutation({
    mutationFn: () =>
      api.patch<ProjectView>(path(`/projects/${project.id}`), { name: name.trim(), client: client.trim() || null, summary: summary.trim(), status }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(keys.project(company, project.slug), saved);
      await queryClient.invalidateQueries({ queryKey: keys.projects(company) });
      toast.success("Saved");
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change the project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="change-project" variant="primary" loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id="change-project" onSubmit={submit} className="space-y-4">
        <Field label="Name" required>
          {(id) => <input id={id} className="input w-full" value={name} onChange={(e) => setName(e.target.value)} required />}
        </Field>
        <Field label="Client" optional>
          {(id) => <input id={id} className="input w-full" value={client} onChange={(e) => setClient(e.target.value)} />}
        </Field>
        <Field label="What it is about" optional>
          {(id) => <textarea id={id} className="input w-full" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />}
        </Field>
        <Field label="Status" hint="A finished or cancelled project's channel is archived.">
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

function RemoveDialog({ project, open, onClose }: { project: ProjectView; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.del(path(`/projects/${project.id}`)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.projects(company) });
      toast.success("Project removed", { description: "Its designs stay in the Studio; the brain keeps what it knew." });
      navigate(paths.projects());
    },
    onError: (error) => toast.error(error),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Remove this project?"
      description="Its list of assets goes; its Studio conversations, interviews and AI employees stay; its channel is archived; the brain keeps the project and notes what happened."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" icon={Trash2} loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        </>
      }
    />
  );
}

/** One project: its details, what it uses, its designs, the person's tasks for it, and the development package. */
export default function ProjectPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab | null) ?? "overview";
  const project = useProject(slug);
  const todos = useTodos("open", { projectId: project.data?.id, enabled: Boolean(project.data) });
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  useDocumentTitle(project.data?.name ?? "Project");
  const setTab = (next: Tab) => {
    const search = new URLSearchParams(params);
    if (next === "overview") search.delete("tab");
    else search.set("tab", next);
    setParams(search, { replace: true });
  };
  if (project.error) {
    return (
      <Page>
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      </Page>
    );
  }
  const data = project.data;
  if (!data) {
    return (
      <Page>
        <Skeleton className="h-24" />
      </Page>
    );
  }
  const meta = [data.client ? `For ${data.client}` : null, data.owner ? `Owner ${data.owner.name}` : null].filter(Boolean).join(" · ");
  return (
    <Page>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300">
            <FolderKanban className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted">Project</p>
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight text-fg sm:text-2xl">
              <span>{data.name}</span>
              <Badge tone={STATUS_TONES[data.status]}>{STATUS_LABELS[data.status]}</Badge>
            </h1>
            {meta && <p className="mt-0.5 text-sm text-muted">{meta}</p>}
            {data.summary && <p className="mt-1 max-w-3xl text-sm whitespace-pre-line text-muted">{data.summary}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:pl-14">
          {data.channel && (
            <ButtonLink to={paths.conversation(data.channel.id)} icon={Hash} size="sm" title="The project's channel in Chat">
              {data.channel.name ?? "Channel"}
            </ButtonLink>
          )}
          {data.thingId && (
            <ButtonLink to={paths.brain.thing(data.thingId)} icon={Brain} size="sm" title="What the company brain knows about it">
              In the brain
            </ButtonLink>
          )}
          {data.canEdit && (
            <>
              <Button icon={Pencil} size="sm" variant="primary" onClick={() => setChanging(true)}>
                Change
              </Button>
              <Button icon={Trash2} size="sm" variant="ghost" onClick={() => setRemoving(true)} aria-label="Remove" />
            </>
          )}
        </div>
      </div>
      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard },
          { id: "assets", label: "Assets", icon: Layers, count: data.counts.assets || undefined },
          { id: "designs", label: "Designs", icon: WandSparkles, count: data.counts.designs || undefined },
          { id: "tasks", label: "Tasks", icon: CircleCheck, count: todos.data?.length || undefined, alert: Boolean(todos.data?.length) },
        ]}
      />
      {tab === "overview" && <OverviewTab project={data} onTab={setTab} />}
      {tab === "assets" && <AssetsTab project={data} />}
      {tab === "designs" && <DesignsTab project={data} />}
      {tab === "tasks" && <TasksTab project={data} />}
      {changing && <ChangeDialog project={data} open onClose={() => setChanging(false)} />}
      <RemoveDialog project={data} open={removing} onClose={() => setRemoving(false)} />
    </Page>
  );
}
