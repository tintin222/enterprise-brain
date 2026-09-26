import { createHash } from "node:crypto";
import { Agent, request } from "node:https";
import type { ConfigFieldInput } from "./define.ts";
import { ConnectorError } from "./types.ts";

/**
 * Connections that sign in with a client certificate (mutual TLS), or reach systems whose certificate
 * a company's own authority issued. Any connector that declares these fields gets a fetch that
 * presents the certificate and trusts the authority.
 */

export const TLS_CONFIG: ConfigFieldInput[] = [
  {
    key: "client_certificate",
    label: "Client certificate (PEM)",
    type: "textarea",
    placeholder: "-----BEGIN CERTIFICATE-----",
    help: "For systems that sign callers in with a certificate (mutual TLS). Include intermediate certificates after it.",
  },
  { key: "client_key", label: "Client certificate's private key (PEM)", type: "textarea", secret: true, placeholder: "-----BEGIN PRIVATE KEY-----" },
  { key: "client_key_passphrase", label: "Private key passphrase", type: "password", secret: true },
  {
    key: "ca_certificate",
    label: "Trusted certificate authority (PEM)",
    type: "textarea",
    placeholder: "-----BEGIN CERTIFICATE-----",
    help: "When the system's certificate comes from your company's own authority.",
  },
];

export interface TlsOptions {
  cert?: string;
  key?: string;
  passphrase?: string;
  ca?: string;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

/** The TLS options a connection's settings ask for, or undefined when none. */
export function tlsOptionsFrom(config: Record<string, unknown>, secrets: Record<string, string>): TlsOptions | undefined {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const cert = text(config.client_certificate);
  const key = text(secrets.client_key);
  const ca = text(config.ca_certificate);
  if (!cert && !key && !ca) return undefined;
  if (cert && !PEM_CERT.test(cert)) throw new ConnectorError("The client certificate must be in PEM format (-----BEGIN CERTIFICATE-----)", "config");
  if (cert && !key) throw new ConnectorError("Give the client certificate's private key too", "config");
  if (key && !cert) throw new ConnectorError("Give the client certificate too, not only its private key", "config");
  if (key && !PEM_KEY.test(key)) throw new ConnectorError("The private key must be in PEM format (-----BEGIN PRIVATE KEY-----)", "config");
  if (ca && !PEM_CERT.test(ca)) throw new ConnectorError("The certificate authority must be in PEM format (-----BEGIN CERTIFICATE-----)", "config");
  return {
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(text(secrets.client_key_passphrase) ? { passphrase: secrets.client_key_passphrase } : {}),
    ...(ca ? { ca } : {}),
  };
}

const agents = new Map<string, Agent>();

function agentFor(options: TlsOptions): Agent {
  const id = createHash("sha256").update(JSON.stringify(options)).digest("hex");
  let agent = agents.get(id);
  if (!agent) {
    try {
      agent = new Agent({ ...options, keepAlive: true, maxSockets: 10 });
    } catch (error) {
      throw new ConnectorError(`The certificate settings can't be used: ${(error as Error).message}`, "config");
    }
    agents.set(id, agent);
  }
  return agent;
}

const NO_BODY = new Set([101, 204, 205, 304]);
const MAX_REDIRECTS = 5;

function bodyOf(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new ConnectorError("This request body can't be sent with a client certificate", "unsupported");
}

/**
 * A fetch that presents a client certificate and trusts the given authority (https only). It follows
 * redirects within the same site (the certificate is never shown to another one).
 */
export function tlsFetch(options: TlsOptions): typeof fetch {
  const agent = agentFor(options);
  const once = (url: URL, init: RequestInit, body: Buffer | undefined): Promise<Response> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => (headers[key] = value));
      if (body && !headers["content-length"]) headers["content-length"] = String(body.length);
      const req = request(url, { method: init.method ?? "GET", headers, agent, signal: init.signal ?? undefined }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
            else if (value !== undefined) responseHeaders.set(key, String(value));
          }
          const status = res.statusCode ?? 502;
          resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
        });
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });

  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") throw new ConnectorError(`Certificates are only used over https (${url.origin})`, "config");
    const body = bodyOf(init.body);
    let response = await once(url, init, body);
    for (let hops = 0; hops < MAX_REDIRECTS && [301, 302, 303, 307, 308].includes(response.status); hops++) {
      const location = response.headers.get("location");
      if (!location) break;
      const next = new URL(location, url);
      if (next.origin !== url.origin)
        throw new ConnectorError(`The system redirected to another site (${next.origin}); not followed with the certificate`, "remote");
      const keepsBody = response.status === 307 || response.status === 308;
      url = next;
      response = await once(url, keepsBody ? init : { ...init, method: init.method === "HEAD" ? "HEAD" : "GET" }, keepsBody ? body : undefined);
    }
    return response;
  }) as typeof fetch;
}
