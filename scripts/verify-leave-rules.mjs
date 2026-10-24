/**
 * Leave decision rules — quick regression subset (LR-1…LR-9)
 * ---------------------------------------------------------------------------
 * Usage:  node scripts/verify-leave-rules.mjs [baseUrl]
 * For the FULL checklist suite (items 1–14) see scripts/test-leave.mjs.
 * Run against a freshly started production server.
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const ADMIN = "admin@saylani.com"; // E-100
const HR = "hr@saylani.com"; // E-301
const EMP = "taha@saylani.com"; // E-102

let failures = 0;
const record = (id, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id} — ${detail}`);
};

async function get(path, email) {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-user-email": email } });
  return { status: res.status, body: await res.json() };
}
async function post(path, body, email) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-email": email },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function decide(id, body, email) {
  const res = await fetch(`${BASE}/api/leaves/${id}/decision`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-user-email": email },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const balanceRow = (bal, type) => bal?.balances?.find((b) => b.type === type)?.remaining;

/* LR-1 — Employee cannot decide */
{
  const r = await decide("LV-004", { action: "approve" }, EMP);
  record(
    "LR-1",
    r.status === 403 && /Only Admin and HR/.test(r.body.error ?? ""),
    `Employee PATCH approve → ${r.status} "${r.body.error}"`,
  );
}

/* LR-2 — HR cannot decide their OWN leave (submit one as HR first) */
const hrApp = await post(
  "/api/leaves",
  { type: "casual", start: "2026-12-01", end: "2026-12-01", reason: "HR officer self-test application" },
  HR,
);
{
  const hrCasualBefore = balanceRow(hrApp.body.balance, "casual");
  const self = await decide(hrApp.body.application.id, { action: "approve" }, HR);
  record(
    "LR-2",
    self.status === 403 && /own leave request/.test(self.body.error ?? ""),
    `HR self-decision → ${self.status} "${self.body.error}" (casual before: ${hrCasualBefore})`,
  );

  /* LR-3 — Admin approves HR's application: status/decidedBy/decidedAt/deduction */
  const ok = await decide(hrApp.body.application.id, { action: "approve" }, ADMIN);
  const app = ok.body.application;
  const hrCasualAfter = balanceRow(ok.body.balance, "casual");
  const expectedAfter = hrCasualBefore - app.days;
  record(
    "LR-3",
    ok.status === 200 &&
      app.status === "approved" &&
      app.decidedBy === "E-100" &&
      typeof app.decidedAt === "string" &&
      hrCasualAfter === expectedAfter,
    `Admin approve → ${ok.status}, status=${app.status}, decidedBy=${app.decidedBy}, decidedAt=${app.decidedAt ?? "?"}, HR casual ${hrCasualBefore}→${hrCasualAfter} (−${app.days})`,
  );

  /* LR-4 — first action wins: any later decision → 409 */
  const again = await decide(hrApp.body.application.id, { action: "approve" }, ADMIN);
  const flip = await decide(hrApp.body.application.id, { action: "reject" }, ADMIN);
  record(
    "LR-4",
    again.status === 409 && flip.status === 409 && /already approved/.test(again.body.error ?? ""),
    `Re-approve → ${again.status}, reject-after → ${flip.status} ("${again.body.error}")`,
  );
}

/* LR-5 — reject: no balance change */
{
  const app = await post(
    "/api/leaves",
    { type: "casual", start: "2026-12-03", end: "2026-12-03", reason: "Rejection test application" },
    EMP,
  );
  const before = balanceRow(app.body.balance, "casual");
  const rej = await decide(app.body.application.id, { action: "reject" }, ADMIN);
  const after = balanceRow(rej.body.balance, "casual");
  record(
    "LR-5",
    rej.status === 200 &&
      rej.body.application.status === "rejected" &&
      rej.body.application.decidedBy === "E-100" &&
      before === after &&
      /no balance change/.test(rej.body.message ?? ""),
    `Admin reject → ${rej.status}, status=${rej.body.application.status}, casual ${before}→${after} (unchanged)`,
  );
}

/* LR-6 — unpaid exempt from deduction */
{
  const unpaid = await post(
    "/api/leaves",
    { type: "unpaid", start: "2026-12-02", end: "2026-12-02", reason: "Unpaid exemption test" },
    EMP,
  );
  const sickBefore = balanceRow(unpaid.body.balance, "sick");
  const annualBefore = balanceRow(unpaid.body.balance, "annual");
  const casualBefore = balanceRow(unpaid.body.balance, "casual");
  const okU = await decide(unpaid.body.application.id, { action: "approve" }, ADMIN);
  record(
    "LR-6",
    okU.status === 200 &&
      okU.body.application.status === "approved" &&
      balanceRow(okU.body.balance, "sick") === sickBefore &&
      balanceRow(okU.body.balance, "annual") === annualBefore &&
      balanceRow(okU.body.balance, "casual") === casualBefore &&
      /no balance deduction/.test(okU.body.message ?? ""),
    `Unpaid approve → ${okU.status}, sick/annual/casual unchanged (${sickBefore}/${annualBefore}/${casualBefore})`,
  );
}

/* LR-7 — deduction math: remaining −= approved working days */
{
  const paid = await post(
    "/api/leaves",
    { type: "casual", start: "2026-12-10", end: "2026-12-11", reason: "Deduction math test" }, // Thu–Fri = 2 working days
    EMP,
  );
  const before = balanceRow(paid.body.balance, "casual");
  const okP = await decide(paid.body.application.id, { action: "approve" }, ADMIN);
  const after = balanceRow(okP.body.balance, "casual");
  record(
    "LR-7",
    okP.status === 200 && after === before - 2 && /2 casual working days deducted/.test(okP.body.message ?? ""),
    `Casual 2d approve → casual ${before}→${after} (expected −2), message "${okP.body.message}"`,
  );
}

/* LR-8 — decisions + refusals audited */
{
  const logs = await get("/api/ai/logs?limit=200", ADMIN);
  const rows = logs.body.logs ?? [];
  const decisions = rows.filter((l) => l.feature === "leave_admin" && l.tool_status === "ok");
  const refusals = rows.filter((l) => l.feature === "leave_admin" && l.tool_status === "forbidden");
  record(
    "LR-8",
    decisions.length >= 3 && refusals.length >= 2,
    `audit trail: ${decisions.length} decision row(s), ${refusals.length} refusal row(s)`,
  );
}

/* LR-9 — employee cannot see the pending queue */
{
  const empView = await get("/api/leaves", EMP);
  const hrView = await get("/api/leaves", HR);
  record(
    "LR-9",
    empView.body.all === undefined && Array.isArray(hrView.body.all) && hrView.body.all.length >= 0,
    `Employee officer-list hidden (${empView.body.all === undefined ? "✓" : "LEAK"}); HR list visible with ${hrView.body.all?.length ?? "?"} row(s)`,
  );
}

console.log(
  failures === 0 ? "\nALL LEAVE-RULE CHECKS PASSED ✅" : `\n${failures} LEAVE-RULE CHECK(S) FAILED ❌`,
);
process.exit(failures === 0 ? 0 : 1);
