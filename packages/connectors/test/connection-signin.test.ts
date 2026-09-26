import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, restApiConnector, tlsFetch, tlsOptionsFrom } from "../src/index.ts";
import { expectConnectorError, FakeFetch, json, makeCtx, run } from "./helpers.ts";

/**
 * How web-service connections sign in: OAuth 2.0 with the connection's own credentials, or with the
 * refresh token someone's sign-in left (replaced when the provider rotates it), and client
 * certificates (mutual TLS) with a company's own certificate authority.
 */

const API = "https://orders.acme.example/api";
const TOKEN = "https://login.acme.example/oauth2/token";

describe("OAuth 2.0 for web services", () => {
  beforeEach(() => clearTokenCache());

  it("gets a token with the connection's credentials, and a new one when the system refuses it", async () => {
    let issued = 0;
    const fake = new FakeFetch()
      .on("POST", TOKEN, () => json({ access_token: `token-${++issued}`, token_type: "Bearer", expires_in: 3600 }))
      .on("GET", `${API}/orders/4711`, json({ id: 4711 }));
    const ctx = makeCtx({
      fetch: fake.fetch,
      config: {
        base_url: API,
        auth_type: "oauth2_client_credentials",
        token_url: TOKEN,
        client_id: "brain",
        scope: "orders.read",
        audience: "https://orders.acme.example",
      },
      secrets: { client_secret: "s3cret" },
    });
    expect(await run(restApiConnector, "http_get", { path: "/orders/4711" }, ctx)).toMatchObject({ ok: true, status: 200, data: { id: 4711 } });
    expect(Object.fromEntries(fake.callsTo("POST", TOKEN)[0]!.form!)).toEqual({
      grant_type: "client_credentials",
      scope: "orders.read",
      audience: "https://orders.acme.example",
      client_id: "brain",
      client_secret: "s3cret",
    });
    // The cached token is refused (revoked early): a fresh one, once.
    fake.once("GET", `${API}/orders/4711`, json({ error: "expired" }, 401));
    await run(restApiConnector, "http_get", { path: "/orders/4711" }, ctx);
    expect(fake.callsTo("GET", `${API}/orders/4711`).map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  it("uses the refresh token someone's sign-in left, and keeps the one the provider rotates to", async () => {
    const saved: Record<string, string>[] = [];
    const fake = new FakeFetch()
      .on("POST", TOKEN, (request) => {
        expect(request.form!.get("grant_type")).toBe("refresh_token");
        expect(request.form!.get("refresh_token")).toBe("refresh-1");
        return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      })
      .on("GET", `${API}/customers`, json([{ id: "C-1" }]));
    const ctx = makeCtx({
      fetch: fake.fetch,
      config: {
        base_url: API,
        auth_type: "oauth2_authorization_code",
        token_url: TOKEN,
        client_id: "brain",
        authorize_url: "https://login.acme.example/authorize",
      },
      secrets: { client_secret: "s3cret", refresh_token: "refresh-1" },
      saveSecrets: async (patch) => {
        saved.push(patch);
      },
    });
    expect(await run(restApiConnector, "http_get", { path: "/customers" }, ctx)).toMatchObject({ data: [{ id: "C-1" }] });
    expect(fake.callsTo("GET", `${API}/customers`)[0]!.headers.get("authorization")).toBe("Bearer access-2");
    expect(saved).toEqual([{ refresh_token: "refresh-2" }]);

    const unsigned = makeCtx({ fetch: fake.fetch, config: ctx.config, secrets: { client_secret: "s3cret" } });
    expect((await expectConnectorError(run(restApiConnector, "http_get", { path: "/customers" }, unsigned))).message).toMatch(
      /Nobody signed in to this connection yet/,
    );
  });

  it("never sends credentials to a sign-in address over plain http", async () => {
    const ctx = makeCtx({
      fetch: new FakeFetch().fetch,
      config: { base_url: API, auth_type: "oauth2_client_credentials", token_url: "http://login.acme.example/token", client_id: "brain" },
      secrets: { client_secret: "s3cret" },
    });
    expect((await expectConnectorError(run(restApiConnector, "http_get", { path: "/x" }, ctx))).message).toBe("Token URL must use https");
  });
});

// ---------------------------------------------------------------------------
// Client certificates, against a real HTTPS server that asks for one
// ---------------------------------------------------------------------------

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("client certificates", () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-mtls-"));
  const file = (name: string) => join(dir, name);
  const read = (name: string) => readFileSync(file(name), "utf8");
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  let server: Server;
  let base = "";

  /** A certificate authority, and a certificate it signs for a name (a server's, or a client's). */
  function authority(name: string) {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=${name}`);
  }
  function issue(ca: string, name: string, extensions: string) {
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
    writeFileSync(file(`${name}.ext`), extensions);
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${ca}.pem`,
      "-CAkey",
      `${ca}.key`,
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
    );
  }

  beforeAll(async () => {
    authority("acme-ca");
    authority("stranger-ca");
    issue("acme-ca", "server", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    issue("acme-ca", "brain", "extendedKeyUsage=clientAuth\n");
    issue("stranger-ca", "intruder", "extendedKeyUsage=clientAuth\n");
    server = createServer(
      { key: read("server.key"), cert: read("server.pem"), ca: read("acme-ca.pem"), requestCert: true, rejectUnauthorized: true },
      (request, response) => {
        const peer = (request.socket as import("node:tls").TLSSocket).getPeerCertificate();
        if (request.url === "/moved") {
          response.writeHead(302, { location: "/who" });
          return response.end();
        }
        if (request.url === "/away") {
          response.writeHead(302, { location: "https://elsewhere.example/who" });
          return response.end();
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ caller: peer.subject?.CN, method: request.method }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server?.close(resolve)));

  it("signs in with the certificate, trusting the company's own authority", async () => {
    const tls = tlsOptionsFrom({ client_certificate: read("brain.pem"), ca_certificate: read("acme-ca.pem") }, { client_key: read("brain.key") })!;
    const response = await tlsFetch(tls)(`${base}/who`);
    expect(await response.json()).toEqual({ caller: "brain", method: "GET" });
    // Redirects within the site are followed; to another site, never with the certificate.
    expect(await (await tlsFetch(tls)(`${base}/moved`)).json()).toMatchObject({ caller: "brain" });
    await expect(tlsFetch(tls)(`${base}/away`)).rejects.toThrow(/redirected to another site/);
  });

  it("works through a web-service connection, and fails without a certificate the system trusts", async () => {
    const config = { base_url: base, auth_type: "none", client_certificate: read("brain.pem"), ca_certificate: read("acme-ca.pem") };
    const ctx = makeCtx({ config, secrets: { client_key: read("brain.key") }, fetch: tlsFetch(tlsOptionsFrom(config, { client_key: read("brain.key") })!) });
    expect(await run(restApiConnector, "http_post", { path: "/orders", body: { item: "valve" } }, ctx)).toMatchObject({
      status: 200,
      data: { caller: "brain", method: "POST" },
    });

    const intruder = tlsOptionsFrom({ client_certificate: read("intruder.pem"), ca_certificate: read("acme-ca.pem") }, { client_key: read("intruder.key") })!;
    await expect(tlsFetch(intruder)(`${base}/who`)).rejects.toThrow();
    // Without the company's authority, the server's certificate isn't trusted.
    const untrusting = tlsOptionsFrom({ client_certificate: read("brain.pem") }, { client_key: read("brain.key") })!;
    await expect(tlsFetch(untrusting)(`${base}/who`)).rejects.toThrow(/certificate/i);
  });

  it("checks the certificate settings", () => {
    expect(tlsOptionsFrom({}, {})).toBeUndefined();
    expect(() => tlsOptionsFrom({ client_certificate: read("brain.pem") }, {})).toThrow(/private key too/);
    expect(() => tlsOptionsFrom({ client_certificate: "not a certificate" }, { client_key: read("brain.key") })).toThrow(/PEM/);
    expect(() => tlsFetch({ ca: read("acme-ca.pem") })("http://127.0.0.1/x")).rejects.toThrow(/only used over https/);
  });
});
