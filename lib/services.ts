/**
 * HCM Lite — Shared Services (M8)
 * ---------------------------------------------------------------------------
 * The ONE service layer used by BOTH the Dashboard UI and every AI tool
 * (Constitution: "one data engine, one permission system"). Every AI-visible
 * fact must come from here; tools never query the raw store directly.
 *
 * Privacy invariants enforced here (defense in depth — permissions.ts is the
 * second layer, the tool layer the third):
 *   - Payroll outputs are aggregates only; individual salaries never appear.
 *   - searchEmployees never returns salary, CNIC or bank details.
 *   - Leave balances count APPROVED usage only; pending is reported apart.
 */

import {
  ATTENDANCE,
  EMPLOYEES,
  LEAVE_RECORDS,
  TIMEZONE,
  employeeById,
  latestAttendanceDate,
  leaveQuotaFor,
  todayIso,
  weekdayOf,
} from "./hcmData";
import type {
  DepartmentName,
  Employee,
  LeaveBalanceView,
  LeaveType,
  ToolMeta,
} from "./types";

export interface PeriodRange {
  start: string;
  end: string;
  label: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(year: number, month0: number): string {
  return `${MONTHS[month0]} ${year}`;
}

/**
 * Resolve a free-text period into a concrete date range (inclusive), evaluated
 * in the HCM timezone. Accepts: undefined/"this month" | "last month" |
 * "today" | "YYYY-MM" | "YYYY" | "October 2026" | "Oct 2026" | "October".
 * Returns null when the text is non-empty but unrecognised (caller responds
 * with `ambiguous` instead of guessing).
 */
export function resolvePeriod(input?: string | null): PeriodRange | null {
  const today = todayIso();
  const [yStr, mStr] = today.split("-");
  const year = Number(yStr);
  const month = Number(mStr); // 1-based

  const clean = (input ?? "this month").trim().toLowerCase();

  if (clean === "today") {
    return { start: today, end: today, label: `Today, ${formatLabel(today)}` };
  }
  if (["this month", "current month", ""].includes(clean)) {
    return {
      start: `${yStr}-${mStr}-01`,
      end: today,
      label: monthLabel(year, month - 1),
    };
  }
  if (["last month", "previous month"].includes(clean)) {
    const pm = month === 1 ? 12 : month - 1;
    const py = month === 1 ? year - 1 : year;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return {
      start: `${py}-${String(pm).padStart(2, "0")}-01`,
      end: `${py}-${String(pm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
      label: monthLabel(py, pm - 1),
    };
  }

  const isoMonth = /^(\d{4})-(\d{2})$/.exec(clean);
  if (isoMonth) {
    const y = Number(isoMonth[1]);
    const m = Number(isoMonth[2]);
    if (m < 1 || m > 12) return null;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      start: `${isoMonth[1]}-${isoMonth[2]}-01`,
      end: `${isoMonth[1]}-${isoMonth[2]}-${String(lastDay).padStart(2, "0")}`,
      label: monthLabel(y, m - 1),
    };
  }

  const bareYear = /^(\d{4})$/.exec(clean);
  if (bareYear) {
    return {
      start: `${bareYear[1]}-01-01`,
      end: `${bareYear[1]}-12-31`,
      label: bareYear[1],
    };
  }

  // "October 2026" / "Oct 2026" / "October"
  const tokens = clean.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const monthIdx = MONTHS.findIndex((m) => m.toLowerCase().startsWith(tokens[0]));
  if (monthIdx >= 0 && tokens.length <= 2) {
    const y = tokens[1] && /^\d{4}$/.test(tokens[1]) ? Number(tokens[1]) : year;
    const lastDay = new Date(Date.UTC(y, monthIdx + 1, 0)).getUTCDate();
    return {
      start: `${y}-${String(monthIdx + 1).padStart(2, "0")}-01`,
      end: `${y}-${String(monthIdx + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
      label: monthLabel(y, monthIdx),
    };
  }

  return null;
}

function formatLabel(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function meta(tool: string, extra: Partial<ToolMeta> = {}): ToolMeta {
  return {
    tool,
    generated_at: new Date().toISOString(),
    timezone: TIMEZONE,
    ...extra,
  };
}

function activeEmployees(dept?: string): Employee[] {
  return EMPLOYEES.filter(
    (e) =>
      e.status !== "resigned" &&
      (!dept || !dept.trim() || e.dept.toLowerCase() === dept.trim().toLowerCase()),
  );
}

function isKnownDept(dept?: string): boolean {
  if (!dept || !dept.trim()) return true;
  return EMPLOYEES.some((e) => e.dept.toLowerCase() === dept.trim().toLowerCase());
}

/* ------------------------------------------------------------------------- */
/* 1. Headcount                                                              */
/* ------------------------------------------------------------------------- */

export interface HeadcountData {
  dept: string;
  totalHeadcount: number;
  active: number;
  onProbation: number;
  resigned: number;
  byDept?: { dept: string; active: number; total: number }[];
}

export function getHeadcountService(dept?: string) {
  if (!isKnownDept(dept)) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("get_headcount"),
      message: `Unknown department "${dept}". Valid departments: Engineering, Sales, HR.`,
    };
  }
  const scope = dept?.trim() || "All departments";
  if (dept?.trim()) {
    const all = EMPLOYEES.filter(
      (e) => e.dept.toLowerCase() === dept.trim().toLowerCase(),
    );
    const data: HeadcountData = {
      dept: all[0]?.dept ?? dept,
      totalHeadcount: all.length,
      active: all.filter((e) => e.status !== "resigned").length,
      onProbation: all.filter((e) => e.status === "probation").length,
      resigned: all.filter((e) => e.status === "resigned").length,
    };
    return { status: "ok" as const, data, meta: meta("get_headcount", { scope }) };
  }
  const byDept = [...new Set(EMPLOYEES.map((e) => e.dept))].map((d) => {
    const all = EMPLOYEES.filter((e) => e.dept === d);
    return {
      dept: d,
      active: all.filter((e) => e.status !== "resigned").length,
      total: all.length,
    };
  });
  const data: HeadcountData = {
    dept: "All departments",
    totalHeadcount: EMPLOYEES.length,
    active: EMPLOYEES.filter((e) => e.status !== "resigned").length,
    onProbation: EMPLOYEES.filter((e) => e.status === "probation").length,
    resigned: EMPLOYEES.filter((e) => e.status === "resigned").length,
    byDept,
  };
  return { status: "ok" as const, data, meta: meta("get_headcount", { scope }) };
}

/* ------------------------------------------------------------------------- */
/* 2. Attendance summary                                                     */
/* ------------------------------------------------------------------------- */

export interface AttendanceSummaryData {
  period: string;
  from: string;
  to: string;
  employeesConsidered: number;
  workingDayRecords: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  attendanceRatePct: number;
}

export function getAttendanceSummaryService(dept?: string, period?: string) {
  if (!isKnownDept(dept)) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("get_attendance_summary"),
      message: `Unknown department "${dept}". Valid departments: Engineering, Sales, HR.`,
    };
  }
  const range = resolvePeriod(period);
  if (!range) {
    return {
      status: "ambiguous" as const,
      data: null,
      meta: meta("get_attendance_summary"),
      message: `I could not understand the period "${period}". Try "this month", "last month" or "2026-10".`,
    };
  }
  const ids = new Set(activeEmployees(dept).map((e) => e.id));
  const records = ATTENDANCE.filter(
    (r) => r.date >= range.start && r.date <= range.end && ids.has(r.employeeId),
  );
  const present = records.filter((r) => r.status === "present").length;
  const late = records.filter((r) => r.status === "late").length;
  const absent = records.filter((r) => r.status === "absent").length;
  const onLeave = records.filter((r) => r.status === "on_leave").length;
  const data: AttendanceSummaryData = {
    period: range.label,
    from: range.start,
    to: range.end,
    employeesConsidered: ids.size,
    workingDayRecords: records.length,
    present,
    late,
    absent,
    onLeave,
    // Attendance rate = arrived for work (present + late) over all working-day
    // records. Authorised leave does not count against the rate.
    attendanceRatePct: records.length
      ? Math.round(((present + late) / records.length) * 1000) / 10
      : 0,
  };
  return {
    status: "ok" as const,
    data,
    meta: meta("get_attendance_summary", { period: range.label, scope: dept?.trim() || "All departments" }),
  };
}

