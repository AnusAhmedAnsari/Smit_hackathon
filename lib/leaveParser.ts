/**
 * HCM Lite — Deterministic Leave Parser (M8, T6.x)
 * ---------------------------------------------------------------------------
 * Server-side natural-language → structured leave suggestion. This module is
 * the trustworthy fallback for the Smart Leave endpoint (which prefers Gemini,
 * retries once on malformed JSON, then lands here — fail soft) and the rule
 * engine when no AI key is configured.
 *
 * Relative dates ("next Monday and Tuesday", "tomorrow", "day after tomorrow",
 * "next week") are resolved SERVER-SIDE in the HCM timezone so the client can
 * never skew dates. "next <weekday>" = the next occurrence of that weekday
 * strictly after today.
 */

import { addDaysIso, isWeekend, todayIso, weekdayOf } from "./hcmData";
import { getMyLeaveBalanceService } from "./services";
import type { LeaveType } from "./types";

export interface LeaveSuggestion {
  type: LeaveType;
  start: string;
  end: string;
  days: number;
  reason: string;
  /** Non-blocking advisory messages (weekend overlap, quota overrun, past date). */
  warnings: string[];
  fatal?: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function nextOccurrenceOf(weekday: number, fromIso: string): string {
  for (let i = 1; i <= 7; i++) {
    const d = addDaysIso(fromIso, i);
    if (weekdayOf(d) === weekday) return d;
  }
  return fromIso;
}

function monthFromName(name: string): number | null {
  const idx = MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3)));
  return idx >= 0 ? idx : null;
}

