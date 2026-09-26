import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorError, type ScreenJob } from "@enterprise-brain/connectors";
import { ScriptedLlm, UnavailableLlm, type OperateRequest, type ScriptedOperateTurn, type ToolsetCall, type ToolsetResult } from "@enterprise-brain/llm";
import { ScreenService } from "../src/index.ts";
import { executablePath, hasBrowser, pngSize } from "./browser.ts";
import { OLD_SYSTEM_PASSWORD, OLD_SYSTEM_USER, startOldSystem, type OldSystem } from "../demo/old-system.ts";

type History = { call: ToolsetCall; result: ToolsetResult }[];
type Script = (request: OperateRequest, turn: number, history: History) => ScriptedOperateTurn;

/** The reference of the element a pattern finds in the latest page read. */
function ref(history: History, pattern: RegExp): { type: "ref"; ref: string } {
  for (const { call, result } of [...history].reverse()) {
    if (call.name !== "read_page" && call.name !== "find") continue;
    const found = pattern.exec(result.text ?? "")?.[1];
    if (found) return { type: "ref", ref: found };
  }
  throw new Error(`No ${pattern} in the pages read`);
}

/** Sign in, then carry on with `then` (turn numbers from 1 again). */
function signingIn(then: Script): Script {
  return (request, turn, history) => {
    if (turn === 1) return { actions: [{ name: "read_page", input: { filter: "interactive" } }] };
    if (turn === 2) {
      return {
        actions: [
          { name: "form_input", input: { target: ref(history, /textbox "User name" \[(ref_\d+)\]/), value: "{{username}}" } },
          { name: "form_input", input: { target: ref(history, /textbox "Password" \[(ref_\d+)\]/), value: "{{password}}" } },
          { name: "left_click", input: { target: ref(history, /button "Sign in" \[(ref_\d+)\]/) } },
        ],
      };
    }
    return then(request, turn - 2, history);
  };
}

