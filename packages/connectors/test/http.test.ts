import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanODataV2,
  clearTokenCache,
  ConnectorError,
  encodeQuery,
  extractErrorMessage,
  fromODataV2Date,
  getClientCredentialsToken,
  httpError,
  httpRequest,
  odataKey,
  odataString,
  odataV2Collection,
  odataV2DateTimeLiteral,
  requestJson,
  toODataV2Date,
  withTokenRetry,
} from "../src/index.ts";
import { FakeFetch, empty, expectConnectorError, json, text } from "./helpers.ts";

describe("httpRequest", () => {
  it("sends JSON, encodes query parameters with %20 and parses JSON responses", async () => {
    const fake = new FakeFetch().on("POST", "https://api.example.com/items", (req) => json({ echo: req.json }, 201));
    const response = await httpRequest<{ echo: unknown }>(fake.fetch, "https://api.example.com/items", {
      method: "POST",
      json: { name: "Çelik sac" },
      query: { $filter: "name eq 'a b'", skip: undefined, tags: ["x", "y"] },
    });
    expect(response.status).toBe(201);
    expect(response.data.echo).toEqual({ name: "Çelik sac" });
    const call = fake.calls[0]!;
    // The WHATWG URL parser (used by fetch) normalises ' to %27 in query strings.
    expect(call.url.search).toBe("?$filter=name%20eq%20%27a%20b%27&tags=x&tags=y");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("accept")).toBe("application/json");
  });

  it("maps HTTP errors to ConnectorError codes with the remote message", async () => {
    const fake = new FakeFetch()
      .on("GET", "https://api.example.com/401", json({ error: "invalid_token", error_description: "expired" }, 401))
      .on("GET", "https://api.example.com/403", json({ message: "forbidden" }, 403))
      .on("GET", "https://api.example.com/404", json({ error: { code: "NotFound", message: "no such item" } }, 404))
      .on("GET", "https://api.example.com/422", json([{ errorCode: "REQUIRED_FIELD_MISSING", message: "LastName" }], 422))
      .on("GET", "https://api.example.com/429", text("slow down", 429))
      .on("GET", "https://api.example.com/500", json({ error: { code: "/IWBEP/CM_MGW_RT/020", message: { lang: "en", value: "Backend down" } } }, 500));
    const call = (path: string) => expectConnectorError(requestJson(fake.fetch, `https://api.example.com/${path}`, { service: "Demo" }));
    expect(await call("401")).toMatchObject({ code: "auth", status: 401, message: "Demo returned HTTP 401: invalid_token: expired" });
    expect(await call("403")).toMatchObject({ code: "auth", status: 403 });
    expect(await call("404")).toMatchObject({ code: "not_found", message: "Demo returned HTTP 404: NotFound: no such item" });
    expect(await call("422")).toMatchObject({ code: "validation", message: "Demo returned HTTP 422: REQUIRED_FIELD_MISSING: LastName" });
    expect(await call("429")).toMatchObject({ code: "remote", status: 429 });
    expect(await call("500")).toMatchObject({ code: "remote", message: "Demo returned HTTP 500: /IWBEP/CM_MGW_RT/020: Backend down" });
  });

  it("reports network failures as remote errors", async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    const error = await expectConnectorError(requestJson(failing, "https://down.example.com", { service: "Down" }));
    expect(error.code).toBe("remote");
    expect(error.message).toBe("Could not reach Down: fetch failed");
  });

  it("returns undefined for empty bodies and bytes when asked", async () => {
    const fake = new FakeFetch()
      .on("DELETE", "https://api.example.com/x", empty(204))
      .on("GET", "https://api.example.com/file", () => new Response(new Uint8Array([1, 2, 3])));
    expect((await httpRequest(fake.fetch, "https://api.example.com/x", { method: "DELETE" })).data).toBeUndefined();
    const bytes = await httpRequest<Uint8Array>(fake.fetch, "https://api.example.com/file", { responseType: "bytes" });
    expect([...bytes.data]).toEqual([1, 2, 3]);
  });

  it("extracts messages from common error payloads", () => {
    expect(extractErrorMessage("<html><body><h1>Bad gateway</h1></body></html>")).toBe("Bad gateway");
    expect(extractErrorMessage({ status: "error", message: "Property values were not valid" })).toBe("Property values were not valid");
    expect(httpError(400, { error: { code: 400, message: "Invalid id", status: "INVALID_ARGUMENT" } }, "Gmail").message).toBe(
      "Gmail returned HTTP 400: INVALID_ARGUMENT: Invalid id",
    );
  });

  it("encodes queries without touching $ in keys", () => {
    expect(encodeQuery({ $top: 5, "sap-client": "100", q: "a&b=c" })).toBe("$top=5&sap-client=100&q=a%26b%3Dc");
  });
});

