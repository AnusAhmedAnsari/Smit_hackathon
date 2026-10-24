/**
 * HCM Lite — Session Resolution (M8, T3.2)
 * ---------------------------------------------------------------------------
 * The client may only choose WHICH demo seat it is sitting in (email); the
 * server resolves identity + role from its own user registry and never trusts
 * a client-declared role. In production this file would be the single place
 * swapped for a real auth provider (e.g. Supabase/Firebase session cookies);
 * every route already consumes the resolved SessionUser, nothing else.
 */

import { SESSION_EMAILS, USERS } from "./hcmData";
import type { SessionUser } from "./types";

export const SESSION_HEADER = "x-user-email";

/**
 * Resolve the active session from the request. Falls back to the Admin demo
 * seat when no header is present (direct API testing convenience), and
 * returns null for an unknown email so routes can answer 401.
 */
export function getSession(req: Request): SessionUser | null {
  const email = req.headers.get(SESSION_HEADER)?.trim().toLowerCase();
  if (!email) return USERS["admin@saylani.com"];
  return USERS[email] ?? null;
}

export function listDemoSessions(): SessionUser[] {
  return SESSION_EMAILS.map((e) => USERS[e]);
}

export function unauthorized() {
  return Response.json(
    { error: "Unknown session. Pass a valid demo seat via the x-user-email header." },
    { status: 401 },
  );
}
