/**
 * M8 · GET /api/ai/logs — Admin audit viewer feed (T4/T7)
 * Returns the append-only ai_logs rows (newest first) plus aggregate stats.
 * Admin only — 403 for everyone else.
 */

import { getAiLogs, getAiLogStats } from "@/lib/aiLogs";
import { getSession, unauthorized } from "@/lib/session";

export async function GET(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  if (session.role !== "Admin") {
    return Response.json(
      { error: "The audit log is restricted to Admin." },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  return Response.json({
    logs: getAiLogs(Number.isFinite(limit) ? limit : 100),
    stats: getAiLogStats(),
    ai_generated: false,
  });
}
