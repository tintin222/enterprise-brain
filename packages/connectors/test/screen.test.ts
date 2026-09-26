import { describe, expect, it } from "vitest";
import { NamedAction } from "@enterprise-brain/core";
import {
  createDefaultRegistry,
  fillGoal,
  screenConnector,
  screenTarget,
  withNamedActions,
  type ConnectorUsage,
  type ScreenJob,
  type ScreenOperator,
  type ScreenOutcome,
} from "../src/index.ts";
import { expectConnectorError, makeCtx } from "./helpers.ts";

/** Old systems through their screens: the connector turns IT's actions into jobs for the screen operator. */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const USAGE: ConnectorUsage = { calls: 3, inputTokens: 9000, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.06 };

class FakeScreens implements ScreenOperator {
  readonly jobs: ScreenJob[] = [];
  outcome: Partial<ScreenOutcome> = {};
  async operate(job: ScreenJob): Promise<ScreenOutcome> {
    this.jobs.push(job);
    return {
      done: true,
      summary: "PO-4711 is open.",
      result: { status: "Open", delivery_date: "2026-10-02", total: "1 250" },
      steps: 7,
      trail: ["Opened https://orders.acme.local/login", "Typed “{{password}}” into textbox “Password”"],
      lastScreen: PNG,
      usage: USAGE,
      ...this.outcome,
    };
  }
  async check() {
    return {
      ok: true,
      message: "Opened “Sign in” at https://orders.acme.local/login (HTTP 200).",
      title: "Sign in",
      url: "https://orders.acme.local/login",
      screen: PNG,
    };
  }
}

const lookup = NamedAction.parse({
  id: "look_up_order",
  name: "Look up an order",
  kind: "read",
  goal: "Find order {order_number} and read its status, delivery date and total.",
  params: [{ key: "order_number", required: true }],
  returns: [
    { key: "status", description: "The order's status" },
    { key: "delivery_date", type: "date" },
    { key: "total", type: "number" },
  ],
});
const setStatus = NamedAction.parse({
  id: "set_status",
  name: "Set an order's status",
  kind: "write",
  goal: "Open order {order_number} and set its status to {status}.",
  params: [
    { key: "order_number", required: true },
    { key: "status", required: true },
  ],
});

function setup(config: Record<string, unknown> = {}) {
  const screens = new FakeScreens();
  const usage: ConnectorUsage[] = [];
  const files: { name: string; source: string }[] = [];
  const ctx = makeCtx({
    config: {
      start_url: "https://orders.acme.local/login",
      system_name: "Order system",
      username: "robot",
      form_paths: "/login\n/orders/search",
      allowed_hosts: "sso.acme.local",
      guidance: "Search by order number.",
      ...config,
    },
    secrets: { password: "s3cret" },
    screens,
    recordUsage: (u) => usage.push(u),
    files: {
      get: async () => {
        throw new Error("not used");
      },
      put: async (file) => {
        files.push({ name: file.name, source: file.source });
        return { id: `file-${files.length}` };
      },
    },
  });
  return { screens, usage, files, ctx, connector: withNamedActions(screenConnector, [lookup, setStatus]) };
}

describe("screen connections", () => {
  it("is a connector of its own, with only IT's actions", () => {
    const manifest = createDefaultRegistry().get("screen")!.manifest;
    expect(manifest).toMatchObject({ type: "screen", name: "Old system (through its screens)", operations: [] });
    expect(manifest.config.find((f) => f.key === "password")).toMatchObject({ secret: true });
    const { connector } = setup();
    expect(connector.manifest.operations.map((o) => [o.id, o.kind])).toEqual([
      ["look_up_order", "read"],
      ["set_status", "write"],
    ]);
  });

  it("gives the operator the job: the goal with its values, the sign-in, the system's addresses and whether it only reads", async () => {
    const { screens, ctx, connector, usage, files } = setup();
    const result = await connector.execute("look_up_order", { order_number: "PO-4711" }, ctx);
    expect(screens.jobs[0]).toEqual({
      system: "Order system",
      startUrl: "https://orders.acme.local/login",
      kind: "web",
      allowedHosts: ["sso.acme.local"],
      credentials: { username: "robot", password: "s3cret" },
      httpAuth: false,
      acceptInvalidCertificates: false,
      action: "Look up an order",
      goal: "Find order “PO-4711” and read its status, delivery date and total.",
      returns: lookup.returns,
      readOnly: true,
      formPaths: ["/login", "/orders/search"],
      guidance: "Search by order number.",
      maxSteps: 40,
    });
    // Values as the action asks for them, the summary, and how it was done.
    expect(result).toEqual({
      status: "Open",
      delivery_date: "2026-10-02",
      total: 1250,
      summary: "PO-4711 is open.",
      screens: { steps: 7, trail: ["Opened https://orders.acme.local/login", "Typed “{{password}}” into textbox “Password”"], lastScreenFileId: "file-1" },
    });
    expect(usage).toEqual([USAGE]);
    expect(files).toEqual([{ name: "Order system - Look up an order.png", source: "screen" }]);

    await connector.execute("set_status", { order_number: "PO-4711", status: "Delivered" }, ctx);
    expect(screens.jobs[1]).toMatchObject({ readOnly: false, goal: "Open order “PO-4711” and set its status to “Delivered”." });
  });

  it("fails when the screens don't allow the job, and still counts what it cost", async () => {
    const { screens, ctx, connector, usage } = setup();
    screens.outcome = { done: false, summary: "There is no order PO-9999.", result: {} };
    const error = await expectConnectorError(connector.execute("look_up_order", { order_number: "PO-9999" }, ctx));
    expect(error).toMatchObject({ message: "Order system: There is no order PO-9999.", code: "not_found" });
    expect(usage).toHaveLength(1);
    const write = await expectConnectorError(connector.execute("set_status", { order_number: "PO-9999", status: "Open" }, ctx));
    expect(write.code).toBe("remote");
  });

  it("tests a connection by opening its start page", async () => {
    const { ctx } = setup();
    expect(await screenConnector.test(ctx)).toEqual({
      ok: true,
      message: "Opened “Sign in” at https://orders.acme.local/login (HTTP 200).",
      details: { title: "Sign in", url: "https://orders.acme.local/login", screenFileId: "file-1" },
    });
    expect(await screenConnector.test(makeCtx({ config: { start_url: "https://x.example" } }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/needs a browser/),
    });
    expect(await screenConnector.test(makeCtx({ config: { start_url: "ftp://x.example" }, screens: new FakeScreens() }))).toMatchObject({
      ok: false,
      message: "Address: use an http or https address",
    });
  });

  it("reads its settings", () => {
    const ctx = makeCtx({ config: { start_url: "https://guac.acme.local/#/client/c/stock", kind: "desktop", http_auth: true, max_steps: 12 } });
    expect(screenTarget(ctx)).toEqual({
      system: "guac.acme.local",
      startUrl: "https://guac.acme.local/#/client/c/stock",
      kind: "desktop",
      allowedHosts: [],
      credentials: {},
      httpAuth: false,
      acceptInvalidCertificates: false,
    });
    expect(fillGoal("Open {a} then {b}", { a: "X-1" })).toBe("Open “X-1” then (not given)");
  });
});
