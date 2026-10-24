"use client";

/**
 * Leave records — the signed-in user's applications, plus (for Admin/HR) the
 * pending approval queue with Approve/Reject actions. Every decision rule is
 * enforced by the server (PATCH /api/leaves); the buttons only reflect the
 * server-computed `canDecide` per row.
 */

import { CalendarClock, Check, Inbox, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import type { Role } from "@/lib/types";

interface LeaveRow {
  id: string;
  employeeId: string;
  employeeName?: string;
  dept?: string;
  type: string;
  start: string;
  end: string;
  days: number;
  status: "approved" | "pending" | "rejected";
  reason: string;
  appliedOn: string;
  aiSuggested?: boolean;
  decidedBy?: string;
  decidedAt?: string;
  canDecide?: boolean;
}

interface Viewer {
  userId: string;
  role: Role;
}

const STATUS_CHIP: Record<LeaveRow["status"], string> = {
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  rejected: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

export default function LeaveRecords({
  sessionEmail,
  refreshKey,
  onDataChanged,
}: {
  sessionEmail: string;
  refreshKey: number;
  onDataChanged?: () => void;
}) {
  const [data, setData] = useState<{
    mine: LeaveRow[];
    pending: LeaveRow[] | null;
    viewer: Viewer | null;
  } | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [deciding, setDeciding] = useState<string | null>(null);
  const cacheKey = `${sessionEmail}#${refreshKey}#${nonce}`;
  const loading = fetchedFor !== cacheKey;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/leaves", {
          headers: { "x-user-email": sessionEmail },
        });
        const body = res.ok ? await res.json() : null;
        if (cancelled) return;
        setData(
          body
            ? {
                mine: body.mine ?? [],
                pending: body.pending ?? null,
                viewer: body.viewer ?? null,
              }
            : { mine: [], pending: null, viewer: null },
        );
      } finally {
        if (!cancelled) setFetchedFor(cacheKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, sessionEmail]);

  const mine = data?.mine ?? [];
  const pending = data?.pending ?? null;
  const viewer = data?.viewer ?? null;

  async function decide(id: string, action: "approve" | "reject") {
    setDeciding(`${id}:${action}`);
    try {
      const res = await fetch("/api/leaves", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-user-email": sessionEmail },
        body: JSON.stringify({ id, action }),
      });
      const body = await res.json();
      if (!res.ok) {
        // Server verdicts (403 self-decision, 409 already decided) surface verbatim.
        toast.error(body.error ?? "Could not record the decision.");
        setNonce((n) => n + 1); // re-sync in case another officer just decided
        return;
      }
      toast.success(body.message);
      if (body.warning) toast(body.warning, { icon: "⚠️" });
      onDataChanged?.();
      setNonce((n) => n + 1);
    } catch {
      toast.error("Network error while recording the decision.");
    } finally {
      setDeciding(null);
    }
  }

  const fmt = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-sky-300" />
          <h3 className="text-sm font-semibold text-slate-100">My applications</h3>
        </div>
        {loading ? (
          <p className="mt-4 text-sm text-slate-500">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No applications yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-800/70">
            {mine.slice(0, 8).map((lv) => (
              <li key={lv.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">
                    <span className="capitalize">{lv.type}</span> · {fmt(lv.start)} → {fmt(lv.end)}{" "}
                    <span className="text-slate-500">({lv.days}d)</span>
                    {lv.aiSuggested && (
                      <span className="ml-2 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300">
                        AI-suggested
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-slate-500">
                    {lv.reason}
                    {lv.decidedAt &&
                      lv.decidedBy &&
                      ` · decided by ${lv.decidedBy} at ${new Date(lv.decidedAt).toLocaleString()}`}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_CHIP[lv.status]}`}
                >
                  {lv.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {viewer && viewer.role !== "Employee" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-amber-300" />
            <h3 className="text-sm font-semibold text-slate-100">Pending approvals (org-wide)</h3>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            First decision wins — the server rejects later attempts. HR cannot decide their own
            leave; only Admin can.
          </p>
          {loading ? (
            <p className="mt-4 text-sm text-slate-500">Loading…</p>
          ) : !pending || pending.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">The pending queue is empty.</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-800/70">
              {pending.map((lv) => (
                <li key={lv.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">
                      {lv.employeeName} <span className="text-slate-500">({lv.dept})</span> ·{" "}
                      <span className="capitalize">{lv.type}</span> · {lv.days}d
                      {lv.aiSuggested && (
                        <span className="ml-2 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300">
                          AI-suggested
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {fmt(lv.start)} → {fmt(lv.end)} · {lv.reason}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {lv.canDecide ? (
                      <>
                        <button
                          onClick={() => decide(lv.id, "approve")}
                          disabled={deciding !== null}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
                        >
                          {deciding === `${lv.id}:approve` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="h-3 w-3" />
                          )}
                          Approve
                        </button>
                        <button
                          onClick={() => decide(lv.id, "reject")}
                          disabled={deciding !== null}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
                        >
                          {deciding === `${lv.id}:reject` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <X className="h-3 w-3" />
                          )}
                          Reject
                        </button>
                      </>
                    ) : viewer.role === "HR" && lv.employeeId === viewer.userId ? (
                      <span className="text-[10px] text-slate-500">Own leave — Admin decides</span>
                    ) : (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_CHIP.pending}`}
                      >
                        pending
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
