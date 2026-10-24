/**
 * HCM Lite — Safe Mock Assistant (M8, T3.6 fail-soft path)
 * ---------------------------------------------------------------------------
 * A deterministic, rule-based assistant used when (a) no GEMINI_API_KEY /
 * AI_API_KEY is configured, or (b) the Gemini call failed / timed out.
 * It routes through the SAME tool executor, permission matrix and audit log
 * as the real model, so behaviour and refusals are identical. It never
 * reveals more than the tools return.
 */

import { SALARY_REFUSAL } from "./permissions";
import { NO_POLICY_ANSWER } from "./policy";
import { formatDateLabel } from "./hcmData";
import { parseLeaveRequest, withQuotaWarning, type LeaveSuggestion } from "./leaveParser";
import { executeTool } from "./tools";
import type { SessionUser, ToolResult } from "./types";

export interface MockReply {
  reply: string;
  toolsUsed: { name: string; status: string }[];
  refused: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function nameInText(text: string): string | null {
  // A capitalized word sequence that is likely a person name (heuristic).
  const m = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)('?s)?\b/.exec(
    text.replace(/^(what|who|how|is|tell me about|show)(\s|$)/gi, ""),
  );
  return m ? m[1] : null;
}

function looksLikeSalaryQuestion(text: string): boolean {
  return /\b(salary|salaries|pay|paid|payment|wage|wages|earn|earns|earning|earnings|compensation|income|ctc|package)\b/.test(
    text,
  );
}

function looksLikeInjection(text: string): boolean {
  return (
    /\b(ignore|disregard|forget|override|bypass|drop)\b[^.?!]*\b(rules?|instructions?|polic(?:y|ies)|constraints?|restrictions?|prompts?)\b/.test(
      text,
    ) ||
    /\b(system\s*prompt|developer\s*mode|god\s*mode|admin\s*mode|pretend|roleplay|jailbreak|dan\s*mode)\b/.test(
      text,
    ) ||
    /\b(show|give|list|reveal|display)\b[^.?!]*\b(all\s+)?(salaries|salary\s*(list|data|info|information)|everyones?\s+salary)\b/.test(
      text,
    )
  );
}

function isSelfSalary(text: string): boolean {
  return /\b(my|mine|my own)\b/.test(text) && looksLikeSalaryQuestion(text);
}

function toolLine(r: ToolResult): { name: string; status: string } {
  return { name: r.meta.tool, status: r.status };
}

function formatLeaveBalance(r: ToolResult): string {
  const d = r.data as {
    name: string;
    year: number;
    balances: { type: string; entitlement: number; used: number; pending: number; remaining: number }[];
  };
  const row = (t: string) => d.balances.find((b) => b.type === t)!;
  const lines = d.balances.map(
    (b) =>
      `• ${b.type.charAt(0).toUpperCase() + b.type.slice(1)}: ${b.remaining} of ${b.entitlement} days remaining (${b.used} used)`,
  );
  const sick = row("sick");
  const pendingNote = d.balances.some((b) => b.pending > 0)
    ? `\n\nNote: pending applications are NOT deducted — e.g. you have ${sick.pending} sick day(s) awaiting approval, and your remaining sick balance stays ${sick.remaining} days until HR approves them.`
    : "";
  return `Here is your leave balance for ${d.year}, ${d.name}:\n${lines.join("\n")}${pendingNote}`;
}

function formatHeadcount(r: ToolResult, dept: string | undefined): string {
  const d = r.data as {
    dept: string;
    totalHeadcount: number;
    active: number;
    onProbation: number;
    resigned: number;
    byDept?: { dept: string; active: number; total: number }[];
  };
  const scope = dept ? `the ${d.dept} department` : "the whole organization";
  let out = `There ${d.active === 1 ? "is" : "are"} ${d.active} active employee${d.active === 1 ? "" : "s"} in ${scope} (total headcount ${d.totalHeadcount}`;
  if (d.onProbation) out += `, ${d.onProbation} on probation`;
  if (d.resigned) out += `, ${d.resigned} resigned`;
  out += ").";
  if (d.byDept) {
    out += `\n\nBy department: ${d.byDept.map((b) => `${b.dept} ${b.active}`).join(", ")}.`;
  }
  return out;
}

