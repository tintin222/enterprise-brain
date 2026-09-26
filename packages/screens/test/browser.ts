import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

/** The browser the tests run: EB_BROWSER_PATH, or Playwright's own when it is installed. */
export const executablePath = process.env.EB_BROWSER_PATH || undefined;

export const hasBrowser =
  Boolean(executablePath) ||
  (() => {
    try {
      return existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  })();

export const launch = () => chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

/** A PNG's width and height, from its header. */
export function pngSize(data: Buffer | string): { width: number; height: number } {
  const bytes = typeof data === "string" ? Buffer.from(data, "base64") : data;
  if (bytes.subarray(1, 4).toString() !== "PNG") throw new Error("not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
