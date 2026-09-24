import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { ReplyAnswer, SessionView, StakeholderRequest } from "../../types.ts";

/** Mutations of a builder session. Every call returns the full SessionView, which replaces the cached one. */
export function useSessionActions(sessionId: string) {
  const { company, path } = useCompany();
  const queryClient = useQueryClient();
  const toast = useToast();
  const base = path(`/builder/sessions/${encodeURIComponent(sessionId)}`);
  const sessionKey = keys.session(company, sessionId);

  const apply = (view: SessionView) => {
    queryClient.setQueryData(sessionKey, view);
    void queryClient.invalidateQueries({ queryKey: [...keys.builder(company), "list"] });
  };
  const onError = (error: unknown) => toast.error(error);

  const reply = useMutation({
    mutationFn: (body: { text?: string; answers?: ReplyAnswer[]; fileIds?: string[] }) => api.post<SessionView>(`${base}/reply`, body),
    onSuccess: apply,
    onError,
  });

  /** Free text plus attached sample files in one multipart reply. */
  const replyWithFiles = useMutation({
    mutationFn: ({ text, files }: { text: string; files: File[] }) => {
      const form = new FormData();
      if (text) form.append("text", text);
      for (const f of files) form.append("files", f, f.name);
      return api.upload<SessionView>(`${base}/reply`, form);
    },
    onSuccess: apply,
    onError,
  });

  const uploadSamples = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      return api.upload<SessionView>(`${base}/samples`, form);
    },
    onSuccess: (view, files) => {
      apply(view);
      toast.success(`Analysed ${files.length} sample${files.length === 1 ? "" : "s"}`);
    },
    onError,
  });

  const demoSamples = useMutation({
    mutationFn: (fileIds: string[]) => api.post<SessionView>(`${base}/reply`, { fileIds }),
    onSuccess: (view, ids) => {
      apply(view);
      toast.success(`Analysed ${ids.length} demo sample${ids.length === 1 ? "" : "s"}`);
    },
    onError,
  });

  const uploadReference = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      return api.upload<SessionView>(`${base}/reference`, form);
    },
    onSuccess: (view) => {
      apply(view);
      toast.success("Reference documents added to the agent's knowledge");
    },
    onError,
  });

  const proceed = useMutation({ mutationFn: () => api.post<SessionView>(`${base}/proceed`), onSuccess: apply, onError });

  const confirm = useMutation({
    mutationFn: () => api.post<SessionView>(`${base}/confirm`),
    onMutate: () => {
      // Show "generating" immediately; the server flips the status too.
      queryClient.setQueryData<SessionView>(sessionKey, (old) => (old ? { ...old, session: { ...old.session, status: "generating" } } : old));
    },
    onSuccess: (view) => {
      apply(view);
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success(view.agent ? `${view.agent.name} is built and in testing` : "Agent generated");
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      toast.error(error);
    },
  });

  const activate = useMutation({
    mutationFn: () => api.post<SessionView>(`${base}/activate`),
    onSuccess: (view) => {
      apply(view);
      void queryClient.invalidateQueries({ queryKey: keys.agents(company) });
      toast.success(`${view.agent?.name ?? "The agent"} is live`, view.agent ? { link: { to: `/apps/${view.agent.slug}`, label: "Open its app" } } : undefined);
    },
    onError,
  });

  const reopen = useMutation({
    mutationFn: (nodeId: string) => api.post<SessionView>(`${base}/reopen`, { nodeId }),
    onSuccess: (view) => {
      apply(view);
      toast.info("Reopened — the analyst will ask about it again");
    },
    onError,
  });

  const patchRequest = (row: StakeholderRequest) => {
    queryClient.setQueryData<SessionView>(sessionKey, (old) => (old ? { ...old, requests: old.requests.map((r) => (r.id === row.id ? { ...r, ...row } : r)) } : old));
  };

  const updateRequest = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<StakeholderRequest, "recipientName" | "recipientEmail" | "subject" | "body">> }) =>
      api.put<StakeholderRequest>(path(`/builder/requests/${encodeURIComponent(id)}`), patch),
    onSuccess: (row) => {
      patchRequest(row);
    },
    onError,
  });

  const sendRequest = useMutation({
    mutationFn: ({ id, via }: { id: string; via: "mail" | "manual" }) => api.post<StakeholderRequest>(path(`/builder/requests/${encodeURIComponent(id)}/send`), { via }),
    onSuccess: (row, { via }) => {
      patchRequest(row);
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      toast.success(via === "mail" ? "Request sent through the company mailbox" : "Marked as sent");
    },
    onError,
  });

  return { reply, replyWithFiles, uploadSamples, demoSamples, uploadReference, proceed, confirm, activate, reopen, updateRequest, sendRequest };
}

export type SessionActions = ReturnType<typeof useSessionActions>;
