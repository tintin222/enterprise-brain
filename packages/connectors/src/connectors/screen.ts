import type { NamedAction } from "@enterprise-brain/core";
import { defineConnector, defineManifest } from "../define.ts";
import { ConnectorError, type ConnectorContext, type ConnectorImplementation, type ScreenOperator, type ScreenTarget } from "../types.ts";
import { configBoolean, configNumber, configString, optionalSecret, requireConfig, type Rec } from "../util.ts";

/**
 * Old systems without an API, used through their screens the way a person at a desk does: Claude's
 * browser use for web systems, and computer use for desktop programs shown in a remote desktop page
 * (Apache Guacamole, noVNC). IT names each action and says what to do in plain words; AI employees see
 * only these actions. The sign-in is typed for them and never shown to them, only the system's own
 * addresses can be opened, and in web systems a read can't send anything but sign-in and search forms.
 */

export const SCREEN_RESERVED_KEYS = ["summary", "screens"] as const;

const manifest = defineManifest({
  type: "screen",
  name: "Old system (through its screens)",
  vendor: "Enterprise Brain",
  category: "other",
  description:
    "Works in a system that has no API the way a person does, through its screens: its web pages (Claude's browser use), or a desktop program shown in a remote desktop page such as Apache Guacamole or noVNC (Claude's computer use). IT names each action and says what to do in plain words; reads can't send changes, and changes wait for approval like any other.",
  auth: "custom",
  maturity: "preview",
  config: [
    {
      key: "start_url",
      label: "Address",
      type: "url",
      required: true,
      placeholder: "https://orders.acme.local/",
      help: "Where the system opens: its sign-in page, or the remote desktop page that shows it.",
    },
    { key: "system_name", label: "System name", type: "string", placeholder: "Order system", help: "How people call it; AI employees see this name." },
    {
      key: "kind",
      label: "What it is",
      type: "select",
      default: "web",
      options: [
        { value: "web", label: "Web pages (browser use)" },
        { value: "desktop", label: "A desktop program in a remote desktop page (computer use)" },
      ],
      help: "Desktop programs are worked by looking at the screen and using the mouse and keyboard; reads there are read-only by instruction, so give the AI employee an account that can do no more than its actions need.",
    },
    { key: "username", label: "Username", type: "string", help: "Typed for the AI employee when it signs in." },
    { key: "password", label: "Password", type: "password", secret: true, help: "Typed for it into the password field; it never sees it." },
    {
      key: "http_auth",
      label: "The browser asks for the username and password (HTTP authentication)",
      type: "boolean",
      default: false,
      showWhen: { key: "kind", values: ["web"] },
    },
    {
      key: "allowed_hosts",
      label: "Other addresses it may open",
      type: "textarea",
      placeholder: "sso.acme.local",
      help: "One host per line (*.acme.local for all below it): the sign-in service the system sends people to. Nothing else can be opened.",
    },
    {
      key: "form_paths",
      label: "Pages a read may send forms to",
      type: "textarea",
      placeholder: "/login\n/orders/search",
      help: "One path per line. A read only opens pages: forms that send data are blocked, except to the sign-in and search pages listed here.",
      showWhen: { key: "kind", values: ["web"] },
    },
    {
      key: "guidance",
      label: "How the system works",
      type: "textarea",
      placeholder: "Orders are under Sales > Orders; search by order number. Dates are shown as DD.MM.YYYY.",
      help: "Told to the AI employee every time it works in the system.",
    },
    { key: "max_steps", label: "Most steps per action", type: "number", default: 40, help: "It stops and says so when an action takes more." },
    {
      key: "accept_invalid_certificates",
      label: "Accept a certificate the browser doesn't trust (your company's own authority)",
      type: "boolean",
      default: false,
    },
  ],
  operations: [],
  itRequirements: [
    "The system's address, reachable from Enterprise Brain (firewall rule or VPN for internal systems)",
    "An account for the AI employee that can do no more than its actions need",
    "For desktop programs: a remote desktop gateway that shows the program in a browser page (Apache Guacamole or noVNC), with a session for that account",
    "The addresses of any sign-in service the system sends people to",
  ],
});

