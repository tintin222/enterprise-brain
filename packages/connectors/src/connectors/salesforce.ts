import { defineConnector, defineManifest } from "../define.ts";
import {
  getClientCredentialsToken,
  getRefreshTokenAccessToken,
  httpRequest,
  withTokenRetry,
  type HttpRequestOptions,
  type HttpResponse,
  type OAuthToken,
} from "../http.ts";
import { anyObject, email, int, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import {
  configString,
  isRecord,
  normalizeBaseUrl,
  normalizeEmail,
  optLimit,
  optStringList,
  optionalSecret,
  reqRecord,
  reqString,
  requireConfig,
  requireSecret,
  type Input,
  type Rec,
} from "../util.ts";

const SERVICE = "Salesforce";
const DEFAULT_API_VERSION = "v62.0";

function loginUrl(ctx: ConnectorContext): string {
  return normalizeBaseUrl(requireConfig(ctx, "login_url", "My Domain URL"), "My Domain URL");
}

function apiVersion(ctx: ConnectorContext): string {
  const version = configString(ctx, "api_version", DEFAULT_API_VERSION) ?? DEFAULT_API_VERSION;
  return version.startsWith("v") ? version : `v${version}`;
}

/** Access token via client credentials flow (default) or refresh token flow; the response carries instance_url. */
function salesforceToken(ctx: ConnectorContext, forceRefresh: boolean): Promise<OAuthToken> {
  const tokenUrl = `${loginUrl(ctx)}/services/oauth2/token`;
  const clientId = requireConfig(ctx, "client_id", "Consumer key");
  const clientSecret = requireSecret(ctx, "client_secret", "Consumer secret");
  const refreshToken = optionalSecret(ctx, "refresh_token");
  if (configString(ctx, "auth_type", "client_credentials") === "refresh_token") {
    if (!refreshToken) throw new ConnectorError("Missing secret: refresh_token (required for the refresh token flow)", "config");
    return getRefreshTokenAccessToken(ctx.fetch, { tokenUrl, clientId, clientSecret, refreshToken, service: SERVICE }, forceRefresh);
  }
  return getClientCredentialsToken(ctx.fetch, { tokenUrl, clientId, clientSecret, service: SERVICE }, forceRefresh);
}

function instanceUrl(token: OAuthToken, ctx: ConnectorContext): string {
  const url = token.extra.instance_url;
  return typeof url === "string" && url ? normalizeBaseUrl(url, "instance_url") : loginUrl(ctx);
}

/** REST call relative to the instance (path starting with /services/...). */
function salesforce<T = unknown>(ctx: ConnectorContext, path: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  return withTokenRetry(
    (force) => salesforceToken(ctx, force),
    (token) =>
      httpRequest<T>(ctx.fetch, `${instanceUrl(token, ctx)}${path}`, {
        ...options,
        service: SERVICE,
        headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` },
      }),
  );
}

function dataPath(ctx: ConnectorContext, suffix: string): string {
  return `/services/data/${apiVersion(ctx)}${suffix}`;
}

function sobjectName(input: Input): string {
  const name = reqString(input, "sobject");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new ConnectorError(`sobject must be an API name such as Account, Contact or Invoice__c (got "${name}")`, "validation");
  return name;
}

function recordId(input: Input): string {
  const id = reqString(input, "id");
  if (!/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(id)) throw new ConnectorError(`id must be a 15 or 18 character Salesforce id (got "${id}")`, "validation");
  return id;
}

/** SOQL string literal with the escapes Salesforce requires. */
export function soqlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

/** Drops the "attributes" metadata Salesforce adds to every record (recursively). */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "attributes") continue;
    out[key] = isRecord(child) && Array.isArray(child.records) ? { ...child, records: child.records.map(clean) } : clean(child);
  }
  return out;
}

async function runSoql(ctx: ConnectorContext, soql: string, maxRecords: number): Promise<Rec> {
  const records: unknown[] = [];
  let response = await salesforce<Rec>(ctx, dataPath(ctx, "/query"), { query: { q: soql } });
  let totalSize = Number(response.data.totalSize ?? 0);
  for (;;) {
    const page = response.data;
    if (Array.isArray(page.records)) records.push(...page.records);
    const next = page.nextRecordsUrl;
    if (page.done === true || typeof next !== "string" || records.length >= maxRecords) {
      const items = records.slice(0, maxRecords).map(clean);
      return { items, total: totalSize, done: page.done === true && records.length <= maxRecords };
    }
    response = await salesforce<Rec>(ctx, next);
    totalSize = Number(response.data.totalSize ?? totalSize);
  }
}

const manifest = defineManifest({
  type: "salesforce",
  name: "Salesforce",
  vendor: "Salesforce",
  category: "crm",
  description:
    "Queries and updates Salesforce CRM data (accounts, contacts, leads, opportunities, cases, custom objects) through the REST API with SOQL, using an External Client App / Connected App with the OAuth 2.0 client credentials flow (or a refresh token).",
  auth: "oauth2-client-credentials",
  docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm",
  maturity: "preview",
  config: [
    {
      key: "login_url",
      label: "My Domain URL",
      type: "url",
      required: true,
      placeholder: "https://acme.my.salesforce.com",
      help: "Your org's My Domain URL (the client credentials flow does not work with login.salesforce.com).",
    },
    {
      key: "auth_type",
      label: "OAuth flow",
      type: "select",
      default: "client_credentials",
      options: [
        { value: "client_credentials", label: "Client credentials (integration user)" },
        { value: "refresh_token", label: "Refresh token" },
      ],
    },
    { key: "client_id", label: "Consumer key", type: "string", required: true },
    { key: "client_secret", label: "Consumer secret", type: "password", required: true, secret: true },
    { key: "refresh_token", label: "Refresh token", type: "password", secret: true, help: "Only for the refresh token flow." },
    { key: "api_version", label: "API version", type: "string", default: DEFAULT_API_VERSION },
  ],
  operations: [
    readOp("soql_query", "SOQL query", "Run a SOQL SELECT query; returns { items, total, done } and pages large results automatically up to max_records.", {
      soql: str("SOQL, e.g. SELECT Id, Name, StageName, Amount FROM Opportunity WHERE IsClosed = false ORDER BY CloseDate LIMIT 50"),
      max_records: int("Maximum number of records to return (default 200, max 2000)"),
    }, ["soql"]),
    readOp("get_record", "Get record", "Read one record by id.", {
      sobject: str("Object API name, e.g. Account, Contact, Case, Invoice__c"),
      id: str("15 or 18 character record id"),
      fields: str("Comma-separated fields to return (default: all)"),
    }, ["sobject", "id"]),
    writeOp("create_record", "Create record", "Create a record.", {
      sobject: str("Object API name, e.g. Lead"),
      fields: anyObject("Field values by API name, e.g. {\"LastName\": \"Koç\", \"Company\": \"Doğu Marmara Arıtma\", \"Email\": \"y@example.com\"}"),
    }, ["sobject", "fields"]),
    writeOp("update_record", "Update record", "Update fields of a record.", {
      sobject: str("Object API name, e.g. Opportunity"),
      id: str("Record id"),
      fields: anyObject("Field values to change, e.g. {\"StageName\": \"Negotiation/Review\"}"),
    }, ["sobject", "id", "fields"]),
    readOp("search_contacts_by_email", "Find contacts by e-mail", "Contacts (with their account) that have the given e-mail address.", {
      email: email("E-mail address"),
    }, ["email"]),
  ],
  itRequirements: [
    "An External Client App (or Connected App) with OAuth enabled, the client credentials flow enabled and scopes 'api' and 'refresh_token'; provide consumer key and consumer secret",
    "A dedicated integration user (Salesforce Integration license) set as the flow's 'Run As' user, with a permission set granting access only to the needed objects and fields",
    "The org's My Domain URL, e.g. https://acme.my.salesforce.com",
    "Outbound HTTPS from Enterprise Brain to *.my.salesforce.com",
  ],
});

export const salesforceConnector = defineConnector({
  manifest,

  async test(ctx) {
    const response = await salesforce(ctx, dataPath(ctx, "/"));
    const resources = isRecord(response.data) ? Object.keys(response.data).length : 0;
    return {
      ok: true,
      message: `Connected to Salesforce REST API ${apiVersion(ctx)} (${resources} resources available).`,
      details: { apiVersion: apiVersion(ctx) },
    };
  },

  operations: {
    async soql_query(input, ctx) {
      const soql = reqString(input, "soql");
      if (!/^\s*select\s/i.test(soql)) throw new ConnectorError("soql must be a SELECT statement", "validation");
      return runSoql(ctx, soql, optLimit(input, "max_records", 200, 2000));
    },

    async get_record(input, ctx) {
      const fields = optStringList(input, "fields")?.join(",");
      const response = await salesforce(ctx, dataPath(ctx, `/sobjects/${sobjectName(input)}/${recordId(input)}`), {
        query: { fields },
      });
      return clean(response.data);
    },

    async create_record(input, ctx) {
      const sobject = sobjectName(input);
      const response = await salesforce<Rec>(ctx, dataPath(ctx, `/sobjects/${sobject}`), { method: "POST", json: reqRecord(input, "fields") });
      const data = isRecord(response.data) ? response.data : {};
      return { ok: data.success !== false, id: data.id ?? null, sobject, errors: Array.isArray(data.errors) ? data.errors : [] };
    },

    async update_record(input, ctx) {
      const sobject = sobjectName(input);
      const id = recordId(input);
      await salesforce(ctx, dataPath(ctx, `/sobjects/${sobject}/${id}`), { method: "PATCH", json: reqRecord(input, "fields") });
      return { ok: true, id, sobject, updated_fields: Object.keys(reqRecord(input, "fields")) };
    },

    async search_contacts_by_email(input, ctx) {
      const mail = normalizeEmail(reqString(input, "email"));
      const soql =
        "SELECT Id, FirstName, LastName, Name, Title, Email, Phone, MobilePhone, AccountId, Account.Name, OwnerId " +
        `FROM Contact WHERE Email = ${soqlString(mail)} ORDER BY LastModifiedDate DESC LIMIT 20`;
      const { items } = await runSoql(ctx, soql, 20);
      return { items, total: Array.isArray(items) ? items.length : 0 };
    },
  },
});
