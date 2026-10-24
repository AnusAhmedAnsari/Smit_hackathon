"use client";

/**
 * Leave Requests screen.
 * - Admin/HR: filterable table of ALL requests (employee, type, dates, days,
 *   reason, status) with Approve/Reject on pending rows. The server computes
 *   `canDecide` per row (NOBODY decides their own request); after a decision
 *   the buttons disappear and decidedBy name + decidedAt are shown.
 * - Employee: their own requests with status, and the decision note if rejected.
 * Every rule is enforced by the server (PATCH /api/leaves/[id]/decision);
 * the buttons merely reflect it.
 */

import { CalendarClock, Check, ClipboardList, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

interface LeaveRow {
  id: string;
  employeeId: string;
  employeeName?: string;
  dept?: string;
  type: string;
  start: string;
  end: string;
  days: number;
  status: "pending" | "approved" | "rejected";
  reason: string;
  appliedOn: string;
  aiSuggested?: boolean;
  decidedBy?: string;
  decidedAt?: string;
  decidedByName?: string;
  decisionNote?: string;
  canDecide?: boolean;
}

type StatusFilter = "all" | "pending" | "approved" | "rejected";

const STATUS_CHIP: Record<LeaveRow["status"], string> = {
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  rejected: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

const TYPE_CHIP: Record<string, string> = {
  annual: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  sick: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  casual: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  unpaid: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

const fmt = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

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
    all: LeaveRow[] | null;
    viewer: { userId: string; role: string } | null;
  } | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const cacheKey = `${sessionEmail}#${refreshKey}#${nonce}#${filter}`;
  const loading = fetchedFor !== cacheKey;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = data?.viewer && data.viewer.role !== "Employee" && filter !== "all"
          ? `?status=${filter}`
          : "";
        const res = await fetch(`/api/leaves${qs}`, {
          headers: { "x-user-email": sessionEmail },
        });
        const body = res.ok ? await res.json() : null;
        if (cancelled) return;
        setData(
          body
            ? {
                mine: body.mine ?? [],
                all: body.all ?? null,
                viewer: body.viewer ?? null,
              }
            : { mine: [], all: null, viewer: null },
        );
      } finally {
        if (!cancelled) setFetchedFor(cacheKey);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, sessionEmail]);

  const isOfficer = data?.viewer && data.viewer.role !== "Employee";

  async function decide(id: string, action: "approve" | "reject", note?: string) {
    setDeciding(`${id}:${action}`);
    try {
      const res = await fetch(`/api/leaves/${id}/decision`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-user-email": sessionEmail },
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) {
        // Server verdicts (401/403/404/409/422) surface verbatim.
        toast.error(body.error ?? "Could not record the decision.");
        setNonce((n) => n + 1); // re-sync — another officer may have decided
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
      setNoteFor(null);
      setNoteText("");
    }
  }

  function startReject(id: string) {
    setNoteFor(id);
    setNoteText("");
  }

  const requests = data?.all ?? [];
  const mine = data?.mine ?? [];

  return (
    <div className="space-y-4">
      {isOfficer && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-amber-300" />
              <h3 className="text-sm font-semibold text-slate-100">Leave requests</h3>
            </div>
            <div className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-lg px-2.5 py-1 text-xs transition ${
                    filter === f.key
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            First decision wins — the server rejects later attempts (409). Nobody can decide their
            own request, Admin included. Unpaid leave never touches balances.
          </p>

          {loading ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : requests.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center">
              <p className="text-sm text-slate-400">No leave requests for this filter.</p>
              <p className="mt-1 text-[11px] text-slate-600">
                New applications appear here the moment an employee confirms them.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              {/* header (desktop only) */}
              <div className="hidden gap-3 border-b border-slate-800 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 lg:grid lg:grid-cols-[1.2fr_.7fr_1.2fr_.4fr_1.4fr_.7fr_1fr]">
                <span>Employee</span>
                <span>Type</span>
                <span>Dates</span>
                <span>Days</span>
                <span>Reason</span>
                <span>Status</span>
                <span className="text-right">Decision</span>
              </div>
              <div className="divide-y divide-slate-800/70">
                {requests.map((lv) => (
                  <div
                    key={lv.id}
                    className="grid gap-1.5 px-3 py-3 text-sm lg:grid-cols-[1.2fr_.7fr_1.2fr_.4fr_1.4fr_.7fr_1fr] lg:items-center lg:gap-3"
                  >
                    <div className="min-w-0">
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 lg:hidden">
                        Employee ·{" "}
                      </span>
                      <span className="font-medium text-slate-100">{lv.employeeName}</span>
                      <span className="ml-1 text-[11px] text-slate-500">({lv.dept})</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 lg:hidden">
                        Type ·{" "}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${TYPE_CHIP[lv.type] ?? ""}`}
                      >
                        {lv.type}
                      </span>
                      {lv.aiSuggested && (
                        <span className="ml-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300">
                          AI
                        </span>
                      )}
                    </div>
                    <div className="text-slate-300">
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 lg:hidden">
                        Dates ·{" "}
                      </span>
                      {fmt(lv.start)} → {fmt(lv.end)}
                    </div>
                    <div className="text-slate-300">
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 lg:hidden">
                        Days ·{" "}
                      </span>
                      {lv.days}
                    </div>
                    <div className="min-w-0 truncate text-slate-400" title={lv.reason}>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 lg:hidden">
                        Reason ·{" "}
                      </span>
                      {lv.reason}
                    </div>
                    <div>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_CHIP[lv.status]}`}
                      >
                        {lv.status}
                      </span>
                    </div>
                    <div className="lg:text-right">
                      {lv.status === "pending" ? (
                        lv.canDecide ? (
                          noteFor === lv.id ? (
                            <div className="flex flex-col items-stretch gap-1.5 lg:items-end">
                              <input
                                autoFocus
                                value={noteText}
                                onChange={(e) => setNoteText(e.target.value)}
                                placeholder="Optional note to the employee"
                                maxLength={200}
                                className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-rose-500 focus:outline-none"
                              />
                              <div className="flex gap-1.5 lg:justify-end">
                                <button
                                  onClick={() => decide(lv.id, "reject", noteText.trim() || undefined)}
                                  disabled={deciding !== null}
                                  className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
                                >
                                  {deciding === `${lv.id}:reject` ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <X className="h-3 w-3" />
                                  )}
                                  Confirm reject
                                </button>
                                <button
                                  onClick={() => {
                                    setNoteFor(null);
                                    setNoteText("");
                                  }}
                                  className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 transition hover:border-slate-500"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1.5 lg:justify-end">
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
                                onClick={() => startReject(lv.id)}
                                disabled={deciding !== null}
                                className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
                              >
                                <X className="h-3 w-3" />
                                Reject
                              </button>
                            </div>
                          )
                        ) : (
                          <span className="text-[10px] text-slate-500">Own request — another officer decides</span>
                        )
                      ) : (
                        <div className="text-[11px] leading-snug text-slate-400">
                          {lv.decidedByName && (
                            <p>
                              by <span className="text-slate-300">{lv.decidedByName}</span>
                            </p>
                          )}
                          {lv.decidedAt && (
                            <p className="text-[10px] text-slate-600">
                              {new Date(lv.decidedAt).toLocaleString()}
                            </p>
                          )}
                          {lv.decisionNote && (
                            <p className="mt-0.5 text-[10px] italic text-slate-500" title={lv.decisionNote}>
                              “{lv.decisionNote}”
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Own applications — every role */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-sky-300" />
          <h3 className="text-sm font-semibold text-slate-100">My applications</h3>
        </div>
        {loading ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : mine.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No applications yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-800/70">
            {mine.slice(0, 8).map((lv) => (
              <li key={lv.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">
                    <span className="capitalize">{lv.type}</span> · {fmt(lv.start)} → {fmt(lv.end)}{" "}
                    <span className="text-slate-500">({lv.days} working day{lv.days === 1 ? "" : "s"})</span>
                    {lv.aiSuggested && (
                      <span className="ml-2 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-300">
                        AI-suggested
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-slate-500">{lv.reason}</p>
                  {lv.status === "rejected" && lv.decisionNote && (
                    <p className="mt-0.5 truncate text-[11px] text-rose-300/80">
                      Note from {lv.decidedByName ?? "the decider"}: “{lv.decisionNote}”
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_CHIP[lv.status]}`}
                  >
                    {lv.status}
                  </span>
                  {lv.decidedByName && (
                    <p className="mt-0.5 text-[10px] text-slate-600">by {lv.decidedByName}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
