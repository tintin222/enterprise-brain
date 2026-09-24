import type { ConfigFieldInput } from "../define.ts";
import {
  getClientCredentialsToken,
  httpRequest,
  odataV4Collection,
  sameOrigin,
  withTokenRetry,
  type HttpRequestOptions,
  type HttpResponse,
  type OAuthToken,
} from "../http.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import { requireConfig, requireSecret, type Rec } from "../util.ts";

/** Shared pieces of the Microsoft Entra ID (client credentials) based connectors. */

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export const ENTRA_CONFIG: ConfigFieldInput[] = [
  {
    key: "tenant_id",
    label: "Directory (tenant) ID",
    type: "string",
    required: true,
    placeholder: "00000000-0000-0000-0000-000000000000",
    help: "Microsoft Entra ID tenant id or primary domain (e.g. acme.onmicrosoft.com).",
  },
  {
    key: "client_id",
    label: "Application (client) ID",
    type: "string",
    required: true,
    help: "Client id of the app registration used by Enterprise Brain.",
  },
  {
    key: "client_secret",
    label: "Client secret",
    type: "password",
    required: true,
    secret: true,
    help: "Client secret value of the app registration (not the secret id).",
  },
];

export function entraTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

/** Client-credentials token for `scope` (e.g. Graph or a Dataverse org URL + "/.default"). */
export function entraToken(ctx: ConnectorContext, scope: string, forceRefresh = false): Promise<OAuthToken> {
  return getClientCredentialsToken(
    ctx.fetch,
    {
      tokenUrl: entraTokenUrl(requireConfig(ctx, "tenant_id", "Directory (tenant) ID")),
      clientId: requireConfig(ctx, "client_id", "Application (client) ID"),
      clientSecret: requireSecret(ctx, "client_secret", "Client secret"),
      scope,
      service: "Microsoft Entra ID",
    },
    forceRefresh,
  );
}

/**
 * Microsoft Graph request with app-only token. `pathOrUrl` is relative to
 * /v1.0 or an absolute Graph URL (e.g. an @odata.nextLink); credentials are
 * never sent to other hosts.
 */
export function graphRequest<T = unknown>(
  ctx: ConnectorContext,
  pathOrUrl: string,
  options: HttpRequestOptions = {},
  service = "Microsoft Graph",
): Promise<HttpResponse<T>> {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${GRAPH_ROOT}${pathOrUrl}`;
  if (!sameOrigin(url, GRAPH_ROOT)) throw new ConnectorError(`Refusing to send Graph credentials to ${new URL(url).host}`, "remote");
  return withTokenRetry(
    (force) => entraToken(ctx, GRAPH_SCOPE, force),
    (token) =>
      httpRequest<T>(ctx.fetch, url, {
        ...options,
        service,
        headers: { ...options.headers, authorization: `Bearer ${token.accessToken}` },
      }),
  );
}

/** Reads a Graph collection, following @odata.nextLink until `max` items were collected. */
export async function graphCollect(
  ctx: ConnectorContext,
  path: string,
  options: HttpRequestOptions,
  max: number,
  service?: string,
): Promise<{ items: Rec[]; hasMore: boolean }> {
  const items: Rec[] = [];
  let next: string | undefined = path;
  let first = true;
  while (next && items.length < max) {
    const response: HttpResponse = await graphRequest(ctx, next, first ? options : { headers: options.headers }, service);
    const page = odataV4Collection(response.data);
    items.push(...page.items);
    next = page.nextLink;
    first = false;
  }
  return { items: items.slice(0, max), hasMore: Boolean(next) || items.length > max };
}
