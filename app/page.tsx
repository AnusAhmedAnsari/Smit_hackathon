"use client";

/**
 * HCM Lite — AI Assistant Module (M8) · main page.
 * Header + session switcher, KPI dashboard with AI insights, Smart Leave
 * center, Admin audit modal and the floating AI chat drawer. All AI traffic
 * goes to internal /api/ai/* endpoints only (AT-11).
 */

import { Bot, LayoutDashboard, ShieldCheck, CalendarDays } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import toast, { Toaster } from "react-hot-toast";
import AuditViewer from "./components/AuditViewer";
import ChatDrawer from "./components/ChatDrawer";
import DashboardKpis, { type Kpis } from "./components/DashboardKpis";
import LeaveRecords from "./components/LeaveRecords";
import SessionSwitcher from "./components/SessionSwitcher";
import SmartLeave from "./components/SmartLeave";
import type { Role } from "@/lib/types";

type Tab = "dashboard" | "leave";

export default function Home() {
  const [sessionEmail, setSessionEmail] = useState<string>("admin@saylani.com");
  const [session, setSession] = useState<{
    name: string;
    role: Role;
    dept: string;
    designation: string;
  } | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [chatOpen, setChatOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadDashboard = useCallback(async (email: string) => {
    try {
      const res = await fetch("/api/dashboard", {
        headers: { "x-user-email": email },
      });
      if (!res.ok) {
        toast.error("Could not load the dashboard.");
        return;
      }
      const body = await res.json();
      setKpis(body.kpis);
      setSession({
        name: body.session.name,
        role: body.session.role,
        dept: body.session.dept,
        designation: body.session.designation,
      });
    } catch {
      toast.error("Network error while loading the dashboard.");
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("hcm-active-seat");
    // Deferred so the effect never sets state synchronously (react-hooks rule).
    if (saved && saved !== sessionEmail) {
      queueMicrotask(() => setSessionEmail(saved));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.localStorage.setItem("hcm-active-seat", sessionEmail);
    const t = setTimeout(() => loadDashboard(sessionEmail), 0);
    return () => clearTimeout(t);
  }, [sessionEmail, loadDashboard]);

  const onSelectSeat = (seatEmail: string) => {
    if (seatEmail === sessionEmail) return;
    setSessionEmail(seatEmail);
    setKpis(null);
    setTab("dashboard");
    const role =
      seatEmail === "admin@saylani.com"
        ? "Admin"
        : seatEmail === "hr@saylani.com"
          ? "HR"
          : "Employee";
    toast.success(`Active session: ${role} (${seatEmail})`);
  };

  const isAdmin = session?.role === "Admin";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: "#0f172a",
            color: "#e2e8f0",
            border: "1px solid #1e293b",
            fontSize: "13px",
          },
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
              <Bot className="h-6 w-6" />
            </span>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-slate-50">
                HCM Lite
              </h1>
              <p className="text-[11px] text-slate-500">
                AI Assistant Module · M8 · Saylani Hackathon
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => setAuditOpen(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm font-medium text-violet-300 transition hover:bg-violet-500/20"
              >
                <ShieldCheck className="h-4 w-4" />
                <span className="hidden sm:inline">AI Audit</span>
              </button>
            )}
            <SessionSwitcher activeEmail={sessionEmail} onSelect={onSelectSeat} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {/* scope banner + tabs */}
        {session && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                  session.role === "Admin"
                    ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                    : session.role === "HR"
                      ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                }`}
              >
                {session.role}
              </span>
              <p className="text-sm text-slate-300">
                {session.name} · {session.designation} ·{" "}
                <span className="text-slate-500">
                  {session.role === "Employee"
                    ? "scope: self-service (own leave, sanitized directory)"
                    : "scope: all departments + aggregate payroll"}
                </span>
              </p>
            </div>
            <div className="flex gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1">
              <button
                onClick={() => setTab("dashboard")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                  tab === "dashboard"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <LayoutDashboard className="h-4 w-4" /> Dashboard
              </button>
              <button
                onClick={() => setTab("leave")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                  tab === "leave"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <CalendarDays className="h-4 w-4" /> Leave Center
              </button>
            </div>
          </div>
        )}

        {tab === "dashboard" && (
          <DashboardKpis kpis={kpis} role={session?.role ?? "Admin"} sessionEmail={sessionEmail} />
        )}

        {tab === "leave" && (
          <div className="space-y-4">
            <SmartLeave
              sessionEmail={sessionEmail}
              role={session?.role ?? "Admin"}
              onSubmitted={() => {
                setRefreshKey((k) => k + 1);
                loadDashboard(sessionEmail);
              }}
            />
            <LeaveRecords
              sessionEmail={sessionEmail}
              refreshKey={refreshKey}
              onDataChanged={() => {
                setRefreshKey((k) => k + 1);
                loadDashboard(sessionEmail);
              }}
            />
          </div>
        )}

        {/* module footer */}
        <footer className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-3 text-[11px] text-slate-500">
          <p>
            Constitution: DB is the single source of truth · one permission system · AI never
            writes without human confirmation · polite refusals · fail soft.
          </p>
          <p>
            Provider calls run server-side only; your browser talks exclusively to{" "}
            <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">/api/ai/*</code>.
          </p>
        </footer>
      </main>

      {/* floating chat button */}
      <button
        onClick={() => setChatOpen(true)}
        className="fixed bottom-6 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-2xl shadow-indigo-600/40 transition-colors hover:bg-indigo-500"
        aria-label="Open AI assistant"
      >
        <Bot className="h-7 w-7" />
        <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-slate-950 bg-emerald-500 text-[9px] font-bold text-slate-950">
          AI
        </span>
      </button>

      <ChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        sessionEmail={sessionEmail}
        role={session?.role ?? "Admin"}
        userName={session?.name ?? "Guest"}
      />

      {isAdmin && (
        <AuditViewer
          open={auditOpen}
          onClose={() => setAuditOpen(false)}
          sessionEmail={sessionEmail}
        />
      )}
    </div>
  );
}
