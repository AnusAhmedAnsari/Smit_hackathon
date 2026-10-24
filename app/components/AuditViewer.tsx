"use client";

/**
 * Admin Audit Viewer (T8.6) — live inspection of the append-only ai_logs
 * trail: who asked what, which tool ran, its status, latency, and whether
 * redaction scrubbed anything. Admin only; the server enforces it.
 */

import { Loader2, RefreshCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import type { AiLogEntry } from "@/lib/types";

interface LogStats {
  total: number;
  byStatus: Record<string, number>;
  byFeature: Record<string, number>;
  redactedCount: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

const STATUS_CHIP: Record<string, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  forbidden: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  error: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  not_found: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  ambiguous: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  "n/a": "border-slate-600/40 bg-slate-600/10 text-slate-400",
};

export default function AuditViewer({
  open,
  onClose,
  sessionEmail,
}: {
  open: boolean;
  onClose: () => void;
  sessionEmail: string;
}) {
  const [logs, setLogs] = useState<AiLogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [nonce, setNonce] = useState(0);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const loading = open && fetchedFor !== `${sessionEmail}#${nonce}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/ai/logs?limit=120`, {
          headers: { "x-user-email": sessionEmail },
        });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          toast.error(body.error ?? "Could not load the audit log.");
          return;
        }
        setLogs(body.logs ?? []);
        setStats(body.stats ?? null);
      } catch {
        toast.error("Network error while loading the audit log.");
      } finally {
        if (!cancelled) setFetchedFor(`${sessionEmail}#${nonce}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, nonce, sessionEmail]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        className="relative z-10 flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
        role="dialog"
        aria-label="AI audit log"
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/20 text-violet-300">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">AI audit log — live</h2>
              <p className="text-[11px] text-slate-500">
                Append-only · every AI request, tool call, refusal and redaction
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setNonce((n) => n + 1)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
              aria-label="Close audit viewer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        {stats && (
          <div className="grid grid-cols-2 gap-3 border-b border-slate-800 px-5 py-3 sm:grid-cols-5">
            {[
              { label: "Entries", value: stats.total },
              { label: "Avg latency", value: `${stats.avgLatencyMs} ms` },
              { label: "p95 latency", value: `${stats.p95LatencyMs} ms` },
              { label: "Redacted fields", value: stats.redactedCount },
              {
                label: "Forbidden refusals",
                value: stats.byStatus["forbidden"] ?? 0,
              },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">{s.label}</p>
                <p className="text-sm font-semibold text-slate-100">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="sticky top-0 bg-slate-900/95 text-[10px] uppercase tracking-wider text-slate-500 backdrop-blur">
              <tr>
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">User</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-3 py-2.5 font-medium">Feature</th>
                <th className="px-3 py-2.5 font-medium">Tool</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Outcome</th>
                <th className="px-3 py-2.5 text-right font-medium">ms</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-slate-300">
              {logs.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    No AI activity yet — ask the assistant something and refresh.
                  </td>
                </tr>
              )}
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-900/50">
                  <td className="whitespace-nowrap px-4 py-2 text-slate-400">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{log.user_id}</td>
                  <td className="px-3 py-2">{log.role}</td>
                  <td className="px-3 py-2">{log.feature}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-indigo-300">
                    {log.tool_name ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        STATUS_CHIP[log.tool_status] ?? STATUS_CHIP["n/a"]
                      }`}
                    >
                      {log.tool_status}
                    </span>
                  </td>
                  <td className="max-w-md px-3 py-2">
                    <span className="line-clamp-2" title={log.outcome}>
                      {log.outcome}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      {log.redacted && (
                        <ShieldAlert
                          className="h-3.5 w-3.5 text-rose-400"
                          aria-label="Sensitive values redacted"
                        />
                      )}
                      {log.latency_ms}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="border-t border-slate-800 px-5 py-3 text-[11px] text-slate-500">
          <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-rose-400" />
          marks rows where salary/CNIC/bank/credential patterns were scrubbed before storage.
          Employees&apos; payroll refusals appear here as <strong>forbidden</strong> — proof the
          permission matrix held.
        </footer>
      </div>
    </div>
  );
}
