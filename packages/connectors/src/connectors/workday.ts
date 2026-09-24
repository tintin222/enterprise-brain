import { defineConnector, defineManifest } from "../define.ts";
import { getRefreshTokenAccessToken, httpRequest, withTokenRetry, type HttpResponse, type Query } from "../http.ts";
import { int, readOp, str } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { isRecord, normalizeBaseUrl, optLimit, optString, reqString, requireConfig, requireSecret, type Rec } from "../util.ts";

const SERVICE = "Workday";

function host(ctx: ConnectorContext): string {
  return normalizeBaseUrl(requireConfig(ctx, "host", "REST API host"), "REST API host");
}

function tenant(ctx: ConnectorContext): string {
  return encodeURIComponent(requireConfig(ctx, "tenant", "Tenant"));
}

/** Workday REST API (common v1) with an API client for integrations and a refresh token. */
function workday<T = unknown>(ctx: ConnectorContext, path: string, query: Query = {}): Promise<HttpResponse<T>> {
  return withTokenRetry(
    (force) =>
      getRefreshTokenAccessToken(
        ctx.fetch,
        {
          tokenUrl: `${host(ctx)}/ccx/oauth2/${tenant(ctx)}/token`,
          clientId: requireConfig(ctx, "client_id", "Client ID"),
          clientSecret: requireSecret(ctx, "client_secret", "Client secret"),
          refreshToken: requireSecret(ctx, "refresh_token", "Refresh token"),
          clientAuth: "basic",
          service: `${SERVICE} OAuth`,
        },
        force,
      ),
    (token) =>
      httpRequest<T>(ctx.fetch, `${host(ctx)}/ccx/api/v1/${tenant(ctx)}${path}`, {
        service: SERVICE,
        query,
        headers: { authorization: `Bearer ${token.accessToken}` },
      }),
  );
}

function workerId(input: Rec): string {
  const id = reqString(input, "worker_id");
  if (/[/?#]/.test(id)) throw new ConnectorError("worker_id must not contain '/', '?' or '#'", "validation");
  return id;
}

const manifest = defineManifest({
  type: "workday",
  name: "Workday HCM",
  vendor: "Workday",
  category: "hris",
  description: "Reads workers (employees and contingent workers) from Workday HCM through the Workday REST API (common v1): search, profile and direct reports.",
  auth: "oauth2-refresh-token",
  docsUrl: "https://community.workday.com/sites/default/files/file-hosting/restapi/index.html",
  maturity: "preview",
  config: [
    {
      key: "host",
      label: "REST API host",
      type: "url",
      required: true,
      placeholder: "https://wd2-impl-services1.workday.com",
      help: "Host part of the REST API endpoint shown in the 'View API Clients' task.",
    },
    { key: "tenant", label: "Tenant", type: "string", required: true, placeholder: "acme" },
    { key: "client_id", label: "Client ID", type: "string", required: true },
    { key: "client_secret", label: "Client secret", type: "password", required: true, secret: true },
    { key: "refresh_token", label: "Refresh token", type: "password", required: true, secret: true, help: "Non-expiring refresh token generated for the integration system user." },
  ],
  operations: [
    readOp("search_workers", "Search workers", "Workers matching a name or id.", {
      query: str("Name, worker id or e-mail fragment"),
      limit: int("Maximum number of results (default 20, max 100)"),
    }),
    readOp("get_worker", "Get worker", "Worker profile: business title, e-mail, supervisory organization, worker type.", {
      worker_id: str("Workday worker id (WID)"),
    }, ["worker_id"]),
    readOp("list_direct_reports", "List direct reports", "Direct reports of a manager.", {
      worker_id: str("Workday worker id (WID) of the manager"),
    }, ["worker_id"]),
  ],
  itRequirements: [
    "An integration system user (ISU) in a security group with view access to the Worker Data domains the agent needs",
    "An API client registered with 'Register API Client for Integrations' (scopes such as Staffing, Organizations and Roles, Contact Information) and a non-expiring refresh token for the ISU",
    "The REST API host and tenant name (task 'View API Clients')",
    "Outbound HTTPS from Enterprise Brain to the Workday services host",
  ],
});

function page(data: unknown): { items: Rec[]; total: number } {
  const body = isRecord(data) ? data : {};
  const items = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  return { items, total: typeof body.total === "number" ? body.total : items.length };
}

export const workdayConnector = defineConnector({
  manifest,

  async test(ctx) {
    await workday(ctx, "/workers", { limit: 1 });
    return { ok: true, message: `Connected to Workday tenant ${requireConfig(ctx, "tenant")}.` };
  },

  operations: {
    async search_workers(input, ctx) {
      const limit = optLimit(input, "limit", 20, 100);
      const response = await workday(ctx, "/workers", { search: optString(input, "query"), limit, offset: 0 });
      const { items, total } = page(response.data);
      return { items, total, has_more: total > items.length };
    },

    async get_worker(input, ctx) {
      const response = await workday(ctx, `/workers/${encodeURIComponent(workerId(input))}`);
      return response.data;
    },

    async list_direct_reports(input, ctx) {
      const response = await workday(ctx, `/workers/${encodeURIComponent(workerId(input))}/directReports`, { limit: 100 });
      const { items, total } = page(response.data);
      return { items, total };
    },
  },
});
