/**
 * HCM Lite — Data Engine (M8)
 * ---------------------------------------------------------------------------
 * Self-contained, deterministic, in-memory data store. Pre-seeded per Spec
 * Section 16 / T9.1 so that every acceptance test has a known answer:
 *
 *  - Departments: Engineering, Sales, HR (+ Executive for the Admin seat)
 *  - 17 employees (16 active, 1 resigned) — salaries are stored but NEVER
 *    exposed by any AI tool.
 *  - Daily attendance generated deterministically for every working day of
 *    2026 up to "today" (Asia/Karachi), with explicit latecomer overrides for
 *    March and October 2026 (e.g. Bilal Ahmed is late 7x in October).
 *  - Leave quotas: Annual 14, Sick 8, Casual 10. Pending applications exist
 *    and are excluded from remaining balances (AT-04).
 *
 * CONSTITUTION: this module is the single source of truth for both the
 * Dashboard and the AI tools. The DB is read-only for the AI; the only write
 * path is a human-confirmed leave application (POST /api/leaves).
 */

import type {
  AttendanceRecord,
  Department,
  DepartmentName,
  Employee,
  LeaveQuota,
  LeaveRecord,
  SessionUser,
} from "./types";

export const TIMEZONE = "Asia/Karachi";
export const POLICY_VERSION = "M8-policy-3.2";
export const SHIFT_START = "09:00"; // work day starts 09:00 PKT, grace 15 min
export const LEAVE_QUOTA_YEAR = 2026;

/* ------------------------------------------------------------------------- */
/* Dates & calendar helpers (timezone-safe, no external deps)                */
/* ------------------------------------------------------------------------- */

/** Current wall-clock datetime in the HCM timezone, as ISO 8601. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Current date in the HCM timezone as yyyy-mm-dd. */
export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Day of week (0=Sun..6=Sat) for an ISO date, evaluated safely. */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

/** Saturday/Sunday are the weekend in the HCM timezone. */
export function isWeekend(isoDate: string): boolean {
  const wd = weekdayOf(isoDate);
  return wd === 0 || wd === 6;
}

export function isWorkingDay(isoDate: string): boolean {
  return !isWeekend(isoDate);
}

/**
 * Fixed-date national public holidays (Pakistan, 2026). Lunar holidays (Eid
 * etc.) are moon-sighted and intentionally not modeled — the demo calendar
 * only skips these deterministic dates plus weekends.
 */
export const PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set([
  "2026-02-05", // Kashmir Day
  "2026-03-23", // Pakistan Day
  "2026-05-01", // Labour Day
  "2026-08-14", // Independence Day
  "2026-11-09", // Iqbal Day
  "2026-12-25", // Quaid-e-Azam Day
]);

export function isPublicHoliday(isoDate: string): boolean {
  return PUBLIC_HOLIDAYS.has(isoDate);
}

/**
 * Count leave days between two ISO dates (inclusive), SKIPPING weekends and
 * public holidays. This is the only day-count the ledger ever sees.
 */
export function countWorkingDays(start: string, end: string): number {
  let count = 0;
  for (let d = start; d <= end; d = addDaysIso(d, 1)) {
    if (isWorkingDay(d) && !isPublicHoliday(d)) count += 1;
    if (d === end) break; // guard against malformed ranges
  }
  return count;
}