/* ------------------------------------------------------------------------- */
/* 3. Latecomers                                                             */
/* ------------------------------------------------------------------------- */

export interface LateComerRow {
  rank: number;
  employeeId: string;
  name: string;
  dept: DepartmentName;
  designation: string;
  lateCount: number;
  totalMinutesLate: number;
  recentLateDates: string[];
}

export function getLateComersService(dept?: string, period?: string, limit?: number) {
  if (!isKnownDept(dept)) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("get_late_comers"),
      message: `Unknown department "${dept}". Valid departments: Engineering, Sales, HR.`,
    };
  }
  const range = resolvePeriod(period);
  if (!range) {
    return {
      status: "ambiguous" as const,
      data: null,
      meta: meta("get_late_comers"),
      message: `I could not understand the period "${period}". Try "this month", "last month" or "2026-10".`,
    };
  }
  const ids = new Set(activeEmployees(dept).map((e) => e.id));
  const lateRecords = ATTENDANCE.filter(
    (r) =>
      r.date >= range.start &&
      r.date <= range.end &&
      r.status === "late" &&
      ids.has(r.employeeId),
  );
  const byEmp = new Map<string, typeof lateRecords>();
  for (const r of lateRecords) {
    const list = byEmp.get(r.employeeId) ?? [];
    list.push(r);
    byEmp.set(r.employeeId, list);
  }
  const ranking: LateComerRow[] = [...byEmp.entries()]
    .map(([empId, recs]) => {
      const emp = employeeById(empId)!;
      return {
        employeeId: empId,
        name: emp.name,
        dept: emp.dept,
        designation: emp.designation,
        lateCount: recs.length,
        totalMinutesLate: recs.reduce((s, r) => s + (r.minutesLate ?? 0), 0),
        recentLateDates: recs
          .map((r) => r.date)
          .sort()
          .slice(-5),
      };
    })
    .sort(
      (a, b) => b.lateCount - a.lateCount || b.totalMinutesLate - a.totalMinutesLate,
    )
    .slice(0, Math.max(1, Math.min(limit ?? 5, 10)))
    .map((row, i) => ({ ...row, rank: i + 1 }));

  return {
    status: "ok" as const,
    data: { period: range.label, from: range.start, to: range.end, ranking },
    meta: meta("get_late_comers", { period: range.label, scope: dept?.trim() || "All departments" }),
  };
}