function daysBetweenInclusive(start: string, end: string): number {
  const a = new Date(`${start}T12:00:00Z`).getTime();
  const b = new Date(`${end}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

function detectType(text: string): LeaveType {
  if (/\b(sick|fever|flu|ill|illness|doctor|medical|checkup|surgery|not feeling well|food poison|migraine|dentist)\b/.test(text))
    return "sick";
  if (/\b(annual|vacation|vacay|trip|tour|hunza|holiday abroad|travel|umrah|hajj)\b/.test(text))
    return "annual";
  // wedding / family functions / errands / anything personal → casual
  return "casual";
}

function extractReason(text: string): string {
  const cleaned = text
    .replace(/\s+/g, " ")
    .replace(
      /^(i('|’)?( would like|'d like| need| want| am going|'m going| take| am taking|'m taking| will be taking)?\s*(to apply for|to request)?\s*(a |an |some )?(sick |annual |casual )?(leave|day off|days off|time off|off)?\s*(on |for |from )?(next )?(because )?)/i,
      "",
    )
    .replace(/^(please|kindly)\s+/i, "")
    .trim();
  const tail = /(?:\bfor\b\s+)([^.,;]+)/i.exec(cleaned);
  const because = /(?:\bbecause\b\s+|\bdue to\b\s+)([^.,;]+)/i.exec(cleaned);
  const raw = because?.[1] ?? tail?.[1] ?? cleaned;
  const reason = raw
    .replace(/\b(my|our)\b\s+/i, "")
    .replace(/^(sister|brother|cousin|daughter|son|wife|husband|niece|nephew|aunt|uncle|mother|father|family)(?!'s)/i, "$1's")
    .trim();
  if (!reason) return "Personal matter";
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * Parse a plain-words leave request. Returns a suggestion plus advisory
 * warnings; `fatal` marks an unusable parse (caller falls back to the manual
 * form). Never throws.
 */
export function parseLeaveRequest(message: string): LeaveSuggestion {
  const text = message.toLowerCase().trim();
  const today = todayIso();
  const warnings: string[] = [];
  let start: string | null = null;
  let end: string | null = null;

  // --- relative weekday phrases -------------------------------------------
  const weekdayMentions: string[] = [];
  const relRe = /(?:this|next|coming|upcoming)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(text)) !== null) weekdayMentions.push(m[1]);

  if (/\bday after tomorrow\b/.test(text)) {
    start = addDaysIso(today, 2);
    end = start;
  } else if (/\btomorrow\b/.test(text)) {
    start = addDaysIso(today, 1);
    end = start;
  } else if (/\bnext week\b/.test(text)) {
    start = nextOccurrenceOf(1, today); // coming Monday
    end = addDaysIso(start, 4); // Mon–Fri
  } else if (weekdayMentions.length > 0) {
    const targets = [...new Set(weekdayMentions.map((w) => WEEKDAYS.indexOf(w)))];
    const dates = targets.map((wd) => nextOccurrenceOf(wd, today)).sort();
    start = dates[0];
    end = dates[dates.length - 1];
    // A range spanning into the next week (e.g. Friday→Monday) is reported
    // as-is so the confirmer sees exactly what was meant.
  }

  // --- explicit ISO dates ---------------------------------------------------
  const iso = /(\d{4}-\d{2}-\d{2})(?:\s*(?:to|until|through|–|-)\s*(\d{4}-\d{2}-\d{2}))?/.exec(text);
  if (iso) {
    start = iso[1];
    end = iso[2] ?? iso[1];
  }

  // --- "2 November" / "November 2" (optionally "to 3 November") -------------
  const dmy = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)/.exec(text);
  const mdy = /([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/.exec(text);
  const pickMonth = (name: string): string | null => {
    const mi = monthFromName(name);
    if (mi === null) return null;
    const year = Number(today.slice(0, 4));
    const candidate = `${year}-${String(mi + 1).padStart(2, "0")}-`;
    return candidate;
  };
  if (!start && dmy) {
    const prefix = pickMonth(dmy[2]);
    if (prefix) start = `${prefix}${dmy[1].padStart(2, "0")}`;
  }
  if (!start && mdy) {
    const prefix = pickMonth(mdy[1]);
    if (prefix) start = `${prefix}${mdy[2].padStart(2, "0")}`;
  }

  if (!start) {
    return {
      type: detectType(text),
      start: "",
      end: "",
      days: 0,
      reason: extractReason(text),
      warnings: ["I could not work out the dates from your description."],
      fatal: "No dates recognised. Please pick the dates in the manual form.",
    };
  }

  if (!end) end = start;

  // --- "for N days" extends a single-date start ------------------------------
  const forDays = /\bfor\s+(\d{1,2})\s+days?\b/.exec(text);
  if (forDays && start === end) {
    end = addDaysIso(start, Number(forDays[1]) - 1);
  }

  if (end < start) [start, end] = [end, start];

  const days = daysBetweenInclusive(start, end);
  const type = detectType(text);
  const reason = extractReason(text);

  // --- validation warnings ---------------------------------------------------
  if (start < today) {
    warnings.push(`The start date ${start} is in the past.`);
  }
  const weekendDays: string[] = [];
  for (let d = start; d <= end; d = addDaysIso(d, 1)) {
    if (isWeekend(d)) weekendDays.push(d);
  }
  if (weekendDays.length) {
    warnings.push(
      `Your selection includes the weekend (${weekendDays.join(", ")}). Weekends are already non-working days.`,
    );
  }
  return { type, start, end, days, reason, warnings };
}

/** Attach a quota warning for a specific employee (used by the API route). */
export function withQuotaWarning(
  suggestion: LeaveSuggestion,
  userId: string,
): LeaveSuggestion {
  if (suggestion.fatal || !suggestion.start) return suggestion;
  const balance = getMyLeaveBalanceService(userId);
  if (balance.status !== "ok") return suggestion;
  const row = balance.data.balances.find((b) => b.type === suggestion.type);
  if (row && suggestion.days > row.remaining) {
    suggestion.warnings.push(
      `You are requesting ${suggestion.days} ${suggestion.type} day(s) but only ${row.remaining} ${suggestion.type} day(s) remain this year. HR may reject this application.`,
    );
  }
  return suggestion;
}
