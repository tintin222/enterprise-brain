import type { ToolsetCall, ToolsetResult } from "@enterprise-brain/llm";
import type { ElementHandle, Frame, Page } from "playwright-core";
import { isModifier, keySequence, modifierKeys } from "./keys.ts";
import { elementExpression, elementIdFunction, readerFunction, type ReaderNode, type ReaderOp, type ReaderResult } from "./page-reader.ts";
import { ScreenError, possessive, type ScreenSession, type Tab } from "./session.ts";

const MAX_TEXT = 50_000;
const TAB_MEMBERS = new Set(["new_tab", "list_tabs", "switch_tab", "close_tab"]);

type Target = { type: "coordinate"; x: number; y: number } | { type: "ref"; ref: string };

const png = (data: Buffer): ToolsetResult["image"] => ({ data: data.toString("base64"), mediaType: "image/png" });
const quote = (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ");
const shorten = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Runs Claude's browser use toolset on a job's browser: pages are read as accessibility-style trees with
 * element references, and acted on by reference or viewport coordinate. Every call is logged to the
 * job's trail; what the guards blocked or answered is added to the result.
 */
export class BrowserTools {
  constructor(private readonly session: ScreenSession) {}

  async run(call: ToolsetCall): Promise<ToolsetResult> {
    const input = call.input;
    try {
      if (input.tab_id !== undefined && typeof input.tab_id !== "string") throw new ScreenError("tab_id must be a string.");
      const result = await this.dispatch(call.name, input);
      if (TAB_MEMBERS.has(call.name)) return result;
      const notices = this.session.takeNotices();
      const text = [result.text, ...notices.map((n) => `Note: ${n}`)].filter(Boolean).join("\n\n");
      const state = call.name === "zoom" ? undefined : await this.session.browserState();
      return { ...result, ...(text ? { text: this.session.redact(text) } : {}), ...(state ? { browserState: state } : {}) };
    } catch (error) {
      const notices = this.session.takeNotices();
      const message = error instanceof ScreenError ? error.message : describeError(error);
      this.session.log(`${call.name} failed: ${message}`);
      return { text: [`Error: ${message}`, ...notices.map((n) => `Note: ${n}`)].join("\n\n"), isError: true };
    }
  }

  private tab(input: Record<string, unknown>): Tab {
    return this.session.tab(typeof input.tab_id === "string" ? input.tab_id : undefined);
  }

  private async dispatch(name: string, input: Record<string, unknown>): Promise<ToolsetResult> {
    switch (name) {
      case "navigate":
        return this.navigate(this.tab(input), input.url);
      case "screenshot": {
        const tab = this.tab(input);
        this.session.log("Took a screenshot");
        return { text: `Screenshot of ${tab.id}.`, image: png(await this.session.screenshot(tab.page)) };
      }
      case "zoom": {
        const tab = this.tab(input);
        this.session.log(`Zoomed into ${JSON.stringify(input.region)}`);
        return { image: png(await this.session.zoom(input.region, tab.page)) };
      }
      case "left_click":
        return this.click(this.tab(input), input, "left", 1, "Clicked");
      case "right_click":
        return this.click(this.tab(input), input, "right", 1, "Right-clicked");
      case "middle_click":
        return this.click(this.tab(input), input, "middle", 1, "Middle-clicked");
      case "double_click":
        return this.click(this.tab(input), input, "left", 2, "Double-clicked");
      case "triple_click":
        return this.click(this.tab(input), input, "left", 3, "Triple-clicked");
      case "hover": {
        const tab = this.tab(input);
        const target = this.target(input.target);
        if (target.type === "ref") {
          const { handle, label } = await this.element(tab, target.ref);
          await handle.hover();
          this.session.log(`Pointed at ${label}`);
          return { text: `Hovering over ${target.ref}.` };
        }
        await tab.page.mouse.move(target.x, target.y);
        this.session.log(`Pointed at (${target.x}, ${target.y})`);
        return { text: `Hovering at (${target.x}, ${target.y}).` };
      }
      case "left_click_drag": {
        const tab = this.tab(input);
        const from = this.coordinate(input.from, "from");
        const to = this.coordinate(input.target, "target");
        await tab.page.mouse.move(from.x, from.y);
        await tab.page.mouse.down();
        await tab.page.mouse.move(to.x, to.y, { steps: 12 });
        await tab.page.mouse.up();
        await this.session.settle(tab.page);
        this.session.log(`Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`);
        return { text: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).` };
      }
      case "left_mouse_down":
      case "left_mouse_up":
      case "mouse_move": {
        const tab = this.tab(input);
        const at = this.coordinate(input.target, "target");
        await tab.page.mouse.move(at.x, at.y);
        if (name === "left_mouse_down") await tab.page.mouse.down();
        if (name === "left_mouse_up") await tab.page.mouse.up();
        const done = name === "mouse_move" ? "Moved the pointer" : name === "left_mouse_down" ? "Pressed the left button" : "Released the left button";
        this.session.log(`${done} at (${at.x}, ${at.y})`);
        return { text: `${done} at (${at.x}, ${at.y}).` };
      }
      case "scroll": {
        const tab = this.tab(input);
        const at = this.coordinate(input.target, "target");
        const direction = String(input.scroll_direction ?? "down");
        const amount = Math.min(10, Math.max(1, Math.round(Number(input.scroll_amount ?? 3)) || 3));
        const delta = amount * 100;
        const [dx, dy] =
          direction === "up"
            ? [0, -delta]
            : direction === "down"
              ? [0, delta]
              : direction === "left"
                ? [-delta, 0]
                : direction === "right"
                  ? [delta, 0]
                  : [NaN, NaN];
        if (Number.isNaN(dx)) throw new ScreenError(`scroll_direction must be up, down, left or right.`);
        await tab.page.mouse.move(at.x, at.y);
        await tab.page.mouse.wheel(dx, dy);
        await tab.page.waitForTimeout(200);
        this.session.log(`Scrolled ${direction} ${amount}`);
        return { text: `Scrolled ${direction} by ${amount} at (${at.x}, ${at.y}).` };
      }
      case "scroll_to": {
        const tab = this.tab(input);
        const target = this.target(input.target);
        if (target.type !== "ref") throw new ScreenError("scroll_to takes an element reference.");
        const { handle, label } = await this.element(tab, target.ref);
        await handle.scrollIntoViewIfNeeded();
        this.session.log(`Scrolled to ${label}`);
        return { text: `Scrolled ${target.ref} into view.` };
      }
      case "type":
        return this.type(this.tab(input), input.text);
      case "key":
        return this.key(this.tab(input), input.text, input.repeat);
      case "hold_key": {
        const tab = this.tab(input);
        const keys = keySequence(String(input.text ?? ""))[0] ?? [];
        const seconds = Math.min(30, Math.max(0, Number(input.duration) || 0));
        for (const key of keys) await tab.page.keyboard.down(key);
        await tab.page.waitForTimeout(seconds * 1000);
        for (const key of [...keys].reverse()) await tab.page.keyboard.up(key);
        this.session.log(`Held ${keys.join("+")} for ${seconds} s`);
        return { text: `Held ${keys.join("+")} for ${seconds} s.` };
      }
      case "wait": {
        const tab = this.tab(input);
        const seconds = Math.min(30, Math.max(0, Number(input.duration) || 0));
        await tab.page.waitForTimeout(seconds * 1000);
        this.session.log(`Waited ${seconds} s`);
        return { text: `Waited ${seconds} s.` };
      }
      case "read_page":
        return this.readPage(this.tab(input), input);
      case "find":
        return this.find(this.tab(input), input.query);
      case "get_page_text":
        return this.pageText(this.tab(input));
      case "form_input":
        return this.formInput(this.tab(input), input);
      case "new_tab": {
        await this.session.newTab();
        this.session.log("Opened a new tab");
        return { browserState: await this.session.browserState() };
      }
      case "list_tabs":
        return { browserState: await this.session.browserState() };
      case "switch_tab": {
        const tab = this.session.activate(this.requireTabId(input));
        await tab.page.bringToFront();
        this.session.log(`Switched to ${tab.id}`);
        return { browserState: await this.session.browserState() };
      }
      case "close_tab": {
        const tab = this.session.tab(this.requireTabId(input));
        await tab.page.close();
        this.session.log(`Closed ${tab.id}`);
        return { browserState: await this.session.browserState() };
      }
      default:
        throw new ScreenError(`${name} is not enabled in this environment.`);
    }
  }

  private requireTabId(input: Record<string, unknown>): string {
    if (typeof input.tab_id !== "string" || !input.tab_id) throw new ScreenError("tab_id is required.");
    if (input.tab_id.length > 4096 || /[\u0000-\u001f\u2028\u2029]/.test(input.tab_id)) throw new ScreenError("That tab_id is not valid.");
    return input.tab_id;
  }

  private target(raw: unknown): Target {
    if (!raw || typeof raw !== "object") throw new ScreenError("target must be {type: 'ref', ref} or {type: 'coordinate', x, y}.");
    const target = raw as Record<string, unknown>;
    if (target.type === "ref") {
      if (typeof target.ref !== "string") throw new ScreenError('A ref target needs ref, e.g. "ref_2".');
      return { type: "ref", ref: target.ref };
    }
    return this.coordinate(raw, "target");
  }

  private coordinate(raw: unknown, what: string): { type: "coordinate"; x: number; y: number } {
    const target = (raw ?? {}) as Record<string, unknown>;
    const { width, height } = this.session.options.viewport;
    const x = Number(target.x);
    const y = Number(target.y);
    if (target.type !== undefined && target.type !== "coordinate") throw new ScreenError(`${what} must be a viewport coordinate here.`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ScreenError(`${what} needs x and y.`);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new ScreenError(`(${x}, ${y}) is outside the ${width}×${height} viewport.`);
    return { type: "coordinate", x: Math.round(x), y: Math.round(y) };
  }

  private async navigate(tab: Tab, raw: unknown): Promise<ToolsetResult> {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) throw new ScreenError("navigate needs a url.");
    const page = tab.page;
    if (value === "back" || value === "forward" || value === "reload") {
      if (value === "back") await page.goBack({ waitUntil: "domcontentloaded" });
      else if (value === "forward") await page.goForward({ waitUntil: "domcontentloaded" });
      else await page.reload({ waitUntil: "domcontentloaded" });
      await this.session.settle(page);
      this.session.log(`Went ${value === "reload" ? "to the same page again" : value}`);
      return { text: `${value === "reload" ? "Reloaded" : `Went ${value}`}.` };
    }
    let url: URL;
    try {
      const base = /^https?:/.test(page.url()) ? page.url() : this.session.options.target.startUrl;
      url = value.startsWith("/") ? new URL(value, base) : new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    } catch {
      throw new ScreenError(`"${shorten(value)}" is not a web address.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ScreenError("Navigation refused. Only http and https URLs are allowed.");
    if (!this.session.allowed(url)) {
      throw new ScreenError(
        `${url.host} is not one of ${possessive(this.session.options.target.system)} addresses: only the system's own pages can be opened.`,
      );
    }
    const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await this.session.settle(page);
    this.session.log(`Opened ${url.origin}${url.pathname}`);
    const status = response?.status();
    return { text: `Navigated to ${url.toString()}${status && status >= 400 ? ` (the server answered HTTP ${status})` : ""}.` };
  }

  private async click(tab: Tab, input: Record<string, unknown>, button: "left" | "right" | "middle", clickCount: number, verb: string): Promise<ToolsetResult> {
    const target = this.target(input.target);
    const modifiers = modifierKeys(input.modifiers) as ("Alt" | "Control" | "Meta" | "Shift")[];
    if (target.type === "ref") {
      const { handle, label } = await this.element(tab, target.ref);
      await handle.click({ button, clickCount, modifiers, timeout: this.session.options.actionTimeoutMs });
      await this.session.settle(tab.page);
      this.session.log(`${verb} ${label}`);
      return { text: `${verb} element ${target.ref}.` };
    }
    const page = tab.page;
    for (const key of modifiers) await page.keyboard.down(key);
    try {
      await page.mouse.click(target.x, target.y, { button, clickCount });
    } finally {
      for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
    }
    await this.session.settle(page);
    this.session.log(`${verb} at (${target.x}, ${target.y})`);
    return { text: `${verb} at (${target.x}, ${target.y}).` };
  }

  private async type(tab: Tab, raw: unknown): Promise<ToolsetResult> {
    if (typeof raw !== "string") throw new ScreenError("type needs text.");
    // The password goes only into a password field that has the keyboard.
    const secret = raw.includes("{{password}}");
    const focus = secret ? await this.focus(tab.page) : undefined;
    const text = this.session.fill(raw, !secret ? "unknown" : focus?.password ? "password" : "other");
    await tab.page.keyboard.type(text, { delay: 5 });
    this.session.log(`Typed “${shorten(raw)}”${focus?.name ? ` into ${focus.role ?? "field"} “${shorten(focus.name, 40)}”` : ""}`);
    return { text: `Typed "${quote(shorten(raw))}".` };
  }

  private async key(tab: Tab, raw: unknown, repeatRaw: unknown): Promise<ToolsetResult> {
    if (typeof raw !== "string" || !raw.trim()) throw new ScreenError('key needs text, e.g. "Enter" or "ctrl+a".');
    const sequence = keySequence(raw);
    const repeat = Math.min(100, Math.max(1, Math.round(Number(repeatRaw ?? 1)) || 1));
    for (let i = 0; i < repeat; i++) for (const chord of sequence) await pressChord(tab.page, chord);
    await this.session.settle(tab.page);
    this.session.log(`Pressed ${raw.trim()}${repeat > 1 ? ` ×${repeat}` : ""}`);
    return { text: `Pressed ${raw.trim()}${repeat > 1 ? ` ${repeat} times` : ""}.` };
  }

  /** What has the keyboard, looking into frames. */
  private async focus(page: Page): Promise<NonNullable<ReaderResult["focus"]> | undefined> {
    for (const frame of framesInOrder(page)) {
      const result = await this.reader(frame, { kind: "focus" }).catch(() => undefined);
      const focus = result?.focus;
      if (focus?.focused && !focus.frame && !focus.none) return focus;
    }
    return undefined;
  }

  private reader(frame: Frame, op: ReaderOp): Promise<ReaderResult> {
    return frame.evaluate(readerFunction, op);
  }

  /** A reference's element, or an error telling Claude to read the page again. */
  private async element(tab: Tab, ref: string): Promise<{ handle: ElementHandle; label: string }> {
    const known = tab.refs.get(ref);
    const stale = new ScreenError(`${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    if (!known || known.frame.isDetached()) throw stale;
    const handle = await known.frame.evaluateHandle(elementExpression(known.doc, known.id)).catch(() => undefined);
    const element = handle?.asElement();
    if (!element) throw stale;
    const described = await this.reader(known.frame, { kind: "describe", id: known.id }).catch(() => undefined);
    const label = described?.element
      ? `${described.element.role ?? "element"}${described.element.name ? ` “${shorten(described.element.name, 60)}”` : ""}`
      : ref;
    return { handle: element, label: this.session.redact(label) };
  }

  /** ref_N for an element, the same one each time the element is seen. */
  private refFor(tab: Tab, frame: Frame, doc: string, id: number): string {
    const key = `${frameKey(frame)}:${doc}:${id}`;
    let ref = tab.keys.get(key);
    if (!ref) {
      ref = `ref_${tab.next++}`;
      tab.keys.set(key, ref);
      tab.refs.set(ref, { frame, doc, id });
    }
    return ref;
  }

  private format(tab: Tab, frame: Frame, doc: string, nodes: ReaderNode[], base = 0): string[] {
    return nodes.map((node) => {
      const indent = "  ".repeat(base + node.d);
      if (node.text !== undefined) return `${indent}text "${quote(node.text)}"`;
      const ref = node.id !== undefined ? ` [${this.refFor(tab, frame, doc, node.id)}]` : "";
      const name = node.name ? ` "${quote(node.name)}"` : "";
      const props = node.props?.length ? ` ${node.props.join(" ")}` : "";
      return `${indent}${node.role}${name}${ref}${props}`;
    });
  }

  /** A frame's tree, with the frames inside it read in place. */
  private async tree(tab: Tab, frame: Frame, op: Extract<ReaderOp, { kind: "read" }>, base: number, depthLeft: number): Promise<string[]> {
    const result = await this.reader(frame, op);
    if (result.missing) throw new ScreenError("The page changed while it was being read: read it again.");
    const nodes = result.nodes ?? [];
    const children = new Map<number, Frame>();
    for (const child of frame.childFrames()) {
      const element = await child.frameElement().catch(() => undefined);
      const id = element ? await element.evaluate(elementIdFunction).catch(() => null) : null;
      if (id && id.doc === result.doc) children.set(id.id, child);
    }
    const lines: string[] = [];
    for (const node of nodes) {
      lines.push(...this.format(tab, frame, result.doc, [node], base));
      const child = node.frame && node.id !== undefined ? children.get(node.id) : undefined;
      if (child && depthLeft > 1) {
        const inner = await this.tree(tab, child, { ...op, root: undefined }, base + node.d + 1, depthLeft - 1).catch(() => [
          `${"  ".repeat(base + node.d + 1)}(this frame can't be read)`,
        ]);
        lines.push(...inner);
      }
    }
    return lines;
  }

  private async readPage(tab: Tab, input: Record<string, unknown>): Promise<ToolsetResult> {
    const filter = input.filter === "interactive" || input.filter === "all" ? input.filter : undefined;
    const depth = Math.max(1, Math.min(50, Math.round(Number(input.depth ?? 15)) || 15));
    let lines: string[];
    if (typeof input.ref === "string") {
      const known = tab.refs.get(input.ref);
      if (!known || known.frame.isDetached())
        throw new ScreenError(`${input.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
      const result = await this.reader(known.frame, { kind: "read", filter, depth, root: known.id });
      if (result.missing || result.doc !== known.doc)
        throw new ScreenError(`${input.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
      lines = this.format(tab, known.frame, result.doc, result.nodes ?? []);
    } else {
      lines = await this.tree(tab, tab.page.mainFrame(), { kind: "read", filter, depth }, 0, 4);
    }
    this.session.log(`Read the page${filter ? ` (${filter})` : ""}`);
    let text = lines.join("\n");
    if (!text) text = filter === "interactive" ? "No interactive elements are visible in the viewport." : "Nothing is visible in the viewport.";
    if (text.length > MAX_TEXT) {
      text = `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT.toLocaleString("en-US")} characters: read less with a smaller depth or a ref)`;
    }
    return { text };
  }

  private async find(tab: Tab, raw: unknown): Promise<ToolsetResult> {
    if (typeof raw !== "string" || !raw.trim()) throw new ScreenError("find needs a query.");
    const lines: string[] = [];
    for (const frame of framesInOrder(tab.page)) {
      if (lines.length >= 20) break;
      const result = await this.reader(frame, { kind: "find", query: raw }).catch(() => undefined);
      if (result?.nodes) lines.push(...this.format(tab, frame, result.doc, result.nodes.slice(0, 20 - lines.length)));
    }
    this.session.log(`Looked for “${shorten(raw)}”`);
    return { text: lines.length ? lines.join("\n") : `Nothing on the page matches "${shorten(raw)}".` };
  }

  private async pageText(tab: Tab): Promise<ToolsetResult> {
    const parts: string[] = [];
    for (const frame of framesInOrder(tab.page)) {
      const result = await this.reader(frame, { kind: "text" }).catch(() => undefined);
      if (!result?.text) continue;
      const label = frame === tab.page.mainFrame() ? "" : `--- frame ${frame.name() || safePath(frame.url())} ---\n`;
      parts.push(`${label}${result.text}`);
    }
    this.session.log("Read the page's text");
    let text = parts.join("\n\n") || "The page shows no text.";
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT.toLocaleString("en-US")} characters)`;
    return { text };
  }

  private async formInput(tab: Tab, input: Record<string, unknown>): Promise<ToolsetResult> {
    const target = this.target(input.target);
    if (target.type !== "ref") throw new ScreenError("form_input takes an element reference.");
    const value = input.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      throw new ScreenError("value must be a string, number or boolean.");
    const known = tab.refs.get(target.ref);
    const { handle, label } = await this.element(tab, target.ref);
    const field = known ? (await this.reader(known.frame, { kind: "field", id: known.id })).field : undefined;
    if (!field) throw new ScreenError(`${target.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    if (field.tag === "INPUT" && (field.type === "checkbox" || field.type === "radio")) {
      const checked = typeof value === "boolean" ? value : /^(true|yes|on|1)$/i.test(String(value));
      await handle.setChecked(checked);
      this.session.log(`${checked ? "Ticked" : "Cleared"} ${label}`);
    } else if (field.tag === "SELECT") {
      const wanted = String(value);
      const option =
        field.options.find((o) => o.value === wanted) ??
        field.options.find((o) => o.text === wanted) ??
        field.options.find((o) => o.text.toLowerCase() === wanted.toLowerCase());
      if (!option)
        throw new ScreenError(
          `${target.ref} has no option "${shorten(wanted)}"; its options: ${field.options
            .map((o) => `"${shorten(o.text, 40)}"`)
            .slice(0, 30)
            .join(", ")}.`,
        );
      await handle.selectOption({ value: option.value });
      this.session.log(`Chose “${shorten(option.text)}” in ${label}`);
    } else {
      const raw = String(value);
      const text = this.session.fill(raw, field.tag === "INPUT" && field.type === "password" ? "password" : "other");
      await handle.fill(text);
      this.session.log(`Filled ${label} with “${shorten(raw)}”`);
    }
    await this.session.settle(tab.page);
    return { text: `Set ${target.ref}.` };
  }
}

/** Press a chord: modifiers held, the key pressed, modifiers released. */
export async function pressChord(page: Page, keys: string[]): Promise<void> {
  const modifiers = keys.filter(isModifier);
  const main = keys.filter((k) => !isModifier(k));
  if (!main.length) {
    for (const key of modifiers) await page.keyboard.press(key);
    return;
  }
  for (const key of modifiers) await page.keyboard.down(key);
  try {
    for (const key of main) await page.keyboard.press(key);
  } finally {
    for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  }
}

/** The page's frames, the main one first. */
function framesInOrder(page: Page): Frame[] {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => f !== main && !f.isDetached())];
}

const FRAME_KEYS = new WeakMap<Frame, number>();
let frameCounter = 0;
function frameKey(frame: Frame): number {
  let key = FRAME_KEYS.get(frame);
  if (key === undefined) {
    key = ++frameCounter;
    FRAME_KEYS.set(frame, key);
  }
  return key;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** Playwright's errors, without its call logs. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n")[0] ?? message;
  const cleaned = first.replace(/^(locator|elementHandle|page|frame|mouse|keyboard)\.[a-zA-Z]+:\s*/, "");
  if (/Timeout \d+ms exceeded/.test(cleaned)) return `${cleaned} The element may be hidden, covered or disabled; look at the page again.`;
  if (/net::ERR_BLOCKED_BY_CLIENT/.test(cleaned)) return "The request was blocked (see the note).";
  return cleaned;
}