/* ------------------------------------------------------------------------- */
/* 4. Leave summary (aggregates; no individual balances except pending cases) */
/* ------------------------------------------------------------------------- */

export interface LeaveSummaryData {
  period: string;
  byType: { type: LeaveType; approved: number; pending: number; rejected: number; days: number }[];
  pendingCases: {
    employeeId: string;
    name: string;
    dept: DepartmentName;
    type: LeaveType;
    start: string;
    end: string;
    days: number;
    reason: string;
  }[];
}

export function getLeaveSummaryService(dept?: string, period?: string, type?: string) {
  if (!isKnownDept(dept)) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("get_leave_summary"),
      message: `Unknown department "${dept}". Valid departments: Engineering, Sales, HR.`,
    };
  }
  const range = resolvePeriod(period);
  if (!range) {
    return {
      status: "ambiguous" as const,
      data: null,
      meta: meta("get_leave_summary"),
      message: `I could not understand the period "${period}". Try "this month", "last month" or "2026-10".`,
    };
  }
  const wantedType = type?.trim().toLowerCase();
  if (wantedType && !["annual", "sick", "casual", "unpaid"].includes(wantedType)) {
    return {
      status: "ambiguous" as const,
      data: null,
      meta: meta("get_leave_summary"),
      message: `Unknown leave type "${type}". Valid types: annual, sick, casual, unpaid.`,
    };
  }
  const scopeIds = new Set(activeEmployees(dept).map((e) => e.id));
  const inScope = LEAVE_RECORDS.filter(
    (lv) =>
      scopeIds.has(lv.employeeId) &&
      lv.start >= range.start &&
      lv.start <= range.end &&
      (!wantedType || lv.type === wantedType),
  );
  const types: LeaveType[] = wantedType
    ? [wantedType as LeaveType]
    : ["annual", "sick", "casual", "unpaid"];
  const byType = types.map((t) => {
    const rows = inScope.filter((lv) => lv.type === t);
    return {
      type: t,
      approved: rows.filter((r) => r.status === "approved").length,
      pending: rows.filter((r) => r.status === "pending").length,
      rejected: rows.filter((r) => r.status === "rejected").length,
      days: rows.filter((r) => r.status === "approved").reduce((s, r) => s + r.days, 0),
    };
  });
  const pendingCases = inScope
    .filter((lv) => lv.status === "pending")
    .map((lv) => {
      const emp = employeeById(lv.employeeId)!;
      return {
        employeeId: lv.employeeId,
        name: emp.name,
        dept: emp.dept,
        type: lv.type,
        start: lv.start,
        end: lv.end,
        days: lv.days,
        reason: lv.reason,
      };
    });
  return {
    status: "ok" as const,
    data: { period: range.label, from: range.start, to: range.end, byType, pendingCases },
    meta: meta("get_leave_summary", { period: range.label, scope: dept?.trim() || "All departments" }),
  };
}

