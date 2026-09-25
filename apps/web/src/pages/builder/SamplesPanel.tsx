import { BookOpen, FileText, ScanText } from "lucide-react";
import { Badge } from "../../components/Badge.tsx";
import { Dropzone } from "../../components/Dropzone.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { FileLink } from "../../components/FileLink.tsx";
import { humanize } from "../../lib/format.ts";
import type { SessionView } from "../../types.ts";
import type { SessionActions } from "./actions.ts";
import { DemoSamplesButton } from "../../components/DemoSamples.tsx";

/** Sample files the analyst analysed, plus uploads for more samples and reference documents. */
export function SamplesPanel({ view, actions }: { view: SessionView; actions: SessionActions }) {
  const samples = view.session.samples ?? [];
  const locked = view.session.status === "generating";
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Dropzone
          compact
          busy={actions.uploadSamples.isPending}
          disabled={locked}
          label="Add sample files"
          hint="Real examples become its test cases."
          onFiles={(files) => actions.uploadSamples.mutate(files)}
        />
        <DemoSamplesButton
          busy={actions.demoSamples.isPending}
          preferred={view.session.templateId?.includes("cv") ? "cv" : view.session.templateId?.includes("invoice") ? "invoice" : undefined}
          onPick={(ids) => actions.demoSamples.mutate(ids)}
        />
      </div>

      {samples.length === 0 ? (
        <EmptyState
          compact
          icon={FileText}
          title="No samples yet"
          description="Upload 3–5 real examples. I read formats, languages and content myself so you don't have to describe them."
        />
      ) : (
        <ul className="space-y-3">
          {samples.map((s) => (
            <li key={s.fileId} className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <FileLink fileId={s.fileId} name={s.fileName} className="min-w-0 text-sm font-medium" />
                {s.needsOcr && (
                  <Badge tone="amber" size="xs" icon={ScanText}>
                    Needs OCR
                  </Badge>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.documentType && s.documentType !== "unknown" && (
                  <Badge tone="brand" size="xs">
                    {humanize(s.documentType)}
                  </Badge>
                )}
                {s.pages !== undefined && (
                  <Badge size="xs">
                    {s.pages} page{s.pages === 1 ? "" : "s"}
                  </Badge>
                )}
                {s.language && <Badge size="xs">Language: {s.language.toUpperCase()}</Badge>}
                <Badge size="xs">{s.mimeType.split("/").pop()}</Badge>
              </div>
              {s.summary && <p className="mt-2 text-[13px] text-muted">{s.summary}</p>}
              {s.detectedFields && s.detectedFields.length > 0 && (
                <div className="mt-2">
                  <p className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">Detected information</p>
                  <div className="flex flex-wrap gap-1">
                    {s.detectedFields.map((f) => (
                      <Badge key={f} size="xs" tone="neutral">
                        {humanize(f)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-line bg-subtle/40 p-3.5">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <BookOpen className="size-4 text-muted" /> Reference documents
        </p>
        <p className="mt-0.5 mb-2.5 text-xs text-muted">Job descriptions, policies or price lists it should consult. They go into its knowledge base.</p>
        <Dropzone
          compact
          busy={actions.uploadReference.isPending}
          disabled={locked}
          label="Add reference documents"
          onFiles={(files) => actions.uploadReference.mutate(files)}
        />
      </div>
    </div>
  );
}
