/**
 * M8 · PATCH /api/leaves/[id]/decision — Admin/HR decision endpoint
 * ---------------------------------------------------------------------------
 * Body: { action: "approve" | "reject", note?: string }
 * ALL rules are enforced HERE on the server, never just in the UI:
 *
 *   401 — no session (missing/unknown x-user-email; strict, no demo fallback).
 *   403 — role is Employee.
 *   404 — leave application not found.
 *   403 — the leave belongs to the deciding user. NOBODY decides their own
 *         request: not HR, not Admin. (An HR user's own leave can only be
 *         decided by Admin; an Admin's own leave can only be decided by HR.)
 *   409 — status is not Pending. The FIRST decision wins; no second decision
 *         ever, and no double deduction.
 *   422 — approval-time revalidation: the balance is no longer sufficient or
 *         the range now overlaps another pending/approved request.
 *
 * On approve: status → approved, decidedBy + decidedAt stored; the balance is
 * deducted through the ledger (remaining = entitlement − approved days) for
 * Annual/Sick/Casual. Unpaid deducts NOTHING — it is settled in payroll.
 * On reject: status → rejected, decidedBy + decidedAt + optional decisionNote;
 * NO balance change.
 *
 * Atomicity: this store is an in-memory ledger accessed from a single Node
 * event loop; the status check and the status flip happen in ONE synchronous
 * block with no await in between, so a double-click or parallel requests can
 never both pass the pending check — the loser gets 409.
 */

import { logAiRequest } from "@/lib/aiLogs";
import { LEAVE_RECORDS, employeeById } from "@/lib/hcmData";
import { getMyLeaveBalanceService } from "@/lib/services";
import { getSessionStrict, unauthorized } from "@/lib/session";
import { z } from "zod";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(200).optional(),
});

const QUOTA_TYPES = new Set(["annual", "sick", "casual"]);

function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && a.end >= b.start;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = getSessionStrict(req);
  if (!session) return unauthorized();

  const { id } = await params;
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
  const { action, note } = parsed.data;
  const t0 = Date.now();

  // Rule: only Admin and HR decide.
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
      { error: "Only Admin and HR can approve or reject leave requests." },
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

  // Rule: NOBODY decides their own leave — HR or Admin alike.
  if (record.employeeId === session.userId) {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "leave_admin",
      toolName: null,
      toolStatus: "forbidden",
      outcome: `${session.role} attempted to ${action} their OWN leave ${id} — refused`,
      latencyMs: Date.now() - t0,
    });
    return Response.json(
      { error: "You cannot approve or reject your own leave request." },
      { status: 403 },
    );
  }

  // ---- synchronous decision block: check + flip with no await in between ----
  // Rule: first action wins. Anything not pending is already decided.
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

  // Rule: approval-time revalidation — balances and overlaps may have changed
  // since the request was applied for. A failed revalidation leaves the record
  // pending so the officer can reject it instead.
  if (action === "approve") {
    if (QUOTA_TYPES.has(record.type)) {
      const balanceNow = getMyLeaveBalanceService(record.employeeId);
      const row = balanceNow.status === "ok"
        ? balanceNow.data.balances.find((b) => b.type === record.type)
        : undefined;
      if (row && record.days > row.remaining) {
        return Response.json(
          {
            error: `Approval blocked: ${applicant?.name ?? record.employeeId} has only ${row.remaining} ${record.type} day(s) remaining but this request needs ${record.days}.`,
          },
          { status: 422 },
        );
      }
    }
    const clash = LEAVE_RECORDS.find(
      (lv) =>
        lv.id !== record.id &&
        lv.employeeId === record.employeeId &&
        lv.status !== "rejected" &&
        overlaps(record, lv),
    );
    if (clash) {
      return Response.json(
        {
          error: `Approval blocked: the dates overlap an existing ${clash.status} request (${clash.start} → ${clash.end}).`,
        },
        { status: 422 },
      );
    }
  }

  record.decidedBy = session.userId; // approvedBy on approval
  record.decidedAt = new Date().toISOString(); // approvedAt on approval
  record.status = action === "approve" ? "approved" : "rejected";
  if (note) record.decisionNote = note;

  const balance = getMyLeaveBalanceService(record.employeeId);
  let warning: string | undefined;

  if (action === "approve" && QUOTA_TYPES.has(record.type) && balance.status === "ok") {
    const row = balance.data.balances.find((b) => b.type === record.type);
    if (row && row.remaining < 0) {
      warning = `${applicant?.name ?? record.employeeId} now has a negative ${record.type} balance (${row.remaining} days).`;
    }
  }
  // --------------------------------------------------------------------------

  logAiRequest({
    userId: session.userId,
    role: session.role,
    feature: "leave_admin",
    toolName: null,
    toolStatus: "ok",
    outcome: `${session.role} ${action}ed leave ${record.id} (${record.type} ${record.start}→${record.end}, ${record.days} working day(s)) for ${applicant?.name ?? record.employeeId}${
      note ? ` — note: ${note}` : ""
    } — ${
      action === "approve"
        ? QUOTA_TYPES.has(record.type)
          ? "balance deducted"
          : "unpaid: no balance deduction"
        : "rejected: no balance change"
    }`,
    latencyMs: Date.now() - t0,
  });

  const deducted = action === "approve" && QUOTA_TYPES.has(record.type);
  return Response.json({
    ok: true,
    application: record,
    balance: balance.status === "ok" ? balance.data : null,
    message:
      action === "approve"
        ? deducted
          ? `Application ${record.id} approved — ${record.days} ${record.type} working day${record.days === 1 ? "" : "s"} deducted from ${applicant?.name ?? "the employee"}'s balance.`
          : `Application ${record.id} approved — unpaid leave, no balance deduction.`
        : `Application ${record.id} rejected — no balance change.`,
    ...(warning ? { warning } : {}),
  });
}
