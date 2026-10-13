import { createHmac, timingSafeEqual } from "node:crypto";
import { defineConnector, defineManifest } from "../define.ts";

/**
 * Replaced: each AI employee has its own webhook address (with its own secret or signature) and its own
 * public form, on its page in the Studio (Duties). Kept so connections made before still show; its
 * signing helpers are what those addresses check signatures with.
 */

export const SUBMISSION_EVENT = {
  id: "submission",
  name: "Submission received",
  description: "A web form submission or webhook call arrived; the event data holds the submitted fields and the ids of uploaded files.",
};

const manifest = defineManifest({
  type: "webhook-inbound",
  name: "Inbound webhook / web form",
  vendor: "Enterprise Brain",
  category: "web",
  description:
    "Replaced by each AI employee's own webhook address and public form: open the AI employee in the Studio, Duties, " +
    "to give its address (with a secret or a signature) to another system, or the link of its form to people.",
  auth: "none",
  maturity: "deprecated",
  config: [
    {
      key: "shared_secret",
      label: "Signing secret",
      type: "password",
      secret: true,
      help: "Optional. Senders sign the raw request body with HMAC-SHA256 and send it as X-Signature: sha256=<hex>; unsigned or wrongly signed calls are rejected.",
    },
    {
      key: "allowed_origins",
      label: "Allowed origins",
      type: "string",
      placeholder: "https://careers.acme.com",
      help: "Comma-separated website origins allowed to submit from the browser (CORS).",
    },
    { key: "max_file_mb", label: "Max upload size per file (MB)", type: "number", default: 10 },
  ],
  operations: [],
  events: [SUBMISSION_EVENT],
  itRequirements: [
    "For forms on the company website: allow the Enterprise Brain form endpoint in the site's Content-Security-Policy (form-action / connect-src) or embed the hosted form",
    "For system-to-system webhooks: the sending system must be able to POST JSON over HTTPS and, if a signing secret is used, compute an HMAC-SHA256 signature of the raw body",
    "Public reachability of the Enterprise Brain webhook endpoint (or an allow-list rule on the reverse proxy)",
  ],
});

export const webhookInboundConnector = defineConnector({
  manifest,
  async test() {
    return {
      ok: true,
      message: "Inbound webhook is ready: submissions to the webhook URL shown for this integration trigger the bound agent.",
    };
  },
  operations: {},
});

/** Signature header value (`sha256=<hex>`) for a raw request body. */
export function signWebhookPayload(secret: string, rawBody: string | Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Constant-time check of an `X-Signature: sha256=<hex>` header against the raw request body. */
export function verifyWebhookSignature(secret: string, rawBody: string | Uint8Array, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}