describe("OAuth 2.0 client credentials token cache", () => {
  beforeEach(() => clearTokenCache());
  afterEach(() => vi.useRealTimers());

  const tokenUrl = "https://login.example.com/oauth2/token";

  function tokenServer(expiresIn: number | undefined) {
    let issued = 0;
    const fake = new FakeFetch().on("POST", tokenUrl, () => {
      issued++;
      return json({ access_token: `token-${issued}`, token_type: "Bearer", ...(expiresIn === undefined ? {} : { expires_in: expiresIn }) });
    });
    return { fake, issued: () => issued };
  }

  it("requests a token with the client credentials grant and caches it until shortly before expiry", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T10:00:00Z") });
    const { fake, issued } = tokenServer(3600);
    const options = { tokenUrl, clientId: "app", clientSecret: "s3cret", scope: "https://graph.example.com/.default" };
    const first = await getClientCredentialsToken(fake.fetch, options);
    expect(first).toMatchObject({ accessToken: "token-1", fromCache: false });
    const form = fake.calls[0]!.form!;
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      scope: "https://graph.example.com/.default",
      client_id: "app",
      client_secret: "s3cret",
    });

    expect(await getClientCredentialsToken(fake.fetch, options)).toMatchObject({ accessToken: "token-1", fromCache: true });
    vi.setSystemTime(new Date("2026-09-24T10:58:00Z"));
    expect((await getClientCredentialsToken(fake.fetch, options)).accessToken).toBe("token-1");
    vi.setSystemTime(new Date("2026-09-24T10:59:30Z"));
    expect((await getClientCredentialsToken(fake.fetch, options)).accessToken).toBe("token-2");
    expect(issued()).toBe(2);
  });

  it("keys the cache by token URL, client id, scope and secret", async () => {
    const { fake, issued } = tokenServer(3600);
    await getClientCredentialsToken(fake.fetch, { tokenUrl, clientId: "a", clientSecret: "x" });
    await getClientCredentialsToken(fake.fetch, { tokenUrl, clientId: "b", clientSecret: "x" });
    await getClientCredentialsToken(fake.fetch, { tokenUrl, clientId: "a", clientSecret: "rotated" });
    await getClientCredentialsToken(fake.fetch, { tokenUrl, clientId: "a", clientSecret: "x", scope: "other" });
    await getClientCredentialsToken(fake.fetch, { tokenUrl, clientId: "a", clientSecret: "x" });
    expect(issued()).toBe(4);
  });

  it("shares one in-flight request between concurrent callers and supports HTTP Basic client auth", async () => {
    const { fake, issued } = tokenServer(600);
    const options = { tokenUrl, clientId: "app", clientSecret: "pw", clientAuth: "basic" as const };
    const tokens = await Promise.all([1, 2, 3].map(() => getClientCredentialsToken(fake.fetch, options)));
    expect(new Set(tokens.map((t) => t.accessToken))).toEqual(new Set(["token-1"]));
    expect(issued()).toBe(1);
    expect(fake.calls[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("app:pw").toString("base64")}`);
    expect(fake.calls[0]!.form!.get("client_secret")).toBeNull();
  });

  it("maps token endpoint rejections to auth errors", async () => {
    const fake = new FakeFetch().on("POST", tokenUrl, json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" }, 401));
    const error = await expectConnectorError(getClientCredentialsToken(fake.fetch, { tokenUrl, clientId: "a", clientSecret: "bad" }));
    expect(error.code).toBe("auth");
    expect(error.message).toContain("AADSTS7000215");
    const badRequest = new FakeFetch().on("POST", tokenUrl, json({ error: "invalid_grant" }, 400));
    expect((await expectConnectorError(getClientCredentialsToken(badRequest.fetch, { tokenUrl, clientId: "a", clientSecret: "b" }))).code).toBe("auth");
  });

  it("withTokenRetry refreshes a cached token once after a 401", async () => {
    const { fake, issued } = tokenServer(3600);
    const options = { tokenUrl, clientId: "app", clientSecret: "pw" };
    await getClientCredentialsToken(fake.fetch, options);
    const seen: string[] = [];
    const result = await withTokenRetry(
      (force) => getClientCredentialsToken(fake.fetch, options, force),
      async (token) => {
        seen.push(token.accessToken);
        if (token.accessToken === "token-1") throw new ConnectorError("revoked", "auth", 401);
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(seen).toEqual(["token-1", "token-2"]);
    expect(issued()).toBe(2);
  });
});

describe("OData helpers", () => {
  it("quotes strings and builds key predicates", () => {
    expect(odataString("O'Reilly")).toBe("'O''Reilly'");
    expect(odataKey("A_PurchaseOrder", "4500000123")).toBe("A_PurchaseOrder('4500000123')");
    expect(odataKey("A_SupplierInvoice", { SupplierInvoice: "5105600001", FiscalYear: "2026" })).toBe(
      "A_SupplierInvoice(SupplierInvoice='5105600001',FiscalYear='2026')",
    );
    expect(odataKey("User", "a b/c")).toBe("User('a%20b%2Fc')");
  });

  it("converts OData V2 dates", () => {
    expect(toODataV2Date("2026-09-01")).toBe(`/Date(${Date.UTC(2026, 8, 1)})/`);
    expect(fromODataV2Date(`/Date(${Date.UTC(2026, 8, 1)})/`)).toBe("2026-09-01");
    expect(fromODataV2Date(`/Date(${Date.UTC(2026, 8, 1, 12, 30)}+0000)/`)).toBe("2026-09-01T12:30:00.000Z");
    expect(odataV2DateTimeLiteral("2026-01-31")).toBe("datetime'2026-01-31T00:00:00'");
  });

  it("cleans OData V2 payloads", () => {
    const body = {
      d: {
        results: [
          {
            __metadata: { uri: "x" },
            PurchaseOrder: "4500000001",
            CreationDate: `/Date(${Date.UTC(2026, 0, 15)})/`,
            to_PurchaseOrderItem: { results: [{ __metadata: {}, PurchaseOrderItem: "10" }] },
            to_Supplier: { __deferred: { uri: "y" } },
          },
        ],
        __next: "https://s4/next?$skiptoken=1",
      },
    };
    const page = odataV2Collection(body);
    expect(page.next).toBe("https://s4/next?$skiptoken=1");
    expect(page.items).toEqual([{ PurchaseOrder: "4500000001", CreationDate: "2026-01-15", to_PurchaseOrderItem: [{ PurchaseOrderItem: "10" }] }]);
    expect(cleanODataV2({ a: [{ __metadata: {}, b: 1 }] })).toEqual({ a: [{ b: 1 }] });
  });
});
