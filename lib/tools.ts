/**
 * HCM Lite — Tool Registry & Executor (M8, T2.1–T2.9)
 * ---------------------------------------------------------------------------
 * Exactly 7 tools (Spec §6). Each execution is:
 *   1. schema-validated (zod, unknown keys stripped),
 *   2. permission-checked (lib/permissions.ts — the ONE permission system),
 *   3. served by lib/services.ts (the ONE data engine),
 *   4. audit-logged with latency (lib/aiLogs.ts).
 *
 * Every result uses the common envelope: { status, data, meta, message? }.
 * The AI can only act through these tools — there is no other data path.
 */

import { z } from "zod";
import { getAiLogs, logAiRequest } from "./aiLogs";
import { checkToolPermission, TOOL_NAMES, type ToolName } from "./permissions";
import {
  getAttendanceSummaryService,
  getHeadcountService,
  getLateComersService,
  getLeaveSummaryService,
  getMyLeaveBalanceService,
  getPayrollSummaryService,
  searchEmployeesService,
} from "./services";
import type { SessionUser, ToolResult } from "./types";

export { TOOL_NAMES };
export type { ToolName };

/* ------------------------------------------------------------------------- */
/* Argument schemas (strict about types, loose about unknown keys)           */
/* ------------------------------------------------------------------------- */

const deptSchema = z.string().trim().min(1).max(40).optional();
const periodSchema = z.string().trim().min(1).max(60).optional();

export const TOOL_ARG_SCHEMAS = {
  get_headcount: z.object({ dept: deptSchema }),
  get_attendance_summary: z.object({ dept: deptSchema, period: periodSchema }),
  get_late_comers: z.object({
    dept: deptSchema,
    period: periodSchema,
    limit: z.number().int().min(1).max(10).optional(),
  }),
  get_leave_summary: z.object({
    dept: deptSchema,
    period: periodSchema,
    type: z.enum(["annual", "sick", "casual", "unpaid"]).optional(),
  }),
  get_my_leave_balance: z.object({}),
  get_payroll_summary: z.object({ dept: deptSchema, period: periodSchema }),
  search_employees: z.object({
    query: z.string().trim().min(1).max(60),
    dept: deptSchema,
    limit: z.number().int().min(1).max(10).optional(),
  }),
} satisfies Record<ToolName, z.ZodTypeAny>;

/* ------------------------------------------------------------------------- */
/* Gemini function declarations (plain JSON; adapted in lib/gemini.ts)        */
/* ------------------------------------------------------------------------- */

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): unknown => ({
  type: "OBJECT",
  properties,
  required,
});

const str = (description: string, enumVals?: string[]) => ({
  type: "STRING",
  description,
  ...(enumVals ? { enum: enumVals } : {}),
});
const num = (description: string) => ({ type: "NUMBER", description });

export interface ToolCatalogEntry {
  name: ToolName;
  description: string;
  parameters: unknown;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "get_headcount",
    description:
      "Count employees. Returns total headcount plus active/on-probation/resigned counts for one department or the whole organization. Available to Admin and HR only.",
    parameters: obj({
      dept: str(
        "Optional department name. Omit for the whole organization.",
        ["Engineering", "Sales", "HR"],
      ),
    }),
  },
  {
    name: "get_attendance_summary",
    description:
      "Attendance statistics (present / late / absent / on-leave counts and the attendance rate %) for a period. Available to Admin and HR only.",
    parameters: obj({
      dept: str("Optional department filter.", ["Engineering", "Sales", "HR"]),
      period: str(
        'Optional period, e.g. "this month", "last month", "October 2026", "2026-10". Defaults to the current month.',
      ),
    }),
  },
  {
    name: "get_late_comers",
    description:
      "Ranked list of employees who arrived late most often in a period, with counts and total minutes late. Available to Admin and HR only.",
    parameters: obj({
      dept: str("Optional department filter.", ["Engineering", "Sales", "HR"]),
      period: str(
        'Optional period, e.g. "this month", "last month", "March 2026". Defaults to the current month.',
      ),
      limit: num("Optional max rows to return (1-10, default 5)."),
    }),
  },
  {
    name: "get_leave_summary",
    description:
      "Aggregate leave statistics by type (annual/sick/casual) and status for a period, including the current pending applications. Available to Admin and HR only.",
    parameters: obj({
      dept: str("Optional department filter.", ["Engineering", "Sales", "HR"]),
      period: str("Optional period, defaults to the current month."),
      type: str("Optional single leave type to focus on.", [
        "annual",
        "sick",
        "casual",
        "unpaid",
      ]),
    }),
  },
  {
    name: "get_my_leave_balance",
    description:
      "The signed-in user's OWN leave balance for the current year: entitlement, approved usage, pending applications and remaining days for annual, sick and casual leave. Takes NO arguments — it always resolves to the signed-in user. Available to every role.",
    parameters: obj({}),
  },
  {
    name: "get_payroll_summary",
    description:
      "AGGREGATE payroll cost only (total, average and per-department gross). Never contains individual salaries. Available to Admin and HR only; employees are refused.",
    parameters: obj({
      dept: str("Optional department filter.", ["Engineering", "Sales", "HR"]),
      period: str("Optional month, defaults to the current month."),
    }),
  },
  {
    name: "search_employees",
    description:
      "Search the employee directory by name, designation or department. Returns sanitized rows only: id, name, designation, department, status and email. NEVER returns salary, CNIC or bank details, for any role.",
    parameters: obj(
      {
        query: str("Name, designation or department to search for."),
        dept: str("Optional department filter.", ["Engineering", "Sales", "HR"]),
        limit: num("Optional max rows to return (1-10, default 5)."),
      },
      ["query"],
    ),
  },
];

