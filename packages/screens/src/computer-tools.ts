import type { ToolsetCall, ToolsetResult } from "@enterprise-brain/llm";
import { describeError, pressChord } from "./browser-tools.ts";
import { keySequence, modifierKeys } from "./keys.ts";
import { ScreenError, type ScreenSession } from "./session.ts";

const png = (data: Buffer): ToolsetResult["image"] => ({ data: data.toString("base64"), mediaType: "image/png" });
const shorten = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Runs Claude's computer use toolset on the page that shows a desktop program (a remote desktop page such
 * as Apache Guacamole or noVNC): screenshots, and the mouse and keyboard at screenshot coordinates, which
 * are the page's viewport pixels.
 */
export class ComputerTools {
  constructor(private readonly session: ScreenSession) {}

  async run(call: ToolsetCall): Promise<ToolsetResult> {
    try {
      const result = await this.dispatch(call.name, call.input);
      const notices = this.session.takeNotices();
      if (!notices.length) return result;
      return { ...result, text: [result.text, ...notices.map((n) => `Note: ${n}`)].filter(Boolean).join("\n\n") };
    } catch (error) {
      const message = error instanceof ScreenError ? error.message : describeError(error);
      this.session.log(`${call.name} failed: ${message}`);
      return { text: `Error: ${message}`, isError: true };
    }
  }

  private point(raw: unknown, what = "coordinate"): { x: number; y: number } {
    const { width, height } = this.session.options.viewport;
    if (!Array.isArray(raw) || raw.length !== 2) throw new ScreenError(`${what} must be [x, y].`);
    const [x, y] = raw.map(Number) as [number, number];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ScreenError(`${what} must be two numbers.`);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new ScreenError(`(${x}, ${y}) is outside the ${width}×${height} screen.`);
    return { x: Math.round(x), y: Math.round(y) };
  }

  private async moveTo(raw: unknown): Promise<{ x: number; y: number }> {
    if (raw === undefined || raw === null) return this.session.cursor;
    const at = this.point(raw);
    await this.session.page.mouse.move(at.x, at.y);
    this.session.cursor = at;
    return at;
  }

  private async held<T>(modifiersText: unknown, action: () => Promise<T>): Promise<T> {
    const page = this.session.page;
    const modifiers = modifierKeys(modifiersText);
    for (const key of modifiers) await page.keyboard.down(key);
    try {
      return await action();
    } finally {
      for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
    }
  }

  private async dispatch(name: string, input: Record<string, unknown>): Promise<ToolsetResult> {
    const page = this.session.page;
    const settle = () => page.waitForTimeout(300);
    switch (name) {
      case "screenshot":
        this.session.log("Took a screenshot");
        return { image: png(await this.session.screenshot()) };
      case "zoom":
        this.session.log(`Zoomed into ${JSON.stringify(input.region)}`);
        return { image: png(await this.session.zoom(input.region)) };
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const button = name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left";
        const clickCount = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        const at = await this.moveTo(input.coordinate);
        await this.held(input.text, () => page.mouse.click(at.x, at.y, { button, clickCount }));
        await settle();
        const verb = {
          left_click: "Clicked",
          right_click: "Right-clicked",
          middle_click: "Middle-clicked",
          double_click: "Double-clicked",
          triple_click: "Triple-clicked",
        }[name];
        this.session.log(`${verb} at (${at.x}, ${at.y})`);
        return { text: "OK" };
      }
      case "left_click_drag": {
        const from = this.point(input.start_coordinate, "start_coordinate");
        const to = this.point(input.coordinate);
        await this.held(input.text, async () => {
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 12 });
          await page.mouse.up();
        });
        this.session.cursor = to;
        await settle();
        this.session.log(`Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`);
        return { text: "OK" };
      }
      case "mouse_move": {
        const at = await this.moveTo(input.coordinate ?? [NaN, NaN]);
        this.session.log(`Moved the pointer to (${at.x}, ${at.y})`);
        return { text: "OK" };
      }
      case "left_mouse_down":
        await page.mouse.down();
        this.session.log(`Pressed the left button at (${this.session.cursor.x}, ${this.session.cursor.y})`);
        return { text: "OK" };
      case "left_mouse_up":
        await page.mouse.up();
        this.session.log(`Released the left button at (${this.session.cursor.x}, ${this.session.cursor.y})`);
        return { text: "OK" };
      case "cursor_position":
        return { text: `X=${this.session.cursor.x}, Y=${this.session.cursor.y}` };
      case "scroll": {
        const direction = String(input.scroll_direction ?? "down");
        const amount = Math.min(20, Math.max(1, Math.round(Number(input.scroll_amount ?? 3)) || 3));
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
        if (Number.isNaN(dx)) throw new ScreenError("scroll_direction must be up, down, left or right.");
        await this.moveTo(input.coordinate);
        await this.held(input.text, () => page.mouse.wheel(dx, dy));
        await settle();
        this.session.log(`Scrolled ${direction} ${amount}`);
        return { text: "OK" };
      }
      case "type": {
        if (typeof input.text !== "string") throw new ScreenError("type needs text.");
        // A desktop's fields can't be told apart from here: the sign-in values are typed where Claude is.
        const text = this.session.fill(input.text, "unknown");
        await page.keyboard.type(text, { delay: 15 });
        await settle();
        this.session.log(`Typed “${shorten(input.text)}”`);
        return { text: "OK" };
      }
      case "key": {
        if (typeof input.text !== "string" || !input.text.trim()) throw new ScreenError('key needs text, e.g. "Return" or "ctrl+s".');
        const sequence = keySequence(input.text);
        const repeat = Math.min(100, Math.max(1, Math.round(Number(input.repeat ?? 1)) || 1));
        for (let i = 0; i < repeat; i++) for (const chord of sequence) await pressChord(page, chord);
        await settle();
        this.session.log(`Pressed ${input.text.trim()}${repeat > 1 ? ` ×${repeat}` : ""}`);
        return { text: "OK" };
      }
      case "hold_key": {
        const keys = keySequence(String(input.text ?? ""))[0] ?? [];
        const seconds = Math.min(60, Math.max(0, Number(input.duration) || 0));
        for (const key of keys) await page.keyboard.down(key);
        await page.waitForTimeout(seconds * 1000);
        for (const key of [...keys].reverse()) await page.keyboard.up(key);
        this.session.log(`Held ${keys.join("+")} for ${seconds} s`);
        return { text: "OK" };
      }
      case "wait": {
        const seconds = Math.min(60, Math.max(0, Number(input.duration) || 0));
        await page.waitForTimeout(seconds * 1000);
        this.session.log(`Waited ${seconds} s`);
        return { text: "OK" };
      }
      default:
        throw new ScreenError(`${name} is not available here.`);
    }
  }
}