/** A connection's screens: where they are and how they are entered. */
export function screenTarget(ctx: ConnectorContext): ScreenTarget {
  const startUrl = requireConfig(ctx, "start_url", "Address");
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    throw new ConnectorError(`Address: "${startUrl}" is not a web address`, "config");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectorError("Address: use an http or https address", "config");
  const kind = configString(ctx, "kind", "web") === "desktop" ? "desktop" : "web";
  const username = configString(ctx, "username");
  const password = optionalSecret(ctx, "password");
  return {
    system: configString(ctx, "system_name") || url.hostname,
    startUrl: url.toString(),
    kind,
    allowedHosts: lines(configString(ctx, "allowed_hosts")),
    credentials: { ...(username ? { username } : {}), ...(password ? { password } : {}) },
    httpAuth: kind === "web" && configBoolean(ctx, "http_auth", false),
    acceptInvalidCertificates: configBoolean(ctx, "accept_invalid_certificates", false),
  };
}

function lines(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function operatorOf(ctx: ConnectorContext): ScreenOperator {
  if (!ctx.screens) {
    throw new ConnectorError("Working screens needs a browser on the Enterprise Brain server (set EB_BROWSER_PATH, or use the Docker image)", "unsupported");
  }
  return ctx.screens;
}

/** "Open order {order_number}" with { order_number: "PO-4711" } → "Open order “PO-4711”". */
export function fillGoal(goal: string, values: Rec): string {
  return goal.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined || value === null || value === "" ? "(not given)" : `“${String(value)}”`;
  });
}

/** A value read from the screens, as the type the action asked for (left as read when it doesn't convert). */
function asType(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (type === "number" || type === "integer") {
    const n = typeof value === "number" ? value : Number(String(value).replace(/\s/g, ""));
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (/^(true|yes)$/i.test(String(value))) return true;
    if (/^(false|no)$/i.test(String(value))) return false;
    return value;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

const screenImplementation = defineConnector({
  manifest,

  async test(ctx) {
    const target = screenTarget(ctx);
    const check = await operatorOf(ctx).check(target);
    const stored =
      check.screen && ctx.files
        ? await ctx.files.put({ name: `${target.system} start page.png`, data: check.screen, mimeType: "image/png", source: "screen" })
        : undefined;
    return {
      ok: check.ok,
      message: check.message,
      details: { title: check.title ?? null, url: check.url ?? null, ...(stored ? { screenFileId: stored.id } : {}) },
    };
  },

  operations: {},
});

/** The screen connector: its named actions are jobs on the system's screens. */
export const screenConnector: ConnectorImplementation = {
  ...screenImplementation,
  async runAction(action: NamedAction, values: Rec, ctx: ConnectorContext) {
    if (!action.goal?.trim()) throw new ConnectorError(`${action.name} doesn't say what to do on the screens`, "config");
    const target = screenTarget(ctx);
    const returns = action.returns ?? [];
    const outcome = await operatorOf(ctx).operate({
      ...target,
      action: action.name,
      goal: fillGoal(action.goal, values),
      returns,
      readOnly: action.kind === "read",
      formPaths: lines(configString(ctx, "form_paths")),
      guidance: configString(ctx, "guidance"),
      maxSteps: Math.min(200, Math.max(5, configNumber(ctx, "max_steps", 40))),
    });
    if (outcome.usage) ctx.recordUsage?.(outcome.usage);
    const stored =
      outcome.lastScreen && ctx.files
        ? await ctx.files.put({
            name: `${target.system} - ${action.name}.png`,
            data: outcome.lastScreen,
            mimeType: "image/png",
            source: "screen",
            metadata: { action: action.id },
          })
        : undefined;
    if (!outcome.done) {
      throw new ConnectorError(`${target.system}: ${outcome.summary}`, action.kind === "read" ? "not_found" : "remote");
    }
    const result: Rec = {};
    for (const field of returns) result[field.key] = asType(field.type, outcome.result[field.key]);
    if (!returns.length) Object.assign(result, outcome.result);
    for (const key of SCREEN_RESERVED_KEYS) delete result[key];
    return {
      ...result,
      summary: outcome.summary,
      screens: { steps: outcome.steps, trail: outcome.trail, ...(stored ? { lastScreenFileId: stored.id } : {}) },
    };
  },
};
