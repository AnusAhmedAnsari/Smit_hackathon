/**
 * M8 · /api/leaves — the human confirmation write path (Constitution §4)
 * ---------------------------------------------------------------------------
 * GET   : Employee → ONLY their own records (server-enforced; no list of
 *         others is ever sent). Admin/HR → their own records PLUS the full
 *         request list, optionally filtered with ?status=pending|approved|rejected.
 * POST  : apply for leave. Creates ONE record with status `pending`. The ONLY
 *         way a record is created, and it happens ONLY after the human pressed
 *         "Confirm & Submit" — the AI itself can never write.
 * PATCH : moved to /api/leaves/[id]/decision (approve/reject lives there).
 *
 * Apply-time validation (HTTP 422 on failure):
 *   - the requested range overlaps one of the employee's pending/approved
 *     requests;
 *   - for Annual/Sick/Casual the working-day count exceeds the remaining
 *     balance (Unpaid is unlimited — no balance is ever touched; it is
 *     deducted in payroll later).
 *
 * Day counting: `days` is ALWAYS working days — weekends and public holidays
 * are skipped (lib/hcmData.countWorkingDays).
 *
 * Auth: STRICT — a missing or unknown x-user-email answers 401. No request
 * without a valid session can read or change any leave record.
 */

import { logAiRequest } from "@/lib/aiLogs";
import {
  addLeaveApplication,
  countWorkingDays,
  todayIso,
  LEAVE_RECORDS,
  employeeById,
} from "@/lib/hcmData";
import { getMyLeaveBalanceService } from "@/lib/services";
import { getSessionStrict, unauthorized } from "@/lib/session";
import type { LeaveRecord } from "@/lib/types";
import { z } from "zod";

const submitSchema = z.object({
  type: z.enum(["annual", "sick", "casual", "unpaid"]),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
  reason: z.string().trim().min(3, "Please include a short reason.").max(200),
  ai_suggested: z.boolean().optional(),
});

const QUOTA_TYPES = new Set(["annual", "sick", "casual"]);

let applicationSeq = 100;

/** Serialize a record with resolved names for display. */
function serialize(lv: LeaveRecord, extra: Record<string, unknown> = {}) {
  return {
    ...lv,
    employeeName: employeeById(lv.employeeId)?.name ?? lv.employeeId,
    dept: employeeById(lv.employeeId)?.dept ?? "—",
    decidedByName: lv.decidedBy ? employeeById(lv.decidedBy)?.name ?? lv.decidedBy : undefined,
    ...extra,
  };
}

function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && a.end >= b.start;
}

export async function GET(req: Request) {
  const session = getSessionStrict(req);
  if (!session) return unauthorized();

  const mine = LEAVE_RECORDS.filter((lv) => lv.employeeId === session.userId).sort(
    (a, b) => b.appliedOn.localeCompare(a.appliedOn) || b.id.localeCompare(a.id),
  );

  const balance = getMyLeaveBalanceService(session.userId);
  const balanceData = balance.status === "ok" ? balance.data : null;

  // Employees: own records only — nothing else ever leaves the server.
  if (session.role === "Employee") {
    return Response.json({
      mine: mine.map((lv) => serialize(lv)),
      balance: balanceData,
      viewer: { userId: session.userId, role: session.role },
    });
  }

  // Officers: full request list with optional status filter.
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");
  const valid = ["pending", "approved", "rejected"];
  if (statusFilter && !valid.includes(statusFilter)) {
    return Response.json(
      { error: `Unknown status filter "${statusFilter}". Use pending, approved or rejected.` },
      { status: 400 },
    );
  }
  const all = LEAVE_RECORDS.filter(
    (lv) => !statusFilter || lv.status === statusFilter,
  ).sort((a, b) => b.appliedOn.localeCompare(a.appliedOn) || b.id.localeCompare(a.id));

  return Response.json({
    mine: mine.map((lv) => serialize(lv)),
    all: all.map((lv) =>
      serialize(lv, {
        // Server-computed: NOBODY can decide their own request — buttons are
        // hidden in the UI but the decision endpoint enforces it regardless.
        canDecide: lv.status === "pending" && lv.employeeId !== session.userId,
      }),
    ),
    balance: balanceData,
    viewer: { userId: session.userId, role: session.role },
  });
}

export async function POST(req: Request) {
  const session = getSessionStrict(req);
  if (!session) return unauthorized();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = submitSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }
  const { type, start, end, reason, ai_suggested } = parsed.data;
  const today = todayIso();

  if (start < today) {
    return Response.json({ error: "The start date is in the past." }, { status: 400 });
  }
  if (end < start) {
    return Response.json({ error: "The end date is before the start date." }, { status: 400 });
  }

  // Days are WORKING days — weekends and public holidays never consume balance.
  const days = countWorkingDays(start, end);
  if (days < 1) {
    return Response.json(
      { error: "The selected range contains no working days (weekends and public holidays are skipped)." },
      { status: 400 },
    );
  }
  if (days > 30) {
    return Response.json({ error: "Applications longer than 30 working days need HR directly." }, { status: 400 });
  }

  // Overlap: against the employee's own pending AND approved requests.
  const clash = LEAVE_RECORDS.find(
    (lv) =>
      lv.employeeId === session.userId &&
      lv.status !== "rejected" &&
      overlaps({ start, end }, lv),
  );
  if (clash) {
    return Response.json(
      {
        error: `These dates overlap an existing ${clash.status} request (${clash.start} → ${clash.end}). Please choose different dates.`,
      },
      { status: 422 },
    );
  }

  // Balance: Annual/Sick/Casual must fit the remaining balance at apply time.
  // Unpaid is unlimited and skips this check entirely. (Approval re-validates.)
  if (QUOTA_TYPES.has(type)) {
    const balance = getMyLeaveBalanceService(session.userId);
    const row = balance.status === "ok" ? balance.data.balances.find((b) => b.type === type) : undefined;
    if (row && days > row.remaining) {
      return Response.json(
        {
          error: `Not enough balance: this request needs ${days} ${type} working day(s) but only ${row.remaining} remain.`,
        },
        { status: 422 },
      );
    }
  }

  applicationSeq += 1;
  const application: LeaveRecord = {
    id: `LV-${applicationSeq}`,
    employeeId: session.userId,
    type,
    start,
    end,
    days,
    status: "pending",
    reason,
    appliedOn: today,
    ...(ai_suggested ? { aiSuggested: true } : {}),
  };
  addLeaveApplication(application);

  logAiRequest({
    userId: session.userId,
    role: session.role,
    feature: ai_suggested ? "smart_leave" : "chat",
    toolName: null,
    toolStatus: "ok",
    outcome: `human-confirmed leave application ${application.id}: ${type} ${start}→${end} (${days} working day(s))${ai_suggested ? " [AI-suggested]" : ""} — now pending approval`,
    latencyMs: 0,
  });

  const balance = getMyLeaveBalanceService(session.userId);
  return Response.json({
    ok: true,
    application,
    balance: balance.status === "ok" ? balance.data : null,
    message: `Applied for ${days} ${type} working day${days === 1 ? "" : "s"} (${start} → ${end}). Status: pending approval.`,
  });
}