/** Org-wide pending queue (any start date) — used by exec KPIs, not period-scoped. */
export function getPendingLeaveApplicationsService(dept?: string) {
  const scopeIds = new Set(activeEmployees(dept).map((e) => e.id));
  return LEAVE_RECORDS.filter(
    (lv) => lv.status === "pending" && scopeIds.has(lv.employeeId),
  ).map((lv) => {
    const emp = employeeById(lv.employeeId)!;
    return {
      id: lv.id,
      employeeId: lv.employeeId,
      name: emp.name,
      dept: emp.dept,
      type: lv.type,
      start: lv.start,
      end: lv.end,
      days: lv.days,
      reason: lv.reason,
      appliedOn: lv.appliedOn,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* 5. My leave balance (self only; approved counts, pending shown separately) */
/* ------------------------------------------------------------------------- */

export interface MyLeaveBalanceData {
  employeeId: string;
  name: string;
  year: number;
  balances: LeaveBalanceView[];
  totalRemaining: number;
}

export function getMyLeaveBalanceService(userId: string) {
  const emp = employeeById(userId);
  if (!emp) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("get_my_leave_balance"),
      message: "I could not find your employee record.",
    };
  }
  const year = Number(todayIso().slice(0, 4));
  const quota = leaveQuotaFor(userId);
  const mine = LEAVE_RECORDS.filter((lv) => lv.employeeId === userId);
  const balances: LeaveBalanceView[] = (["annual", "sick", "casual"] as const).map(
    (t) => {
      const entitlement = quota[t];
      const used = mine
        .filter((lv) => lv.type === t && lv.status === "approved" && lv.start.startsWith(String(year)))
        .reduce((s, lv) => s + lv.days, 0);
      const pending = mine
        .filter((lv) => lv.type === t && lv.status === "pending")
        .reduce((s, lv) => s + lv.days, 0);
      return { type: t, entitlement, used, pending, remaining: entitlement - used };
    },
  );
  const data: MyLeaveBalanceData = {
    employeeId: userId,
    name: emp.name,
    year,
    balances,
    totalRemaining: balances.reduce((s, b) => s + b.remaining, 0),
  };
  return {
    status: "ok" as const,
    data,
    meta: meta("get_my_leave_balance", { scope: "self" }),
  };
}

/* ------------------------------------------------------------------------- */
/* 6. Payroll summary — AGGREGATES ONLY, never individual figures            */
/* ------------------------------------------------------------------------- */

export interface PayrollSummaryData {
  period: string;
  activeEmployees: number;
  totalGrossPkr: number;
  averageGrossPkr: number;
  byDept: { dept: DepartmentName; employees: number; totalGrossPkr: number }[];
}

export function getPayrollSummaryService(dept?: string, period?: string) {
  if (!isKnownDept(dept)) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("get_payroll_summary"),
      message: `Unknown department "${dept}". Valid departments: Engineering, Sales, HR.`,
    };
  }
  const range = resolvePeriod(period);
  if (!range) {
    return {
      status: "ambiguous" as const,
      data: null,
      meta: meta("get_payroll_summary"),
      message: `I could not understand the period "${period}". Try "this month", "last month" or "2026-10".`,
    };
  }
  // Salary ledger is monthly and current (no retro changes seeded for 2026),
  // so every month resolves to the same gross run.
  const emps = activeEmployees(dept);
  const total = emps.reduce((s, e) => s + e.monthlySalaryPkr, 0);
  const depts = [...new Set(emps.map((e) => e.dept))].map((d) => {
    const rows = emps.filter((e) => e.dept === d);
    return {
      dept: d,
      employees: rows.length,
      totalGrossPkr: rows.reduce((s, e) => s + e.monthlySalaryPkr, 0),
    };
  });
  const data: PayrollSummaryData = {
    period: range.label,
    activeEmployees: emps.length,
    totalGrossPkr: total,
    averageGrossPkr: emps.length ? Math.round(total / emps.length) : 0,
    byDept: depts.sort((a, b) => b.totalGrossPkr - a.totalGrossPkr),
  };
  return {
    status: "ok" as const,
    data,
    meta: meta("get_payroll_summary", { period: range.label, scope: dept?.trim() || "All departments" }),
  };
}

