import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { changeTable, describeTableChanges, proposeTable } from "@enterprise-brain/builder";
import { buildingRulesOf, TableField, TableSettings, type BuildingRules, type TableDesign } from "@enterprise-brain/core";
import { readSheets, writeWorkbook } from "@enterprise-brain/documents";
import type { TableView } from "@enterprise-brain/runtime";
import { canBuildFor, canChangeBuilt, rulesOf } from "../auth/building.ts";
import { actorOf, canManageDepartment, canSeeDepartment, viewerOf, type Viewer } from "../auth/viewer.ts";
import type { AppContext } from "../context.ts";
import { HttpError, companyOf, readMultipart } from "../http.ts";
import { personalDataAfterDesign, renamesBack } from "./building.ts";

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

/** Who changes a table's design and settings: as the rules for building say (its department's managers by default); admins for company tables. */
export function canDesignTable(viewer: Viewer, table: Pick<TableView, "departmentId" | "createdBy">, rules: BuildingRules = buildingRulesOf({})): boolean {
  return canChangeBuilt(viewer, table, rules);
}

/** Why someone may not make a table (or an app, a calculation) for a department, in plain words. */
export function notBuilding(what: string, departmentId: string | null | undefined, rules: BuildingRules): string {
  if (!departmentId) return `Only IT makes company-wide ${what}; choose a department`;
  if (rules.who === "it") return `IT makes ${what} here; ask IT`;
  return rules.who === "managers" ? `Only a manager of this department makes its ${what}` : `Only this department's people make its ${what}`;
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
  const withRights = (viewer: Viewer, table: TableView, rules?: BuildingRules) => ({
    ...table,
    can: { edit: canEditRecords(viewer, table), design: canDesignTable(viewer, table, rules) },
  });
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
  const designable = async (request: FastifyRequest, company: { id: string; settings: Record<string, unknown> }, ref: string) => {
    const table = await tableFor(request, company.id, ref);
    if (!canDesignTable(viewerOf(request), table, rulesOf(company)))
      throw new HttpError(403, `Only a manager of its department (or whoever made it) changes ${table.name}`);
    return table;
  };
  /** Who makes tables for a department is as the rules for building say; company-wide ones are IT's. */
  const assertMayCreate = (viewer: Viewer, departmentId: string | null | undefined, rules: BuildingRules) => {
    if (!canBuildFor(viewer, departmentId, rules)) throw new HttpError(403, notBuilding("tables", departmentId, rules));
  };

  app.get("/api/companies/:company/tables", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { archived } = z.object({ archived: z.enum(["true", "false"]).optional() }).parse(request.query ?? {});
    const tables = await platform.tables.list(company.id, { archived: archived === "true" });
    const rules = rulesOf(company);
    return tables.filter((t) => canSeeTable(viewer, t)).map((t) => withRights(viewer, t, rules));
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
    const rules = rulesOf(company);
    assertMayCreate(viewer, body.departmentId, rules);
    // Shared with the whole company only once IT says so.
    const share = body.settings?.visibility === "company" && !viewer.isAdmin;
    const made = await platform.tables.create(
      company.id,
      share ? { ...body, settings: { ...body.settings, visibility: "department" } } : body,
      actorOf(viewer),
    );
    const { table } = await personalDataAfterDesign(platform, company.id, viewer, rules, made);
    if (share) await platform.reviews.sharing(company.id, { type: "table", id: table.id, departmentId: table.departmentId }, viewer.name);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "table.created",
      entityType: "table",
      entityId: table.id,
      summary: `Made the table ${table.name}`,
    });
    return { ...withRights(viewer, table, rules), reviews: await platform.reviews.list(company.id, { status: "waiting", itemId: table.id }) };
  });

  app.get("/api/companies/:company/tables/:table", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    const table = await tableFor(request, company.id, ref);
    return {
      ...withRights(viewerOf(request), table, rulesOf(company)),
      reviews: await platform.reviews.list(company.id, { status: "waiting", itemId: table.id }),
    };
  });

  app.patch("/api/companies/:company/tables/:table", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { table: ref } = request.params as { table: string };
    const body = Design.partial().parse(request.body);
    const rules = rulesOf(company);
    const table = await designable(request, company, ref);
    if (body.departmentId !== undefined && body.departmentId !== table.departmentId) assertMayCreate(viewer, body.departmentId, rules);
    // Shared with the whole company only once IT says so.
    const share = body.settings?.visibility === "company" && table.settings.visibility !== "company" && !viewer.isAdmin;
    const { visibility: _asked, ...otherSettings } = body.settings ?? {};
    const changes = share ? { ...body, settings: otherSettings } : body;
    const { table: changed } = await personalDataAfterDesign(
      platform,
      company.id,
      viewer,
      rules,
      await platform.tables.change(company.id, table.id, { ...changes, by: viewer.name }),
    );
    if (share) await platform.reviews.sharing(company.id, { type: "table", id: table.id, departmentId: changed.departmentId }, viewer.name);
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "table.changed",
      entityType: "table",
      entityId: table.id,
      summary: `Changed the table ${changed.name}`,
      data: { changed: Object.keys(body) },
    });
    return { ...withRights(viewer, changed, rules), reviews: await platform.reviews.list(company.id, { status: "waiting", itemId: table.id }) };
  });

  /** Its versions, newest first, each with what changed from the one before, in plain words. */
  app.get("/api/companies/:company/tables/:table/versions", async (request) => {
    const company = await companyOf(platform, request);
    const { table: ref } = request.params as { table: string };
    const table = await tableFor(request, company.id, ref);
    const versions = await platform.versions.list(company.id, { type: "table", id: table.id });
    const design = (snapshot: Record<string, unknown>) => ({ ...(snapshot as Omit<TableDesign, "key">), key: table.key }) as TableDesign;
    return versions.map((v, i) => {
      const previous = versions[i + 1];
      const renames = (v.snapshot.renames ?? {}) as Record<string, Record<string, string>>;
      return {
        version: v.version,
        by: v.by,
        note: v.note,
        createdAt: v.createdAt,
        current: v.version === table.version,
        summary: previous ? describeTableChanges(design(previous.snapshot), design(v.snapshot), renames) : ["Made"],
      };
    });
  });

  /** Go back to an earlier version: a new version with its fields (choice values renamed since are renamed back). */
  app.post("/api/companies/:company/tables/:table/versions/:version/restore", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { table: ref, version } = request.params as { table: string; version: string };
    const table = await designable(request, company, ref);
    const versions = await platform.versions.list(company.id, { type: "table", id: table.id });
    const target = versions.find((v) => v.version === Number(version));
    if (!target) throw new HttpError(404, `${table.name} has no version ${version}`);
    if (target.version === table.version) throw new HttpError(400, `${table.name} is at version ${version} already`);
    const snapshot = target.snapshot as Omit<TableDesign, "key">;
    const { table: changed } = await personalDataAfterDesign(
      platform,
      company.id,
      viewer,
      rulesOf(company),
      await platform.tables.change(company.id, table.id, {
        name: snapshot.name,
        description: snapshot.description,
        fields: snapshot.fields,
        titleField: snapshot.titleField ?? "",
        renames: renamesBack(versions.filter((v) => v.version > target.version)),
        by: viewer.name,
        note: `Back to version ${target.version}`,
      }),
    );
    await platform.activity.record(company.id, {
      actor: actorOf(viewer),
      action: "table.restored",
      entityType: "table",
      entityId: table.id,
      summary: `${viewer.name} took ${table.name} back to version ${target.version}`,
    });
    return withRights(viewer, changed, rulesOf(company));
  });

  /** A change said in plain words: the table as it would be, what changes, and the records that wouldn't fit (nothing changes yet). */
  app.post("/api/companies/:company/tables/:table/changes", async (request) => {
    const company = await companyOf(platform, request);
    const viewer = viewerOf(request);
    const { table: ref } = request.params as { table: string };
    const body = z.object({ request: z.string().trim().min(3).max(2000) }).parse(request.body);
    const table = await designable(request, company, ref);
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
      const table = await designable(request, company, ref);
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
