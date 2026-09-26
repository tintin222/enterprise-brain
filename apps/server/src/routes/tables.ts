import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { changeTable, proposeTable } from "@enterprise-brain/builder";
import { TableField, TableSettings } from "@enterprise-brain/core";
import { readSheets, writeWorkbook } from "@enterprise-brain/documents";
import type { TableView } from "@enterprise-brain/runtime";
import { actorOf, canManageDepartment, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart } from "../http.ts";

/** Who sees a table: its department's people, or everyone when it is shared with the company. */
export function canSeeTable(viewer: Viewer, table: Pick<TableView, "departmentId" | "settings">): boolean {
  return table.settings.visibility === "company" || canSeeDepartment(viewer, table.departmentId);
}

/** Who adds and changes records: its department's people (or only its managers); everyone for company tables. */
export function canEditRecords(viewer: Viewer, table: Pick<TableView, "departmentId" | "settings">): boolean {
  if (viewer.isAdmin) return true;
  if (table.settings.editors === "managers") return canManageDepartment(viewer, table.departmentId);
  if (!table.departmentId) return viewer.kind === "session";
  return viewer.departments.some((d) => d.departmentId === table.departmentId);
}

/** Who changes a table's design and settings: its department's managers; admins for company tables. */
export function canDesignTable(viewer: Viewer, table: Pick<TableView, "departmentId">): boolean {
  return canManageDepartment(viewer, table.departmentId);
}

const Design = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  fields: z.array(TableField).min(1).max(60),
  titleField: z.string().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  settings: TableSettings.partial().optional(),
  /** Choice values renamed in every record: { field key: { old value: new value } }. */
  renames: z.record(z.string(), z.record(z.string(), z.string().min(1).max(80))).optional(),
});

/**
 * Tables: business data people describe in plain words. The Studio proposes a design from a
 * description; people see, add and change records by their department; every change is kept.
 */
