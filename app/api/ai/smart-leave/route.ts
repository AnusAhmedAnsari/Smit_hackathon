/**
 * M8 · POST /api/ai/smart-leave — natural-language leave suggestion (T6.x)
 * ---------------------------------------------------------------------------
 * Employee-only endpoint (403 for Admin/HR — their leave goes through the HR
 * portal in this demo). Converts a plain-words description into
 * { suggestion: { type, start, end, days, reason }, ai_suggested: true }.
 *
 * Pipeline: Gemini strict-JSON parse (if a key is configured) → validate
 * server-side → on malformed JSON retry once → on any failure fall back to
 * the deterministic parser (lib/leaveParser.ts). Dates are ALWAYS recomputed
 * server-side in Asia/Karachi; the model's dates are accepted only if they
 * parse as ISO and are not in the past. Weekend/quota issues are returned as
 * warnings; unusable output returns fallback_to_manual.
 */

import { logAiRequest } from "@/lib/aiLogs";
import { getApiKey, hasGeminiKey, GEMINI_MODEL } from "@/lib/aiGateway";
import {
  parseLeaveRequest,
  withQuotaWarning,
  type LeaveSuggestion,
} from "@/lib/leaveParser";
import { todayIso } from "@/lib/hcmData";
import { getSession, unauthorized } from "@/lib/session";
import { z } from "zod";

const bodySchema = z.object({
  message: z.string().trim().min(3, "Describe your leave in a few words.").max(500),
});

interface ModelSuggestion {
  type?: string;
  start?: string;
  end?: string;
  reason?: string;
}

async function geminiParse(message: string, today: string): Promise<ModelSuggestion | null> {
  const prompt = `Today is ${today} (timezone Asia/Karachi, weekend Sat–Sun).
Convert the employee's leave request into STRICT JSON only, no prose, no markdown:
{"type":"annual"|"sick"|"casual","start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"short reason"}
Rules: "next Monday" means the next occurrence of Monday after today (if several weekdays are named, span from the earliest to the latest). Include weekends inside the span. Wedding/family functions/errands are "casual"; illness is "sick"; vacations/trips are "annual". Keep the employee's own reason text, shortened.
Request: "${message.replace(/"/g, "'")}"`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(getApiKey()!);
      const model = genAI.getGenerativeModel(
        {
          model: GEMINI_MODEL,
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 200,
            responseMimeType: "application/json",
          },
        },
        { timeout: 15_000 },
      );
      const res = await model.generateContent(
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous answer was not valid JSON. Return ONLY the JSON object.`,
      );
      const text = res.response.text() ?? "";
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) continue;
      return JSON.parse(match[0]) as ModelSuggestion;
    } catch {
      continue; // retry once, then fall through to the deterministic parser
    }
  }
  return null;
}

function sanitizeModelSuggestion(
  raw: ModelSuggestion,
  fallback: LeaveSuggestion,
): LeaveSuggestion {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const today = todayIso();
  const type =
    raw.type && ["annual", "sick", "casual"].includes(raw.type)
      ? (raw.type as LeaveSuggestion["type"])
      : fallback.type;
  const start = raw.start && iso.test(raw.start) ? raw.start : "";
  let end = raw.end && iso.test(raw.end) ? raw.end : "";
  if (!start || start < today) return fallback; // never trust past/invalid dates
  if (!end || end < start) end = start;
  const days =
    Math.round(
      (new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
  return {
    type,
    start,
    end,
    days,
    reason: (raw.reason ?? fallback.reason).slice(0, 120),
    warnings: fallback.warnings,
  };
}

export async function POST(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  const t0 = Date.now();
  if (session.role !== "Employee") {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "smart_leave",
      toolName: null,
      toolStatus: "forbidden",
      outcome: `smart leave refused for ${session.role} role (employee-only flow)`,
      latencyMs: Date.now() - t0,
    });
    return Response.json(
      {
        error:
          "The Smart Leave assistant is for employees. As " +
          session.role +
          " you can review leave requests in the Leave Center records instead.",
      },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const today = todayIso();
  const deterministic = parseLeaveRequest(parsed.data.message);

  let suggestion: LeaveSuggestion = deterministic;
  let engine: "gemini" | "deterministic" = "deterministic";

  if (hasGeminiKey()) {
    const modelSuggestion = await geminiParse(parsed.data.message, today);
    if (modelSuggestion) {
      suggestion = sanitizeModelSuggestion(modelSuggestion, deterministic);
      engine = "gemini";
    }
  }

  suggestion = withQuotaWarning(suggestion, session.userId);

  if (suggestion.fatal || !suggestion.start) {
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "smart_leave",
      toolName: null,
      toolStatus: "not_found",
      outcome: `smart leave could not extract dates ("${parsed.data.message.slice(0, 60)}"); offered manual form`,
      latencyMs: Date.now() - t0,
    });
    return Response.json({
      fallback_to_manual: true,
      message:
        "I couldn't work out the dates from that description. Please fill the manual form below and submit.",
      ai_suggested: false,
      partial: { type: suggestion.type, reason: suggestion.reason },
    });
  }

  logAiRequest({
    userId: session.userId,
    role: session.role,
    feature: "smart_leave",
    toolName: null,
    toolStatus: "ok",
    outcome: `smart leave suggestion (${engine}): ${suggestion.type} ${suggestion.start}→${suggestion.end} (${suggestion.days}d), pending confirmation`,
    latencyMs: Date.now() - t0,
  });

  return Response.json({
    suggestion: {
      type: suggestion.type,
      start: suggestion.start,
      end: suggestion.end,
      days: suggestion.days,
      reason: suggestion.reason,
    },
    warnings: suggestion.warnings,
    ai_suggested: true,
    engine,
  });
}
