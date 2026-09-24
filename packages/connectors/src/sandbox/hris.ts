import { defineManifest } from "../define.ts";
import { date, email, oneOf, readOp, str, writeOp } from "../schema.ts";
import { ConnectorError } from "../types.ts";
import {
  addDays,
  matchesQuery,
  normalizeEmail,
  normalizeText,
  optEnum,
  optString,
  parseIsoDate,
  reqEnum,
  reqString,
  toIsoDate,
  type Rec,
} from "../util.ts";
import {
  addWorkingDays,
  defineSandboxConnector,
  emailFor,
  listResult,
  nowIso,
  relativeDates,
  todayIso,
  workingDaysBetween,
  type SandboxDb,
} from "./common.ts";

const DOMAIN = "acme.example";
const LEAVE_TYPES = ["annual", "sick", "excuse", "unpaid"] as const;
const BALANCE_TYPES = ["annual", "sick", "excuse"] as const;
const REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
const DECISIONS = ["approved", "rejected", "cancelled"] as const;

const LEAVE_TYPE_SYNONYMS: Record<string, (typeof LEAVE_TYPES)[number]> = {
  vacation: "annual",
  holiday: "annual",
  annual_leave: "annual",
  paid: "annual",
  paid_leave: "annual",
  pto: "annual",
  yillik: "annual",
  yillik_izin: "annual",
  sick_leave: "sick",
  illness: "sick",
  medical: "sick",
  rapor: "sick",
  personal: "excuse",
  excuse_leave: "excuse",
  marriage: "excuse",
  bereavement: "excuse",
  compassionate: "excuse",
  mazeret: "excuse",
  mazeret_izni: "excuse",
  unpaid_leave: "unpaid",
  ucretsiz: "unpaid",
  ucretsiz_izin: "unpaid",
};

const DECISION_SYNONYMS: Record<string, (typeof DECISIONS)[number]> = {
  approve: "approved",
  accept: "approved",
  accepted: "approved",
  reject: "rejected",
  decline: "rejected",
  declined: "rejected",
  deny: "rejected",
  denied: "rejected",
  cancel: "cancelled",
  canceled: "cancelled",
  withdraw: "cancelled",
  withdrawn: "cancelled",
};

type LeaveType = (typeof LEAVE_TYPES)[number];
type BalanceType = (typeof BALANCE_TYPES)[number];
type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Company policy on top of the statutory annual leave. */
const SICK_DAYS = 10;
const EXCUSE_DAYS = 5;

interface Employee {
  employee_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  phone: string | null;
  position: string;
  position_id: string | null;
  department: string;
  cost_center: string;
  location: string;
  manager_id: string | null;
  start_date: string;
  employment_type: "full_time" | "part_time" | "contractor";
  status: "active" | "on_leave" | "pre_boarding" | "terminated";
  created_at: string;
}

interface LeaveBalance {
  key: string;
  employee_id: string;
  year: number;
  entitlements: Record<BalanceType, number>;
  carried_over: Record<BalanceType, number>;
  /** Days used before requests were tracked in this system. */
  used_before_tracking: Record<BalanceType, number>;
}

