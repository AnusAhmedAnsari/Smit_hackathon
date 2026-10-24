/**
 * HCM Lite — Rate Limiter (M8, T3.5)
 * ---------------------------------------------------------------------------
 * In-memory sliding-window limiter (~20 requests / user / hour on the chat
 * gateway, per Spec NFR). Exceeding it answers HTTP 429 with a friendly,
 * non-leaking message. Single-instance demo deployments only; a production
 * build would back this with Redis/Upstash using the same contract.
 */

const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(
  key: string,
  limit = 20,
  windowMs = 60 * 60 * 1000,
): RateLimitResult {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const oldest = hits[0];
    buckets.set(key, hits);
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}
