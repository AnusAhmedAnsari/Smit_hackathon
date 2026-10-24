"use client";

/**
 * Active Session Switcher — demo seat picker for judges.
 * NOTE: this only asks the server WHICH seat is active; the server resolves
 * the role itself from its own registry (x-user-email → lib/session.ts).
 */

import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface DemoSeat {
  email: string;
  name: string;
  role: "Admin" | "HR" | "Employee";
  dept: string;
}

export const DEMO_SEATS: DemoSeat[] = [
  {
    email: "admin@saylani.com",
    name: "Sikandar Hayat",
    role: "Admin",
    dept: "Executive · All departments",
  },
  {
    email: "hr@saylani.com",
    name: "Nadia Hussain",
    role: "HR",
    dept: "HR · All departments",
  },
  {
    email: "taha@saylani.com",
    name: "Taha Siddiqui",
    role: "Employee",
    dept: "Engineering · Self service",
  },
];

const ROLE_STYLES: Record<DemoSeat["role"], string> = {
  Admin: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  HR: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  Employee: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

export function RoleChip({ role, className = "" }: { role: DemoSeat["role"]; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${ROLE_STYLES[role]} ${className}`}
    >
      {role}
    </span>
  );
}

export default function SessionSwitcher({
  activeEmail,
  onSelect,
}: {
  activeEmail: string;
  onSelect: (email: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = DEMO_SEATS.find((s) => s.email === activeEmail) ?? DEMO_SEATS[0];

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-3 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 text-left transition hover:border-slate-500"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-sm font-semibold text-indigo-300">
          {active.name.split(" ").map((p) => p[0]).join("")}
        </span>
        <span className="hidden sm:block">
          <span className="block text-sm font-medium text-slate-100">{active.name}</span>
          <span className="block text-xs text-slate-400">{active.email}</span>
        </span>
        <RoleChip role={active.role} />
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50"
          role="listbox"
        >
          <p className="border-b border-slate-800 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Active session (role is resolved server-side)
          </p>
          {DEMO_SEATS.map((seat) => (
            <button
              key={seat.email}
              role="option"
              aria-selected={seat.email === activeEmail}
              onClick={() => {
                onSelect(seat.email);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-800/70 ${
                seat.email === activeEmail ? "bg-slate-800/50" : ""
              }`}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20 text-sm font-semibold text-indigo-300">
                {seat.name.split(" ").map((p) => p[0]).join("")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-100">{seat.name}</span>
                  <RoleChip role={seat.role} />
                </span>
                <span className="block truncate text-xs text-slate-400">{seat.email}</span>
                <span className="block text-[11px] text-slate-500">{seat.dept}</span>
              </span>
              {seat.email === activeEmail && (
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
              )}
            </button>
          ))}
          <p className="flex items-center gap-2 border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5" />
            Permissions are enforced by the server, never by this UI.
          </p>
        </div>
      )}
    </div>
  );
}
