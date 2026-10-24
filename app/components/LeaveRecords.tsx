"use client";

/**
 * Leave records — the signed-in user's applications, plus (for Admin/HR) the
 * pending approval queue. Read-only here: approvals happen in the HR portal.
 */

import { CalendarClock, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
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
}

const STATUS_CHIP: Record<LeaveRow["status"], string> = {
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  rejected: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

export default function LeaveRecords({
  sessionEmail,
  role,
  refreshKey,
}: {
  sessionEmail: string;
  role: Role;
  refreshKey: number;
}) {
  const [data, setData] = useState<{ mine: LeaveRow[]; pending: LeaveRow[] | null } | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const cacheKey = `${sessionEmail}#${refreshKey}`;
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
            ? { mine: body.mine ?? [], pending: body.pending ?? null }
            : { mine: [], pending: null },
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
                  <p className="truncate text-[11px] text-slate-500">{lv.reason}</p>
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

      {role !== "Employee" && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-amber-300" />
            <h3 className="text-sm font-semibold text-slate-100">Pending approvals (org-wide)</h3>
          </div>
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
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {fmt(lv.start)} → {fmt(lv.end)} · {lv.reason}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_CHIP[lv.status]}`}
                  >
                    pending
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
