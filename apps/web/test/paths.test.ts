import { describe, expect, it } from "vitest";
import { MOVED, movedTo, paths, portalOf, twin, upgrade } from "../src/lib/paths.ts";

describe("the two portals' addresses", () => {
  it("tells the portal from the address", () => {
    expect(portalOf("/")).toBe("operations");
    expect(portalOf("/work/EB-12345")).toBe("operations");
    expect(portalOf("/studio")).toBe("studio");
    expect(portalOf("/studio/brain/e/x")).toBe("studio");
    expect(portalOf("/studios")).toBe("operations");
  });

  it("builds each page's address in its portal", () => {
    expect(paths.brain.thing("a b")).toBe("/studio/brain/e/a%20b");
    expect(paths.ai("cv-screener", "operations")).toBe("/ai/cv-screener");
    expect(paths.ai("cv-screener", "studio", "coaching")).toBe("/studio/ai/cv-screener?tab=coaching");
    expect(paths.table("complaints", "studio", { change: "add a field" })).toBe("/studio/tables/complaints?change=add+a+field");
    expect(paths.settings("connections", { signin: "ok" })).toBe("/studio/settings/connections?signin=ok");
    expect(paths.need("studio", { text: "A register of complaints", as: "table" })).toBe("/studio?need=A+register+of+complaints&as=table");
    expect(paths.home("studio")).toBe("/studio");
  });

  it("sends old addresses to their new place, keeping parameters, query and hash", () => {
    expect(upgrade("/brain/e/123")).toBe("/studio/brain/e/123");
    expect(upgrade("/brain")).toBe("/studio/brain");
    expect(upgrade("/brain/map?focus=9")).toBe("/studio/brain/map?focus=9");
    expect(upgrade("/brain/ask")).toBe("/chat/for/ai_employee/company-brain");
    expect(upgrade("/settings/connections?signin=ok#top")).toBe("/studio/settings/connections?signin=ok#top");
    expect(upgrade("/settings/mailboxes")).toBe("/mail");
    expect(upgrade("/hire/studio/new?template=hr.cv-screener")).toBe("/studio/interviews/new?template=hr.cv-screener");
    expect(upgrade("/catalog/departments/finance")).toBe("/studio/ready-made/finance");
    expect(upgrade("/runs")).toBe("/work?view=tasks");
    // Today's addresses, outside links and files stay as they are.
    for (const href of ["/work/EB-1", "/chat/abc", "/ai/x", "/studio/brain", "https://example.com/brain", "/api/companies/acme/files/1"]) {
      expect(upgrade(href)).toBe(href);
    }
    expect(movedTo("/work?view=tasks", {}, "status=done")).toBe("/work?view=tasks&status=done");
    // Specific old addresses come before the general ones they also match.
    const order = MOVED.map(([from]) => from);
    expect(order.indexOf("brain/ask")).toBeLessThan(order.indexOf("brain/*"));
    expect(order.indexOf("settings/mailboxes")).toBeLessThan(order.indexOf("settings/*"));
  });

  it("finds the same page in the other portal", () => {
    expect(twin("/ai/cv-screener")).toBe("/studio/ai/cv-screener");
    expect(twin("/studio/ai/cv-screener")).toBe("/ai/cv-screener");
    expect(twin("/ai/cv-screener/app")).toBe("/studio/ai/cv-screener");
    expect(twin("/tables/complaints")).toBe("/studio/tables/complaints");
    expect(twin("/studio/apps")).toBe("/apps");
    expect(twin("/company")).toBe("/studio/ai");
    expect(twin("/work")).toBeNull();
    expect(twin("/studio/brain/e/1")).toBeNull();
  });
});

describe("chat addresses", () => {
  it("builds channels, direct messages and threads", () => {
    expect(paths.conversation("c-1")).toBe("/chat/c-1");
    expect(paths.conversation("c-1", { thread: "m-9" })).toBe("/chat/c-1?thread=m-9");
    expect(paths.thread("c-1", "m 9")).toBe("/chat/c-1?thread=m%209");
    expect(paths.threads()).toBe("/chat/threads");
    expect(paths.dm("u-7")).toBe("/chat/for/dm/u-7");
    expect(paths.aiChat("invoice-helper", { work: 1 })).toBe("/chat/for/ai_employee/invoice-helper?work=1");
  });
});
