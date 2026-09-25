import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { AgentDefinition, AgentRow, AgentStatus } from "../../types.ts";

export function useAgentMutations() {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
    void queryClient.invalidateQueries({ queryKey: keys.home(company) });
    void queryClient.invalidateQueries({ queryKey: keys.dashboard(company) });
    void queryClient.invalidateQueries({ queryKey: keys.departments(company) });
  };

  const setStatus = useMutation({
    mutationFn: ({ slug, status }: { slug: string; status: AgentStatus }) => api.post<AgentRow>(path(`/agents/${encodeURIComponent(slug)}/status`), { status }),
    onSuccess: (row) => {
      invalidate();
      toast.success(
        row.status === "active"
          ? `${row.name} is at work`
          : row.status === "paused"
            ? `${row.name} is paused: its duties wait until you put it back to work`
            : `${row.name} is now ${row.status}`,
      );
    },
    onError: (error) => toast.error(error),
  });

  const save = useMutation({
    mutationFn: ({ slug, definition, note }: { slug: string; definition: AgentDefinition; note?: string }) =>
      api.put<{ agent: AgentRow; definition: AgentDefinition }>(path(`/agents/${encodeURIComponent(slug)}`), { definition, note }),
    onSuccess: (res) => {
      invalidate();
      toast.success(`Saved as version ${res.agent.version}`);
    },
    onError: (error) => toast.error(error),
  });

  const rollback = useMutation({
    mutationFn: ({ slug, version }: { slug: string; version: number }) =>
      api.post<{ agent: AgentRow; definition: AgentDefinition }>(path(`/agents/${encodeURIComponent(slug)}/rollback`), { version }),
    onSuccess: (res, vars) => {
      invalidate();
      toast.success(`Rolled back to version ${vars.version}`, { description: `Now at version ${res.agent.version}.` });
    },
    onError: (error) => toast.error(error),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api.del<{ ok: boolean }>(path(`/agents/${encodeURIComponent(slug)}`)),
    onSuccess: () => {
      invalidate();
      toast.success("Let go");
    },
    onError: (error) => toast.error(error),
  });

  return { setStatus, save, rollback, remove };
}
