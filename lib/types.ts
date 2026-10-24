/**
 * HCM Lite — AI Assistant Module (M8)
 * Shared type definitions. Single source of truth for the shape of every
 * entity flowing between the data engine, services, tools, APIs and UI.
 */

export type Role = "Admin" | "HR" | "Employee";

export type DepartmentName = "Engineering" | "Sales" | "HR" | "Executive";

export type EmploymentStatus = "active" | "probation" | "resigned";

export interface Employee {
  id: string;
  name: string;
  email: string;
  dept: DepartmentName;
  designation: string;
  status: EmploymentStatus;
  joinedOn: string; // ISO date
  /** Monthly gross salary in PKR. NEVER exposed through AI tools or directory search. */
  monthlySalaryPkr: number;
  /** PII that must never leave the data engine. */
  cnic: string;
  bankAccount: string;
}

export interface Department {
  name: DepartmentName;
  head: string; // employee id
  description: string;
}

export type AttendanceStatus =
  | "present"
  | "late"
  | "absent"
  | "on_leave"
  | "weekend"
  | "holiday";

export interface AttendanceRecord {
  employeeId: string;
  date: string; // ISO date (yyyy-mm-dd)
  status: Exclude<AttendanceStatus, "weekend" | "holiday">;
  checkIn?: string; // HH:mm
  minutesLate?: number;
}

export type LeaveType = "annual" | "sick" | "casual" | "unpaid";

export type LeaveStatus = "approved" | "pending" | "rejected";

export interface LeaveRecord {
  id: string;
  employeeId: string;
  type: LeaveType;
  start: string; // ISO date
  end: string; // ISO date inclusive
  days: number;
  status: LeaveStatus;
  reason: string;
  appliedOn: string;
  /** Set by the deciding Admin/HR (approvedBy on approval). */
  decidedBy?: string;
  /** Server timestamp of the decision (approvedAt on approval). */
  decidedAt?: string;
  /** Optional note recorded with the decision (shown to the employee on rejection). */
  decisionNote?: string;
  /** Only present on newly submitted (pending) applications from the Smart Leave flow. */
  aiSuggested?: boolean;
}

export interface LeaveQuota {
  employeeId: string;
  year: number;
  annual: number;
  sick: number;
  casual: number;
}

export interface LeaveBalanceView {
  type: LeaveType;
  entitlement: number;
  used: number;
  pending: number;
  remaining: number;
}

/** Common result envelope for every tool (Spec: common envelope contract). */
export type ToolStatus = "ok" | "forbidden" | "not_found" | "ambiguous" | "error";

export interface ToolMeta {
  tool: string;
  generated_at: string;
  period?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface ToolResult<T = unknown> {
  status: ToolStatus;
  data: T | null;
  meta: ToolMeta;
  /** Human-friendly message shown to the user for non-ok results. */
  message?: string;
}

export interface AiLogEntry {
  id: string;
  timestamp: string; // ISO datetime
  user_id: string;
  role: Role;
  feature: "chat" | "dashboard_summary" | "smart_leave" | "tool" | "leave_admin";
  tool_name: string | null;
  tool_status: ToolStatus | "n/a";
  outcome: string;
  latency_ms: number;
  redacted: boolean;
}

export interface SessionUser {
  email: string;
  name: string;
  role: Role;
  userId: string; // employee id
  dept: DepartmentName;
  designation: string;
}