function formatAttendance(r: ToolResult): string {
  const d = r.data as {
    period: string;
    workingDayRecords: number;
    present: number;
    late: number;
    absent: number;
    onLeave: number;
    attendanceRatePct: number;
  };
  return `The attendance rate for ${d.period} is ${d.attendanceRatePct}%.\nAcross ${d.workingDayRecords} working-day records: ${d.present} present, ${d.late} late arrivals, ${d.absent} absent and ${d.onLeave} on approved leave. Authorised leave does not count against the rate.`;
}

function formatLatecomers(r: ToolResult): string {
  const d = r.data as {
    period: string;
    ranking: {
      rank: number;
      name: string;
      dept: string;
      lateCount: number;
      totalMinutesLate: number;
    }[];
  };
  if (!d.ranking.length) {
    return `Good news — no late arrivals were recorded in ${d.period}.`;
  }
  const lines = d.ranking
    .map(
      (row) =>
        `${row.rank}. ${row.name} (${row.dept}) — late ${row.lateCount} time${row.lateCount === 1 ? "" : "s"}, ${row.totalMinutesLate} minutes total`,
    )
    .join("\n");
  const top = d.ranking[0];
  return `Latecomer ranking for ${d.period}:\n${lines}\n\nMost often late: ${top.name}, with ${top.lateCount} late arrival${top.lateCount === 1 ? "" : "s"}.`;
}

function formatLeaveSummary(r: ToolResult): string {
  const d = r.data as {
    period: string;
    byType: { type: string; approved: number; pending: number; rejected: number; days: number }[];
    pendingCases: { name: string; type: string; start: string; end: string; days: number }[];
  };
  const lines = d.byType.map(
    (t) =>
      `• ${t.type}: ${t.approved} approved (${t.days} days), ${t.pending} pending, ${t.rejected} rejected`,
  );
  let out = `Leave summary for ${d.period}:\n${lines.join("\n")}`;
  if (d.pendingCases.length) {
    out += `\n\nPending applications: ${d.pendingCases
      .map((p) => `${p.name} (${p.type}, ${p.start} → ${p.end}, ${p.days} day${p.days === 1 ? "" : "s"})`)
      .join("; ")}.`;
  }
  return out;
}

function formatPayroll(r: ToolResult): string {
  const d = r.data as {
    period: string;
    activeEmployees: number;
    totalGrossPkr: number;
    averageGrossPkr: number;
    byDept: { dept: string; employees: number; totalGrossPkr: number }[];
  };
  return `Aggregate payroll for ${d.period} (Admin/HR view):\n• Total gross: PKR ${fmt(d.totalGrossPkr)} for ${d.activeEmployees} active employees\n• Average gross: PKR ${fmt(d.averageGrossPkr)}\n• By department: ${d.byDept
    .map((b) => `${b.dept} PKR ${fmt(b.totalGrossPkr)}`)
    .join(", ")}\n\nIndividual salaries are never disclosed by this assistant.`;
}

function formatDirectory(r: ToolResult): string {
  const d = r.data as {
    query: string;
    count: number;
    matches: { name: string; designation: string; dept: string; status: string; email: string }[];
  };
  if (!d.count) {
    return `I could not find anyone matching "${d.query}" in the directory. Try a name, designation or department.`;
  }
  const lines = d.matches
    .map((m) => `• ${m.name} — ${m.designation}, ${m.dept} (${m.status}) — ${m.email}`)
    .join("\n");
  return `Found ${d.count} match${d.count === 1 ? "" : "es"} for "${d.query}":\n${lines}\n\n(Directory listings never include salary or bank details.)`;
}

function formatSuggestionText(s: LeaveSuggestion): string {
  return `${s.type.charAt(0).toUpperCase() + s.type.slice(1)} leave, ${formatDateLabel(s.start)} → ${formatDateLabel(s.end)} (${s.days} working-window day${s.days === 1 ? "" : "s"}), reason: "${s.reason}".`;
}

const CAPABILITIES = `I can help you with:
• Headcount — "How many active employees are in Engineering?"
• Attendance — "What is this month's attendance rate?"
• Latecomers — "Who came late most often this month?"
• Leave — "How many sick leaves do I have left this year?" (your own balance)
• Employee directory — "Find Ayesha" (no salary or bank details, ever)
• Payroll aggregates (Admin/HR only) — "What is the total payroll cost this month?"
• Smart leave — describe your leave in the Smart Leave card and I'll pre-fill it for your confirmation.`;

