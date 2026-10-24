/**
 * M8 · /api/leaves — the human confirmation write path (Constitution §4)
 * ---------------------------------------------------------------------------
 * GET   : the signed-in user's own applications, the pending queue for Admin/HR
 *         (each row carries a server-computed `canDecide`), and the viewer's
 *         own leave balance.
 * POST  : submit a leave application. The ONLY way a record is created, and it
 *         happens ONLY after the human pressed "Confirm & Submit" — the AI
 *         itself can never write. New records are always status `pending`.
 * PATCH : Admin/HR decision endpoint (approve | reject). ALL rules are
 *         enforced here on the server, never just in the UI:
 *
 *   1. Only Admin and HR may decide (Employee → 403).
 *   2. Decisions apply ONLY while status is `pending` — the first action wins;
 *      any later attempt gets 409 Conflict (approve-after-reject, etc.).
 *   3. On approve the balance is deducted (ledger-derived: remaining =
 *      entitlement − approved days). `unpaid` leave is EXEMPT — approving it
 *      never touches any balance.
 *   4. On reject there is NO balance change.
 *   5. The decision stores `decidedBy` (approvedBy) and `decidedAt`
 *      (approvedAt) server-side.
 *   6. HR cannot approve/reject their OWN leave — only Admin can (403).
 *
 * Validation on POST: valid ISO dates, not in the past, end ≥ start, known
 * type. Quota overruns do NOT block submission or approval (HR decides), but
 * the approval response carries a warning when a balance goes negative.
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
  type: z.enum(["annual", "sick", "casual", "unpaid"]),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
  reason: z.string().trim().min(3, "Please include a short reason.").max(200),
  ai_suggested: z.boolean().optional(),
});

const decisionSchema = z.object({
  id: z.string().trim().min(1),
  action: z.enum(["approve", "reject"]),
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
        // Server-computed: HR is blocked on their own applications, Admin is not.
        canDecide: session.role === "Admin" || lv.employeeId !== session.userId,
      }))
    : undefined;
  const balance = getMyLeaveBalanceService(session.userId);

  return Response.json({
    mine,
    pending,
    balance: balance.status === "ok" ? balance.data : null,
    viewer: { userId: session.userId, role: session.role },
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

/**
 * Decision endpoint — the ONLY path that moves a pending application to
 * approved/rejected. Every rule in the header comment is enforced HERE.
 */
export async function PATCH(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }
  const { id, action } = parsed.data;
  const t0 = Date.now();

  // Rule 1 — only Admin and HR decide.
  if (session.role === "Employee") {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "leave_admin",
      toolName: null,
      toolStatus: "forbidden",
      outcome: `Employee attempted to ${action} leave ${id} — refused`,
      latencyMs: Date.now() - t0,
    });
    return Response.json(
      { error: "Only Admin and HR can approve or reject leave applications." },
      { status: 403 },
    );
  }

  const record = LEAVE_RECORDS.find((lv) => lv.id === id);
  if (!record) {
    return Response.json(
      { error: `Leave application "${id}" was not found.` },
      { status: 404 },
    );
  }

  // Rule 6 — HR cannot decide their own leave; only Admin can.
  if (session.role === "HR" && record.employeeId === session.userId) {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "leave_admin",
      toolName: null,
      toolStatus: "forbidden",
      outcome: `HR attempted to ${action} their OWN leave ${id} — refused (Admin only)`,
      latencyMs: Date.now() - t0,
    });
    return Response.json(
      { error: "HR cannot approve or reject their own leave. Only Admin can." },
      { status: 403 },
    );
  }

  // Rule 2 — first action wins: only a pending record can be decided.
  if (record.status !== "pending") {
    const priorDecider =
      employeeById(record.decidedBy ?? "")?.name ?? record.decidedBy ?? "someone";
    return Response.json(
      {
        error: `Application ${id} was already ${record.status} by ${priorDecider} — the first decision stands.`,
      },
      { status: 409 },
    );
  }

  const applicant = employeeById(record.employeeId);
  record.decidedBy = session.userId; // approvedBy on approval
  record.decidedAt = new Date().toISOString(); // approvedAt on approval
  record.status = action === "approve" ? "approved" : "rejected";

  const balance = getMyLeaveBalanceService(record.employeeId);
  let warning: string | undefined;
  if (action === "approve" && record.type !== "unpaid" && balance.status === "ok") {
    const row = balance.data.balances.find((b) => b.type === record.type);
    if (row && row.remaining < 0) {
      warning = `${applicant?.name ?? record.employeeId} now has a negative ${record.type} balance (${row.remaining} days).`;
    }
  }

  const deducted = action === "approve" && record.type !== "unpaid";
  logAiRequest({
    userId: session.userId,
    role: session.role,
    feature: "leave_admin",
    toolName: null,
    toolStatus: "ok",
    outcome: `${session.role} ${action}ed leave ${record.id} (${record.type} ${record.start}→${record.end}, ${record.days}d) for ${applicant?.name ?? record.employeeId} — ${
      deducted
        ? "balance deducted"
        : action === "approve"
          ? "unpaid: no balance change"
          : "rejected: no balance change"
    }`,
    latencyMs: Date.now() - t0,
  });

  return Response.json({
    ok: true,
    application: record,
    balance: balance.status === "ok" ? balance.data : null,
    message:
      action === "approve"
        ? deducted
          ? `Application ${record.id} approved — ${record.days} ${record.type} day${record.days === 1 ? "" : "s"} deducted from ${applicant?.name ?? "the employee"}'s balance.`
          : `Application ${record.id} approved — unpaid leave, no balance change.`
        : `Application ${record.id} rejected — no balance change.`,
    ...(warning ? { warning } : {}),
  });
}