export function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDaysIso(startIso: string, endIso: string): number {
  const a = new Date(`${startIso}T12:00:00Z`).getTime();
  const b = new Date(`${endIso}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function formatDateLabel(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

/* ------------------------------------------------------------------------- */
/* Deterministic RNG (attendance must be identical on every boot)            */
/* ------------------------------------------------------------------------- */

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFor(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------- */
/* Departments & employees                                                   */
/* ------------------------------------------------------------------------- */

export const DEPARTMENTS: Department[] = [
  {
    name: "Engineering",
    head: "E-101",
    description: "Product engineering, QA and DevOps",
  },
  { name: "Sales", head: "E-201", description: "Regional sales and accounts" },
  { name: "HR", head: "E-301", description: "People operations and recruiting" },
  {
    name: "Executive",
    head: "E-100",
    description: "Company leadership (Admin seat)",
  },
];

export const EMPLOYEES: Employee[] = [
  {
    id: "E-100",
    name: "Sikandar Hayat",
    email: "admin@saylani.com",
    dept: "Executive",
    designation: "Director",
    status: "active",
    joinedOn: "2019-02-01",
    monthlySalaryPkr: 450_000,
    cnic: "42101-1234567-1",
    bankAccount: "PK36SCBL0000001123456702",
  },
  {
    id: "E-101",
    name: "Ahmed Raza",
    email: "ahmed.raza@saylani.com",
    dept: "Engineering",
    designation: "Senior Software Engineer",
    status: "active",
    joinedOn: "2021-06-14",
    monthlySalaryPkr: 185_000,
    cnic: "42101-2345678-2",
    bankAccount: "PK24HABB0000002345678901",
  },
  {
    id: "E-102",
    name: "Taha Siddiqui",
    email: "taha@saylani.com",
    dept: "Engineering",
    designation: "Software Engineer",
    status: "active",
    joinedOn: "2023-03-06",
    monthlySalaryPkr: 120_000,
    cnic: "42101-3456789-3",
    bankAccount: "PK89MEZN0000003456789012",
  },
  {
    id: "E-103",
    name: "Bilal Ahmed",
    email: "bilal.ahmed@saylani.com",
    dept: "Engineering",
    designation: "Software Engineer",
    status: "active",
    joinedOn: "2022-09-19",
    monthlySalaryPkr: 95_000,
    cnic: "42101-4567890-4",
    bankAccount: "PK55JSBL0000004567890123",
  },
  {
    id: "E-104",
    name: "Sana Javed",
    email: "sana.javed@saylani.com",
    dept: "Engineering",
    designation: "QA Engineer",
    status: "active",
    joinedOn: "2022-01-10",
    monthlySalaryPkr: 90_000,
    cnic: "42101-5678901-5",
    bankAccount: "PK10BAHL0000005678901234",
  },
  {
    id: "E-105",
    name: "Hamza Tariq",
    email: "hamza.tariq@saylani.com",
    dept: "Engineering",
    designation: "DevOps Engineer",
    status: "active",
    joinedOn: "2020-11-02",
    monthlySalaryPkr: 140_000,
    cnic: "42101-6789012-6",
    bankAccount: "PK77FAYS0000006789012345",
  },
  {
    id: "E-106",
    name: "Fatima Noor",
    email: "fatima.noor@saylani.com",
    dept: "Engineering",
    designation: "Frontend Engineer",
    status: "probation",
    joinedOn: "2026-08-17",
    monthlySalaryPkr: 80_000,
    cnic: "42101-7890123-7",
    bankAccount: "PK32BOPP0000007890123456",
  },
  {
    id: "E-107",
    name: "Usman Ghani",
    email: "usman.ghani@saylani.com",
    dept: "Engineering",
    designation: "Backend Engineer",
    status: "active",
    joinedOn: "2021-08-23",
    monthlySalaryPkr: 135_000,
    cnic: "42101-8901234-8",
    bankAccount: "PK68ALFH0000008901234567",
  },
  {
    id: "E-108",
    name: "Zainab Iqbal",
    email: "zainab.iqbal@saylani.com",
    dept: "Engineering",
    designation: "Junior Developer",
    status: "resigned",
    joinedOn: "2024-02-05",
    monthlySalaryPkr: 60_000,
    cnic: "42101-9012345-9",
    bankAccount: "PK91NBPA0000009012345678",
  },
  {
    id: "E-201",
    name: "Ayesha Khan",
    email: "ayesha.khan@saylani.com",
    dept: "Sales",
    designation: "Sales Manager",
    status: "active",
    joinedOn: "2020-05-11",
    monthlySalaryPkr: 150_000,
    cnic: "42201-1122334-1",
    bankAccount: "PK17MCBL0000011223344556",
  },
  {
    id: "E-202",
    name: "Omar Farooq",
    email: "omar.farooq@saylani.com",
    dept: "Sales",
    designation: "Sales Executive",
    status: "active",
    joinedOn: "2023-01-16",
    monthlySalaryPkr: 85_000,
    cnic: "42201-2233445-2",
    bankAccount: "PK43SILK0000022334455667",
  },
  {
    id: "E-203",
    name: "Mariam Shah",
    email: "mariam.shah@saylani.com",
    dept: "Sales",
    designation: "Sales Executive",
    status: "active",
    joinedOn: "2022-07-04",
    monthlySalaryPkr: 82_000,
    cnic: "42201-3344556-3",
    bankAccount: "PK29SUMB0000033445566778",
  },
  {
    id: "E-204",
    name: "Ali Hassan",
    email: "ali.hassan@saylani.com",
    dept: "Sales",
    designation: "Account Executive",
    status: "active",
    joinedOn: "2021-10-25",
    monthlySalaryPkr: 78_000,
    cnic: "42201-4455667-4",
    bankAccount: "PK52SMPA0000044556677889",
  },
  {
    id: "E-205",
    name: "Hira Aslam",
    email: "hira.aslam@saylani.com",
    dept: "Sales",
    designation: "Sales Trainee",
    status: "probation",
    joinedOn: "2026-09-07",
    monthlySalaryPkr: 45_000,
    cnic: "42201-5566778-5",
    bankAccount: "PK85FNBP0000055667788990",
  },
  {
    id: "E-301",
    name: "Nadia Hussain",
    email: "hr@saylani.com",
    dept: "HR",
    designation: "HR Manager",
    status: "active",
    joinedOn: "2019-09-02",
    monthlySalaryPkr: 160_000,
    cnic: "42301-6677889-6",
    bankAccount: "PK61HABB0000066778899001",
  },
  {
    id: "E-302",
    name: "Kamran Malik",
    email: "kamran.malik@saylani.com",
    dept: "HR",
    designation: "HR Officer",
    status: "active",
    joinedOn: "2022-04-18",
    monthlySalaryPkr: 75_000,
    cnic: "42301-7788990-7",
    bankAccount: "PK08JSBL0000077889900112",
  },
  {
    id: "E-303",
    name: "Rabia Bano",
    email: "rabia.bano@saylani.com",
    dept: "HR",
    designation: "Recruiter",
    status: "active",
    joinedOn: "2023-11-27",
    monthlySalaryPkr: 70_000,
    cnic: "42301-8899001-8",
    bankAccount: "PK73MEZN0000088990011223",
  },
];

export function employeeById(id: string): Employee | undefined {
  return EMPLOYEES.find((e) => e.id === id);
}

export function employeeByName(name: string): Employee | undefined {
  const q = name.trim().toLowerCase();
  return EMPLOYEES.find((e) => e.name.toLowerCase() === q);
}

/* ------------------------------------------------------------------------- */
/* Active demo sessions (server resolves identity; the client only sends     */
/* the chosen email — role is NEVER trusted from the client).                */
/* ------------------------------------------------------------------------- */

export const USERS: Record<string, SessionUser> = Object.fromEntries(
  EMPLOYEES.filter((e) =>
    ["admin@saylani.com", "hr@saylani.com", "taha@saylani.com"].includes(
      e.email,
    ),
  ).map((e) => [
    e.email,
    {
      email: e.email,
      name: e.name,
      role:
        e.email === "admin@saylani.com"
          ? "Admin"
          : e.email === "hr@saylani.com"
            ? "HR"
            : "Employee",
      userId: e.id,
      dept: e.dept,
      designation: e.designation,
    } satisfies SessionUser,
  ]),
);

export const SESSION_EMAILS = [
  "admin@saylani.com",
  "hr@saylani.com",
  "taha@saylani.com",
] as const;

/* ------------------------------------------------------------------------- */
/* Leave quotas (Annual 14 / Sick 8 / Casual 10) and leave records            */
/* ------------------------------------------------------------------------- */

export const LEAVE_QUOTAS: LeaveQuota[] = EMPLOYEES.map((e) => ({
  employeeId: e.id,
  year: LEAVE_QUOTA_YEAR,
  annual: 14,
  sick: 8,
  casual: 10,
}));

export function leaveQuotaFor(employeeId: string): LeaveQuota {
  const q = LEAVE_QUOTAS.find((x) => x.employeeId === employeeId);
  if (!q) throw new Error(`No leave quota for ${employeeId}`);
  return q;
}

/**
 * Leave ledger. Statuses drive everything: only `approved` consumes quota,
 * `pending` is surfaced separately and NEVER deducted (AT-04).
 */
export const LEAVE_RECORDS: LeaveRecord[] = [
  // --- Taha Siddiqui (session Employee) -------------------------------------
  {
    id: "LV-001",
    employeeId: "E-102",
    type: "sick",
    start: "2026-01-12",
    end: "2026-01-13",
    days: 2,
    status: "approved",
    reason: "Flu and fever",
    appliedOn: "2026-01-10",
    decidedBy: "E-301",
  },
  {
    id: "LV-002",
    employeeId: "E-102",
    type: "annual",
    start: "2026-03-09",
    end: "2026-03-11",
    days: 3,
    status: "approved",
    reason: "Family trip to Lahore",
    appliedOn: "2026-02-27",
    decidedBy: "E-301",
  },
  {
    id: "LV-003",
    employeeId: "E-102",
    type: "casual",
    start: "2026-06-05",
    end: "2026-06-05",
    days: 1,
    status: "approved",
    reason: "Personal errand at NADRA",
    appliedOn: "2026-06-01",
    decidedBy: "E-301",
  },
  {
    // AT-04: pending sick leave — must NOT reduce the remaining sick balance.
    id: "LV-004",
    employeeId: "E-102",
    type: "sick",
    start: "2026-11-05",
    end: "2026-11-06",
    days: 2,
    status: "pending",
    reason: "Follow-up medical checkup",
    appliedOn: "2026-10-20",
  },
  // --- Other pending cases (visible in leave summary) -----------------------
  {
    id: "LV-011",
    employeeId: "E-106",
    type: "annual",
    start: "2026-12-21",
    end: "2026-12-24",
    days: 4,
    status: "pending",
    reason: "Winter break with family",
    appliedOn: "2026-10-18",
  },
  {
    id: "LV-012",
    employeeId: "E-204",
    type: "casual",
    start: "2026-11-02",
    end: "2026-11-02",
    days: 1,
    status: "pending",
    reason: "Sister's wedding shopping",
    appliedOn: "2026-10-19",
  },
  {
    id: "LV-013",
    employeeId: "E-205",
    type: "sick",
    start: "2026-10-27",
    end: "2026-10-27",
    days: 1,
    status: "pending",
    reason: "Dentist appointment",
    appliedOn: "2026-10-22",
  },
  // --- Approved leaves across the org ---------------------------------------
  {
    id: "LV-021",
    employeeId: "E-203",
    type: "annual",
    start: "2026-10-19",
    end: "2026-10-23",
    days: 5,
    status: "approved",
    reason: "Annual vacation — Hunza",
    appliedOn: "2026-09-30",
    decidedBy: "E-301",
  },
  {
    id: "LV-022",
    employeeId: "E-107",
    type: "sick",
    start: "2026-10-21",
    end: "2026-10-22",
    days: 2,
    status: "approved",
    reason: "Food poisoning",
    appliedOn: "2026-10-21",
    decidedBy: "E-301",
  },
  {
    id: "LV-023",
    employeeId: "E-201",
    type: "casual",
    start: "2026-09-14",
    end: "2026-09-14",
    days: 1,
    status: "approved",
    reason: "Bank documentation",
    appliedOn: "2026-09-10",
    decidedBy: "E-301",
  },
  {
    id: "LV-024",
    employeeId: "E-101",
    type: "annual",
    start: "2026-08-03",
    end: "2026-08-07",
    days: 5,
    status: "approved",
    reason: "Umrah pilgrimage",
    appliedOn: "2026-07-15",
    decidedBy: "E-100",
  },
  {
    id: "LV-025",
    employeeId: "E-301",
    type: "casual",
    start: "2026-06-08",
    end: "2026-06-08",
    days: 1,
    status: "approved",
    reason: "Family matter",
    appliedOn: "2026-06-05",
    decidedBy: "E-100",
  },
  {
    id: "LV-026",
    employeeId: "E-202",
    type: "casual",
    start: "2026-10-14",
    end: "2026-10-14",
    days: 1,
    status: "approved",
    reason: "Vehicle paperwork",
    appliedOn: "2026-10-12",
    decidedBy: "E-301",
  },
  // --- A rejection for realism ----------------------------------------------
  {
    id: "LV-031",
    employeeId: "E-202",
    type: "annual",
    start: "2026-09-07",
    end: "2026-09-11",
    days: 5,
    status: "rejected",
    reason: "Vacation during quarter close",
    appliedOn: "2026-08-28",
    decidedBy: "E-201",
  },
];

/** In-memory append of a human-confirmed leave application. */
export function addLeaveApplication(rec: LeaveRecord): void {
  LEAVE_RECORDS.push(rec);
}

/* ------------------------------------------------------------------------- */
/* Attendance engine                                                         */
/* ------------------------------------------------------------------------- */

/** Explicit latecomer overrides (yyyy-mm-dd), per Spec Section 16. */
const LATE_OVERRIDES: Record<string, string[]> = {
  // October 2026 — Bilal Ahmed is the month's worst latecomer (7x)
  "E-103": [
    "2026-10-05",
    "2026-10-07",
    "2026-10-09",
    "2026-10-14",
    "2026-10-16",
    "2026-10-21",
    "2026-10-23",
  ],
  "E-201": [
    "2026-10-06",
    "2026-10-12",
    "2026-10-19",
    "2026-10-22", // Ayesha 4x in October
    "2026-03-11",
    "2026-03-25", // 2x in March
  ],
  "E-202": ["2026-10-08", "2026-10-15"], // Omar 2x
  "E-102": ["2026-10-20"], // Taha 1x
  "E-302": ["2026-10-13"], // Kamran 1x
  "E-301": ["2026-10-02"], // Nadia 1x
  // March 2026 — Hamza Tariq is the worst latecomer (5 Mondays)
  "E-105": [
    "2026-03-02",
    "2026-03-09",
    "2026-03-16",
    "2026-03-23",
    "2026-03-30",
  ],
};

function attendanceFor(employee: Employee, date: string): AttendanceRecord {
  const rng = rngFor(`${employee.id}:${date}`);
  const roll = rng() * 100;
  let status: AttendanceRecord["status"] = "present";
  // Baseline: ~3% random lates / ~2% absences; explicit overrides in
  // LATE_OVERRIDES produce the *known* latecomers for March & October 2026.
  if (roll >= 92 && roll < 95) status = "late";
  else if (roll >= 95 && roll < 97) status = "absent";

  if (status === "late") {
    const minutesLate = 10 + Math.floor(rng() * 60);
    const h = 9 + Math.floor((15 + minutesLate) / 60);
    const m = (15 + minutesLate) % 60;
    return {
      employeeId: employee.id,
      date,
      status: "late",
      checkIn: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      minutesLate,
    };
  }
  if (status === "absent") {
    return { employeeId: employee.id, date, status: "absent" };
  }
  const checkInMinute = Math.floor(rng() * 35); // 08:40 – 09:15 (within grace)
  const h = 8 + Math.floor((40 + checkInMinute) / 60);
  const m = (40 + checkInMinute) % 60;
  return {
    employeeId: employee.id,
    date,
    status: "present",
    checkIn: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  };
}

function buildAttendance(): AttendanceRecord[] {
  const records: AttendanceRecord[] = [];
  const today = todayIso();
  const start = `${LEAVE_QUOTA_YEAR}-01-01`;

  for (
    let d = start;
    d <= today;
    d = addDaysIso(d, 1)
  ) {
    if (!isWorkingDay(d)) continue;
    for (const emp of EMPLOYEES) {
      if (emp.status === "resigned" && d > "2026-09-15") continue; // left on Sep 15
      if (emp.joinedOn > d) continue; // not hired yet
      records.push(attendanceFor(emp, d));
    }
  }

  // Apply latecomer overrides (highest priority).
  for (const [empId, dates] of Object.entries(LATE_OVERRIDES)) {
    for (const date of dates) {
      if (date > today || !isWorkingDay(date)) continue;
      const rng = rngFor(`late:${empId}:${date}`);
      const minutesLate = 8 + Math.floor(rng() * 50);
      const existing = records.find((r) => r.employeeId === empId && r.date === date);
      if (existing) {
        existing.status = "late";
        existing.minutesLate = minutesLate;
        const totalMin = 9 * 60 + 25 + Math.floor(rng() * 70); // 09:25 – 10:34
        existing.checkIn = `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(totalMin % 60).padStart(2, "0")}`;
      } else {
        records.push({
          employeeId: empId,
          date,
          status: "late",
          checkIn: "09:35",
          minutesLate,
        });
      }
    }
  }

  // Approved leave beats any generated attendance status.
  for (const rec of records) {
    const onLeave = LEAVE_RECORDS.some(
      (lv) =>
        lv.employeeId === rec.employeeId &&
        lv.status === "approved" &&
        lv.start <= rec.date &&
        lv.end >= rec.date,
    );
    if (onLeave) {
      rec.status = "on_leave";
      delete rec.checkIn;
      delete rec.minutesLate;
    }
  }

  return records;
}

export const ATTENDANCE: AttendanceRecord[] = buildAttendance();

/**
 * The most recent working day for which attendance exists (today if it is a
 * working day, otherwise the last working day). Keeps "Present/Late Today"
 * meaningful on weekends.
 */
export function latestAttendanceDate(): string {
  const today = todayIso();
  if (isWorkingDay(today) && ATTENDANCE.some((r) => r.date === today)) {
    return today;
  }
  let d = today;
  for (let i = 0; i < 7; i++) {
    d = addDaysIso(d, -1);
    if (isWorkingDay(d) && ATTENDANCE.some((r) => r.date === d)) return d;
  }
  return today;
}

export function departmentNames(): DepartmentName[] {
  return DEPARTMENTS.map((d) => d.name);
}
