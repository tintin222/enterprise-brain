import { defineConnector, defineManifest } from "../define.ts";
import {
  basicAuth,
  cachedToken,
  httpRequest,
  odataKey,
  odataString,
  odataV2Collection,
  odataV2Entity,
  requestToken,
  sameOrigin,
  tokenCacheKey,
  withTokenRetry,
  type HttpResponse,
  type OAuthToken,
  type Query,
} from "../http.ts";
import { int, oneOf, readOp, str } from "../schema.ts";
import { ConnectorError, type ConnectorContext } from "../types.ts";
import {
  configString,
  normalizeBaseUrl,
  optEnum,
  optLimit,
  optString,
  reqString,
  requireConfig,
  requireSecret,
  type Rec,
} from "../util.ts";

const SERVICE = "SAP SuccessFactors";
const USER_SELECT =
  "userId,username,firstName,lastName,displayName,email,department,division,location,title,jobCode,status,hireDate,manager/userId,manager/displayName";

function apiUrl(ctx: ConnectorContext): string {
  return normalizeBaseUrl(requireConfig(ctx, "api_url", "API server URL"), "API server URL");
}

/** OAuth 2.0 SAML bearer flow: SuccessFactors issues the signed assertion (/oauth/idp), then the token (/oauth/token). */
function oauthToken(ctx: ConnectorContext, forceRefresh: boolean): Promise<OAuthToken> {
  const base = apiUrl(ctx);
  const companyId = requireConfig(ctx, "company_id", "Company ID");
  const clientId = requireConfig(ctx, "client_id", "OAuth client ID (API key)");
  const userId = requireConfig(ctx, "oauth_user_id", "Technical user id");
  const privateKey = requireSecret(ctx, "private_key", "OAuth private key");
  const tokenUrl = `${base}/oauth/token`;
  const key = tokenCacheKey({ grant: "saml2-bearer", tokenUrl, clientId, scope: `${companyId}|${userId}`, credential: privateKey });
  return cachedToken(
    key,
    async () => {
      const idp = await httpRequest<string>(ctx.fetch, `${base}/oauth/idp`, {
        method: "POST",
        service: `${SERVICE} OAuth`,
        responseType: "text",
        headers: { accept: "text/plain" },
        form: { client_id: clientId, user_id: userId, token_url: tokenUrl, private_key: privateKey },
      });
      const assertion = String(idp.data ?? "").trim();
      if (!assertion) throw new ConnectorError(`${SERVICE} did not return a SAML assertion`, "auth");
      return requestToken(ctx.fetch, {
        tokenUrl,
        clientId,
        service: `${SERVICE} OAuth`,
        params: {
          company_id: companyId,
          grant_type: "urn:ietf:params:oauth:grant-type:saml2-bearer",
          assertion,
        },
      });
    },
    forceRefresh,
  );
}

function basicHeader(ctx: ConnectorContext): string {
  const username = requireConfig(ctx, "username", "Username");
  const user = username.includes("@") ? username : `${username}@${requireConfig(ctx, "company_id", "Company ID")}`;
  return basicAuth(user, requireSecret(ctx, "password", "Password"));
}

/** OData V2 GET below /odata/v2 (or an absolute __next link on the same host). */
async function sf(ctx: ConnectorContext, pathOrUrl: string, query: Query = {}): Promise<HttpResponse> {
  const root = `${apiUrl(ctx)}/odata/v2`;
  const absolute = /^https?:\/\//.test(pathOrUrl);
  const url = absolute ? pathOrUrl : `${root}/${pathOrUrl}`;
  if (!sameOrigin(url, root)) throw new ConnectorError(`Refusing to follow a link to ${new URL(url).host}`, "remote");
  const hasFormat = absolute && new URL(url).searchParams.has("$format");
  const options = { service: SERVICE, query: hasFormat ? {} : { ...(absolute ? {} : query), $format: "json" } };
  if (configString(ctx, "auth_type", "basic") === "oauth2") {
    return withTokenRetry(
      (force) => oauthToken(ctx, force),
      (token) => httpRequest(ctx.fetch, url, { ...options, headers: { authorization: `Bearer ${token.accessToken}` } }),
    );
  }
  return httpRequest(ctx.fetch, url, { ...options, headers: { authorization: basicHeader(ctx) } });
}

async function collect(ctx: ConnectorContext, entitySet: string, query: Query, max: number): Promise<{ items: Rec[]; hasMore: boolean }> {
  const items: Rec[] = [];
  let response = await sf(ctx, entitySet, query);
  for (;;) {
    const page = odataV2Collection(response.data);
    items.push(...page.items);
    if (!page.next || items.length >= max) return { items: items.slice(0, max), hasMore: Boolean(page.next) || items.length > max };
    response = await sf(ctx, new URL(page.next, `${apiUrl(ctx)}/odata/v2/`).toString());
  }
}

