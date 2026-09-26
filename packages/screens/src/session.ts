import type { ScreenTarget } from "@enterprise-brain/connectors";
import type { BrowserState } from "@enterprise-brain/llm";
import type { Browser, BrowserContext, Dialog, Frame, Page, Route } from "playwright-core";

/** A problem to tell Claude about (it can try another way), rather than a failure of the job. */
export class ScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenError";
  }
}

export interface SessionOptions {
  target: ScreenTarget;
  /** Nothing may change: in web systems requests that send data are blocked (except to formPaths), and dialogs are answered Cancel. */
  readOnly: boolean;
  formPaths: string[];
  viewport: { width: number; height: number };
  /** How long one action may take (ms). */
  actionTimeoutMs: number;
}

/** An element reference handed to Claude: the frame and document it lives in, and its number there. */
export interface ElementRef {
  frame: Frame;
  doc: string;
  id: number;
}

export interface Tab {
  id: string;
  page: Page;
  /** ref_N → element; references are never renumbered while the tab lives. */
  refs: Map<string, ElementRef>;
  keys: Map<string, string>;
  next: number;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SECRET_PARAM = /(token|session|sid|auth|key|pass|secret|code|ticket|sig)/i;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** "Order system" → "Order system's", "Orders" → "Orders'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** A host allowed by a pattern: "erp.acme.local", or "*.acme.local" for the hosts below it. */
export function hostMatches(host: string, pattern: string): boolean {
  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const h = host.toLowerCase();
  if (!p) return false;
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) || h === p.slice(2);
  return h === p;
}

/** A URL fit to show Claude: no session ids or tokens in it, no control characters, not too long. */
export function safeUrl(raw: string): string {
  let text = raw;
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/;jsessionid=[^/?#]*/gi, "");
    for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.set(key, "…");
    url.username = "";
    url.password = "";
    text = url.toString();
  } catch {
    // Not a URL (about:blank): shown as it is.
  }
  return text.replace(CONTROL, "").slice(0, 2000);
}

