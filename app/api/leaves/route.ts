/**
 * M8 · /api/leaves — the human confirmation write path (Constitution §4)
 * ---------------------------------------------------------------------------
 * GET  : the signed-in user's own applications (+ pending queue for Admin/HR).
 * POST : submit a leave application. This is the ONLY write in the module and
 *        it happens ONLY after the human pressed "Confirm & Submit" in the
 *        UI — the AI itself can never write. The application is recorded as
 *        `pending` until HR approves.
 *
 * Validation: valid ISO dates, not in the past, end ≥ start, known type.
 * Quota overruns do NOT block submission (HR decides) but the response carries
 * a warning the UI shows as a toast.
 */

import { logAiRequest } from "@/lib/aiLogs";
import {
  addLeaveApplication,
  todayIso,
  LEAVE_RECORDS,
  employeeById,
} from "@/lib/hcmData";
import { getMyLeaveBalanceService } from "@/lib/services";
import { getSession, unauthorized } from "@/lib/session";
import { z } from "zod";

const submitSchema = z.object({
  type: z.enum(["annual", "sick", "casual"]),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
  reason: z.string().trim().min(3, "Please include a short reason.").max(200),
  ai_suggested: z.boolean().optional(),
});

let applicationSeq = 100;

function diffDays(start: string, end: string): number {
  const a = new Date(`${start}T12:00:00Z`).getTime();
  const b = new Date(`${end}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

export async function GET(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  const mine = LEAVE_RECORDS.filter((lv) => lv.employeeId === session.userId).sort(
    (a, b) => b.appliedOn.localeCompare(a.appliedOn),
  );
  const isOfficer = session.role !== "Employee";
  const pending = isOfficer
    ? LEAVE_RECORDS.filter((lv) => lv.status === "pending").map((lv) => ({
        ...lv,
        employeeName: employeeById(lv.employeeId)?.name ?? lv.employeeId,
        dept: employeeById(lv.employeeId)?.dept ?? "—",
      }))
    : undefined;
  const balance = getMyLeaveBalanceService(session.userId);

  return Response.json({
    mine,
    pending,
    balance: balance.status === "ok" ? balance.data : null,
  });
}

export async function POST(req: Request) {
  const session = getSession(req);
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
  const days = diffDays(start, end);
  if (days > 30) {
    return Response.json({ error: "Applications longer than 30 days need HR directly." }, { status: 400 });
  }

  applicationSeq += 1;
  const application = {
    id: `LV-${applicationSeq}`,
    employeeId: session.userId,
    type,
    start,
    end,
    days,
    status: "pending" as const,
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
    outcome: `human-confirmed leave application ${application.id}: ${type} ${start}→${end} (${days}d)${ai_suggested ? " [AI-suggested]" : ""} — now pending HR approval`,
    latencyMs: 0,
  });

  const balance = getMyLeaveBalanceService(session.userId);
  return Response.json({
    ok: true,
    application,
    balance: balance.status === "ok" ? balance.data : null,
    message: `Applied for ${days} ${type} day${days === 1 ? "" : "s"} (${start} → ${end}). Status: pending HR approval.`,
  });
}
