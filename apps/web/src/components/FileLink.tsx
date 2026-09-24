import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Download, FileText } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { api, downloadWithAuth, fileUrl, getApiKey } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatBytes } from "../lib/format.ts";
import { useToast } from "../lib/toast.tsx";
import type { StoredFile } from "../types.ts";

/**
 * Link to a stored file (/api/companies/:company/files/:id). Plain href in local
 * trusted mode; with an API key the download goes through fetch so the
 * Authorization header is sent.
 */
export function FileLink({
  fileId,
  name,
  inline,
  className,
  children,
  icon = true,
}: {
  fileId: string;
  name?: string;
  inline?: boolean;
  className?: string;
  children?: ReactNode;
  icon?: boolean;
}) {
  const { company } = useCompany();
  const toast = useToast();
  const href = fileUrl(company, fileId, inline);
  const onClick = (e: MouseEvent) => {
    if (!getApiKey()) return;
    e.preventDefault();
    downloadWithAuth(fileUrl(company, fileId), name ?? fileId).catch((error) => toast.error(error));
  };
  return (
    <a
      href={href}
      onClick={onClick}
      target={inline ? "_blank" : undefined}
      rel="noopener noreferrer"
      className={clsx("inline-flex max-w-full items-center gap-1.5 text-brand-600 hover:underline dark:text-brand-300", className)}
    >
      {icon && (inline ? <FileText className="size-3.5 shrink-0" /> : <Download className="size-3.5 shrink-0" />)}
      <span className="truncate">{children ?? name ?? "Download"}</span>
    </a>
  );
}

/** Link to a file known only by id: its name is looked up from /files/:id/meta. */
export function FileIdLink({ fileId, className }: { fileId: string; className?: string }) {
  const { company, path } = useCompany();
  const meta = useQuery({
    queryKey: [company, "files", "meta", fileId],
    queryFn: () => api.get<StoredFile>(path(`/files/${encodeURIComponent(fileId)}/meta`)),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <span className="inline-flex items-center gap-2">
      <FileLink fileId={fileId} name={meta.data?.name ?? (meta.isError ? "File (unavailable)" : "File")} className={className} />
      {meta.data && <span className="text-xs text-faint">{formatBytes(meta.data.size)}</span>}
    </span>
  );
}