export function safeTitle(raw: string): string {
  return raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * One job's browser: a fresh context (no cookies from other jobs) whose requests are checked. Documents,
 * frames, websockets and anything that sends data go only to the system's own addresses; in a web
 * system's read, requests that send data are blocked except to the sign-in and search pages IT named.
 * Pages' dialogs are answered (Cancel when only reading), downloads are refused, and what was blocked or
 * answered is told to Claude with the next result.
 */
export class ScreenSession {
  readonly trail: string[] = [];
  /** Where the pointer is, for the computer toolset (Playwright doesn't say). */
  cursor = { x: 0, y: 0 };
  private notices: string[] = [];
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private counter = 0;
  private opened: string[] = [];
  private readonly patterns: string[];

  private constructor(
    readonly context: BrowserContext,
    readonly options: SessionOptions,
  ) {
    this.patterns = [new URL(options.target.startUrl).host, ...options.target.allowedHosts];
  }

  static async open(browser: Browser, options: SessionOptions): Promise<ScreenSession> {
    const { target } = options;
    const start = new URL(target.startUrl);
    const { username, password } = target.credentials;
    const context = await browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
      ignoreHTTPSErrors: Boolean(target.acceptInvalidCertificates),
      ...(target.httpAuth && username ? { httpCredentials: { username, password: password ?? "", origin: start.origin } } : {}),
    });
    context.setDefaultTimeout(options.actionTimeoutMs);
    context.setDefaultNavigationTimeout(Math.max(options.actionTimeoutMs, 30_000));
    const session = new ScreenSession(context, options);
    await context.route("**/*", (route) => session.guard(route));
    await context.routeWebSocket(/.*/, (ws) => {
      let url: URL | undefined;
      try {
        url = new URL(ws.url());
      } catch {
        url = undefined;
      }
      if (url && session.allowed(url)) ws.connectToServer();
      else {
        session.notice(`Blocked: a connection to ${url?.host ?? "another address"}, which is not one of ${possessive(target.system)} addresses.`);
        void ws.close({ code: 1008, reason: "Not allowed" });
      }
    });
    context.on("page", (page) => session.adopt(page));
    session.adopt(await context.newPage());
    return session;
  }

  /** The system's own addresses: the start page's host and the ones IT added. */
  allowed(url: URL): boolean {
    return this.patterns.some((p) => hostMatches(url.host, p) || hostMatches(url.hostname, p));
  }

  private formAllowed(url: URL): boolean {
    const path = url.pathname.toLowerCase();
    return this.options.formPaths.some((entry) => {
      let wanted = entry.trim();
      try {
        if (/^https?:\/\//i.test(wanted)) wanted = new URL(wanted).pathname;
      } catch {
        return false;
      }
      wanted = wanted.toLowerCase().replace(/\?.*$/, "");
      if (!wanted.startsWith("/")) wanted = `/${wanted}`;
      return path.startsWith(wanted);
    });
  }

  private async guard(route: Route): Promise<void> {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.abort("blockedbyclient");
    }
    const method = request.method().toUpperCase();
    const document = request.resourceType() === "document";
    // A page that is not loaded stays as it was: the answer "no content" keeps the tab on its page.
    const refuse = () => (document ? route.fulfill({ status: 204, body: "" }) : route.abort("blockedbyclient"));
    if (!this.allowed(url) && (document || !SAFE_METHODS.has(method))) {
      this.notice(
        `Blocked: ${url.host} is not one of ${possessive(this.options.target.system)} addresses, so ${safeUrl(`${url.origin}${url.pathname}`)} was not ${document ? "opened" : "sent anything"}.`,
      );
      return refuse();
    }
    if (this.options.readOnly && this.options.target.kind === "web" && !SAFE_METHODS.has(method) && !this.formAllowed(url)) {
      this.notice(`Blocked: sending data to ${url.pathname} (${method}). This job only reads, so nothing was changed.`);
      return refuse();
    }
    return route.continue();
  }

  private adopt(page: Page): void {
    if (this.tabs.some((t) => t.page === page)) return;
    const tab: Tab = { id: `tab-${++this.counter}`, page, refs: new Map(), keys: new Map(), next: 1 };
    this.tabs.push(tab);
    if (!this.activeId) this.activeId = tab.id;
    else this.opened.push(tab.id);
    page.on("dialog", (dialog) => void this.answer(dialog));
    page.on("download", (download) => {
      this.notice(`A download (${safeTitle(download.suggestedFilename())}) was not kept: files can't be downloaded here.`);
      void download.cancel().catch(() => {});
    });
    page.on("close", () => {
      const index = this.tabs.indexOf(tab);
      if (index >= 0) this.tabs.splice(index, 1);
      if (this.activeId === tab.id) this.activeId = this.tabs.at(-1)?.id ?? null;
    });
  }

  private async answer(dialog: Dialog): Promise<void> {
    const type = dialog.type();
    const accept = !this.options.readOnly || type === "alert" || type === "beforeunload";
    const message = this.redact(safeTitle(dialog.message())) || "(no text)";
    const kind =
      type === "alert"
        ? "a message"
        : type === "confirm"
          ? "a question"
          : type === "prompt"
            ? "a question to type an answer to"
            : "a question about leaving the page";
    this.notice(`The page showed ${kind}: “${message}”. It was answered ${accept ? "OK" : "Cancel, because this job only reads"}.`);
    try {
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    } catch {
      // The page went away meanwhile.
    }
  }

  /** Something Claude should hear with the next result (a blocked request, a dialog). */
  notice(text: string): void {
    if (this.notices.at(-1) !== text) this.notices.push(text);
    this.log(text);
  }

  takeNotices(): string[] {
    const notices = this.notices;
    this.notices = [];
    return notices;
  }

  /** The job's trail: what was done, one line each (never a secret). */
  log(line: string): void {
    if (this.trail.length < 200) this.trail.push(this.redact(line).slice(0, 300));
  }

  get tabList(): readonly Tab[] {
    return this.tabs;
  }

  tab(id?: string): Tab {
    const tab = id ? this.tabs.find((t) => t.id === id) : this.tabs.find((t) => t.id === this.activeId);
    if (!tab) throw new ScreenError(id ? `There is no tab ${id}.` : "No tab is open: open one with new_tab.");
    return tab;
  }

  get page(): Page {
    return this.tab().page;
  }

  activate(id: string): Tab {
    const tab = this.tab(id);
    this.activeId = tab.id;
    return tab;
  }

  async newTab(): Promise<Tab> {
    const page = await this.context.newPage();
    this.adopt(page);
    const tab = this.tabs.find((t) => t.page === page)!;
    this.activeId = tab.id;
    return tab;
  }

  /** The tabs as the browser toolset reports them, with the tabs opened since the last report. */
  async browserState(): Promise<BrowserState> {
    const tabs = await Promise.all(
      this.tabs.map(async (t) => ({
        tab_id: t.id,
        title: this.redact(safeTitle(await t.page.title().catch(() => ""))),
        url: this.redact(safeUrl(t.page.url())),
        ...(t.id === this.activeId ? { active: true } : {}),
      })),
    );
    const opened = this.opened.filter((id) => this.tabs.some((t) => t.id === id));
    this.opened = [];
    return { tabs, ...(opened.length ? { state_changes: opened.map((tab_id) => ({ type: "tab_opened" as const, tab_id })) } : {}) };
  }

  /** The sign-in values where Claude wrote {{username}} and {{password}}; the password only into a password field. */
  fill(text: string, field: "password" | "other" | "unknown"): string {
    const { username, password } = this.options.target.credentials;
    if (text.includes("{{password}}")) {
      if (!password) throw new ScreenError("No password is set for this system: IT adds it to the connection.");
      if (field === "other") throw new ScreenError("The password can only be typed into a password field.");
    }
    if (text.includes("{{username}}") && !username) throw new ScreenError("No username is set for this system: IT adds it to the connection.");
    return text
      .split("{{username}}")
      .join(username ?? "")
      .split("{{password}}")
      .join(password ?? "");
  }

  /** Text for Claude with the password taken out, should a page show it. */
  redact(text: string): string {
    const { password } = this.options.target.credentials;
    return password && password.length >= 4 ? text.split(password).join("{{password}}") : text;
  }

  async screenshot(page: Page = this.page): Promise<Buffer> {
    return page.screenshot({ type: "png", timeout: 15_000 });
  }

  /** A region of the viewport, rendered larger (up to 4×) to fit the usual screenshot size: small text becomes legible. */
  async zoom(region: unknown, page: Page = this.page): Promise<Buffer> {
    const { width, height } = this.options.viewport;
    if (!Array.isArray(region) || region.length !== 4 || !region.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new ScreenError("region must be [x0, y0, x1, y1] in screenshot pixels.");
    }
    const [x0, y0, x1, y1] = region.map((v: number) => Math.round(v)) as [number, number, number, number];
    const left = Math.max(0, Math.min(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    const right = Math.min(width, Math.max(x0, x1));
    const bottom = Math.min(height, Math.max(y0, y1));
    if (right - left < 4 || bottom - top < 4)
      throw new ScreenError(`The region must lie inside the ${width}×${height} screen and be at least 4 pixels wide and high.`);
    const w = right - left;
    const h = bottom - top;
    const scale = Math.max(1, Math.min(4, width / w, height / h));
    const cdp = await this.context.newCDPSession(page);
    try {
      const { x, y } = (await page.evaluate(
        "({ x: window.visualViewport ? visualViewport.pageLeft : scrollX, y: window.visualViewport ? visualViewport.pageTop : scrollY })",
      )) as {
        x: number;
        y: number;
      };
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: left + x, y: top + y, width: w, height: h, scale } })) as {
        data: string;
      };
      return Buffer.from(shot.data, "base64");
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /** After an action: give the page a moment, and wait for a page it started loading. */
  async settle(page: Page = this.page): Promise<void> {
    await page.waitForTimeout(250).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("load", { timeout: 3_000 }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}
