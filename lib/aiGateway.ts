/**
 * HCM Lite — AI Gateway (M8, T3.x / T5.x)
 * ---------------------------------------------------------------------------
 * Single entry point for AI generation:
 *   - Gemini 1.5 Flash via @google/generative-ai when GEMINI_API_KEY or
 *     AI_API_KEY is present (15 s request timeout, max 3 tool rounds),
 *   - deterministic safe mock otherwise, or on any Gemini failure.
 *
 * SECURITY: calls to the provider happen ONLY from this server module — the
 * browser talks exclusively to /api/ai/* (AT-11). The API key never reaches
 * the client and is redacted if it ever appears in a log.
 */

import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type Tool,
} from "@google/generative-ai";
import { logAiRequest } from "./aiLogs";
import { mockAssistantReply } from "./mockAssistant";
import { buildSystemPrompt } from "./policy";
import { executeTool, TOOL_CATALOG } from "./tools";
import type { SessionUser } from "./types";

export const GEMINI_MODEL = "gemini-1.5-flash";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOOL_ROUNDS = 3;

export function getApiKey(): string | null {
  return process.env.GEMINI_API_KEY || process.env.AI_API_KEY || null;
}

export function hasGeminiKey(): boolean {
  return Boolean(getApiKey());
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

export interface ChatTurnResult {
  reply: string;
  toolsUsed: { name: string; status: string }[];
  engine: "gemini" | "mock";
  aiGenerated: true;
  degraded?: string;
}

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

/* ------------------------------------------------------------------------- */
/* Gemini turn (function-calling loop)                                       */
/* ------------------------------------------------------------------------- */

async function geminiChatTurn(
  session: SessionUser,
  conversationId: string,
  message: string,
): Promise<ChatTurnResult> {
  const genAI = new GoogleGenerativeAI(getApiKey()!);
  const model = genAI.getGenerativeModel(
    {
      model: GEMINI_MODEL,
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
  return { reply, toolsUsed, engine: "gemini", aiGenerated: true };
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Run one chat turn. Never throws: any Gemini failure degrades to the mock
 * assistant (fail soft) with a short notice prefixed to the reply.
 */
export async function runChatTurn(
  session: SessionUser,
  conversationId: string,
  message: string,
): Promise<ChatTurnResult> {
  if (!hasGeminiKey()) {
    const mock = mockAssistantReply(message, session);
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "chat",
      toolName: mock.toolsUsed[0]?.name ?? null,
      toolStatus: mock.refused ? "forbidden" : "n/a",
      outcome: `mock chat: ${mock.reply.slice(0, 120)}`,
      latencyMs: 1,
    });
    return { ...mock, engine: "mock", aiGenerated: true };
  }

  const t0 = Date.now();
  try {
    const r = await geminiChatTurn(session, conversationId, message);
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "chat",
      toolName: r.toolsUsed[0]?.name ?? null,
      toolStatus: (r.toolsUsed[0]?.status as "ok") ?? "n/a",
      outcome: `gemini chat: ${r.reply.slice(0, 120)}`,
      latencyMs: Date.now() - t0,
    });
    return r;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const mock = mockAssistantReply(message, session);
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "chat",
      toolName: null,
      toolStatus: "error",
      outcome: `gemini failed (${reason.slice(0, 80)}); degraded to mock`,
      latencyMs: Date.now() - t0,
    });
    return {
      reply: mock.reply,
      toolsUsed: mock.toolsUsed,
      engine: "mock",
      aiGenerated: true,
      degraded:
        "The AI service is unreachable right now, so I answered from local rules.",
    };
  }
}
