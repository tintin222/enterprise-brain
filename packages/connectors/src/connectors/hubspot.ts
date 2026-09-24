import { defineConnector, defineManifest } from "../define.ts";
import { httpRequest, type HttpRequestOptions, type HttpResponse } from "../http.ts";
import { anyObject, arr, int, obj, oneOf, readOp, str, writeOp } from "../schema.ts";
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
  requireSecret,
  type Input,
  type Rec,
} from "../util.ts";

const SERVICE = "HubSpot";
const DEFAULT_BASE_URL = "https://api.hubapi.com";
const OPERATORS = [
  "EQ",
  "NEQ",
  "LT",
  "LTE",
  "GT",
  "GTE",
  "BETWEEN",
  "IN",
  "NOT_IN",
  "HAS_PROPERTY",
  "NOT_HAS_PROPERTY",
  "CONTAINS_TOKEN",
  "NOT_CONTAINS_TOKEN",
] as const;

/** Properties returned when none are requested (per object type). */
const DEFAULT_PROPERTIES: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage", "hs_lead_status"],
  companies: ["name", "domain", "industry", "city", "country", "phone", "lifecyclestage", "numberofemployees"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id"],
  tickets: ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority", "createdate"],
};

function hubspot<T = unknown>(ctx: ConnectorContext, path: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  const base = normalizeBaseUrl(configString(ctx, "base_url", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL, "API base URL");
  return httpRequest<T>(ctx.fetch, `${base}${path}`, {
    ...options,
    service: SERVICE,
    headers: { ...options.headers, authorization: `Bearer ${requireSecret(ctx, "access_token", "Private app access token")}` },
  });
}

function objectType(input: Input): string {
  const value = reqString(input, "object_type");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConnectorError(`object_type must be contacts, companies, deals, tickets or a custom object type id such as 2-1234567 (got "${value}")`, "validation");
  }
  return value.toLowerCase().startsWith("p_") || /^\d/.test(value) ? value : value.toLowerCase();
}

function objectId(input: Input): string {
  const value = reqString(input, "object_id");
  if (/[/?#]/.test(value)) throw new ConnectorError("object_id must not contain '/', '?' or '#'", "validation");
  return value;
}

function properties(input: Input, type: string): string[] | undefined {
  return optStringList(input, "properties") ?? DEFAULT_PROPERTIES[type];
}

function toObject(raw: unknown): Rec {
  if (!isRecord(raw)) return {};
  return {
    id: raw.id,
    properties: raw.properties,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
    archived: raw.archived,
    ...(raw.associations ? { associations: raw.associations } : {}),
  };
}

function parseFilters(input: Input): Rec[] {
  const raw = input.filters;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConnectorError("filters must be a list of {propertyName, operator, value}", "validation");
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new ConnectorError(`filters[${i}] must be an object`, "validation");
    const operator = String(entry.operator ?? "EQ").toUpperCase();
    if (!(OPERATORS as readonly string[]).includes(operator)) {
      throw new ConnectorError(`filters[${i}].operator must be one of ${OPERATORS.join(", ")}`, "validation");
    }
    const filter: Rec = { propertyName: reqString(entry, "propertyName"), operator };
    if (Array.isArray(entry.values)) filter.values = entry.values.map(String);
    else if (entry.value !== undefined && entry.value !== null) filter.value = String(entry.value);
    if (entry.highValue !== undefined && entry.highValue !== null) filter.highValue = String(entry.highValue);
    return filter;
  });
}