interface LeaveRequest {
  request_id: string;
  employee_id: string;
  employee_name: string;
  type: LeaveType;
  start_date: string;
  end_date: string;
  working_days: number;
  reason: string | null;
  status: RequestStatus;
  approver_id: string | null;
  approver_name: string | null;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

interface Position {
  position_id: string;
  title: string;
  department: string;
  location: string;
  grade: string;
  headcount: number;
  incumbents: string[];
  requisition_id: string | null;
  status: "active" | "frozen";
}

const HQ = "Istanbul HQ (Ataşehir)";
const GEBZE = "Gebze Plant (Kocaeli)";
const HAMBURG = "Hamburg Sales Office";

/** Statutory annual leave by completed years of service (Turkish Labour Law 4857, Art. 53). */
function statutoryAnnualLeave(startDate: string, asOf: string): number {
  const years = serviceYears(startDate, asOf);
  if (years < 1) return 0;
  if (years <= 5) return 14;
  if (years < 15) return 20;
  return 26;
}

function serviceYears(startDate: string, asOf: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${asOf}T00:00:00Z`);
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  if (end.getUTCMonth() < start.getUTCMonth() || (end.getUTCMonth() === start.getUTCMonth() && end.getUTCDate() < start.getUTCDate())) {
    years--;
  }
  return Math.max(0, years);
}

function seed(today: Date): Record<string, object[]> {
  const { at, workday } = relativeDates(today);
  const year = today.getUTCFullYear();
  const yearsAgo = (years: number, extraDays = 0) => toIsoDate(addDays(today, -Math.round(years * 365.25) - extraDays));

  const emp = (
    n: number,
    first: string,
    last: string,
    position: string,
    positionId: string,
    department: string,
    costCenter: string,
    location: string,
    managerId: string | null,
    startDate: string,
    status: Employee["status"] = "active",
  ): Employee => ({
    employee_id: `EMP-${String(n).padStart(4, "0")}`,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    email: emailFor(first, last, DOMAIN),
    phone: `+90 5${30 + (n % 9)} 555 ${String(1000 + n * 37).slice(-4, -2)} ${String(1000 + n * 37).slice(-2)}`,
    position,
    position_id: positionId,
    department,
    cost_center: costCenter,
    location,
    manager_id: managerId,
    start_date: startDate,
    employment_type: "full_time",
    status,
    created_at: `${startDate}T06:00:00.000Z`,
  });

  const employees: Employee[] = [
    emp(1, "Mehmet", "Aydın", "Chief Executive Officer", "POS-101", "Executive Management", "CC-1000", HQ, null, yearsAgo(18, 120)),
    emp(2, "Elif", "Yılmaz", "Chief Financial Officer", "POS-102", "Finance", "CC-2000", HQ, "EMP-0001", yearsAgo(9, 40)),
    emp(3, "Zeynep", "Demir", "HR Director", "POS-103", "Human Resources", "CC-3000", HQ, "EMP-0001", yearsAgo(7, 200)),
    emp(4, "Burak", "Şahin", "Plant Manager", "POS-104", "Operations", "CC-4000", GEBZE, "EMP-0001", yearsAgo(12, 75)),
    { ...emp(5, "Thomas", "Weber", "Sales Director", "POS-105", "Sales", "CC-5000", HAMBURG, "EMP-0001", yearsAgo(6, 20)), phone: "+49 171 5550 105" },
    emp(6, "Ayşe", "Kaya", "Procurement Manager", "POS-106", "Procurement", "CC-4200", GEBZE, "EMP-0004", yearsAgo(8, 150)),
    emp(7, "Can", "Öztürk", "IT Manager", "POS-107", "IT", "CC-2500", HQ, "EMP-0002", yearsAgo(5, 60)),
    emp(8, "Selin", "Arslan", "Chief Accountant", "POS-108", "Finance", "CC-2000", HQ, "EMP-0002", yearsAgo(10, 10)),
    emp(9, "Emre", "Koç", "Accounts Payable Specialist", "POS-109", "Finance", "CC-2000", HQ, "EMP-0008", yearsAgo(3, 90)),
    emp(10, "Deniz", "Çelik", "Production Engineer", "POS-110", "Operations", "CC-4100", GEBZE, "EMP-0004", yearsAgo(4, 30)),
    emp(11, "Merve", "Aksoy", "Quality Engineer", "POS-111", "Quality", "CC-4300", GEBZE, "EMP-0004", yearsAgo(2, 110)),
    emp(12, "Gizem", "Polat", "HR Specialist (Recruitment)", "POS-112", "Human Resources", "CC-3000", HQ, "EMP-0003", yearsAgo(1, 180)),
    emp(13, "Ali", "Yıldız", "Key Account Manager Türkiye", "POS-113", "Sales", "CC-5100", HQ, "EMP-0005", yearsAgo(6, 250)),
    { ...emp(14, "Laura", "Rossi", "Export Sales Manager EMEA", "POS-114", "Sales", "CC-5200", HAMBURG, "EMP-0005", yearsAgo(3, 180)), phone: "+49 171 5550 114" },
    emp(15, "Hakan", "Erdoğan", "Maintenance Technician", "POS-115", "Operations", "CC-4100", GEBZE, "EMP-0004", yearsAgo(16, 30)),
    emp(16, "Serkan", "Güneş", "Warehouse Supervisor", "POS-116", "Logistics", "CC-4400", GEBZE, "EMP-0004", yearsAgo(7, 5)),
    emp(17, "Ozan", "Kurt", "Software Developer", "POS-117", "IT", "CC-2500", HQ, "EMP-0007", yearsAgo(0, 240)),
    emp(18, "Ece", "Doğan", "Customer Service Specialist", "POS-118", "Customer Service", "CC-5300", HQ, "EMP-0005", yearsAgo(2, 190)),
    emp(19, "Murat", "Kılıç", "Logistics Specialist", "POS-119", "Logistics", "CC-4400", GEBZE, "EMP-0016", yearsAgo(1, 75)),
    emp(20, "Hande", "Özkan", "Financial Controller", "POS-120", "Finance", "CC-2000", HQ, "EMP-0002", yearsAgo(4, 200), "on_leave"),
  ];

  const pos = (
    id: string,
    title: string,
    department: string,
    location: string,
    grade: string,
    headcount: number,
    incumbents: string[],
    requisitionId: string | null = null,
    status: Position["status"] = "active",
  ): Position => ({ position_id: id, title, department, location, grade, headcount, incumbents, requisition_id: requisitionId, status });

  const positions: Position[] = [
    ...employees.map((e) =>
      pos(
        e.position_id ?? "",
        e.position,
        e.department,
        e.location,
        e.manager_id === null ? "E1" : e.manager_id === "EMP-0001" ? "M3" : e.position.includes("Manager") || e.position.includes("Chief") ? "M2" : "P3",
        e.employee_id === "EMP-0010" ? 2 : 1,
        [e.employee_id],
      ),
    ),
    pos("POS-121", "Senior Backend Engineer (Node.js)", "IT", HQ, "P4", 1, [], "REQ-301"),
    pos("POS-122", "HR Business Partner", "Human Resources", GEBZE, "P4", 1, [], "REQ-302"),
    pos("POS-123", "Sales Development Representative", "Sales", HAMBURG, "P2", 2, [], "REQ-303"),
    pos("POS-124", "Financial Analyst", "Finance", HQ, "P3", 1, [], "REQ-304"),
    pos("POS-125", "Production Planning Engineer", "Operations", GEBZE, "P3", 1, [], "REQ-305"),
    pos("POS-126", "Quality Control Technician", "Quality", GEBZE, "T2", 1, [], "REQ-306", "frozen"),
  ];

  const asOf = toIsoDate(today);
  const usedBefore: Record<string, [number, number, number]> = {
    "EMP-0001": [8, 0, 1],
    "EMP-0002": [4, 1, 0],
    "EMP-0004": [10, 2, 0],
    "EMP-0006": [6, 0, 2],
    "EMP-0008": [9, 3, 0],
    "EMP-0010": [5, 1, 0],
    "EMP-0013": [12, 0, 1],
    "EMP-0015": [15, 4, 0],
    "EMP-0016": [7, 2, 0],
    "EMP-0018": [3, 2, 0],
  };
  const carried: Record<string, number> = { "EMP-0001": 6, "EMP-0004": 4, "EMP-0008": 2, "EMP-0014": 3, "EMP-0015": 5 };

  const balances: LeaveBalance[] = employees.map((e) => {
    const [annual, sick, excuse] = usedBefore[e.employee_id] ?? [2, 0, 0];
    return {
      key: `${e.employee_id}:${year}`,
      employee_id: e.employee_id,
      year,
      entitlements: { annual: statutoryAnnualLeave(e.start_date, asOf), sick: SICK_DAYS, excuse: EXCUSE_DAYS },
      carried_over: { annual: carried[e.employee_id] ?? 0, sick: 0, excuse: 0 },
      used_before_tracking: { annual, sick, excuse },
    };
  });

  const byId = new Map(employees.map((e) => [e.employee_id, e]));
  const request = (
    id: string,
    employeeId: string,
    type: LeaveType,
    startOffset: number,
    workingDays: number,
    status: RequestStatus,
    reason: string | null,
    decisionNote: string | null = null,
  ): LeaveRequest => {
    const employee = byId.get(employeeId);
    const approver = employee?.manager_id ? byId.get(employee.manager_id) : undefined;
    const start = workday(startOffset);
    const end = addWorkingDays(start, workingDays - 1);
    return {
      request_id: id,
      employee_id: employeeId,
      employee_name: employee?.full_name ?? employeeId,
      type,
      start_date: start,
      end_date: end,
      working_days: workingDaysBetween(start, end),
      reason,
      status,
      approver_id: approver?.employee_id ?? null,
      approver_name: approver?.full_name ?? null,
      created_at: at(Math.min(startOffset - 10, -1), 9),
      decided_at: status === "pending" ? null : at(Math.min(startOffset - 8, 0), 16),
      decision_note: decisionNote,
    };
  };

  const leaveRequests: LeaveRequest[] = [
    request("LR-1001", "EMP-0009", "annual", -40, 5, "approved", "Family visit in Trabzon"),
    request("LR-1002", "EMP-0013", "annual", 12, 5, "approved", "Summer holiday"),
    request("LR-1003", "EMP-0010", "annual", 20, 5, "pending", "Holiday"),
    request("LR-1004", "EMP-0018", "sick", -10, 2, "approved", "Flu (doctor's note submitted)"),
    request("LR-1005", "EMP-0014", "annual", 30, 10, "pending", "Trip to Italy"),
    request("LR-1006", "EMP-0016", "excuse", -5, 1, "approved", "Wedding of a sibling"),
    request("LR-1007", "EMP-0011", "annual", 3, 5, "rejected", "Holiday", "Customer audit (Petrokim) that week; please choose another week."),
    request("LR-1008", "EMP-0020", "unpaid", -60, 85, "approved", "Unpaid leave after maternity leave (Art. 74)"),
    request("LR-1009", "EMP-0002", "annual", -80, 8, "approved", "Summer holiday"),
    request("LR-1010", "EMP-0012", "annual", 8, 2, "pending", "Moving house"),
  ];

  return { employees, leave_balances: balances, leave_requests: leaveRequests, positions };
}

// ---------------------------------------------------------------------------
// Leave logic
// ---------------------------------------------------------------------------

interface BalanceView {
  entitlement: number;
  carried_over: number;
  used: number;
  pending: number;
  remaining: number;
}

/** Date at which seniority is measured for a leave year: year end for past years, today for the current one. */
function seniorityDate(year: number): string {
  const today = todayIso();
  const current = Number(today.slice(0, 4));
  if (year < current) return `${year}-12-31`;
  return year === current ? today : `${year}-01-01`;
}

async function loadBalance(db: SandboxDb, employee: Employee, year: number): Promise<LeaveBalance> {
  const existing = await db.get<LeaveBalance>("leave_balances", `${employee.employee_id}:${year}`);
  if (existing) return existing;
  // New leave year (or new hire): entitlement from seniority, nothing used yet.
  const balance: LeaveBalance = {
    key: `${employee.employee_id}:${year}`,
    employee_id: employee.employee_id,
    year,
    entitlements: { annual: statutoryAnnualLeave(employee.start_date, seniorityDate(year)), sick: SICK_DAYS, excuse: EXCUSE_DAYS },
    carried_over: { annual: 0, sick: 0, excuse: 0 },
    used_before_tracking: { annual: 0, sick: 0, excuse: 0 },
  };
  await db.put("leave_balances", balance);
  return balance;
}

function balanceViews(balance: LeaveBalance, requests: LeaveRequest[]): Record<BalanceType, BalanceView> & { unpaid: { used: number; pending: number } } {
  const inYear = requests.filter((r) => r.employee_id === balance.employee_id && r.start_date.startsWith(String(balance.year)));
  const total = (type: LeaveType, status: RequestStatus) =>
    inYear.filter((r) => r.type === type && r.status === status).reduce((acc, r) => acc + r.working_days, 0);
  const view = (type: BalanceType): BalanceView => {
    const used = balance.used_before_tracking[type] + total(type, "approved");
    const pending = total(type, "pending");
    return {
      entitlement: balance.entitlements[type],
      carried_over: balance.carried_over[type],
      used,
      pending,
      remaining: balance.entitlements[type] + balance.carried_over[type] - used - pending,
    };
  };
  return {
    annual: view("annual"),
    sick: view("sick"),
    excuse: view("excuse"),
    unpaid: { used: total("unpaid", "approved"), pending: total("unpaid", "pending") },
  };
}

async function findEmployee(db: SandboxDb, input: { employee_id?: string; email?: string }): Promise<Employee> {
  if (input.employee_id) return db.require<Employee>("employees", input.employee_id.toUpperCase(), "Employee");
  if (input.email) {
    const wanted = input.email.toLowerCase();
    const employee = (await db.list<Employee>("employees")).find((e) => e.email === wanted);
    if (!employee) throw new ConnectorError(`Employee with e-mail ${input.email} not found`, "not_found");
    return employee;
  }
  throw new ConnectorError("Provide employee_id or email", "validation");
}

function publicEmployee(employee: Employee, all: Employee[]): Rec {
  const manager = employee.manager_id ? all.find((e) => e.employee_id === employee.manager_id) : undefined;
  return {
    ...employee,
    service_years: serviceYears(employee.start_date, todayIso()),
    manager: manager ? { employee_id: manager.employee_id, full_name: manager.full_name, email: manager.email, position: manager.position } : null,
    direct_reports: all
      .filter((e) => e.manager_id === employee.employee_id)
      .map((e) => ({ employee_id: e.employee_id, full_name: e.full_name, position: e.position })),
  };
}

// ---------------------------------------------------------------------------
// Manifest & operations
// ---------------------------------------------------------------------------

const manifest = defineManifest({
  type: "sandbox-hris",
  name: "Sandbox HRIS",
  vendor: "Enterprise Brain",
  category: "hris",
  description:
    "Built-in demo HR system of Acme Endüstri A.Ş.: 20 employees across Istanbul HQ, Gebze plant and the Hamburg sales office, positions and vacancies, leave balances (statutory annual leave by seniority per Turkish Labour Law, plus sick and excuse days) and leave requests. Works without credentials; changes persist per company.",
  auth: "none",
  maturity: "sandbox",
  operations: [
    readOp("get_employee", "Get employee", "Employee record with manager and direct reports, by employee id or e-mail.", {
      employee_id: str("Employee id, e.g. EMP-0001"),
      email: email("Work e-mail address"),
    }),
    readOp("search_employees", "Search employees", "Find employees by name, e-mail, position, department or location.", {
      query: str("Free-text search, e.g. 'finance' or 'Gebze'"),
    }),
    readOp("get_leave_balance", "Get leave balance", "Leave balances of the current year per leave type (entitlement, carried over, used, pending, remaining) and upcoming leave.", {
      employee_id: str("Employee id, e.g. EMP-0013"),
    }, ["employee_id"]),
    readOp("list_leave_requests", "List leave requests", "Leave requests, newest first, by employee and/or status.", {
      employee_id: str("Employee id"),
      status: oneOf(REQUEST_STATUSES, "Request status"),
    }),
    readOp("list_positions", "List positions", "Positions with headcount, incumbents, vacancies and linked job requisitions."),
    writeOp("create_leave_request", "Create leave request", "Request leave for an employee. Working days exclude weekends and fixed public holidays; the request is checked against the remaining balance and overlapping requests, then routed to the manager for approval.", {
      employee_id: str("Employee id, e.g. EMP-0013"),
      type: str("Leave type: annual (vacation), sick, excuse (marriage, bereavement...) or unpaid"),
      start_date: date("First day of leave (YYYY-MM-DD)"),
      end_date: date("Last day of leave (YYYY-MM-DD)"),
      reason: str("Reason / comment"),
    }, ["employee_id", "type", "start_date", "end_date"]),
    writeOp("update_leave_request", "Decide leave request", "Approve, reject or cancel a leave request.", {
      request_id: str("Leave request id, e.g. LR-1003"),
      status: str(`Decision: ${DECISIONS.join(", ")}`),
      note: str("Comment for the employee"),
    }, ["request_id", "status"]),
    writeOp("create_employee", "Create employee", "Create an employee record (e.g. after a signed offer). A vacant position with the same title is filled automatically.", {
      first_name: str("First name"),
      last_name: str("Last name"),
      email: email("Work e-mail address"),
      position: str("Job title or position id (e.g. POS-121)"),
      department: str("Department"),
      start_date: date("Start date (YYYY-MM-DD)"),
      manager_id: str("Employee id of the manager"),
    }, ["first_name", "last_name", "email", "position", "department", "start_date"]),
  ],
});

export const sandboxHrisConnector = defineSandboxConnector({
  manifest,
  keys: { employees: "employee_id", leave_balances: "key", leave_requests: "request_id", positions: "position_id" },
  seed,
  operations: {
    async get_employee(input, db) {
      const employee = await findEmployee(db, { employee_id: optString(input, "employee_id"), email: optString(input, "email") });
      return publicEmployee(employee, await db.list<Employee>("employees"));
    },

    async search_employees(input, db) {
      const query = optString(input, "query");
      const items = (await db.list<Employee>("employees"))
        .filter((e) => matchesQuery([e.employee_id, e.full_name, e.email, e.position, e.department, e.location, e.cost_center], query))
        .map((e) => ({
          employee_id: e.employee_id,
          full_name: e.full_name,
          email: e.email,
          position: e.position,
          department: e.department,
          location: e.location,
          manager_id: e.manager_id,
          status: e.status,
        }));
      return listResult(items);
    },

    async get_leave_balance(input, db) {
      const employee = await findEmployee(db, { employee_id: reqString(input, "employee_id") });
      const today = todayIso();
      const year = Number(today.slice(0, 4));
      const balance = await loadBalance(db, employee, year);
      const requests = await db.list<LeaveRequest>("leave_requests");
      const upcoming = requests
        .filter((r) => r.employee_id === employee.employee_id && r.end_date >= today && (r.status === "approved" || r.status === "pending"))
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
      return {
        employee_id: employee.employee_id,
        employee_name: employee.full_name,
        year,
        service_years: serviceYears(employee.start_date, today),
        balances: balanceViews(balance, requests),
        upcoming_leave: upcoming,
        policy: "Annual leave per Turkish Labour Law 4857 Art. 53 (14/20/26 days by seniority, from 1 year of service); company policy: 10 sick days, 5 excuse days per year.",
      };
    },

    async list_leave_requests(input, db) {
      const employeeId = optString(input, "employee_id")?.toUpperCase();
      const status = optEnum(input, "status", REQUEST_STATUSES);
      if (employeeId) await db.require<Employee>("employees", employeeId, "Employee");
      const items = (await db.list<LeaveRequest>("leave_requests"))
        .filter((r) => (!employeeId || r.employee_id === employeeId) && (!status || r.status === status))
        .sort((a, b) => b.start_date.localeCompare(a.start_date));
      return listResult(items);
    },

    async list_positions(_input, db) {
      const employees = new Map((await db.list<Employee>("employees")).map((e) => [e.employee_id, e]));
      const items = (await db.list<Position>("positions")).map((p) => ({
        ...p,
        incumbents: p.incumbents.map((id) => ({ employee_id: id, full_name: employees.get(id)?.full_name ?? id })),
        filled: p.incumbents.length,
        vacancies: Math.max(0, p.headcount - p.incumbents.length),
      }));
      return listResult(items, { total_vacancies: items.reduce((acc, p) => acc + p.vacancies, 0) });
    },

    async create_leave_request(input, db) {
      const employee = await findEmployee(db, { employee_id: reqString(input, "employee_id") });
      const type = reqEnum(input, "type", LEAVE_TYPES, LEAVE_TYPE_SYNONYMS);
      const start = parseIsoDate(reqString(input, "start_date"), "start_date");
      const end = parseIsoDate(reqString(input, "end_date"), "end_date");
      if (end < start) throw new ConnectorError("end_date must not be before start_date", "validation");
      if (employee.status === "terminated" || employee.status === "pre_boarding") {
        throw new ConnectorError(`${employee.full_name} (${employee.employee_id}) is ${employee.status.replace("_", "-")} and cannot request leave`, "validation");
      }
      if (start.slice(0, 4) !== end.slice(0, 4)) {
        throw new ConnectorError("A leave request must not span two leave years; split it at 31 December", "validation");
      }
      const workingDays = workingDaysBetween(start, end);
      if (workingDays === 0) throw new ConnectorError(`No working days between ${start} and ${end} (weekend or public holiday)`, "validation");

      const requests = await db.list<LeaveRequest>("leave_requests");
      const overlap = requests.find(
        (r) => r.employee_id === employee.employee_id && (r.status === "pending" || r.status === "approved") && r.start_date <= end && r.end_date >= start,
      );
      if (overlap) {
        throw new ConnectorError(
          `Overlaps with ${overlap.status} request ${overlap.request_id} (${overlap.type}, ${overlap.start_date} to ${overlap.end_date})`,
          "validation",
        );
      }

      const balance = await loadBalance(db, employee, Number(start.slice(0, 4)));
      const views = balanceViews(balance, requests);
      if (type !== "unpaid") {
        const view = views[type];
        if (type === "annual" && view.entitlement === 0 && view.carried_over === 0) {
          throw new ConnectorError(
            `${employee.full_name} is not yet entitled to annual leave: entitlement starts after 1 year of service (start date ${employee.start_date}; Labour Law 4857 Art. 53). Consider unpaid or excuse leave.`,
            "validation",
          );
        }
        if (workingDays > view.remaining) {
          throw new ConnectorError(
            `Insufficient ${type} leave balance for ${employee.full_name}: requested ${workingDays} working day(s), remaining ${view.remaining} (entitlement ${view.entitlement} + carried over ${view.carried_over} - used ${view.used} - pending ${view.pending})`,
            "validation",
          );
        }
      }

      const employees = await db.list<Employee>("employees");
      const approver = employee.manager_id ? employees.find((e) => e.employee_id === employee.manager_id) : undefined;
      const request: LeaveRequest = {
        request_id: await db.nextId("leave_requests", "LR-", 4),
        employee_id: employee.employee_id,
        employee_name: employee.full_name,
        type,
        start_date: start,
        end_date: end,
        working_days: workingDays,
        reason: optString(input, "reason") ?? null,
        status: "pending",
        approver_id: approver?.employee_id ?? null,
        approver_name: approver?.full_name ?? null,
        created_at: nowIso(),
        decided_at: null,
        decision_note: null,
      };
      await db.put("leave_requests", request);
      const after = balanceViews(balance, [...requests, request]);
      return { ...request, ok: true, balance_after: type === "unpaid" ? after.unpaid : after[type] };
    },

    async update_leave_request(input, db) {
      const request = await db.require<LeaveRequest>("leave_requests", reqString(input, "request_id").toUpperCase(), "Leave request");
      const status = reqEnum(input, "status", DECISIONS, DECISION_SYNONYMS);
      const allowed = request.status === "pending" ? DECISIONS : request.status === "approved" ? (["cancelled"] as const) : [];
      if (!(allowed as readonly string[]).includes(status)) {
        throw new ConnectorError(`Leave request ${request.request_id} is ${request.status} and cannot be ${status}`, "validation");
      }
      request.status = status;
      request.decided_at = nowIso();
      request.decision_note = optString(input, "note") ?? null;
      await db.put("leave_requests", request);
      return { ...request, ok: true };
    },

    async create_employee(input, db) {
      const firstName = reqString(input, "first_name");
      const lastName = reqString(input, "last_name");
      const mail = normalizeEmail(reqString(input, "email"));
      const positionInput = reqString(input, "position");
      const department = reqString(input, "department");
      const startDate = parseIsoDate(reqString(input, "start_date"), "start_date");
      const managerId = optString(input, "manager_id")?.toUpperCase();
      const employees = await db.list<Employee>("employees");
      const duplicate = employees.find((e) => e.email === mail);
      if (duplicate) throw new ConnectorError(`An employee with e-mail ${mail} already exists (${duplicate.employee_id})`, "validation");
      const manager = managerId ? await db.require<Employee>("employees", managerId, "Manager") : undefined;

      const positions = await db.list<Position>("positions");
      const wanted = normalizeText(positionInput);
      const position = positions.find(
        (p) => (p.position_id.toLowerCase() === wanted || normalizeText(p.title) === wanted) && p.incumbents.length < p.headcount,
      );
      const today = todayIso();
      const employee: Employee = {
        employee_id: await db.nextId("employees", "EMP-", 4),
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`,
        email: mail,
        phone: null,
        position: position?.title ?? positionInput,
        position_id: position?.position_id ?? null,
        department,
        cost_center: employees.find((e) => normalizeText(e.department) === normalizeText(department))?.cost_center ?? "CC-9999",
        location: position?.location ?? manager?.location ?? HQ,
        manager_id: manager?.employee_id ?? null,
        start_date: startDate,
        employment_type: "full_time",
        status: startDate > today ? "pre_boarding" : "active",
        created_at: nowIso(),
      };
      await db.put("employees", employee);
      if (position) {
        position.incumbents.push(employee.employee_id);
        await db.put("positions", position);
      }
      await loadBalance(db, employee, Number(today.slice(0, 4)));
      return {
        ...employee,
        ok: true,
        position_assignment: position
          ? { position_id: position.position_id, requisition_id: position.requisition_id, message: `Filled vacancy ${position.position_id}` }
          : { position_id: null, message: "No vacant position with this title; employee created without position assignment" },
      };
    },
  },
});
