/**
 * M8 · GET /api/dashboard — KPI cards for the signed-in seat.
 * Same services as the AI tools (single source of truth). Payroll is only
 * computed for Admin/HR; Employees additionally receive their leave balance.
 */

import { getDashboardKpisService } from "@/lib/services";
import { getSession, unauthorized } from "@/lib/session";

export async function GET(req: Request) {
  const session = getSession(req);
  if (!session) return unauthorized();

  const kpis = getDashboardKpisService({
    includePayroll: session.role !== "Employee",
    userId: session.userId,
  });
  return Response.json({
    kpis,
    session: {
      email: session.email,
      name: session.name,
      role: session.role,
      userId: session.userId,
      dept: session.dept,
      designation: session.designation,
    },
  });
}