export function mockAssistantReply(
  message: string,
  session: SessionUser,
): MockReply {
  const text = message.trim();
  const lower = text.toLowerCase();
  const toolsUsed: { name: string; status: string }[] = [];

  // ---- 1. Injection / rule-override attempts (AT-08) -----------------------
  if (looksLikeInjection(lower)) {
    return {
      reply:
        "I can't do that — my operating rules are fixed and I won't bypass them for anyone. Salary information is never available through this assistant, whatever the wording of the request. If you need payroll insight, Admin and HR can view aggregate reports, and individual payslips live in the HR portal.",
      toolsUsed,
      refused: true,
    };
  }

  // ---- 2. Salary questions (AT-05) -----------------------------------------
  if (looksLikeSalaryQuestion(lower)) {
    if (
      /\b(payroll|total|cost|spend|spending|budget|bill)\b/.test(lower) &&
      session.role !== "Employee"
    ) {
      const r = executeTool("get_payroll_summary", {}, session);
      toolsUsed.push(toolLine(r));
      if (r.status === "ok") return { reply: formatPayroll(r), toolsUsed, refused: false };
      return { reply: r.message ?? "I could not load payroll aggregates right now.", toolsUsed, refused: false };
    }
    if (isSelfSalary(lower)) {
      return {
        reply:
          "I am not able to disclose salary figures through this assistant, including your own. Your payslip is available in the HR portal, or you can ask HR directly.",
        toolsUsed,
        refused: true,
      };
    }
    return { reply: SALARY_REFUSAL, toolsUsed, refused: true };
  }

  // ---- 3. Own leave balance (AT-04) -----------------------------------------
  if (
    /\b(do i have|left|remaining|balance|entitle|available)\b/.test(lower) &&
    /\b(leave|leaves|off|days?)\b/.test(lower) &&
    /\b(i|my|me)\b/.test(lower)
  ) {
    const r = executeTool("get_my_leave_balance", {}, session);
    toolsUsed.push(toolLine(r));
    if (r.status === "ok") {
      return { reply: formatLeaveBalance(r), toolsUsed, refused: false };
    }
    return { reply: r.message ?? "I could not load your leave balance.", toolsUsed, refused: false };
  }

  // ---- 4. Leave application intent inside chat (AT-06 conversational) -------
  if (
    /\b(off|leave|away|out of office|ooo)\b/.test(lower) &&
    /\b(i|me|my|need|want|take|taking|apply|request)\b/.test(lower)
  ) {
    const suggestion = withQuotaWarning(parseLeaveRequest(text), session.userId);
    if (!suggestion.fatal && suggestion.start) {
      return {
        reply: `Here is what I understood: ${formatSuggestionText(suggestion)}${
          suggestion.warnings.length
            ? `\n\nPlease note: ${suggestion.warnings.join(" ")}`
            : ""
        }\n\nI won't submit anything by myself — open the Smart Leave card, where this is pre-filled, and press "Confirm & Submit" to send it to HR.`,
        toolsUsed,
        refused: false,
      };
    }
  }

  // ---- 5. Latecomers ---------------------------------------------------------
  if (/\b(late|latecomer|latecomers|late arrival|arrived late|coming late|last to arrive)\b/.test(lower)) {
    const dept = /engineering/.test(lower) ? "Engineering" : /sales/.test(lower) ? "Sales" : /hr\b|human resources/.test(lower) ? "HR" : undefined;
    const period = /\blast month\b/.test(lower)
      ? "last month"
      : /\b(march)\b/.test(lower)
        ? "March"
        : "this month";
    const r = executeTool("get_late_comers", { dept, period, limit: 5 }, session);
    toolsUsed.push(toolLine(r));
    if (r.status === "ok") return { reply: formatLatecomers(r), toolsUsed, refused: false };
    return { reply: r.message ?? "I could not load latecomer statistics.", toolsUsed, refused: false };
  }

  // ---- 6. Attendance rate / summary ------------------------------------------
  if (/\b(attendance|present|absent|absence|presentee)\b/.test(lower)) {
    const dept = /engineering/.test(lower) ? "Engineering" : /sales/.test(lower) ? "Sales" : /hr\b|human resources/.test(lower) ? "HR" : undefined;
    const period = /\blast month\b/.test(lower) ? "last month" : "this month";
    const r = executeTool("get_attendance_summary", { dept, period }, session);
    toolsUsed.push(toolLine(r));
    if (r.status === "ok") return { reply: formatAttendance(r), toolsUsed, refused: false };
    return { reply: r.message ?? "I could not load attendance statistics.", toolsUsed, refused: false };
  }

  // ---- 7. Headcount -----------------------------------------------------------
  if (/\b(headcount|how many (active )?(employees|people|staff|engineers?|developers?)|who (works|is working)|team size|workforce)\b/.test(lower)) {
    const dept = /engineering/.test(lower) ? "Engineering" : /sales/.test(lower) ? "Sales" : /hr\b|human resources/.test(lower) ? "HR" : undefined;
    const r = executeTool("get_headcount", { dept }, session);
    toolsUsed.push(toolLine(r));
    if (r.status === "ok") return { reply: formatHeadcount(r, dept), toolsUsed, refused: false };
    return { reply: r.message ?? "I could not load headcount.", toolsUsed, refused: false };
  }

  // ---- 8. Leave summary (org-wide, Admin/HR) -----------------------------------
  if (/\b(leave|leaves)\b/.test(lower) && !/\b(my|mine|do i have|i have left)\b/.test(lower)) {
    const dept = /engineering/.test(lower) ? "Engineering" : /sales/.test(lower) ? "Sales" : /hr\b|human resources/.test(lower) ? "HR" : undefined;
    const type = /\bsick\b/.test(lower) ? "sick" : /\bannual\b/.test(lower) ? "annual" : /\bcasual\b/.test(lower) ? "casual" : undefined;
    const r = executeTool("get_leave_summary", { dept, period: "this month", type }, session);
    toolsUsed.push(toolLine(r));
    if (r.status === "ok") return { reply: formatLeaveSummary(r), toolsUsed, refused: false };
    return { reply: r.message ?? "I could not load the leave summary.", toolsUsed, refused: false };
  }

  // ---- 9. Employee directory ----------------------------------------------------
  if (/\b(who is|who's|find|search|directory|contact|colleague|profile of)\b/.test(lower)) {
    const q = nameInText(text.replace(/\b(who is|who's|find|search|contact|profile of|tell me about)\b/gi, "").trim()) ?? "";
    if (q) {
      const r = executeTool("search_employees", { query: q, limit: 5 }, session);
      toolsUsed.push(toolLine(r));
      if (r.status === "ok") return { reply: formatDirectory(r), toolsUsed, refused: false };
      return { reply: r.message ?? "I could not search the directory.", toolsUsed, refused: false };
    }
  }

  // ---- 10. Policy questions (AT-09) ---------------------------------------------
  if (/\b(policy|entitlement|allowed|allowed to|per year|per annum|how many days|maternity|paternity|probation|notice period|work from home|remote work|overtime|bonus|gratuity|dress code)\b/.test(lower)) {
    const covered =
      /\b(annual|sick|casual)\b.*\b(leave|leaves|days?)\b/.test(lower) ||
      /\b(leave|leaves)\b.*\b(annual|sick|casual)\b/.test(lower) ||
      /\b(weekend|shift|late|payroll|salary disclosure|directory|pending)\b/.test(lower);
    if (covered) {
      return {
        reply:
          "Per company policy: Annual leave 14 days, Sick leave 8 days and Casual leave 10 days per year. Approved leave is deducted from your balance while pending applications are not. The work week is Monday–Friday with a 09:00 PKT shift start (15-minute grace). Anything else you'd like me to check?",
        toolsUsed,
        refused: false,
      };
    }
    return { reply: NO_POLICY_ANSWER, toolsUsed, refused: true };
  }

  // ---- 11. Greetings & fallback ---------------------------------------------------
  if (/^(hi|hello|hey|salam|assalam|good (morning|afternoon|evening))\b/.test(lower)) {
    return {
      reply: `Hello ${session.name.split(" ")[0]}! You're signed in as ${session.role}. ${CAPABILITIES}`,
      toolsUsed,
      refused: false,
    };
  }

  return {
    reply: `I'm not sure how to help with that. ${CAPABILITIES}`,
    toolsUsed,
    refused: false,
  };
}
