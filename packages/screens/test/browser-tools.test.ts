import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import type { ToolsetResult } from "@enterprise-brain/llm";
import { BrowserTools, ComputerTools, ScreenSession, chord, hostMatches, keySequence, modifierKeys, safeUrl } from "../src/index.ts";
import { hasBrowser, launch, pngSize } from "./browser.ts";
import { OLD_SYSTEM_PASSWORD, OLD_SYSTEM_USER, startOldSystem, type OldSystem } from "../demo/old-system.ts";

describe("keys and addresses", () => {
  it("reads key names the way Claude writes them", () => {
    expect(chord("Return")).toEqual(["Enter"]);
    expect(chord("ctrl+shift+t")).toEqual(["Control", "Shift", "t"]);
    expect(chord("ctrl++")).toEqual(["Control", "+"]);
    expect(chord("alt+Tab")).toEqual(["Alt", "Tab"]);
    expect(chord("Page_Down")).toEqual(["PageDown"]);
    expect(chord("super+F4")).toEqual(["Meta", "F4"]);
    expect(keySequence("Backspace Backspace")).toEqual([["Backspace"], ["Backspace"]]);
    expect(modifierKeys("ctrl+shift")).toEqual(["Control", "Shift"]);
    expect(() => modifierKeys("a")).toThrow(/not a modifier/);
    expect(() => chord("Hyper_Z")).toThrow(/Unknown key/);
  });

  it("matches the system's hosts, and keeps session ids out of URLs", () => {
    expect(hostMatches("erp.acme.local", "erp.acme.local")).toBe(true);
    expect(hostMatches("sso.acme.local", "*.acme.local")).toBe(true);
    expect(hostMatches("acme.local", "*.acme.local")).toBe(true);
    expect(hostMatches("evilacme.local", "*.acme.local")).toBe(false);
    expect(hostMatches("erp.acme.local.evil.com", "erp.acme.local")).toBe(false);
    expect(safeUrl("https://erp.acme.local/app;jsessionid=ABC123/orders?id=4&sessionToken=xyz")).toBe(
      "https://erp.acme.local/app/orders?id=4&sessionToken=%E2%80%A6",
    );
  });
});

