import { describe, expect, it } from "vitest";
import { sandboxHrisConnector } from "../src/index.ts";
import { addWorkingDays, nextWorkday, workingDaysBetween } from "../src/sandbox/common.ts";
import { addDays, toIsoDate } from "../src/util.ts";
import { expectConnectorError, makeCtx, run } from "./helpers.ts";

const hris = sandboxHrisConnector;

/** A working-day range starting about `offset` days from today that does not cross a year boundary. */
function range(offset: number, workingDays: number): { start_date: string; end_date: string } {
  let start = toIsoDate(nextWorkday(addDays(new Date(), offset)));
  if (addWorkingDays(start, workingDays - 1).slice(0, 4) !== start.slice(0, 4)) {
    start = toIsoDate(nextWorkday(new Date(Date.UTC(Number(start.slice(0, 4)) + 1, 0, 2))));
  }
  return { start_date: start, end_date: addWorkingDays(start, workingDays - 1) };
}

describe("sandbox-hris", () => {
  it("returns employees by id or e-mail with manager and reports", async () => {
    const ctx = makeCtx();
    const ceo = await run(hris, "get_employee", { employee_id: "EMP-0001" }, ctx);
    expect(ceo).toMatchObject({ full_name: "Mehmet Aydın", position: "Chief Executive Officer", manager: null, email: "mehmet.aydin@acme.example" });
    expect(ceo.direct_reports.length).toBeGreaterThanOrEqual(4);
    const ali = await run(hris, "get_employee", { email: "ALI.YILDIZ@acme.example" }, ctx);
    expect(ali.manager).toMatchObject({ employee_id: "EMP-0005", full_name: "Thomas Weber" });
    expect((await expectConnectorError(hris.execute("get_employee", {}, ctx))).code).toBe("validation");
    expect((await run(hris, "search_employees", { query: "finance" }, ctx)).total).toBeGreaterThanOrEqual(4);
    expect((await run(hris, "search_employees", { query: "gebze" }, ctx)).items.every((e: any) => e.location.startsWith("Gebze"))).toBe(true);
  });

  it("computes statutory leave balances by seniority", async () => {
    const ctx = makeCtx();
    const ceo = await run(hris, "get_leave_balance", { employee_id: "EMP-0001" }, ctx);
    expect(ceo.service_years).toBeGreaterThanOrEqual(15);
    expect(ceo.balances.annual.entitlement).toBe(26);
    const ali = await run(hris, "get_leave_balance", { employee_id: "EMP-0013" }, ctx);
    expect(ali.balances.annual).toMatchObject({ entitlement: 20, carried_over: 0 });
    const newcomer = await run(hris, "get_leave_balance", { employee_id: "EMP-0017" }, ctx);
    expect(newcomer.balances.annual.entitlement).toBe(0);
    expect(newcomer.balances.sick.entitlement).toBe(10);
  });

  it("lists positions with vacancies linked to requisitions", async () => {
    const positions = await run(hris, "list_positions", {}, makeCtx());
    const backend = positions.items.find((p: any) => p.position_id === "POS-121");
    expect(backend).toMatchObject({ title: "Senior Backend Engineer (Node.js)", requisition_id: "REQ-301", vacancies: 1, filled: 0 });
    expect(positions.total_vacancies).toBeGreaterThanOrEqual(6);
  });

  it("creates leave requests within the balance and routes them to the manager", async () => {
    const ctx = makeCtx();
    const before = await run(hris, "get_leave_balance", { employee_id: "EMP-0001" }, ctx);
    const dates = range(120, 3);
    const request = await run(hris, "create_leave_request", { employee_id: "EMP-0001", type: "excuse", ...dates, reason: "Family matters" }, ctx);
    expect(request).toMatchObject({ ok: true, status: "pending", working_days: workingDaysBetween(dates.start_date, dates.end_date), approver_id: null });
    if (dates.start_date.startsWith(String(new Date().getUTCFullYear()))) {
      expect(request.balance_after.pending).toBe(before.balances.excuse.pending + request.working_days);
    }
    const routed = await run(hris, "create_leave_request", { employee_id: "EMP-0010", type: "sick", ...range(-3, 1) }, ctx);
    expect(routed).toMatchObject({ approver_id: "EMP-0004", approver_name: "Burak Şahin" });
    const approved = await run(hris, "update_leave_request", { request_id: routed.request_id, status: "approved", note: "Get well soon" }, ctx);
    expect(approved).toMatchObject({ ok: true, status: "approved", decision_note: "Get well soon" });
    expect((await run(hris, "list_leave_requests", { employee_id: "EMP-0010", status: "approved" }, ctx)).items.map((r: any) => r.request_id)).toContain(
      routed.request_id,
    );
  });

  it("rejects requests exceeding the remaining balance", async () => {
    const ctx = makeCtx();
    const balance = await run(hris, "get_leave_balance", { employee_id: "EMP-0013" }, ctx);
    const remaining = balance.balances.annual.remaining;
    expect(remaining).toBeGreaterThanOrEqual(0);
    const today = new Date();
    // Stay inside the current leave year: start early in the year when today is late in December.
    const start = toIsoDate(nextWorkday(new Date(Date.UTC(today.getUTCFullYear(), 0, 5))));
    const tooLong = { start_date: start, end_date: addWorkingDays(start, remaining) };
    const error = await expectConnectorError(hris.execute("create_leave_request", { employee_id: "EMP-0013", type: "annual", ...tooLong }, ctx));
    expect(error.code).toBe("validation");
    expect(error.message).toContain(`requested ${remaining + 1} working day(s), remaining ${remaining}`);
  });

  it("rejects annual leave before one year of service, overlaps and invalid ranges", async () => {
    const ctx = makeCtx();
    const newcomer = await expectConnectorError(hris.execute("create_leave_request", { employee_id: "EMP-0017", type: "annual", ...range(30, 2) }, ctx));
    expect(newcomer.message).toMatch(/not yet entitled to annual leave/);
    const unpaid = await run(hris, "create_leave_request", { employee_id: "EMP-0017", type: "unpaid", ...range(30, 2) }, ctx);
    expect(unpaid.status).toBe("pending");
    const overlap = await expectConnectorError(hris.execute("create_leave_request", { employee_id: "EMP-0017", type: "excuse", ...range(30, 1) }, ctx));
    expect(overlap.message).toMatch(/Overlaps with pending request/);
    const reversed = await expectConnectorError(hris.execute("create_leave_request", { employee_id: "EMP-0001", type: "annual", start_date: "2026-10-10", end_date: "2026-10-01" }, ctx));
    expect(reversed.message).toMatch(/end_date must not be before start_date/);
    const weekend = await expectConnectorError(hris.execute("create_leave_request", { employee_id: "EMP-0001", type: "annual", start_date: "2026-10-03", end_date: "2026-10-04" }, ctx));
    expect(weekend.message).toMatch(/No working days/);
    const badType = await expectConnectorError(hris.execute("create_leave_request", { employee_id: "EMP-0001", type: "sabbatical", start_date: "2026-10-05", end_date: "2026-10-05" }, ctx));
    expect(badType.message).toMatch(/type must be one of: annual, sick, excuse, unpaid/);
    const vacation = await run(hris, "create_leave_request", { employee_id: "EMP-0001", type: "Vacation", ...range(200, 1) }, ctx);
    expect(vacation.type).toBe("annual");
    expect((await run(hris, "update_leave_request", { request_id: vacation.request_id, status: "approve" }, ctx)).status).toBe("approved");
  });

  it("only allows valid leave decisions", async () => {
    const ctx = makeCtx();
    const rejected = await expectConnectorError(hris.execute("update_leave_request", { request_id: "LR-1007", status: "approved" }, ctx));
    expect(rejected.message).toMatch(/is rejected and cannot be approved/);
    expect((await run(hris, "update_leave_request", { request_id: "LR-1002", status: "cancelled" }, ctx)).status).toBe("cancelled");
    expect((await expectConnectorError(hris.execute("update_leave_request", { request_id: "LR-9999", status: "approved" }, ctx))).code).toBe("not_found");
  });

  it("creates employees and fills a matching vacancy", async () => {
    const ctx = makeCtx();
    const start = toIsoDate(addDays(new Date(), 30));
    const employee = await run(
      hris,
      "create_employee",
      { first_name: "Mert", last_name: "Yalçın", email: "mert.yalcin@acme.example", position: "senior backend engineer (node.js)", department: "IT", start_date: start, manager_id: "EMP-0007" },
      ctx,
    );
    expect(employee).toMatchObject({ ok: true, employee_id: "EMP-0021", status: "pre_boarding", position_id: "POS-121", cost_center: "CC-2500" });
    expect(employee.position_assignment.requisition_id).toBe("REQ-301");
    const positions = await run(hris, "list_positions", {}, ctx);
    expect(positions.items.find((p: any) => p.position_id === "POS-121").vacancies).toBe(0);
    expect((await expectConnectorError(hris.execute("create_employee", { first_name: "X", last_name: "Y", email: "mert.yalcin@acme.example", position: "Dev", department: "IT", start_date: start }, ctx))).message).toMatch(
      /already exists/,
    );
    expect((await expectConnectorError(hris.execute("create_employee", { first_name: "X", last_name: "Y", email: "x.y@acme.example", position: "Dev", department: "IT", start_date: start, manager_id: "EMP-9999" }, ctx))).code).toBe(
      "not_found",
    );
  });
});