const manifest = defineManifest({
  type: "sap-successfactors",
  name: "SAP SuccessFactors Employee Central",
  vendor: "SAP",
  category: "hris",
  description:
    "Reads employees from SAP SuccessFactors Employee Central through the OData V2 API: user profiles, employment and current job information (department, position, manager, cost center).",
  auth: "custom",
  docsUrl: "https://help.sap.com/docs/successfactors-platform/sap-successfactors-api-reference-guide-odata-v2",
  maturity: "preview",
  config: [
    {
      key: "api_url",
      label: "API server URL",
      type: "url",
      required: true,
      placeholder: "https://api4.successfactors.com",
      help: "The OData API server of your data center (see SAP note 2215682), not the UI URL.",
    },
    { key: "company_id", label: "Company ID", type: "string", required: true },
    {
      key: "auth_type",
      label: "Authentication",
      type: "select",
      default: "basic",
      options: [
        { value: "basic", label: "Basic authentication (API user)" },
        { value: "oauth2", label: "OAuth 2.0 SAML bearer (registered OAuth client)" },
      ],
    },
    { key: "username", label: "API username", type: "string", help: "Basic authentication: user id (without @company)." },
    { key: "password", label: "API password", type: "password", secret: true },
    { key: "client_id", label: "OAuth client ID (API key)", type: "string" },
    { key: "oauth_user_id", label: "Technical user id", type: "string", help: "User the OAuth token is issued for." },
    { key: "private_key", label: "OAuth private key", type: "textarea", secret: true, help: "Private key of the X.509 certificate registered for the OAuth client." },
  ],
  operations: [
    readOp("search_users", "Search users", "Employees (User entity) by name, e-mail or user id, optionally by department and status.", {
      query: str("Name, e-mail or user id"),
      department: str("Department name"),
      status: oneOf(["active", "inactive"], "Employment status"),
      top: int("Maximum number of results (default 25, max 500)"),
    }),
    readOp("get_user", "Get user", "Profile of one employee incl. manager.", {
      user_id: str("SuccessFactors user id"),
    }, ["user_id"]),
    readOp("get_employment", "Get employment", "Employment (EmpEmployment) and current job information (EmpJob) of an employee.", {
      user_id: str("SuccessFactors user id"),
    }, ["user_id"]),
  ],
  itRequirements: [
    "An API user (technical user) with a permission role granting 'Employee Central API' access and read access to User, EmpEmployment and EmpJob for the relevant population",
    "Preferred: an OAuth 2.0 client application registered in Admin Center > Manage OAuth2 Client Applications with an X.509 certificate (provide API key, technical user id and private key); basic authentication is being retired by SAP",
    "The API server URL of your data center and the company ID",
    "Outbound HTTPS from Enterprise Brain to the SuccessFactors API server",
  ],
});

export const successFactorsConnector = defineConnector({
  manifest,

  async test(ctx) {
    await sf(ctx, "User", { $top: 1, $select: "userId" });
    return { ok: true, message: `Connected to ${SERVICE} (company ${requireConfig(ctx, "company_id")}).` };
  },

  operations: {
    async search_users(input, ctx) {
      const top = optLimit(input, "top", 25, 500);
      const filters: string[] = [];
      const query = optString(input, "query");
      const department = optString(input, "department");
      const status = optEnum(input, "status", ["active", "inactive"] as const);
      if (query) {
        const q = odataString(query);
        filters.push(`(substringof(${q},displayName) or substringof(${q},email) or userId eq ${q})`);
      }
      if (department) filters.push(`department eq ${odataString(department)}`);
      if (status) filters.push(`status eq ${status === "active" ? "'t'" : "'f'"}`);
      const { items, hasMore } = await collect(ctx, "User", {
        $select: USER_SELECT,
        $expand: "manager",
        $filter: filters.length ? filters.join(" and ") : undefined,
        $top: top,
      }, top);
      return { items, total: items.length, has_more: hasMore };
    },

    async get_user(input, ctx) {
      const response = await sf(ctx, odataKey("User", reqString(input, "user_id")), { $select: USER_SELECT, $expand: "manager" });
      return odataV2Entity(response.data);
    },

    async get_employment(input, ctx) {
      const userId = reqString(input, "user_id");
      const filter = `userId eq ${odataString(userId)}`;
      const [employment, job] = await Promise.all([
        collect(ctx, "EmpEmployment", {
          $filter: filter,
          $select: "personIdExternal,userId,startDate,endDate,originalStartDate,seniorityDate,isContingentWorker,lastDateWorked",
        }, 5),
        collect(ctx, "EmpJob", {
          $filter: filter,
          $select:
            "userId,startDate,jobTitle,jobCode,position,department,division,location,company,businessUnit,costCenter,managerId,employmentType,emplStatus,fte,standardHours,payGrade,eventReason",
          $orderby: "startDate desc",
          $top: 1,
        }, 1),
      ]);
      if (employment.items.length === 0 && job.items.length === 0) {
        throw new ConnectorError(`No employment found for user ${userId}`, "not_found");
      }
      return { user_id: userId, employment: employment.items[0] ?? null, job: job.items[0] ?? null, employments: employment.items };
    },
  },
});