/* ------------------------------------------------------------------------- */
/* 7. Employee directory search — NEVER salary, CNIC or bank details         */
/* ------------------------------------------------------------------------- */

export interface DirectoryRow {
  employeeId: string;
  name: string;
  designation: string;
  dept: DepartmentName;
  status: string;
  email: string;
}

export function searchEmployeesService(query: string, dept?: string, limit?: number) {
  const q = query.trim().toLowerCase();
  if (!q) {
    return {
      status: "ambiguous" as const,
      data: null,
      meta: meta("search_employees"),
      message: "Please give me a name or designation to search for.",
    };
  }
  if (!isKnownDept(dept)) {
    return {
      status: "not_found" as const,
      data: null,
      meta: meta("search_employees"),
      message: `Unknown department "${dept}". Valid departments: Engineering, Sales, HR.`,
    };
  }
  const max = Math.max(1, Math.min(limit ?? 5, 10));
  const pool = EMPLOYEES.filter(
    (e) => !dept?.trim() || e.dept.toLowerCase() === dept.trim().toLowerCase(),
  );
  const matches = pool
    .filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.designation.toLowerCase().includes(q) ||
        e.dept.toLowerCase().includes(q),
    )
    .slice(0, max)
    .map(
      (e): DirectoryRow => ({
        employeeId: e.id,
        name: e.name,
        designation: e.designation,
        dept: e.dept,
        status: e.status,
        email: e.email,
      }),
    );
  return {
    status: "ok" as const,
    data: { query, matches, count: matches.length },
    meta: meta("search_employees", { scope: dept?.trim() || "All departments" }),
  };
}

/* ------------------------------------------------------------------------- */
/* Dashboard KPIs — same engine, consumed by GET /api/dashboard               */
/* ------------------------------------------------------------------------- */

export interface DashboardKpis {
  asOfDate: string;
  asOfLabel: string;
  headcount: { active: number; total: number };
  today: { present: number; late: number; onLeave: number };
  attendanceRatePct: number; // current month
  payroll?: { totalGrossPkr: number; activeEmployees: number };
  myLeaveBalance?: MyLeaveBalanceData;
  monthLabel: string;
}

export function getDashboardKpisService(opts: {
  includePayroll: boolean;
  userId: string;
}): DashboardKpis {
  const asOf = latestAttendanceDate();
  const dayRows = ATTENDANCE.filter((r) => r.date === asOf);
  const monthRate = getAttendanceSummaryService(undefined, "this month");
  const kpis: DashboardKpis = {
    asOfDate: asOf,
    asOfLabel: formatLabel(asOf),
    headcount: {
      active: EMPLOYEES.filter((e) => e.status !== "resigned").length,
      total: EMPLOYEES.length,
    },
    today: {
      present: dayRows.filter((r) => r.status === "present").length,
      late: dayRows.filter((r) => r.status === "late").length,
      onLeave: dayRows.filter((r) => r.status === "on_leave").length,
    },
    attendanceRatePct:
      monthRate.status === "ok" ? monthRate.data.attendanceRatePct : 0,
    monthLabel: resolvePeriod("this month")!.label,
  };
  if (opts.includePayroll) {
    const payroll = getPayrollSummaryService();
    if (payroll.status === "ok") {
      kpis.payroll = {
        totalGrossPkr: payroll.data.totalGrossPkr,
        activeEmployees: payroll.data.activeEmployees,
      };
    }
  }
  const balance = getMyLeaveBalanceService(opts.userId);
  if (balance.status === "ok") kpis.myLeaveBalance = balance.data;
  return kpis;
}

/** Weekday check reused by the Smart Leave validation flow. */
export { weekdayOf, todayIso };