describe.skipIf(!hasBrowser)("ScreenService: jobs on an old system's screens", () => {
  let system: OldSystem;
  const services: ScreenService[] = [];
  beforeAll(async () => {
    system = await startOldSystem();
  });
  afterAll(async () => {
    await Promise.all(services.map((s) => s.close()));
    await system?.close();
  });

  const service = (script: Script, extra: { maxSteps?: number } = {}) => {
    const llm = new ScriptedLlm({ "screens.": { operate: script } });
    const screens = new ScreenService({ llm, ...(executablePath ? { executablePath } : {}), actionTimeoutMs: 5000 });
    services.push(screens);
    const job = (overrides: Partial<ScreenJob> = {}): ScreenJob => ({
      system: "Order system",
      startUrl: `${system.url}/login`,
      kind: "web",
      allowedHosts: [],
      credentials: { username: OLD_SYSTEM_USER, password: OLD_SYSTEM_PASSWORD },
      action: "Look up an order",
      goal: "Find order “PO-4711” and read its status and delivery date.",
      returns: [
        { key: "status", type: "string", description: "The order's status" },
        { key: "delivery_date", type: "date" },
      ],
      readOnly: true,
      formPaths: ["/login"],
      guidance: "Orders are listed after signing in; search by order number.",
      maxSteps: extra.maxSteps ?? 30,
      ...overrides,
    });
    return { llm, screens, job };
  };

  it("signs in, finds the values on the screens and brings them back", async () => {
    const { llm, screens, job } = service(
      signingIn((_request, turn, history) => {
        if (turn === 1) return { actions: [{ name: "find", input: { query: "PO-4711 link" } }] };
        if (turn === 2)
          return { actions: [{ name: "left_click", input: { target: ref(history, /link "PO-4711" \[(ref_\d+)\]/) } }, { name: "get_page_text" }] };
        // A value missing: finish says what is wanted, and the job carries on.
        if (turn === 3) return { tool: { name: "finish", input: { outcome: "done", summary: "PO-4711 is open.", result: { status: "Open" } } } };
        return {
          tool: {
            name: "finish",
            input: { outcome: "done", summary: "PO-4711 is open; delivery on 2 October.", result: { status: "Open", delivery_date: "2026-10-02" } },
          },
        };
      }),
    );
    const outcome = await screens.operate(job());
    expect(outcome).toMatchObject({
      done: true,
      summary: "PO-4711 is open; delivery on 2 October.",
      result: { status: "Open", delivery_date: "2026-10-02" },
      steps: 7,
    });
    expect(outcome.trail).toEqual(
      expect.arrayContaining([
        `Opened ${system.url}/login`,
        "Filled textbox “User name” with “{{username}}”",
        "Filled textbox “Password” with “{{password}}”",
        "Clicked button “Sign in”",
        "Clicked link “PO-4711”",
        "Finished: done",
      ]),
    );
    expect(JSON.stringify(outcome)).not.toContain(OLD_SYSTEM_PASSWORD);
    expect(pngSize(outcome.lastScreen!)).toEqual({ width: 1280, height: 800 });
    expect(outcome.usage?.calls).toBeGreaterThan(0);

    const request = llm.calls.find((c) => c.kind === "operate")!.request as OperateRequest;
    expect(request).toMatchObject({ purpose: "screens.web", toolset: "browser", effort: "medium" });
    expect(request.system).toContain("You work in Order system through its screens");
    expect(request.system).toContain("This job only reads");
    expect(request.system).toContain("type {{username}} as the username and {{password}} as the password");
    expect(request.system).toContain("Orders are listed after signing in");
    const first = request.messages[0]!.content as { type: string; text?: string }[];
    expect(first[0]!.text).toContain("The job: Look up an order\nFind order “PO-4711” and read its status and delivery date.");
    expect(first[0]!.text).toContain("- delivery_date (date, YYYY-MM-DD)");
    expect(first[0]!.text).toContain("The browser has one tab, tab-1, showing “Sign in”");
    expect(first[1]!.type).toBe("image");
    expect(request.tools?.[0]?.inputSchema).toMatchObject({ properties: { result: { required: ["status", "delivery_date"] } } });
  });

  it("can't change anything in a read, and says when the job can't be done", async () => {
    const { screens, job } = service(
      signingIn((_request, turn, history) => {
        if (turn === 1) return { actions: [{ name: "navigate", input: { url: "/orders/PO-4711" } }, { name: "read_page" }] };
        if (turn === 2) {
          return {
            actions: [
              { name: "form_input", input: { target: ref(history, /combobox "New status" \[(ref_\d+)\]/), value: "Delivered" } },
              { name: "left_click", input: { target: ref(history, /button "Save" \[(ref_\d+)\]/) } },
            ],
          };
        }
        return { tool: { name: "finish", input: { outcome: "not_possible", summary: "Saving is not allowed in a read." } } };
      }),
    );
    const outcome = await screens.operate(job({ action: "Look at an order" }));
    expect(outcome).toMatchObject({ done: false, summary: "Saving is not allowed in a read." });
    expect(outcome.trail).toContain("The page showed a question: “Change the status of PO-4711?”. It was answered Cancel, because this job only reads.");
    expect(system.orders.get("PO-4711")?.status).toBe("Open");
  });

  it("stops at the step limit, and nudges once when Claude answers in words", async () => {
    const endless = service(() => ({ actions: [{ name: "screenshot" }] }), { maxSteps: 3 });
    const outcome = await endless.screens.operate(endless.job({ maxSteps: 3 }));
    expect(outcome).toMatchObject({ done: false, summary: "It didn't finish within 3 steps.", steps: 3 });

    let calls = 0;
    const talker = service((_request, turn) => {
      if (turn === 1) calls++;
      return calls === 1
        ? { text: "The status is Open." }
        : { tool: { name: "finish", input: { outcome: "done", summary: "Open", result: { status: "Open", delivery_date: null } } } };
    });
    const answered = await talker.screens.operate(talker.job());
    expect(answered).toMatchObject({ done: true, result: { status: "Open", delivery_date: null } });
    expect(talker.llm.calls.filter((c) => c.kind === "operate")).toHaveLength(2);
  });

  it("works a desktop program in a remote desktop page with computer use", async () => {
    const { llm, screens, job } = service((_request, turn) => {
      if (turn === 1)
        return {
          actions: [
            { name: "left_click", input: { coordinate: [600, 317] } },
            { name: "type", input: { text: "{{username}}" } },
            { name: "key", input: { text: "Tab" } },
            { name: "type", input: { text: "{{password}}" } },
            { name: "key", input: { text: "Return" } },
            { name: "screenshot" },
          ],
        };
      return { tool: { name: "finish", input: { outcome: "done", summary: "42 in stock.", result: { in_stock: 42 } } } };
    });
    const outcome = await screens.operate(
      job({
        system: "Stock Control",
        startUrl: `${system.url}/desk`,
        kind: "desktop",
        action: "Read stock",
        goal: "Read the stock of item A-100.",
        returns: [{ key: "in_stock", type: "integer" }],
      }),
    );
    expect(outcome).toMatchObject({ done: true, result: { in_stock: 42 }, steps: 6 });
    const request = llm.calls[0]!.request as OperateRequest;
    expect(request).toMatchObject({ purpose: "screens.desktop", toolset: "computer" });
    expect(request.system).toContain("The screen shows a desktop program through a remote desktop page");
    expect((request.messages[0]!.content as { text?: string }[])[0]!.text).toContain("The screen is 1280×800 pixels.");
  });

  it("checks a connection by opening its start page, without Claude", async () => {
    const screens = new ScreenService({ llm: new UnavailableLlm(), ...(executablePath ? { executablePath } : {}) });
    services.push(screens);
    const target = { system: "Order system", startUrl: `${system.url}/`, kind: "web" as const, allowedHosts: [], credentials: {} };
    const check = await screens.check(target);
    expect(check).toMatchObject({ ok: true, title: "Sign in", url: `${system.url}/` });
    expect(check.message).toMatch(/^Opened “Sign in” at http:\/\/127\.0\.0\.1:\d+\/ \(HTTP 200\)\.$/);
    expect(pngSize(check.screen!)).toEqual({ width: 1280, height: 800 });
    const unreachable = await screens.check({ ...target, startUrl: "http://127.0.0.1:9/" });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.message).toMatch(/^Couldn't open Order system at http:\/\/127\.0\.0\.1:9\/: /);
    await expect(screens.operate({ ...target, action: "x", goal: "x", returns: [], readOnly: true, formPaths: [], maxSteps: 5 })).rejects.toThrow(
      ConnectorError,
    );
  });
});
