/**
 * M8 · POST /api/ai/dashboard-summary — executive insight bullets (T5.2)
 * ---------------------------------------------------------------------------
 * Admin/HR only (403 for Employee). Builds a KPI snapshot from the shared
 * services, asks Gemini for 3–5 concise bullets (or composes them locally
 * when no key is configured), then runs the MANDATORY post-generation number
 * check: every numeric token in every bullet must exist in the KPI input.
 * Bullets containing unverifiable numbers are dropped; the list is topped up
 * with deterministic bullets so the UI always shows 3–5 insights.
 */

import { logAiRequest } from "@/lib/aiLogs";
import { hasGeminiKey, getApiKey, GEMINI_MODEL } from "@/lib/aiGateway";
import { getSession, unauthorized } from "@/lib/session";
import {
  getAttendanceSummaryService,
  getDashboardKpisService,
  getLateComersService,
  getPendingLeaveApplicationsService,
  getPayrollSummaryService,
} from "@/lib/services";
import type { SessionUser } from "@/lib/types";
import { z } from "zod";

const bodySchema = z.object({}).passthrough().optional();

/* ------------------------- KPI snapshot ----------------------------------- */

interface KpiSnapshot {
  month: string;
  asOf: string;
  asOfLabel: string;
  activeEmployees: number;
  totalEmployees: number;
  presentToday: number;
  lateToday: number;
  onLeaveToday: number;
  attendanceRatePct: number;
  presentRecords: number;
  lateRecords: number;
  absentRecords: number;
  onLeaveRecords: number;
  workingDayRecords: number;
  totalGrossPkr?: number;
  averageGrossPkr?: number;
  payrollByDept?: { dept: string; totalGrossPkr: number; employees: number }[];
  pendingLeaveApplications: number;
  topLatecomer?: { name: string; lateCount: number; period: string };
}

function buildKpiSnapshot(session: SessionUser): KpiSnapshot {
  const kpis = getDashboardKpisService({ includePayroll: true, userId: session.userId });
  const attendance = getAttendanceSummaryService(undefined, "this month");
  const pending = getPendingLeaveApplicationsService();
  const payroll = getPayrollSummaryService();
  const late = getLateComersService(undefined, "this month", 1);

  const snap: KpiSnapshot = {
    month: kpis.monthLabel,
    asOf: kpis.asOfDate,
    asOfLabel: kpis.asOfLabel,
    activeEmployees: kpis.headcount.active,
    totalEmployees: kpis.headcount.total,
    presentToday: kpis.today.present,
    lateToday: kpis.today.late,
    onLeaveToday: kpis.today.onLeave,
    attendanceRatePct: kpis.attendanceRatePct,
    presentRecords: attendance.status === "ok" ? attendance.data.present : 0,
    lateRecords: attendance.status === "ok" ? attendance.data.late : 0,
    absentRecords: attendance.status === "ok" ? attendance.data.absent : 0,
    onLeaveRecords: attendance.status === "ok" ? attendance.data.onLeave : 0,
    workingDayRecords: attendance.status === "ok" ? attendance.data.workingDayRecords : 0,
    pendingLeaveApplications: pending.length,
  };
  if (payroll.status === "ok") {
    snap.totalGrossPkr = payroll.data.totalGrossPkr;
    snap.averageGrossPkr = payroll.data.averageGrossPkr;
    snap.payrollByDept = payroll.data.byDept.map((d) => ({
      dept: d.dept,
      totalGrossPkr: d.totalGrossPkr,
      employees: d.employees,
    }));
  }
  if (late.status === "ok" && late.data.ranking.length) {
    snap.topLatecomer = {
      name: late.data.ranking[0].name,
      lateCount: late.data.ranking[0].lateCount,
      period: late.data.period,
    };
  }
  return snap;
}

/* ----------------- post-generation number verification --------------------- */

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/,/g, "")),
  );
}

function allowedNumbers(snap: KpiSnapshot): Set<number> {
  const allowed = new Set<number>();
  const push = (n: number | undefined) => {
    if (typeof n === "number" && Number.isFinite(n)) {
      allowed.add(n);
      allowed.add(Math.round(n));
      if (Number.isInteger(n)) {
        allowed.add(Number(n.toLocaleString("en-US").replace(/,/g, "")));
      }
    }
  };
  push(snap.activeEmployees); push(snap.totalEmployees);
  push(snap.presentToday); push(snap.lateToday); push(snap.onLeaveToday);
  push(snap.attendanceRatePct);
  push(snap.presentRecords); push(snap.lateRecords); push(snap.absentRecords);
  push(snap.onLeaveRecords); push(snap.workingDayRecords);
  push(snap.totalGrossPkr); push(snap.averageGrossPkr);
  push(snap.pendingLeaveApplications);
  snap.payrollByDept?.forEach((d) => { push(d.totalGrossPkr); push(d.employees); });
  if (snap.topLatecomer) push(snap.topLatecomer.lateCount);
  // Calendar tokens that legitimately appear (dates, month indexes, small
  // ordinals like "top 3" / list positions).
  for (let i = 0; i <= 31; i++) push(i);
  push(2026); push(2025); push(100);
  return allowed;
}

