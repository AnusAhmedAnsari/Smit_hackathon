/**
 * M8 · POST /api/ai/chat — the ONLY AI conversation gateway (T3.1, T5.x)
 * ---------------------------------------------------------------------------
 * Contract:
 *   Request : { message: string, conversation_id?: string }
 *   Response: { reply, conversation_id, tools_used, ai_generated: true, engine, degraded? }
 *
 * Guarantees:
 *   - Identity + role are resolved SERVER-SIDE (x-user-email → lib/session.ts);
 *     the client can never declare a role.
 *   - Rate limit ~20 req/user/hour → HTTP 429 with a friendly message.
 *   - Provider calls happen here only (browser never sees the provider — AT-11).
 *   - Every turn + every tool execution lands in ai_logs with redaction.
 *   - Any failure degrades to a friendly, non-leaking fallback (fail soft).
 */

import { runChatTurn } from "@/lib/aiGateway";
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

  const result = await runChatTurn(session, conversationId, message);

  return Response.json({
    reply: result.reply,
    conversation_id: conversationId,
    tools_used: result.toolsUsed,
    ai_generated: result.aiGenerated,
    engine: result.engine,
    ...(result.degraded ? { degraded: result.degraded } : {}),
  });
}