export async function tableRoutes(app: FastifyInstance, ctx: AppContext) {
  const { platform } = ctx;

  const tableFor = async (request: FastifyRequest, companyId: string, ref: string) => {
    const table = await platform.tables.get(companyId, ref).catch(() => undefined);
    if (!table || !canSeeTable(viewerOf(request), table)) throw new HttpError(404, `There is no table "${ref}"`);
    return table;
  };
  const withRights = (viewer: Viewer, table: TableView) => ({ ...table, can: { edit: canEditRecords(viewer, table), design: canDesignTable(viewer, table) } });
  const editable = async (request: FastifyRequest, companyId: string, ref: string) => {
    const table = await tableFor(request, companyId, ref);
    if (!canEditRecords(viewerOf(request), table)) {
      throw new HttpError(
        403,
        table.settings.editors === "managers" ? `Only managers change ${table.name}` : `Only its department's people change ${table.name}`,
      );
    }
    return table;
  };
  const designable = async (request: FastifyRequest, companyId: string, ref: string) => {
    const table = await tableFor(request, companyId, ref);
    if (!canDesignTable(viewerOf(request), table)) throw new HttpError(403, `Only a manager of its department changes ${table.name}`);
    return table;
  };
  /** A table for a department needs a manager of it; a company-wide one an admin. */
  const assertMayCreate = (viewer: Viewer, departmentId: string | null | undefined) => {
    if (!canManageDepartment(viewer, departmentId)) {
      throw new HttpError(
        403,
        departmentId ? "Only a manager of this department makes its tables" : "Only an admin makes company-wide tables; choose a department",
      );
    }
  };

  app.get("/api/companies/:company/tables", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { archived } = z.object({ archived: z.enum(["true", "false"]).optional() }).parse(request.query ?? {});
    const tables = await platform.tables.list(company.id, { archived: archived === "true" });
    return tables.filter((t) => canSeeTable(viewer, t)).map((t) => withRights(viewer, t));
  });

  /** The Studio's proposal for a table from a description (nothing is made yet). */
  app.post("/api/companies/:company/tables/propose", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = z.object({ description: z.string().trim().min(3).max(4000) }).parse(request.body);
    const existing = (await platform.tables.list(company.id)).filter((t) => canSeeTable(viewer, t));
    return proposeTable(platform.llm, { description: body.description, existing: existing.map((t) => ({ key: t.key, name: t.name })) });
  });

  app.post("/api/companies/:company/tables", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const body = Design.parse(request.body);
    assertMayCreate(viewer, body.departmentId);
    const table = await platform.tables.create(company.id, body, actorOf(viewer));
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "table.created",
      entityType: "table",
      entityId: table.id,
      summary: `Made the table ${table.name}`,
    });
    return withRights(viewer, table);
  });

  app.get("/api/companies/:company/tables/:table", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    return withRights(viewerOf(request), await tableFor(request, company.id, ref));
  });

  app.patch("/api/companies/:company/tables/:table", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { table: ref } = request.params as { table: string };
    const body = Design.partial().parse(request.body);
    const table = await designable(request, company.id, ref);
    if (body.departmentId !== undefined && body.departmentId !== table.departmentId) assertMayCreate(viewer, body.departmentId);
    const changed = await platform.tables.change(company.id, table.id, body);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "table.changed",
      entityType: "table",
      entityId: table.id,
      summary: `Changed the table ${changed.name}`,
      data: { changed: Object.keys(body) },
    });
    return withRights(viewer, changed);
  });

  /** A change said in plain words: the table as it would be, what changes, and the records that wouldn't fit (nothing changes yet). */
  app.post("/api/companies/:company/tables/:table/changes", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { table: ref } = request.params as { table: string };
    const body = z.object({ request: z.string().trim().min(3).max(2000) }).parse(request.body);
    const table = await designable(request, company.id, ref);
    const existing = (await platform.tables.list(company.id)).filter((t) => canSeeTable(viewer, t) && t.key !== table.key);
    const change = await changeTable(platform.llm, {
      design: { key: table.key, name: table.name, description: table.description, fields: table.fields, titleField: table.titleField },
      request: body.request,
      existing: existing.map((t) => ({ key: t.key, name: t.name })),
    });
    const problems = await platform.tables.checkChange(company.id, table.id, { fields: change.design.fields, renames: change.renames });
    return { ...change, problems };
  });

  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post(`/api/companies/:company/tables/:table/${path}`, async (request) => {
      const company = await companyOf(platform, request);
      const viewer = viewerOf(request);
      const { table: ref } = request.params as { table: string };
      const table = await designable(request, company.id, ref);
      const done = await platform.tables.archive(company.id, table.id, archived);
      await platform.activity.record(company.id, {
        actor: actorOf(viewer),
        action: archived ? "table.archived" : "table.restored",
        entityType: "table",
        entityId: table.id,
        summary: `${archived ? "Archived" : "Brought back"} the table ${table.name}`,
      });
      return withRights(viewer, done);
    });
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /** Records: ?search=…&sort=<field>&direction=asc&limit=&offset=&archived=true, and filter.<field>=<value>. */
  app.get("/api/companies/:company/tables/:table/records", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    const table = await tableFor(request, company.id, ref);
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = z
      .object({
        search: z.string().max(200).optional(),
        sort: z.string().max(60).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        archived: z.enum(["true", "false"]).optional(),
      })
      .parse(raw);
    const where = Object.fromEntries(
      Object.entries(raw)
        .filter(([key, value]) => key.startsWith("filter.") && value)
        .map(([key, value]) => [key.slice("filter.".length), value]),
    );
    const found = await platform.tables.records(company.id, table.id, { ...query, archived: query.archived === "true", where });
    return { ...found, table: withRights(viewerOf(request), found.table) };
  });

  /** Records counted (or a number added up or averaged), by a field: ?groupBy=&of=count|sum|average&field=&limit=&filter.<field>= */
  app.get("/api/companies/:company/tables/:table/summary", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    const table = await tableFor(request, company.id, ref);
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = z
      .object({
        groupBy: z.string().max(60).optional(),
        of: z.enum(["count", "sum", "average"]).optional(),
        field: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(2).max(50).optional(),
      })
      .parse(raw);
    const where = Object.fromEntries(
      Object.entries(raw)
        .filter(([key, value]) => key.startsWith("filter.") && value)
        .map(([key, value]) => [key.slice("filter.".length), value]),
    );
    return platform.tables.summarize(company.id, table.id, {
      ...(query.groupBy ? { groupBy: query.groupBy } : {}),
      measure: { of: query.of ?? "count", ...(query.field ? { field: query.field } : {}) },
      where,
      ...(query.limit ? { limit: query.limit } : {}),
    });
  });

  app.post("/api/companies/:company/tables/:table/records", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    const table = await editable(request, company.id, ref);
    const body = z.object({ values: z.record(z.string(), z.unknown()) }).parse(request.body);
    return platform.tables.add(company.id, table.id, body.values, { actor: actorOf(viewerOf(request)) });
  });

  /** A record with its history. */
  app.get("/api/companies/:company/tables/:table/records/:record", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref, record } = request.params as { table: string; record: string };
    const table = await tableFor(request, company.id, ref);
    return {
      record: await platform.tables.record(company.id, table.id, record),
      history: await platform.tables.history(company.id, table.id, record),
    };
  });

  app.patch("/api/companies/:company/tables/:table/records/:record", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref, record } = request.params as { table: string; record: string };
    const table = await editable(request, company.id, ref);
    const body = z.object({ values: z.record(z.string(), z.unknown()) }).parse(request.body);
    return platform.tables.update(company.id, table.id, record, body.values, { actor: actorOf(viewerOf(request)) });
  });

  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post(`/api/companies/:company/tables/:table/records/:record/${path}`, async (request) => {
      const company = await companyOf(platform, request);
      const { table: ref, record } = request.params as { table: string; record: string };
      const table = await editable(request, company.id, ref);
      return platform.tables.archiveRecord(company.id, table.id, record, { actor: actorOf(viewerOf(request)) }, archived);
    });
  }

  /**
   * Records from a sheet (Excel or CSV): multipart with the file checks it (nothing is added) and
   * returns its fileId; JSON { fileId } then adds its rows.
   */
  app.post("/api/companies/:company/tables/:table/import", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { table: ref } = request.params as { table: string };
    const table = await editable(request, company.id, ref);
    let fileId: string;
    let dryRun = true;
    if (request.isMultipart()) {
      const { files } = await readMultipart(platform, company.id, request, "table-import");
      if (!files[0]) throw new HttpError(400, "Choose an Excel or CSV file");
      fileId = files[0].id;
    } else {
      const body = z.object({ fileId: z.string().uuid(), dryRun: z.boolean().optional() }).parse(request.body);
      fileId = body.fileId;
      dryRun = body.dryRun ?? false;
    }
    const file = await platform.files.get(company.id, fileId);
    const sheets = await readSheets({ data: file.data, fileName: file.name, mimeType: file.mimeType }).catch((error: unknown) => {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    });
    const sheet = sheets.find((s) => s.rows.length) ?? sheets[0];
    if (!sheet) throw new HttpError(400, `${file.name} has no rows`);
    const result = await platform.tables.importRows(company.id, table.id, sheet.rows, { actor: actorOf(viewer) }, { dryRun, rowNumbers: sheet.rowNumbers });
    if (!dryRun && result.added) {
      await platform.activity.record(company.id, {
        actor: actorOf(viewer),
        action: "table.imported",
        entityType: "table",
        entityId: table.id,
        summary: `Added ${result.added} record${result.added === 1 ? "" : "s"} to ${table.name} from ${file.name}`,
      });
    }
    return { ...result, fileId, fileName: file.name, sheet: sheet.name, rows: sheet.rows.length };
  });

  /** The records as an Excel file, with the columns people read (links and people by name). */
  app.get("/api/companies/:company/tables/:table/export", async (request, reply) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    const table = await tableFor(request, company.id, ref);
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await platform.tables.records(company.id, table.id, { sort: "number", direction: "asc", limit: 500, offset });
      for (const record of page.records) {
        const row: Record<string, unknown> = { "#": record.number };
        for (const field of table.fields) row[field.label] = record.display[field.key] ?? record.values[field.key] ?? null;
        row["Added by"] = record.createdBy;
        row["Added"] = record.createdAt.toISOString();
        rows.push(row);
      }
      if (page.records.length < 500 || rows.length >= 100_000) break;
    }
    const data = await writeWorkbook([{ name: table.name, rows, columns: ["#", ...table.fields.map((f) => f.label), "Added by", "Added"] }]);
    const name = `${table.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "table"}.xlsx`;
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(data);
  });
}
