import { describe, expect, it } from "vitest";
import { sandboxItsmConnector } from "../src/index.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

const itsm = sandboxItsmConnector;

describe("sandbox-itsm", () => {
  it("returns tickets and filters them by status and requester", async () => {
    const ctx = makeCtx();
    const ticket = await run(itsm, "get_ticket", { ticket_id: "TCK-1001" }, ctx);
    expect(ticket).toMatchObject({ category: "erp", priority: "high", assignment_group: "SAP Basis & ERP Support", status: "in_progress" });
    const mine = await run(itsm, "search_tickets", { requester_email: "Laura.Rossi@acme.example" }, ctx);
    expect(mine.items.map((t: any) => t.ticket_id)).toEqual(["TCK-1003"]);
    const fresh = await run(itsm, "search_tickets", { status: "new" }, ctx);
    expect(fresh.total).toBeGreaterThanOrEqual(3);
    expect((await expectConnectorError(itsm.execute("get_ticket", { ticket_id: "TCK-0000" }, ctx))).code).toBe("not_found");
  });

  it("returns assets by tag or by user", async () => {
    const ctx = makeCtx();
    expect(await run(itsm, "get_asset", { asset_tag: "acm-lt-0127" }, ctx)).toMatchObject({ model: "Lenovo ThinkPad T14 Gen 4", assigned_to: "ozan.kurt@acme.example" });
    const emre = await run(itsm, "get_asset", { user_email: "emre.koc@acme.example" }, ctx);
    expect(emre.items.map((a: any) => a.asset_tag)).toEqual(["ACM-LT-0114", "ACM-MN-0305"]);
    expect((await expectConnectorError(itsm.execute("get_asset", {}, ctx))).code).toBe("validation");
  });

  it("creates tickets routed by category with priority-based SLA", async () => {
    const ctx = makeCtx();
    const ticket = await run(
      itsm,
      "create_ticket",
      { requester_email: "Gizem.Polat@acme.example", title: "VPN not connecting", description: "Error 'gateway unreachable' at home office", category: "network", priority: "critical" },
      ctx,
    );
    expect(ticket).toMatchObject({ ok: true, ticket_id: "TCK-1013", status: "new", assignment_group: "Network Operations", requester_email: "gizem.polat@acme.example" });
    expect(Date.parse(ticket.sla_due_at) - Date.parse(ticket.created_at)).toBe(4 * 3_600_000);
    const routed = await run(
      itsm,
      "create_ticket",
      { requester_email: "emre.koc@acme.example", title: "Monitor flickers", description: "ACM-MN-0305 flickers", category: "hardware", priority: "low", assignment_group: "service desk" },
      ctx,
    );
    expect(routed).toMatchObject({ assignment_group: "Service Desk", asset_tag: "ACM-MN-0305" });
    expect((await expectConnectorError(itsm.execute("create_ticket", { requester_email: "x@acme.example", title: "t", description: "d", category: "hardware", priority: "whenever" }, ctx))).message).toMatch(
      /priority must be one of: low, medium, high, critical/,
    );
    const synonyms = await run(itsm, "create_ticket", { requester_email: "x@acme.example", title: "Password reset", description: "Locked out", category: "Password reset", priority: "urgent" }, ctx);
    expect(synonyms).toMatchObject({ category: "access", priority: "critical", assignment_group: "Identity & Access Management" });
    const unknown = await run(itsm, "create_ticket", { requester_email: "x@acme.example", title: "Coffee machine", description: "Broken", category: "Facilities", priority: "P4" }, ctx);
    expect(unknown).toMatchObject({ category: "other", category_detail: "Facilities", priority: "low", assignment_group: "Service Desk" });
  });

  it("updates tickets and refuses to reopen closed ones", async () => {
    const ctx = makeCtx();
    const updated = await run(itsm, "update_ticket", { ticket_id: "TCK-1004", status: "in_progress", comment: "Checking the attachment policy" }, ctx);
    expect(updated).toMatchObject({ ok: true, status: "in_progress", comments: [{ text: "Checking the attachment policy" }] });
    const resolved = await run(itsm, "update_ticket", { ticket_id: "TCK-1004", status: "resolved" }, ctx);
    expect(resolved.resolved_at).toBeTruthy();
    expect((await expectConnectorError(itsm.execute("update_ticket", { ticket_id: "TCK-1006", status: "in_progress" }, ctx))).message).toMatch(/closed/);
    expect((await expectConnectorError(itsm.execute("update_ticket", { ticket_id: "TCK-1004" }, ctx))).code).toBe("validation");
  });

  it("creates access requests with system-owner approval and a linked ticket", async () => {
    const ctx = makeCtx();
    const request = await run(
      itsm,
      "create_access_request",
      { requester_email: "murat.kilic@acme.example", system: "SAP S/4HANA", role: "MM Goods Receipt (MIGO)", justification: "Posting goods receipts in the Gebze warehouse" },
      ctx,
    );
    expect(request).toMatchObject({ ok: true, request_id: "ACR-6009", status: "pending_approval", approver_email: "selin.arslan@acme.example", ticket_id: "TCK-1013" });
    const ticket = await run(itsm, "get_ticket", { ticket_id: "TCK-1013" }, ctx);
    expect(ticket).toMatchObject({ category: "access", assignment_group: "Identity & Access Management", related_request: "ACR-6009" });
    expect((await expectConnectorError(itsm.execute("create_access_request", { requester_email: "murat.kilic@acme.example", system: "sap s/4hana", role: "mm goods receipt (migo)", justification: "Again, please grant it" }, ctx))).message).toMatch(
      /already has access request ACR-6009/,
    );
    expect((await expectConnectorError(itsm.execute("create_access_request", { requester_email: "a@acme.example", system: "VPN", role: "User", justification: "need" }, ctx))).message).toMatch(
      /justification/,
    );
  });
});
