import { defineConnector, defineManifest } from "../define.ts";
import { httpRequest, odataV4Collection, sameOrigin, stripODataControl, withTokenRetry, type HttpRequestOptions, type HttpResponse } from "../http.ts";
import { anyObject, int, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import {
  configString,
  isRecord,
  normalizeBaseUrl,
  optLimit,
  optString,
  optStringList,
  reqRecord,
  reqString,
  requireConfig,
  type Input,
  type Rec,
} from "../util.ts";
import { ENTRA_CONFIG, entraToken } from "./microsoft.ts";

const SERVICE = "Dynamics 365 (Dataverse)";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATTED_VALUES = 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"';

function orgUrl(ctx: ConnectorContext): string {
  return normalizeBaseUrl(requireConfig(ctx, "org_url", "Environment URL"), "Environment URL");
}

function apiRoot(ctx: ConnectorContext): string {
  return `${orgUrl(ctx)}/api/data/${configString(ctx, "api_version", "v9.2")}`;
}

/** Dataverse Web API request (OData 4.0) with an app-only token for the environment. */
function dataverse<T = unknown>(ctx: ConnectorContext, pathOrUrl: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  const root = apiRoot(ctx);
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${root}/${pathOrUrl.replace(/^\/+/, "")}`;
  if (!sameOrigin(url, root)) throw new ConnectorError(`Refusing to send Dataverse credentials to ${new URL(url).host}`, "remote");
  return withTokenRetry(
    (force) => entraToken(ctx, `${orgUrl(ctx)}/.default`, force),
    (token) =>
      httpRequest<T>(ctx.fetch, url, {
        ...options,
        service: SERVICE,
        headers: {
          "odata-maxversion": "4.0",
          "odata-version": "4.0",
          ...options.headers,
          authorization: `Bearer ${token.accessToken}`,
        },
      }),
  );
}

function entitySet(input: Input): string {
  const value = reqString(input, "entity_set");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ConnectorError(`entity_set must be the plural logical name of a table, e.g. accounts or contacts (got "${value}")`, "validation");
  }
  return value;
}

function recordId(input: Input): string {
  const id = reqString(input, "id").replace(/^\{|\}$/g, "");
  if (!GUID.test(id)) throw new ConnectorError(`id must be a GUID, e.g. 5f2c1b4e-3a0d-ef11-9f89-000d3a4b1c2d (got "${id}")`, "validation");
  return id;
}

function selectParam(input: Input): string | undefined {
  return optStringList(input, "select")?.join(",");
}

/** Id of a created record: from the OData-EntityId header or, failing that, the <table>id column. */
function createdId(response: HttpResponse, set: string, record: Rec | undefined): string | undefined {
  const header = response.headers.get("odata-entityid") ?? response.headers.get("location");
  const fromHeader = header ? /\(([0-9a-f-]{36})\)\s*$/i.exec(header)?.[1] : undefined;
  if (fromHeader) return fromHeader;
  if (!record) return undefined;
  const singular = set.replace(/ies$/, "y").replace(/s$/, "");
  const key = Object.keys(record).find((k) => k.toLowerCase() === `${singular.toLowerCase()}id`);
  const value = key ? record[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

const manifest = defineManifest({
  type: "microsoft-dynamics-365",
  name: "Microsoft Dynamics 365 / Dataverse",
  vendor: "Microsoft",
  category: "crm",
  description:
    "Reads and writes Dynamics 365 Sales, Customer Service and Dataverse tables (accounts, contacts, leads, opportunities, incidents, custom tables) through the Dataverse Web API v9.2 with an application user.",
  auth: "oauth2-client-credentials",
  docsUrl: "https://learn.microsoft.com/power-apps/developer/data-platform/webapi/overview",
  maturity: "preview",
  config: [
    {
      key: "org_url",
      label: "Environment URL",
      type: "url",
      required: true,
      placeholder: "https://acme.crm4.dynamics.com",
      help: "URL of the Dataverse environment (Power Platform admin center > Environments).",
    },
    ...ENTRA_CONFIG,
    { key: "api_version", label: "Web API version", type: "string", default: "v9.2" },
  ],
  operations: [
    readOp("query_records", "Query records", "Query a table with OData: $filter, $select, $orderby, $expand. Choice/lookup labels are returned as ...@OData.Community.Display.V1.FormattedValue.", {
      entity_set: str("Table entity set name, e.g. accounts, contacts, leads, opportunities, incidents"),
      filter: str("OData $filter, e.g. \"statecode eq 0 and contains(name,'Hansa')\""),
      select: str("Comma-separated columns, e.g. name,accountnumber,telephone1"),
      orderby: str("OData $orderby, e.g. createdon desc"),
      expand: str("OData $expand, e.g. primarycontactid($select=fullname,emailaddress1)"),
      top: int("Maximum number of records (default 50, max 1000)"),
    }, ["entity_set"]),
    readOp("get_record", "Get record", "Read one record by id.", {
      entity_set: str("Table entity set name, e.g. accounts"),
      id: str("Record GUID"),
      select: str("Comma-separated columns"),
      expand: str("OData $expand"),
    }, ["entity_set", "id"]),
    writeOp("create_record", "Create record", "Create a record. Lookups are set with '<navigation>@odata.bind': '/accounts(<guid>)'.", {
      entity_set: str("Table entity set name, e.g. leads"),
      fields: anyObject("Column values, e.g. {\"subject\": \"Pump inquiry\", \"firstname\": \"Yasemin\", \"emailaddress1\": \"y@example.com\"}"),
    }, ["entity_set", "fields"]),
    writeOp("update_record", "Update record", "Update columns of an existing record (never creates a new one).", {
      entity_set: str("Table entity set name, e.g. opportunities"),
      id: str("Record GUID"),
      fields: anyObject("Column values to change"),
    }, ["entity_set", "id", "fields"]),
  ],
  itRequirements: [
    "A Microsoft Entra ID app registration with a client secret; provide tenant ID, client ID and the secret value",
    "An application user for that app registration in the Dataverse environment (Power Platform admin center > Environment > Settings > Users + permissions > Application users)",
    "A security role for the application user granting read (and, for write operations, create/write) privileges on the required tables only",
    "The environment URL, e.g. https://acme.crm4.dynamics.com",
    "Outbound HTTPS from Enterprise Brain to login.microsoftonline.com and *.dynamics.com",
  ],
});

export const dynamics365Connector = defineConnector({
  manifest,

  async test(ctx) {
    const response = await dataverse(ctx, "WhoAmI");
    const data = isRecord(response.data) ? response.data : {};
    return {
      ok: true,
      message: `Connected to Dataverse environment ${orgUrl(ctx)} as application user ${String(data.UserId ?? "?")}.`,
      details: { userId: data.UserId, organizationId: data.OrganizationId, businessUnitId: data.BusinessUnitId },
    };
  },

  operations: {
    async query_records(input, ctx) {
      const set = entitySet(input);
      const top = optLimit(input, "top", 50, 1000);
      const pageSize = Math.min(top, 500);
      const headers = { prefer: `odata.maxpagesize=${pageSize},${FORMATTED_VALUES}` };
      const items: Rec[] = [];
      let next: string | undefined;
      let response = await dataverse(ctx, set, {
        headers,
        query: {
          $filter: optString(input, "filter"),
          $select: selectParam(input),
          $orderby: optString(input, "orderby"),
          $expand: optString(input, "expand"),
        },
      });
      for (;;) {
        const page = odataV4Collection(response.data);
        items.push(...page.items.map(stripODataControl));
        next = page.nextLink;
        if (!next || items.length >= top) break;
        response = await dataverse(ctx, next, { headers });
      }
      return { items: items.slice(0, top), total: Math.min(items.length, top), has_more: Boolean(next) || items.length > top };
    },

    async get_record(input, ctx) {
      const response = await dataverse(ctx, `${entitySet(input)}(${recordId(input)})`, {
        headers: { prefer: FORMATTED_VALUES },
        query: { $select: selectParam(input), $expand: optString(input, "expand") },
      });
      return isRecord(response.data) ? stripODataControl(response.data) : response.data;
    },

    async create_record(input, ctx) {
      const set = entitySet(input);
      const response = await dataverse(ctx, set, {
        method: "POST",
        json: reqRecord(input, "fields"),
        headers: { prefer: `return=representation,${FORMATTED_VALUES}` },
      });
      const record = isRecord(response.data) ? stripODataControl(response.data) : undefined;
      return { ok: true, id: createdId(response, set, record) ?? null, entity_set: set, record: record ?? null };
    },

    async update_record(input, ctx) {
      const set = entitySet(input);
      const id = recordId(input);
      const response = await dataverse(ctx, `${set}(${id})`, {
        method: "PATCH",
        json: reqRecord(input, "fields"),
        // If-Match: * turns the PATCH into a pure update (no upsert of a missing record).
        headers: { "if-match": "*", prefer: `return=representation,${FORMATTED_VALUES}` },
      });
      const record = isRecord(response.data) ? stripODataControl(response.data) : null;
      return { ok: true, id, entity_set: set, record };
    },
  },
});
