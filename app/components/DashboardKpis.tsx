"use client";

/**
 * Dashboard KPI panel — headcount, present, late, on-leave, payroll cost,
 * plus the Admin/HR-only "Summarize with AI" insight panel (with the
 * mandatory AI-generated badge). Data comes from /api/dashboard, which reads
 * the SAME services the AI tools use — numbers always match (AT-01/AT-03).
 */

import { Loader2, Lock, Sparkles, TrendingUp, Users, UserCheck, AlarmClock, CalendarX2, Wallet } from "lucide-react";
import { useCallback, useState } from "react";
import toast from "react-hot-toast";
import type { Role } from "@/lib/types";

export interface Kpis {
  asOfDate: string;
  asOfLabel: string;
  headcount: { active: number; total: number };
  today: { present: number; late: number; onLeave: number };
  attendanceRatePct: number;
  monthLabel: string;
  payroll?: { totalGrossPkr: number; activeEmployees: number };
  myLeaveBalance?: {
    balances: { type: string; entitlement: number; used: number; pending: number; remaining: number }[];
  };
}

const pkr = (n: number) => `PKR ${n.toLocaleString("en-US")}`;

export default function DashboardKpis({
  kpis,
  role,
  sessionEmail,
}: {
  kpis: Kpis | null;
  role: Role;
  sessionEmail: string;
}) {
  const [insights, setInsights] = useState<string[]>([]);
  const [insightMeta, setInsightMeta] = useState<{ engine: string; at: string } | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const canSeePayroll = role !== "Employee";
  const canSummarize = role !== "Employee";

  const summarize = useCallback(async () => {
    setLoadingInsights(true);
    setInsights([]);
    try {
      const res = await fetch("/api/ai/dashboard-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-email": sessionEmail },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? "The AI summary is unavailable right now.");
        return;
      }
      setInsights(body.insights ?? []);
      setInsightMeta({ engine: body.engine, at: new Date(body.generated_at).toLocaleTimeString() });
    } catch {
      toast.error("Network error while summarizing.");
    } finally {
      setLoadingInsights(false);
    }
  }, [sessionEmail]);

  if (!kpis) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/60" />
        ))}
      </div>
    );
  }

  const cards = [
    {
      icon: Users,
      label: "Headcount",
      value: `${kpis.headcount.active}`,
      sub: `active of ${kpis.headcount.total} total`,
      tone: "text-indigo-300 bg-indigo-500/15",
    },
    {
      icon: UserCheck,
      label: "Present",
      value: `${kpis.today.present}`,
      sub: kpis.asOfLabel,
      tone: "text-emerald-300 bg-emerald-500/15",
    },
    {
      icon: AlarmClock,
      label: "Late",
      value: `${kpis.today.late}`,
      sub: kpis.asOfLabel,
      tone: "text-amber-300 bg-amber-500/15",
    },
    {
      icon: CalendarX2,
      label: "On Leave",
      value: `${kpis.today.onLeave}`,
      sub: kpis.asOfLabel,
      tone: "text-sky-300 bg-sky-500/15",
    },
    canSeePayroll
      ? {
          icon: Wallet,
          label: "Payroll Cost",
          value: pkr(kpis.payroll?.totalGrossPkr ?? 0),
          sub: `monthly gross · ${kpis.payroll?.activeEmployees ?? 0} employees`,
          tone: "text-violet-300 bg-violet-500/15",
        }
      : {
          icon: Lock,
          label: "Payroll Cost",
          value: "••••••",
          sub: "Admin & HR only",
          tone: "text-slate-400 bg-slate-500/15",
        },
  ];

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg shadow-black/20 backdrop-blur"
          >
            <div className="flex items-center justify-between">
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${c.tone}`}>
                <c.icon className="h-5 w-5" />
              </span>
              <span className="text-[11px] uppercase tracking-wider text-slate-500">{c.label}</span>
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-50">{c.value}</p>
            <p className="mt-1 text-xs text-slate-400">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* AI insights */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-indigo-300" />
              <h2 className="text-sm font-semibold text-slate-100">Executive insights</h2>
              {insightMeta && (
                <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
                  <Sparkles className="h-3 w-3" /> AI-generated
                </span>
              )}
            </div>
            {canSummarize ? (
              <button
                onClick={summarize}
                disabled={loadingInsights}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {loadingInsights ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {insightMeta ? "Re-summarize" : "Summarize with AI"}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-400">
                <Lock className="h-3.5 w-3.5" /> Admin & HR only
              </span>
            )}
          </div>

          {loadingInsights && (
            <div className="mt-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-4 w-full animate-pulse rounded bg-slate-800" />
              ))}
            </div>
          )}

          {!loadingInsights && insights.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">
              {canSummarize
                ? "Press “Summarize with AI” to generate 3–5 verified insight bullets from the live KPIs. Every number is checked against the dashboard snapshot before display."
                : "AI summaries are restricted to Admin and HR. Your leave balance is shown on the right."}
            </p>
          )}

          {!loadingInsights && insights.length > 0 && (
            <ul className="mt-4 space-y-2.5">
              {insights.map((b, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-slate-200">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                  {b}
                </li>
              ))}
            </ul>
          )}
          {insightMeta && !loadingInsights && (
            <p className="mt-3 text-[11px] text-slate-500">
              {insightMeta.engine === "gemini" ? "Gemini 1.5 Flash" : "Local rules engine"} · generated{" "}
              {insightMeta.at} · numbers verified against KPI snapshot
            </p>
          )}
        </div>

        {/* Leave balance strip */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <h2 className="text-sm font-semibold text-slate-100">
            {role === "Employee" ? "My leave balance (2026)" : "Leave snapshot"}
          </h2>
          {kpis.myLeaveBalance ? (
            <>
              <div className="mt-4 space-y-3">
                {kpis.myLeaveBalance.balances.map((b) => (
                  <div key={b.type} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm capitalize text-slate-200">{b.type}</p>
                      <p className="text-[11px] text-slate-500">
                        {b.used} used{b.pending > 0 ? ` · ${b.pending} pending (not deducted)` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-slate-50">{b.remaining}</p>
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">of {b.entitlement}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-slate-500">
                Only approved leave is deducted; pending applications are listed separately.
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              Sign in as the Employee seat to see a personal balance, or ask the assistant
              “How many sick leaves do I have left this year?”.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
