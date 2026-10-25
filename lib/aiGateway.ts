/**
 * HCM Lite — AI Gateway (M8, T3.x / T5.x)
 * ---------------------------------------------------------------------------
 * Single entry point for AI generation. SERVER-SIDE ONLY — the browser talks
 * exclusively to /api/ai/* and never sees the provider, the key, or raw
 * provider errors (AT-11).
 *
 * Secrets & configuration (server-only, never NEXT_PUBLIC_*, never hardcoded):
 *   - GEMINI_API_KEY : required for the chat gateway. Missing/empty is NOT a
 *     crash — /api/ai/chat answers a clean 500 "AI is not configured." and
 *     logs a server-side warning.
 *   - GEMINI_MODEL   : optional. Empty falls back to the current stable Flash
 *     model per the official Google docs (gemini-2.5-flash).
 *
 * Failure policy for /api/ai/chat: any provider error/timeout returns a
 * friendly message to the UI and writes the failure to the AI audit log.
 * RBAC checks, tool permissions, audit logging and redaction are untouched.
 */

import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type Tool,
} from "@google/generative-ai";
import { logAiRequest } from "./aiLogs";
import { buildSystemPrompt } from "./policy";
import { SALARY_REFUSAL } from "./permissions";
import { executeTool, TOOL_CATALOG } from "./tools";
import type { SessionUser } from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOOL_ROUNDS = 3;
/** Current stable Gemini Flash model per official docs (ai.google.dev). */
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function getApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

export function hasGeminiKey(): boolean {
  return getApiKey() !== null;
}

/** Env-configured model, or the documented stable default when unset/empty. */
export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

const geminiTools: Tool[] = [
  {
    functionDeclarations: TOOL_CATALOG.map(
      (t): FunctionDeclaration => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as FunctionDeclarationSchema,
      }),
    ),
  },
];

export interface ChatTurnSuccess {
  ok: true;
  reply: string;
  toolsUsed: { name: string; status: string }[];
  engine: "gemini";
  aiGenerated: true;
}

export interface ChatTurnFailure {
  ok: false;
  /** Friendly, non-leaking message safe to show in the UI. */
  error: string;
}

export type ChatTurnResult = ChatTurnSuccess | ChatTurnFailure;

interface TurnRecord {
  role: "user" | "model";
  text: string;
}

/** In-memory conversation memory, keyed by conversation id. */
const conversations = new Map<string, TurnRecord[]>();

export function conversationHistory(conversationId: string): Content[] {
  const turns = conversations.get(conversationId) ?? [];
  return turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
}

function rememberTurns(conversationId: string, turns: TurnRecord[]) {
  const existing = conversations.get(conversationId) ?? [];
  existing.push(...turns);
  while (existing.length > 24) existing.shift(); // cap context
  conversations.set(conversationId, existing);
}

const looksLikeSalaryRefusal = (reply: string) =>
  /i am not authorized to disclose/i.test(reply) || reply.includes(SALARY_REFUSAL.slice(0, 40));

/* ------------------------------------------------------------------------- */
/* Gemini turn (function-calling loop)                                       */
/* ------------------------------------------------------------------------- */

async function geminiChatTurn(
  session: SessionUser,
  conversationId: string,
  message: string,
): Promise<ChatTurnSuccess> {
  const genAI = new GoogleGenerativeAI(getApiKey()!);
  const model = genAI.getGenerativeModel(
    {
      model: getGeminiModel(),
      systemInstruction: buildSystemPrompt(session),
      tools: geminiTools,
      generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
    },
    { timeout: REQUEST_TIMEOUT_MS },
  );

  const chat = model.startChat({ history: conversationHistory(conversationId) });
  const toolsUsed: { name: string; status: string }[] = [];

  let result = await chat.sendMessage(message.trim());
  let reply = result.response.text() ?? "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const calls = result.response.functionCalls();
    if (!calls || calls.length === 0) break;
    const parts = calls.map((fc) => {
      const r = executeTool(fc.name ?? "unknown", fc.args ?? {}, session);
      toolsUsed.push({ name: r.meta.tool, status: r.status });
      return {
        functionResponse: {
          name: fc.name ?? "unknown",
          response: {
            status: r.status,
            data: r.data,
            message: r.message ?? null,
            meta: r.meta,
          },
        },
      };
    });
    result = await chat.sendMessage(parts);
    reply = result.response.text() ?? "";
  }

  if (!reply.trim()) {
    reply =
      "I processed your request but could not compose an answer. Please rephrase and try again.";
  }
  rememberTurns(conversationId, [
    { role: "user", text: message },
    { role: "model", text: reply },
  ]);
  return { ok: true, reply, toolsUsed, engine: "gemini", aiGenerated: true };
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Run one chat turn through Gemini. Never throws: any provider failure is
 * audit-logged and returned as a friendly ChatTurnFailure — the key, stack
 * traces and raw provider errors never reach the browser.
 */
export async function runChatTurn(
  session: SessionUser,
  conversationId: string,
  message: string,
): Promise<ChatTurnResult> {
  const t0 = Date.now();
  try {
    const r = await geminiChatTurn(session, conversationId, message);
    // Permission transparency: a refused tool call OR the canonical salary
    // refusal is recorded with status "forbidden" so the audit viewer proves
    // the permission matrix held, regardless of how the model phrased it.
    const refused =
      r.toolsUsed.some((t) => t.status === "forbidden") || looksLikeSalaryRefusal(r.reply);
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "chat",
      toolName: r.toolsUsed[0]?.name ?? null,
      toolStatus: refused ? "forbidden" : (r.toolsUsed[0]?.status as "ok") ?? "n/a",
      outcome: `${refused ? "refused chat" : "gemini chat"}: ${r.reply.slice(0, 120)}`,
      latencyMs: Date.now() - t0,
    });
    return r;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "chat",
      toolName: null,
      toolStatus: "error",
      outcome: `gemini failed (${reason.slice(0, 120)}) — friendly error returned`,
      latencyMs: Date.now() - t0,
    });
    return {
      ok: false,
      error:
        "I'm having trouble reaching the AI service right now. Please try again in a moment — the dashboard cards keep working meanwhile.",
    };
  }
}