describe.skipIf(!hasBrowser)("browser use on an old web system", () => {
  let browser: Browser;
  let system: OldSystem;
  let session: ScreenSession | undefined;
  beforeAll(async () => {
    browser = await launch();
    system = await startOldSystem();
  });
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });
  afterAll(async () => {
    await browser?.close();
    await system?.close();
  });

  const open = async (readOnly: boolean, extra: { formPaths?: string[]; allowedHosts?: string[] } = {}) => {
    session = await ScreenSession.open(browser, {
      target: {
        system: "Order system",
        startUrl: `${system.url}/login`,
        kind: "web",
        allowedHosts: extra.allowedHosts ?? [],
        credentials: { username: OLD_SYSTEM_USER, password: OLD_SYSTEM_PASSWORD },
      },
      readOnly,
      formPaths: extra.formPaths ?? ["/login"],
      viewport: { width: 1280, height: 800 },
      actionTimeoutMs: 5000,
    });
    const tools = new BrowserTools(session);
    let n = 0;
    const run = (name: string, input: Record<string, unknown> = {}) => tools.run({ id: `c${++n}`, toolset: "browser", name, input });
    return { session, run };
  };
  const ref = (result: ToolsetResult, pattern: RegExp) => {
    const found = pattern.exec(result.text ?? "")?.[1];
    if (!found) throw new Error(`No ${pattern} in:\n${result.text}`);
    return { type: "ref", ref: found };
  };
  const signIn = async (run: (name: string, input?: Record<string, unknown>) => Promise<ToolsetResult>) => {
    await run("navigate", { url: `${system.url}/login` });
    const page = await run("read_page", { filter: "interactive" });
    await run("form_input", { target: ref(page, /textbox "User name" \[(ref_\d+)\]/), value: "{{username}}" });
    await run("left_click", { target: ref(page, /textbox "Password" \[(ref_\d+)\]/) });
    const typed = await run("type", { text: "{{password}}" });
    expect(typed.isError).toBeFalsy();
    return run("key", { text: "Return" });
  };

  it("reads a page as a tree: fields named from the cell beside them, password fields without their value", async () => {
    const { run } = await open(true);
    await run("navigate", { url: `${system.url}/login` });
    const page = await run("read_page");
    expect(page.text).toContain('textbox "User name" [ref_');
    expect(page.text).toMatch(/textbox "Password" \[ref_\d+\] password/);
    expect(page.text).toMatch(/button "Sign in" \[ref_\d+\]/);
    expect(page.browserState?.tabs).toEqual([{ tab_id: "tab-1", title: "Sign in", url: `${system.url}/login`, active: true }]);
    const found = await run("find", { query: "password field" });
    expect(found.text?.split("\n")[0]).toMatch(/^textbox "Password" \[ref_\d+\] password$/);
    // References stay the same while the page lives.
    expect((await run("read_page")).text).toBe(page.text);
    expect((await run("left_click", { target: { type: "ref", ref: "ref_404" } })).text).toMatch(/ref_404 is stale or not found/);
  });

  it("signs in with values it never sees, and types the password only into a password field", async () => {
    const { session, run } = await open(true);
    await run("navigate", { url: `${system.url}/login` });
    const page = await run("read_page", { filter: "interactive" });
    await run("left_click", { target: ref(page, /textbox "User name" \[(ref_\d+)\]/) });
    const refused = await run("type", { text: "{{password}}" });
    expect(refused).toMatchObject({ isError: true, text: "Error: The password can only be typed into a password field." });
    const signedIn = await signIn(run);
    expect(signedIn.browserState?.tabs[0]).toMatchObject({ title: "Orders" });
    expect(system.requests).toContainEqual({ method: "POST", path: "/login" });
    const everything = JSON.stringify(session.trail) + JSON.stringify(await run("read_page"));
    expect(everything).not.toContain(OLD_SYSTEM_PASSWORD);
    expect(session.trail).toContain("Typed “{{password}}” into textbox “Password”");
  });

  it("keeps a read from changing anything: forms are blocked, questions answered Cancel", async () => {
    const { session, run } = await open(true);
    await signIn(run);
    await run("navigate", { url: "/orders/PO-4711" });
    let page = await run("read_page");
    expect(page.text).toMatch(/combobox "New status" \[ref_\d+\] value="Open"/);
    await run("form_input", { target: ref(page, /combobox "New status" \[(ref_\d+)\]/), value: "Delivered" });
    const saved = await run("left_click", { target: ref(page, /button "Save" \[(ref_\d+)\]/) });
    expect(saved.text).toContain("The page showed a question: “Change the status of PO-4711?”. It was answered Cancel, because this job only reads.");
    // A page that sends the form itself gets no further.
    await session.page.evaluate("document.forms[0].submit()");
    page = await run("get_page_text");
    expect(page.text).toContain("Note: Blocked: sending data to /orders/PO-4711/status (POST). This job only reads, so nothing was changed.");
    expect(system.requests.filter((r) => r.method === "POST" && r.path.endsWith("/status"))).toEqual([]);
    expect(system.orders.get("PO-4711")?.status).toBe("Open");
  });

  it("changes things in a write, answering the page's question OK", async () => {
    const { run } = await open(false);
    await signIn(run);
    await run("navigate", { url: "/orders/PO-4712" });
    const page = await run("read_page");
    await run("form_input", { target: ref(page, /combobox "New status" \[(ref_\d+)\]/), value: "Delivered" });
    const saved = await run("left_click", { target: ref(page, /button "Save" \[(ref_\d+)\]/) });
    expect(saved.text).toContain("It was answered OK.");
    expect(saved.browserState?.tabs[0]?.url).toBe(`${system.url}/orders/PO-4712?saved=1`);
    expect(system.orders.get("PO-4712")?.status).toBe("Delivered");
  });

  it("opens only the system's own addresses", async () => {
    const { run } = await open(true);
    await signIn(run);
    const page = await run("read_page");
    const clicked = await run("left_click", { target: ref(page, /link "Partner portal" \[(ref_\d+)\]/) });
    expect(clicked.text).toContain("Blocked: evil.example is not one of Order system's addresses, so http://evil.example/steal was not opened.");
    expect(clicked.browserState?.tabs[0]?.title).toBe("Orders");
    expect(await run("navigate", { url: "https://evil.example/steal?data=1" })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/evil.example is not one of/),
    });
    expect(await run("navigate", { url: "javascript:alert(1)" })).toMatchObject({
      isError: true,
      text: "Error: Navigation refused. Only http and https URLs are allowed.",
    });
    expect(await run("navigate", { url: "file:///etc/passwd" })).toMatchObject({ isError: true });
  });

  it("reports tabs the pages open, and works with them", async () => {
    const { run } = await open(true);
    await signIn(run);
    const page = await run("read_page");
    const clicked = await run("left_click", { target: ref(page, /link "Open PO-4712 in a new window" \[(ref_\d+)\]/) });
    expect(clicked.browserState).toMatchObject({
      tabs: [
        { tab_id: "tab-1", active: true },
        { tab_id: "tab-2", title: "Order PO-4712" },
      ],
      state_changes: [{ type: "tab_opened", tab_id: "tab-2" }],
    });
    const switched = await run("switch_tab", { tab_id: "tab-2" });
    expect(switched).toEqual({
      browserState: { tabs: [expect.objectContaining({ tab_id: "tab-1" }), expect.objectContaining({ tab_id: "tab-2", active: true })] },
    });
    expect((await run("get_page_text")).text).toContain("Ege Tekstil");
    const closed = await run("close_tab", { tab_id: "tab-2" });
    expect(closed.browserState?.tabs).toEqual([expect.objectContaining({ tab_id: "tab-1", active: true })]);
    expect(await run("switch_tab", { tab_id: "tab-9" })).toMatchObject({ isError: true, text: "Error: There is no tab tab-9." });
  });

  it("reads frames in place, answers a page's messages, and zooms", async () => {
    const { run } = await open(true);
    await signIn(run);
    await run("navigate", { url: "/frames" });
    const page = await run("read_page");
    expect(page.text).toMatch(/iframe "menu" \[ref_\d+\]\n  link "All orders" \[ref_\d+\]/);
    expect(page.text).toMatch(/iframe "main" \[ref_\d+\]\n[\s\S]*cell "02.10.2026"/);
    const reports = await run("left_click", { target: ref(page, /clickable "Reports" \[(ref_\d+)\]/) });
    expect(reports.text).toContain("The page showed a message: “Reports are closed”. It was answered OK.");
    const shot = await run("screenshot");
    expect(pngSize(shot.image!.data)).toEqual({ width: 1280, height: 800 });
    const zoom = await run("zoom", { region: [0, 0, 320, 200] });
    expect(pngSize(zoom.image!.data)).toEqual({ width: 1280, height: 800 });
    expect(zoom.browserState).toBeUndefined();
    expect((await run("zoom", { region: [10, 10, 12, 12] })).isError).toBe(true);
  });
});

