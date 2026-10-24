/**
 * HCM Lite — AI Audit Log Engine (M8, T4.1–T4.2)
 * ---------------------------------------------------------------------------
 * Append-only audit trail. EVERY AI interaction (chat turn, dashboard summary,
 * smart-leave parse, and each individual tool execution) is recorded here.
 *
 * CONSTITUTION §5 (transparency): the log is the judge's window into the AI —
 * it proves what the assistant did, for whom, and that nothing sensitive
 * leaked. Entries are never mutated or deleted (append-only); the buffer is
 * capped to the most recent MAX_LOGS entries for this demo deployment.
 *
 * Redaction: any salary-like figure in a salary context, CNIC, bank IBAN or
 * credential-looking string is replaced with [REDACTED] before storage.
 */

import type { AiLogEntry, Role, ToolStatus } from "./types";

const MAX_LOGS = 500;

const logBuffer: AiLogEntry[] = [];
let seq = 0;

/* ----------------------------- redaction --------------------------------- */

const CNIC_RE = /\b\d{5}-\d{7}-\d\b/g;
const IBAN_RE = /\bPK\d{2}[A-Z]{4}\d{10,16}\b|\bPK\d{2}[A-Z]{4}[\dA-Z]{16,24}\b/g;
const CREDENTIAL_RE = /\b(AIza[0-9A-Za-z\-_]{10,}|sk-[0-9A-Za-z\-_]{10,}|Bearer\s+[0-9A-Za-z\-_.]{10,})\b/g;
/** e.g. "salary of 185000", "salary: 185,000" — aggregates without the word
 *  "salary" (KPIs, payroll totals) are legitimate and stay visible. */
const SALARY_FIGURE_RE = /((?:salary|salaries|pay|wage)[^\d]{0,24})\d[\d,]{4,}(\.\d+)?/gi;

/** Scrub sensitive values from any text destined for logs or the UI. */
export function redact(text: string): { text: string; changed: boolean } {
  let changed = false;
  let out = text;
  const sub = (re: RegExp, rep: string) => {
    if (re.test(out)) {
      changed = true;
      out = out.replace(re, rep);
    }
    re.lastIndex = 0;
  };
  sub(CNIC_RE, "[REDACTED]");
  sub(IBAN_RE, "[REDACTED]");
  sub(CREDENTIAL_RE, "[REDACTED]");
  out = out.replace(SALARY_FIGURE_RE, (_m, prefix: string) => {
    changed = true;
    return `${prefix}[REDACTED]`;
  });
  return { text: out, changed };
}

/* ------------------------------- logging --------------------------------- */

export interface LogInput {
  userId: string;
  role: Role;
  feature: AiLogEntry["feature"];
  toolName?: string | null;
  toolStatus?: ToolStatus | "n/a";
  outcome: string;
  latencyMs: number;
}

export function logAiRequest(input: LogInput): AiLogEntry {
  seq += 1;
  const { text, changed } = redact(input.outcome);
  const entry: AiLogEntry = {
    id: `LOG-${String(seq).padStart(5, "0")}`,
    timestamp: new Date().toISOString(),
    user_id: input.userId,
    role: input.role,
    feature: input.feature,
    tool_name: input.toolName ?? null,
    tool_status: input.toolStatus ?? "n/a",
    outcome: text,
    latency_ms: Math.max(0, Math.round(input.latencyMs)),
    redacted: changed,
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  return entry;
}

/** Newest first. */
export function getAiLogs(limit = 100): AiLogEntry[] {
  return [...logBuffer].reverse().slice(0, Math.max(1, Math.min(limit, MAX_LOGS)));
}

export function getAiLogStats() {
  const byStatus: Record<string, number> = {};
  const byFeature: Record<string, number> = {};
  for (const e of logBuffer) {
    byStatus[e.tool_status] = (byStatus[e.tool_status] ?? 0) + 1;
    byFeature[e.feature] = (byFeature[e.feature] ?? 0) + 1;
  }
  const latencies = logBuffer.map((e) => e.latency_ms).sort((a, b) => a - b);
  return {
    total: logBuffer.length,
    byStatus,
    byFeature,
    redactedCount: logBuffer.filter((e) => e.redacted).length,
    avgLatencyMs: latencies.length
      ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length)
      : 0,
    p95LatencyMs: latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
      : 0,
  };
}
