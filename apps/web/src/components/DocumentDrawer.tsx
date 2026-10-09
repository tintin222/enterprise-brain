import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import { useCompany } from "../lib/company.tsx";
import { formatDateTime } from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import type { KnowledgeDocumentDetail } from "../types.ts";
import { Drawer } from "./Dialog.tsx";
import { FileLink } from "./FileLink.tsx";
import { ErrorState, Skeleton } from "./Spinner.tsx";

/** A document of the knowledge base, to read: its original file and its text, part by part. */
export function DocumentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { company, path } = useCompany();
  const doc = useQuery({
    queryKey: [...keys.knowledge(company), "document", id],
    queryFn: () => api.get<KnowledgeDocumentDetail>(path(`/knowledge/documents/${encodeURIComponent(id ?? "")}`)),
    enabled: Boolean(id),
  });
  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      width="lg"
      title={doc.data?.title ?? "Document"}
      description={doc.data ? `${doc.data.chunkCount} chunks · ${doc.data.source} · added ${formatDateTime(doc.data.createdAt)}` : undefined}
    >
      {doc.isLoading && <Skeleton className="h-40" />}
      {doc.error && <ErrorState error={doc.error} />}
      {doc.data && (
        <div className="space-y-3">
          {doc.data.fileId && <FileLink fileId={doc.data.fileId} name="Download the original file" className="text-sm" />}
          {doc.data.chunks.map((c) => (
            <div key={c.id} className="rounded-lg border border-line p-3">
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">Chunk {c.ordinal + 1}</p>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{c.content}</p>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
