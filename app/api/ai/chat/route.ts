/**
 * M8 · POST /api/ai/chat — the ONLY AI conversation gateway (T3.1, T5.x)
 * ---------------------------------------------------------------------------
 * Contract:
 *   Request : { message: string, conversation_id?: string }
 *   Response: { reply, conversation_id, tools_used, ai_generated: true, engine }
 *             — or, on provider failure, 502 with a friendly error message.
 *
 * Guarantees:
 *   - Identity + role are resolved SERVER-SIDE (x-user-email → lib/session.ts);
 *     the client can never declare a role.
 *   - Rate limit ~20 req/user/hour → HTTP 429 with a friendly message.
 *   - GEMINI_API_KEY / GEMINI_MODEL are read from the server environment only.
 *     If the key is missing or empty: clean 500 "AI is not configured." with a
 *     server-side warning — no crash, no details leaked to the client.
 *   - Provider failures (timeout, quota, network) return a friendly message and
 *     are written to the AI audit log. The key, stack traces and raw provider
 *     errors NEVER reach the browser.
 *   - RBAC (permission matrix via the tool executor), audit logging and field
 *     redaction remain fully in force on every turn.
 *   - Every turn + every tool execution lands in ai_logs with redaction.
 */

import { hasGeminiKey, runChatTurn } from "@/lib/aiGateway";
import { logAiRequest } from "@/lib/aiLogs";
import { getSession, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";
import { z } from "zod";

const bodySchema = z.object({
  message: z.string().trim().min(1, "Message is empty.").max(2000),
  conversation_id: z.string().trim().max(80).optional(),
});

export async function POST(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  // Parse body defensively.
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
  const { message } = parsed.data;
  const conversationId =
    parsed.data.conversation_id ?? `conv-${session.userId}-${Date.now().toString(36)}`;

  // Rate limit per user.
  const rl = rateLimit(`chat:${session.userId}`, 20);
  if (!rl.ok) {
    return Response.json(
      {
        error:
          "You've reached the hourly limit of 20 assistant messages. Please try again a bit later — or use the dashboard cards, which don't need the assistant.",
        retry_after_seconds: rl.retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  // Configuration gate: the chat gateway REQUIRES a server-side Gemini key.
  // No key → clean 500, server-side warning, audit row — never a crash and
  // never any detail about the configuration beyond this message.
  if (!hasGeminiKey()) {
    console.warn(
      `[chat] AI is not configured: GEMINI_API_KEY missing or empty (user=${session.userId})`,
    );
    logAiRequest({
      userId: session.userId,
      role: session.role,
      feature: "chat",
      toolName: null,
      toolStatus: "error",
      outcome: "chat unavailable: GEMINI_API_KEY missing or empty — answered 500",
      latencyMs: 0,
    });
    return Response.json({ error: "AI is not configured." }, { status: 500 });
  }

  const result = await runChatTurn(session, conversationId, message);
  if (!result.ok) {
    // Friendly provider-failure message; details live only in the audit log.
    return Response.json({ error: result.error }, { status: 502 });
  }

  return Response.json({
    reply: result.reply,
    conversation_id: conversationId,
    tools_used: result.toolsUsed,
    ai_generated: result.aiGenerated,
    engine: result.engine,
  });
}
