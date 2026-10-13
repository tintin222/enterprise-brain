import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FolderKanban, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { paths } from "../lib/paths.ts";
import { keys, useProjects } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { ProjectAsset, ProjectAssetKind } from "../types.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

/** Puts a thing of the brain (or a table, an app…) into a project; shows where it already is. */
export function AddToProjectDialog({
  asset,
  open,
  onClose,
}: {
  asset: { kind: ProjectAssetKind; ref: string; name: string };
  open: boolean;
  onClose: () => void;
}) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const projects = useProjects({ status: "open", enabled: open });
  const holding = useProjects({ holding: `${asset.kind}:${asset.ref}`, enabled: open });
  const [busy, setBusy] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (projectId: string) => api.post<ProjectAsset>(path(`/projects/${projectId}/assets`), { kind: asset.kind, ref: asset.ref }),
    onSuccess: async (_added, projectId) => {
      const project = projects.data?.find((p) => p.id === projectId);
      toast.success(`Added to ${project?.name ?? "the project"}`);
      await queryClient.invalidateQueries({ queryKey: keys.projects(company) });
      if (project) await queryClient.invalidateQueries({ queryKey: keys.project(company, project.id) });
    },
    onError: (error) => toast.error(error),
    onSettled: () => setBusy(null),
  });
  const held = new Set((holding.data ?? []).map((p) => p.id));
  const list = projects.data ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to a project"
      description={`${asset.name} goes into the project's assets and into its development package.`}
      size="sm"
    >
      {projects.isLoading ? (
        <p className="text-sm text-muted">Looking…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">
          No project in progress.{" "}
          <Link to={paths.projects()} className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={onClose}>
            Start one
          </Link>
          .
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((project) => {
            const already = held.has(project.id);
            return (
              <li key={project.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FolderKanban className="size-4 shrink-0 text-muted" />
                  <Link to={paths.project(project.slug, "assets")} className="truncate font-medium text-fg hover:underline" onClick={onClose}>
                    {project.name}
                  </Link>
                </span>
                {already ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                    <Check className="size-3.5" /> In it
                  </span>
                ) : (
                  <Button
                    size="xs"
                    icon={Plus}
                    loading={busy === project.id}
                    onClick={() => {
                      setBusy(project.id);
                      add.mutate(project.id);
                    }}
                  >
                    Add
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
