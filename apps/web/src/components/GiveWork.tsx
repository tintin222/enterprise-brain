import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { keys } from "../lib/queries.ts";
import { useToast } from "../lib/toast.tsx";
import type { TaskRow } from "../types.ts";

/**
 * Give an AI employee work in plain words: it becomes a task it follows until it is done. Without
 * `agent`, it goes to the AI employee the words name with "@"; files go along with it.
 */
export function useGiveWork(onDone?: (task: TaskRow) => void, options: { quiet?: boolean } = {}) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { agent?: string; text: string; fileIds?: string[] }) => api.post<{ task: TaskRow }>(path("/tasks"), input),
    onSuccess: ({ task }) => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks(company) });
      void queryClient.invalidateQueries({ queryKey: keys.home(company) });
      toast.success(`Given as ${task.ref}`, { description: task.title, link: { to: `/work/${task.ref}`, label: "Follow it" } });
      onDone?.(task);
    },
    // `quiet`: the caller shows the error itself (the composer keeps the words and says what went wrong).
    onError: (error) => {
      if (!options.quiet) toast.error(error);
    },
  });
}