describe.skipIf(!hasBrowser)("computer use on a desktop program in a remote desktop page", () => {
  let browser: Browser;
  let system: OldSystem;
  beforeAll(async () => {
    browser = await launch();
    system = await startOldSystem();
  });
  afterAll(async () => {
    await browser?.close();
    await system?.close();
  });

  it("works it by mouse and keyboard at screenshot coordinates", async () => {
    const session = await ScreenSession.open(browser, {
      target: {
        system: "Stock Control",
        startUrl: `${system.url}/desk`,
        kind: "desktop",
        allowedHosts: [],
        credentials: { username: OLD_SYSTEM_USER, password: OLD_SYSTEM_PASSWORD },
      },
      readOnly: true,
      formPaths: [],
      viewport: { width: 1280, height: 800 },
      actionTimeoutMs: 5000,
    });
    try {
      await session.page.goto(`${system.url}/desk`);
      const tools = new ComputerTools(session);
      const run = (name: string, input: Record<string, unknown> = {}) => tools.run({ id: name, toolset: "computer", name, input });
      expect(pngSize((await run("screenshot")).image!.data)).toEqual({ width: 1280, height: 800 });
      expect(await run("left_click", { coordinate: [600, 317] })).toEqual({ text: "OK" });
      await run("type", { text: "{{username}}" });
      await run("key", { text: "Tab" });
      await run("type", { text: "{{password}}" });
      expect((await run("cursor_position")).text).toBe("X=600, Y=317");
      await run("left_click", { coordinate: [750, 435], text: "shift" });
      const desk = (await session.page.evaluate("window.__desk")) as { signedIn: boolean; events: string[] };
      expect(desk.signedIn).toBe(true);
      expect(desk.events).toContain("click 750,435 shift");
      expect(await run("left_click", { coordinate: [5000, 10] })).toEqual({ text: "Error: (5000, 10) is outside the 1280×800 screen.", isError: true });
      expect(await run("key", { text: "Hyper_Z" })).toEqual({ text: 'Error: Unknown key "Hyper_Z"', isError: true });
      expect(pngSize((await run("zoom", { region: [1080, 770, 1280, 800] })).image!.data)).toEqual({ width: 800, height: 120 });
      expect(JSON.stringify(session.trail)).not.toContain(OLD_SYSTEM_PASSWORD);
    } finally {
      await session.close();
    }
  });
});
