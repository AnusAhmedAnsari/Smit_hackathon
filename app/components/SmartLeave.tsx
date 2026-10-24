"use client";

/**
 * Smart Leave Application (T8.5) — "Describe your leave in plain words".
 * The AI only SUGGESTS ({ ai_suggested: true }); the application is created
 * ONLY when the human presses "Confirm & Submit" (Constitution §4). A manual
 * form is always available as the fail-soft path.
 */

import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  Pencil,
  Plane,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import type { Role } from "@/lib/types";

interface Suggestion {
  type: string;
  start: string;
  end: string;
  days: number;
  reason: string;
}

const TYPE_STYLES: Record<string, string> = {
  annual: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  sick: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  casual: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
};

const fmt = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export default function SmartLeave({
  sessionEmail,
  role,
  onSubmitted,
}: {
  sessionEmail: string;
  role: Role;
  onSubmitted: () => void;
}) {
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [engine, setEngine] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [manualForm, setManualForm] = useState({
    type: "casual",
    start: "",
    end: "",
    reason: "",
  });
  const [submitting, setSubmitting] = useState(false);

  async function suggest() {
    const text = description.trim();
    if (text.length < 3) {
      toast.error("Describe your leave in a few words first.");
      return;
    }
    setLoading(true);
    setSuggestion(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/ai/smart-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-email": sessionEmail },
        body: JSON.stringify({ message: text }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? "The Smart Leave assistant is unavailable.");
        return;
      }
      if (body.fallback_to_manual) {
        setManual(true);
        setManualForm((f) => ({
          ...f,
          type: body.partial?.type ?? "casual",
          reason: body.partial?.reason ?? "",
        }));
        toast(body.message ?? "Please fill the manual form.");
        return;
      }
      setSuggestion(body.suggestion);
      setWarnings(body.warnings ?? []);
      setEngine(body.engine ?? null);
      toast.success("AI prepared your leave for confirmation.");
    } catch {
      toast.error("Network error while contacting the Smart Leave assistant.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(payload: {
    type: string;
    start: string;
    end: string;
    reason: string;
    ai_suggested: boolean;
  }) {
    setSubmitting(true);
    try {
      const res = await fetch("/api/leaves", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-email": sessionEmail },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? "Could not submit the application.");
        return;
      }
      toast.success(body.message);
      setSuggestion(null);
      setDescription("");
      setManual(false);
      setManualForm({ type: "casual", start: "", end: "", reason: "" });
      onSubmitted();
    } catch {
      toast.error("Network error while submitting.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* describe panel */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
        <div className="flex items-center gap-2">
          <Plane className="h-5 w-5 text-emerald-300" />
          <h2 className="text-sm font-semibold text-slate-100">Smart leave application</h2>
          {role !== "Employee" && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
              Employee-only flow
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Describe your leave in plain words — the AI drafts it, you confirm it. Nothing is
          submitted without your explicit confirmation.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={400}
          placeholder="e.g. I need next Monday and Tuesday off for my sister's wedding"
          className="mt-3 w-full resize-none rounded-xl border border-slate-700 bg-slate-950/70 px-3.5 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
        />
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11px] text-slate-500">
            Try: “next Monday and Tuesday for my sister&apos;s wedding”
          </p>
          <button
            onClick={suggest}
            disabled={loading || role !== "Employee"}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Suggest with AI
          </button>
        </div>
      </div>

      {/* suggestion / manual panel */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-slate-300" />
            <h2 className="text-sm font-semibold text-slate-100">Confirmation</h2>
          </div>
          {!manual && (
            <button
              onClick={() => setManual((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-slate-500"
            >
              <Pencil className="h-3.5 w-3.5" /> Fill manually
            </button>
          )}
        </div>

        {manual && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <select
                value={manualForm.type}
                onChange={(e) => setManualForm((f) => ({ ...f, type: e.target.value }))}
                className="rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              >
                <option value="annual">Annual</option>
                <option value="sick">Sick</option>
                <option value="casual">Casual</option>
              </select>
              <input
                type="date"
                value={manualForm.start}
                onChange={(e) => setManualForm((f) => ({ ...f, start: e.target.value }))}
                className="rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
              <input
                type="date"
                value={manualForm.end}
                onChange={(e) => setManualForm((f) => ({ ...f, end: e.target.value }))}
                className="rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <input
              value={manualForm.reason}
              onChange={(e) => setManualForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="Reason (required)"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              onClick={() =>
                submit({
                  type: manualForm.type,
                  start: manualForm.start,
                  end: manualForm.end || manualForm.start,
                  reason: manualForm.reason,
                  ai_suggested: false,
                })
              }
              disabled={submitting || !manualForm.start || manualForm.reason.trim().length < 3}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Confirm & Submit
            </button>
          </div>
        )}

        {!manual && !suggestion && (
          <p className="mt-4 text-sm text-slate-400">
            {role !== "Employee"
              ? "Smart Leave drafts applications for employees. As Admin/HR you review pending applications from the records."
              : "Your AI-drafted application will appear here with an AI-suggested marker before anything is submitted."}
          </p>
        )}

        {!manual && suggestion && (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${TYPE_STYLES[suggestion.type] ?? ""}`}
                >
                  {suggestion.type} leave
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
                  <Sparkles className="h-3 w-3" /> AI-suggested{engine === "gemini" ? " · Gemini" : ""}
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-100">
                {fmt(suggestion.start)} → {fmt(suggestion.end)}
              </p>
              <p className="text-xs text-slate-400">
                {suggestion.days} calendar day{suggestion.days === 1 ? "" : "s"} (working days are
                counted by HR at approval)
              </p>
              <p className="mt-2 text-sm text-slate-300">
                <span className="text-slate-500">Reason:</span> {suggestion.reason}
              </p>
            </div>
            {warnings.length > 0 && (
              <ul className="space-y-1.5">
                {warnings.map((w, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() =>
                submit({
                  type: suggestion.type,
                  start: suggestion.start,
                  end: suggestion.end,
                  reason: suggestion.reason,
                  ai_suggested: true,
                })
              }
              disabled={submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Confirm & Submit
            </button>
            <p className="text-center text-[11px] text-slate-500">
              Submitting sends the application to HR as <strong>pending</strong> — the AI never
              writes on its own.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