const manifest = defineManifest({
  type: "hubspot",
  name: "HubSpot CRM",
  vendor: "HubSpot",
  category: "crm",
  description:
    "Searches, reads, creates and updates HubSpot CRM objects (contacts, companies, deals, tickets and custom objects) through the CRM v3 API with a private app access token.",
  auth: "bearer",
  docsUrl: "https://developers.hubspot.com/docs/api/crm/understanding-the-crm",
  maturity: "preview",
  config: [
    {
      key: "access_token",
      label: "Private app access token",
      type: "password",
      required: true,
      secret: true,
      placeholder: "pat-eu1-...",
      help: "HubSpot > Settings > Integrations > Private apps > (app) > Access token.",
    },
    { key: "base_url", label: "API base URL", type: "url", default: DEFAULT_BASE_URL },
  ],
  operations: [
    readOp("search_objects", "Search objects", "Search CRM objects by free text and/or property filters (combined with AND); paging is handled up to limit.", {
      object_type: str("contacts, companies, deals, tickets or a custom object type id"),
      query: str("Free-text search over the object's default searchable properties"),
      filters: arr(obj({
        propertyName: str("Internal property name, e.g. email, dealstage, createdate"),
        operator: oneOf(OPERATORS, "Comparison operator"),
        value: str("Value to compare with"),
      }, ["propertyName", "operator"]), "Property filters (AND)"),
      properties: str("Comma-separated properties to return"),
      limit: int("Maximum number of results (default 20, max 200)"),
    }, ["object_type"]),
    readOp("get_object", "Get object", "Read one CRM object by id (or by a unique property such as email with id_property).", {
      object_type: str("contacts, companies, deals, tickets or a custom object type id"),
      object_id: str("Record id (or the unique value when id_property is set)"),
      properties: str("Comma-separated properties to return"),
      associations: str("Comma-separated associated object types to include, e.g. companies,deals"),
      id_property: str("Unique property used as id, e.g. email"),
    }, ["object_type", "object_id"]),
    writeOp("create_object", "Create object", "Create a CRM object.", {
      object_type: str("contacts, companies, deals, tickets or a custom object type id"),
      properties: anyObject("Property values, e.g. {\"email\": \"y@example.com\", \"firstname\": \"Yasemin\"}"),
      associations: arr(anyObject(), "Optional associations as defined by the CRM v3 API"),
    }, ["object_type", "properties"]),
    writeOp("update_object", "Update object", "Update properties of a CRM object.", {
      object_type: str("contacts, companies, deals, tickets or a custom object type id"),
      object_id: str("Record id"),
      properties: anyObject("Property values to change"),
    }, ["object_type", "object_id", "properties"]),
  ],
  itRequirements: [
    "A HubSpot private app (Settings > Integrations > Private apps) and its access token",
    "Private app scopes for the objects in use, e.g. crm.objects.contacts.read/.write, crm.objects.companies.read/.write, crm.objects.deals.read/.write, tickets",
    "Outbound HTTPS from Enterprise Brain to api.hubapi.com",
  ],
});

export const hubspotConnector = defineConnector({
  manifest,

  async test(ctx) {
    await hubspot(ctx, "/crm/v3/objects/contacts", { query: { limit: 1, archived: false } });
    return { ok: true, message: "Connected to HubSpot CRM (contacts readable)." };
  },

  operations: {
    async search_objects(input, ctx) {
      const type = objectType(input);
      const limit = optLimit(input, "limit", 20, 200);
      const filters = parseFilters(input);
      const query = optString(input, "query");
      const items: Rec[] = [];
      let after: string | undefined;
      let total = 0;
      do {
        const response = await hubspot<Rec>(ctx, `/crm/v3/objects/${encodeURIComponent(type)}/search`, {
          method: "POST",
          json: {
            ...(query ? { query } : {}),
            ...(filters.length ? { filterGroups: [{ filters }] } : {}),
            ...(properties(input, type) ? { properties: properties(input, type) } : {}),
            limit: Math.min(100, limit - items.length),
            ...(after ? { after } : {}),
          },
        });
        const page = isRecord(response.data) ? response.data : {};
        total = Number(page.total ?? 0);
        if (Array.isArray(page.results)) items.push(...page.results.map(toObject));
        const paging = isRecord(page.paging) && isRecord(page.paging.next) ? page.paging.next : undefined;
        after = typeof paging?.after === "string" ? paging.after : undefined;
      } while (after && items.length < limit);
      return { items: items.slice(0, limit), total, has_more: Boolean(after), next_after: after ?? null };
    },

    async get_object(input, ctx) {
      const type = objectType(input);
      const response = await hubspot(ctx, `/crm/v3/objects/${encodeURIComponent(type)}/${encodeURIComponent(objectId(input))}`, {
        query: {
          properties: properties(input, type)?.join(","),
          associations: optStringList(input, "associations")?.join(","),
          idProperty: optString(input, "id_property"),
        },
      });
      return toObject(response.data);
    },

    async create_object(input, ctx) {
      const type = objectType(input);
      const associations = Array.isArray(input.associations) ? input.associations : undefined;
      const response = await hubspot(ctx, `/crm/v3/objects/${encodeURIComponent(type)}`, {
        method: "POST",
        json: { properties: reqRecord(input, "properties"), ...(associations ? { associations } : {}) },
      });
      return { ok: true, object_type: type, ...toObject(response.data) };
    },

    async update_object(input, ctx) {
      const type = objectType(input);
      const response = await hubspot(ctx, `/crm/v3/objects/${encodeURIComponent(type)}/${encodeURIComponent(objectId(input))}`, {
        method: "PATCH",
        json: { properties: reqRecord(input, "properties") },
      });
      return { ok: true, object_type: type, ...toObject(response.data) };
    },
  },
});
