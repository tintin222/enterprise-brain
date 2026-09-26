import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm, type ToolsetCall, type ToolsetResult } from "@enterprise-brain/llm";
import { hasBrowser } from "../../../packages/screens/test/browser.ts";
import { OLD_SYSTEM_PASSWORD, OLD_SYSTEM_USER, startOldSystem, type OldSystem } from "../../../packages/screens/demo/old-system.ts";
import { createTestApp, type TestApp } from "./helpers.ts";

/**
 * An old order system without an API, connected through its screens: IT sets it up in Settings, writes
 * an action in plain words and tries it. Claude is scripted here; the browser, the system and the
 * guards are real.
 */

type History = { call: ToolsetCall; result: ToolsetResult }[];

function ref(history: History, pattern: RegExp) {
  for (const { result } of [...history].reverse()) {
    const found = pattern.exec(result.text ?? "")?.[1];
    if (found) return { type: "ref", ref: found };
  }
  throw new Error(`No ${pattern} in the pages read`);
}

describe.skipIf(!hasBrowser)("a screen connection", () => {
  let t: TestApp;
  let system: OldSystem;
  let id: string;
  const llm = new ScriptedLlm({
    "screens.": {
      operate: (request, turn, history) => {
        const order = /“(PO-\d+)”/.exec(String((request.messages[0]!.content as { text?: string }[])[0]?.text))?.[1] ?? "";
        if (turn === 1) return { actions: [{ name: "read_page", input: { filter: "interactive" } }] };
        if (turn === 2) {
          return {
            actions: [
              { name: "form_input", input: { target: ref(history, /textbox "User name" \[(ref_\d+)\]/), value: "{{username}}" } },
              { name: "form_input", input: { target: ref(history, /textbox "Password" \[(ref_\d+)\]/), value: "{{password}}" } },
              { name: "left_click", input: { target: ref(history, /button "Sign in" \[(ref_\d+)\]/) } },
              { name: "find", input: { query: `${order} link` } },
            ],
          };
        }
        if (turn === 3) {
          const link = new RegExp(`link "${order}" \\[(ref_\\d+)\\]`);
          if (!link.test(history.at(-1)?.result.text ?? ""))
            return { tool: { name: "finish", input: { outcome: "not_possible", summary: `There is no order ${order}.` } } };
          return { actions: [{ name: "left_click", input: { target: ref(history, link) } }, { name: "get_page_text" }] };
        }
        const text = history.at(-1)?.result.text ?? "";
        const status = /Status:\s+(\w+)/.exec(text)?.[1];
        const date = /Delivery date:\s+(\d\d)\.(\d\d)\.(\d{4})/.exec(text);
        return {
          tool: {
            name: "finish",
            input: status
              ? { outcome: "done", summary: `${order} is ${status}.`, result: { status, delivery_date: date ? `${date[3]}-${date[2]}-${date[1]}` : null } }
              : { outcome: "not_possible", summary: `There is no order ${order}.` },
          },
        };
      },
    },
  });

  beforeAll(async () => {
    system = await startOldSystem();
    t = await createTestApp({ llm, seed: false });
  });
  afterAll(async () => {
    await t?.close();
    await system?.close();
  });

  it("is set up in Settings, its password kept out of sight, and tested by opening its start page", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/companies/acme/connectors",
      payload: {
        type: "screen",
        name: "Order system",
        values: {
          start_url: `${system.url}/login`,
          system_name: "Order system",
          username: OLD_SYSTEM_USER,
          password: OLD_SYSTEM_PASSWORD,
          form_paths: "/login",
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    id = created.json().id;
    expect(created.json()).toMatchObject({ type: "screen", secretFields: ["password"] });
    expect(created.body).not.toContain(OLD_SYSTEM_PASSWORD);

    const tested = await t.app.inject({ method: "POST", url: `/api/companies/acme/connectors/${id}/test` });
    expect(tested.json()).toMatchObject({ ok: true, message: `Opened “Sign in” at ${system.url}/login (HTTP 200).` });
    const screen = await t.app.inject({ method: "GET", url: `/api/companies/acme/files/${tested.json().details.screenFileId}` });
    expect(screen.headers["content-type"]).toBe("image/png");
  });

  it("takes actions written in plain words, and tries them in the system", async () => {
    const actions = [
      {
        id: "look_up_order",
        name: "Look up an order",
        kind: "read",
        goal: "Find order {order_number} and read its status and delivery date.",
        params: [{ key: "order_number", required: true }],
        returns: [{ key: "status" }, { key: "delivery_date", type: "date" }],
      },
    ];
    const refused = await t.app.inject({
      method: "PUT",
      url: `/api/companies/acme/connectors/${id}/actions`,
      payload: { actions: [{ ...actions[0], goal: undefined }] },
    });
    expect(refused.statusCode).toBe(400);
    const saved = await t.app.inject({ method: "PUT", url: `/api/companies/acme/connectors/${id}/actions`, payload: { actions } });
    expect(saved.statusCode, saved.body).toBe(200);

    const tried = await t.app.inject({
      method: "POST",
      url: `/api/companies/acme/connectors/${id}/actions/look_up_order/test`,
      payload: { input: { order_number: "PO-4711" } },
    });
    expect(tried.statusCode, tried.body).toBe(200);
    expect(tried.json().result).toMatchObject({
      status: "Open",
      delivery_date: "2026-10-02",
      summary: "PO-4711 is Open.",
      screens: { steps: 7, trail: expect.arrayContaining(["Filled textbox “Password” with “{{password}}”", "Clicked link “PO-4711”"]) },
    });
    expect(tried.body).not.toContain(OLD_SYSTEM_PASSWORD);
    const last = await t.app.inject({ method: "GET", url: `/api/companies/acme/files/${tried.json().result.screens.lastScreenFileId}` });
    expect(last.headers["content-type"]).toBe("image/png");

    const missing = await t.app.inject({
      method: "POST",
      url: `/api/companies/acme/connectors/${id}/actions/look_up_order/test`,
      payload: { input: { order_number: "PO-9999" } },
    });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json().error).toBe("Order system: There is no order PO-9999.");
  });
});