function bulletPassesNumberCheck(bullet: string, allowed: Set<number>): boolean {
  return numbersIn(bullet).every((n) => allowed.has(n));
}

/* ------------------------- deterministic bullets --------------------------- */

function deterministicBullets(snap: KpiSnapshot): string[] {
  const out: string[] = [];
  const pk = (n: number) => `PKR ${n.toLocaleString("en-US")}`;
  out.push(
    `${snap.month}: attendance rate is ${snap.attendanceRatePct}% across ${snap.workingDayRecords} working-day records (${snap.presentRecords} present, ${snap.lateRecords} late, ${snap.absentRecords} absent, ${snap.onLeaveRecords} on leave).`,
  );
  if (snap.totalGrossPkr !== undefined) {
    out.push(
      `Payroll cost is ${pk(snap.totalGrossPkr)} for ${snap.activeEmployees} active employees (average ${pk(snap.averageGrossPkr ?? 0)}).`,
    );
    if (snap.payrollByDept?.length) {
      const top = snap.payrollByDept[0];
      out.push(`${top.dept} accounts for ${pk(top.totalGrossPkr)} across ${top.employees} employees — the largest payroll share.`);
    }
  }
  if (snap.topLatecomer) {
    out.push(
      `${snap.topLatecomer.name} is the most frequent latecomer in ${snap.topLatecomer.period} with ${snap.topLatecomer.lateCount} late arrivals — worth a check-in.`,
    );
  }
  out.push(
    `As of ${snap.asOfLabel}: ${snap.presentToday} present, ${snap.lateToday} late and ${snap.onLeaveToday} on approved leave; ${snap.pendingLeaveApplications} leave application(s) await HR approval.`,
  );
  return out;
}

/* ------------------------------ Gemini path -------------------------------- */

async function geminiBullets(
  snap: KpiSnapshot,
): Promise<string[] | null> {
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(getApiKey()!);
    const model = genAI.getGenerativeModel(
      {
        model: GEMINI_MODEL,
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
        systemInstruction:
          "You are an HCM analyst. Reply with STRICT JSON only: {\"insights\": [\"...\", ...]}. " +
          "3 to 5 short bullets (max 30 words each) for an executive dashboard. " +
          "Use ONLY the numbers provided in the user message — do not invent, round, or derive any other number. Do not add ranking numbers.",
      },
      { timeout: 15_000 },
    );
    const res = await model.generateContent(
      `KPI snapshot (single source of truth):\n${JSON.stringify(snap, null, 2)}\n\nWrite 3–5 dashboard insight bullets using only these numbers.`,
    );
    const text = res.response.text() ?? "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { insights?: unknown };
    if (!Array.isArray(parsed.insights)) return null;
    return parsed.insights
      .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
      .map((i) => i.trim())
      .slice(0, 5);
  } catch {
    return null;
  }
}

/* --------------------------------- route ----------------------------------- */

export async function POST(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  const t0 = Date.now();
  if (session.role === "Employee") {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "dashboard_summary",
      toolName: null,
      toolStatus: "forbidden",
      outcome: "dashboard summary refused for Employee role",
      latencyMs: Date.now() - t0,
    });
    return Response.json(
      {
        error:
          "AI dashboard summaries are available to Admin and HR only. You can still use the assistant for your own leave balance and the employee directory.",
      },
      { status: 403 },
    );
  }

  await bodySchema.parseAsync(await req.json().catch(() => ({}))).catch(() => ({}));
  const snap = buildKpiSnapshot(session);
  const allowed = allowedNumbers(snap);

  const insights: string[] = [];
  let engine: "gemini" | "mock" = "mock";

  if (hasGeminiKey()) {
    const aiBullets = await geminiBullets(snap);
    if (aiBullets && aiBullets.length) {
      const verified = aiBullets.filter((b) => bulletPassesNumberCheck(b, allowed));
      if (verified.length < aiBullets.length) {
        logAiRequest({
          userId: session.userId,
          role: session.role,
          feature: "dashboard_summary",
          toolName: null,
          toolStatus: "ok",
          outcome: `number check dropped ${aiBullets.length - verified.length} bullet(s) with unverifiable numbers`,
          latencyMs: Date.now() - t0,
        });
      }
      if (verified.length) {
        insights.push(...verified.slice(0, 5));
        engine = "gemini";
      }
    }
  }
  if (insights.length < 3) {
    for (const b of deterministicBullets(snap)) {
      if (insights.length >= 5) break;
      if (!insights.includes(b)) insights.push(b);
    }
  }

  logAiRequest({
    userId: session.userId,
    role: session.role,
    feature: "dashboard_summary",
    toolName: null,
    toolStatus: "ok",
    outcome: `dashboard summary (${engine}): ${insights.length} verified bullets`,
    latencyMs: Date.now() - t0,
  });

  return Response.json({
    insights,
    ai_generated: true,
    engine,
    generated_at: new Date().toISOString(),
    kpi_snapshot: snap,
  });
}
