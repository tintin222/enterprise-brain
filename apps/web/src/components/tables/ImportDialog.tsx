import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useCompany } from "../../lib/company.tsx";
import { plural } from "../../lib/format.ts";
import { keys } from "../../lib/queries.ts";
import { useToast } from "../../lib/toast.tsx";
import type { TableImport, TableView } from "../../types.ts";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Dropzone } from "../Dropzone.tsx";
import { Callout, ErrorState } from "../Spinner.tsx";

/** Bring records in from an Excel or CSV file: first what would be added and each row's problems, then add. */
export function ImportDialog({ table, open, onClose }: { table: TableView; open: boolean; onClose: () => void }) {
  const { company, path } = useCompany();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<TableImport | null>(null);
  useEffect(() => {
    if (open) setChecked(null);
  }, [open]);
  const check = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.upload<TableImport>(path(`/tables/${encodeURIComponent(table.key)}/import`), form);
    },
    onSuccess: setChecked,
  });
  const add = useMutation({
    mutationFn: () => api.post<TableImport>(path(`/tables/${encodeURIComponent(table.key)}/import`), { fileId: checked!.fileId }),
    onSuccess: async (done) => {
      toast.success(`${plural(done.added, "record")} added to ${table.name}`);
      await queryClient.invalidateQueries({ queryKey: keys.table(company, table.key) });
      await queryClient.invalidateQueries({ queryKey: keys.tables(company) });
      onClose();
    },
  });
  const labels = new Map(table.fields.map((f) => [f.key, f.label]));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Bring records into ${table.name}`}
      description="From an Excel or CSV file whose first row names the columns. Nothing is added until you say so."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {checked && (
            <Button variant="primary" icon={FileUp} loading={add.isPending} disabled={!checked.ready} onClick={() => add.mutate()}>
              Add {plural(checked.ready, "record")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Dropzone
          accept={[".xlsx", ".csv", ".tsv"]}
          multiple={false}
          busy={check.isPending}
          label={checked ? `Checked ${checked.fileName}: choose another file` : "Choose an Excel or CSV file"}
          hint="Columns go to the fields of the same name"
          compact={Boolean(checked)}
          onFiles={(files) => files[0] && check.mutate(files[0])}
        />
        {check.error && <ErrorState error={check.error} />}
        {checked && (
          <>
            <Callout tone={checked.ready ? "success" : "warning"} title={`${plural(checked.ready, "row")} of ${checked.rows} can be added`}>
              <p>
                Columns:{" "}
                {Object.entries(checked.columns)
                  .map(([column, key]) => (column === labels.get(key) ? column : `${column} → ${labels.get(key) ?? key}`))
                  .join(", ") || "none match the table's fields"}
                .
              </p>
              {checked.ignored.length > 0 && <p className="mt-1">Left out (no field of that name): {checked.ignored.join(", ")}.</p>}
            </Callout>
            {checked.problems.length > 0 && (
              <div>
                <p className="label">{plural(checked.problems.length, "row")} won't be added</p>
                <ul className="max-h-60 space-y-1 overflow-y-auto rounded-xl border border-line p-3 text-sm">
                  {checked.problems.map((p) => (
                    <li key={p.row}>
                      <span className="font-medium text-fg">Row {p.row}:</span> <span className="text-muted">{p.problems.join("; ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {add.error && <ErrorState error={add.error} />}
      </div>
    </Dialog>
  );
}
