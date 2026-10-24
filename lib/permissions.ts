/**
 * HCM Lite — Permission Matrix (M8)
 * ---------------------------------------------------------------------------
 * ONE permission system for every AI surface (Constitution §2). The matrix is
 * role × tool × arguments and is evaluated SERVER-SIDE only. The client never
 * decides anything: the chat route resolves the session from the server and
 * passes it here.
 *
 * Matrix (Spec §7):
 * ┌─────────────────────────┬───────┬────┬──────────┐
 * │ Tool                    │ Admin │ HR │ Employee │
 * ├─────────────────────────┼───────┼────┼──────────┤
 * │ get_headcount           │  ✔   │ ✔  │    ✘     │
 * │ get_attendance_summary  │  ✔   │ ✔  │    ✘     │
 * │ get_late_comers         │  ✔   │ ✔  │    ✘     │
 * │ get_leave_summary       │  ✔   │ ✔  │    ✘     │
 * │ get_my_leave_balance    │  ✔   │ ✔  │ ✔ (self) │
 * │ get_payroll_summary     │  ✔   │ ✔  │    ✘     │
 * │ search_employees        │  ✔   │ ✔  │ ✔ (safe) │
 * └─────────────────────────┴───────┴────┴──────────┘
 *
 * Additionally, NO role can obtain an individual salary through any tool:
 * get_payroll_summary returns aggregates only and search_employees strips all
 * compensation/PII fields. Salary disclosure requests are refused politely.
 */

import type { Role } from "./types";

export const TOOL_NAMES = [
  "get_headcount",
  "get_attendance_summary",
  "get_late_comers",
  "get_leave_summary",
  "get_my_leave_balance",
  "get_payroll_summary",
  "search_employees",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Canonical AT-05 refusal — exact wording required by the acceptance suite. */
export const SALARY_REFUSAL =
  "I am not authorized to disclose other employees' salary information. Salaries are private; even aggregate payroll figures are only available to Admin and HR.";

const EMPLOYEE_SCOPE_REFUSAL =
  "That overview is restricted to Admin and HR. As an employee you can check your own leave balance, or ask me to search the employee directory (without any salary information).";

const READONLY: Record<ToolName, Role[]> = {
  get_headcount: ["Admin", "HR"],
  get_attendance_summary: ["Admin", "HR"],
  get_late_comers: ["Admin", "HR"],
  get_leave_summary: ["Admin", "HR"],
  get_my_leave_balance: ["Admin", "HR", "Employee"],
  get_payroll_summary: ["Admin", "HR"],
  search_employees: ["Admin", "HR", "Employee"],
};

export interface PermissionDecision {
  allowed: boolean;
  refusal?: string;
}

/**
 * Evaluate the matrix for a role + tool. Argument-level scoping is enforced
 * inside the tools themselves (get_my_leave_balance always resolves to the
 * session user, and search_employees always returns sanitized rows).
 */
export function checkToolPermission(tool: ToolName, role: Role): PermissionDecision {
  const allowedRoles = READONLY[tool];
  if (allowedRoles.includes(role)) return { allowed: true };

  return {
    allowed: false,
    refusal:
      tool === "get_payroll_summary"
        ? SALARY_REFUSAL
        : EMPLOYEE_SCOPE_REFUSAL,
  };
}

/** Human-readable scope note injected into the system prompt (data delimiter). */
export function scopeForRole(role: Role): string {
  switch (role) {
    case "Admin":
      return "Full organizational access: all departments, attendance, leave and aggregate payroll.";
    case "HR":
      return "Full organizational access: all departments, attendance, leave and aggregate payroll.";
    case "Employee":
      return "Self-service access only: your own leave balance and the sanitized employee directory. Organizational overviews and payroll are hidden.";
  }
}