/* ------------------------------------------------------------------------- */
/* Executor                                                                  */
/* ------------------------------------------------------------------------- */

function envelope<T>(
  status: ToolResult["status"],
  tool: ToolName,
  data: T | null,
  message?: string,
  extraMeta?: Record<string, unknown>,
): ToolResult<T> {
  return {
    status,
    data,
    message,
    meta: {
      tool,
      generated_at: new Date().toISOString(),
      ...(extraMeta ?? {}),
    },
  };
}

/**
 * Execute a tool on behalf of a resolved session. Never throws — any failure
 * becomes an `error` envelope (Constitution: fail soft).
 */
export function executeTool(
  name: string,
  rawArgs: unknown,
  session: SessionUser,
): ToolResult {
  const t0 = Date.now();
  const finish = (
    result: ToolResult,
    outcome: string,
  ): ToolResult => {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "tool",
      toolName: name,
      toolStatus: result.status,
      outcome,
      latencyMs: Date.now() - t0,
    });
    return result;
  };

  if (!TOOL_NAMES.includes(name as ToolName)) {
    return finish(
      envelope("error", name as ToolName, null, `Unknown tool "${name}".`),
      `unknown tool "${name}" rejected`,
    );
  }
  const tool = name as ToolName;

  // 1) Permission first — even before arguing about arguments.
  const permission = checkToolPermission(tool, session.role);
  if (!permission.allowed) {
    return finish(
      envelope("forbidden", tool, null, permission.refusal),
      `forbidden for role ${session.role}`,
    );
  }

  // 2) Validate arguments.
  const parsed = TOOL_ARG_SCHEMAS[tool].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const msg = `Invalid arguments for ${tool}: ${issue?.path.join(".") || "args"} ${issue?.message ?? "is invalid"}.`;
    return finish(envelope("error", tool, null, msg), `invalid arguments rejected`);
  }
  const args = parsed.data as Record<string, unknown>;

  // 3) Serve from the single service layer.
  try {
    switch (tool) {
      case "get_headcount": {
        const r = getHeadcountService(args.dept as string | undefined);
        return finish(r, `headcount ${r.status} (${r.status === "ok" ? `${r.data.active} active` : r.message})`);
      }
      case "get_attendance_summary": {
        const r = getAttendanceSummaryService(args.dept as string | undefined, args.period as string | undefined);
        return finish(r, `attendance ${r.status} (${r.status === "ok" ? `${r.data.attendanceRatePct}% ${r.data.period}` : r.message})`);
      }
      case "get_late_comers": {
        const r = getLateComersService(
          args.dept as string | undefined,
          args.period as string | undefined,
          args.limit as number | undefined,
        );
        return finish(r, `latecomers ${r.status} (${r.status === "ok" ? `${r.data.ranking.length} rows ${r.data.period}` : r.message})`);
      }
      case "get_leave_summary": {
        const r = getLeaveSummaryService(
          args.dept as string | undefined,
          args.period as string | undefined,
          args.type as string | undefined,
        );
        return finish(r, `leave summary ${r.status} (${r.status === "ok" ? `${r.data.period}, ${r.data.pendingCases.length} pending` : r.message})`);
      }
      case "get_my_leave_balance": {
        // Identity ALWAYS comes from the server session, never from args.
        const r = getMyLeaveBalanceService(session.userId);
        return finish(r, `leave balance ${r.status} for ${session.userId}`);
      }
      case "get_payroll_summary": {
        const r = getPayrollSummaryService(args.dept as string | undefined, args.period as string | undefined);
        return finish(r, `payroll ${r.status} (${r.status === "ok" ? `PKR ${r.data.totalGrossPkr} ${r.data.period}` : r.message})`);
      }
      case "search_employees": {
        const r = searchEmployeesService(
          args.query as string,
          args.dept as string | undefined,
          args.limit as number | undefined,
        );
        return finish(r, `directory search ${r.status} "${args.query}" (${r.status === "ok" ? `${r.data.count} matches, sanitized` : r.message})`);
      }
    }
  } catch (err) {
    return finish(
      envelope("error", tool, null, "The tool failed unexpectedly. Please try again."),
      `tool threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Audit rows for the Admin viewer (re-exported for convenience). */
export { getAiLogs };
