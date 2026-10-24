/**
 * Leave Approval module — full checklist test (items 1–14)
 * ---------------------------------------------------------------------------
 * Usage:  node scripts/test-leave.mjs [baseUrl]
 *
 * IMPORTANT: run against a FRESHLY started production server (npm start) —
 * the ledger is in-memory and must be in its seeded state. This script only
 * creates its own test records; no real user data is touched.
 *
 * Seats (resolved SERVER-side from x-user-email; role is never sent by tests):
 *   ADMIN admin@saylani.com (E-100) · HR hr@saylani.com (E-301) · EMP taha@saylani.com (E-102)
 * Seeded balances for EMP: annual 11, sick 6, casual 9 remaining. HR casual: 9.
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const ADMIN = "admin@saylani.com";
const HR = "hr@saylani.com";
const EMP = "taha@saylani.com";

const results = [];
let failures = 0;
function record(item, ok, detail) {
  if (!ok) failures += 1;
  results.push({ item, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${item} — ${detail}`);
}

async function get(path, email) {
  const headers = email ? { "x-user-email": email } : {};
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function post(path, body, email) {
  const headers = { "Content-Type": "application/json" };
  if (email) headers["x-user-email"] = email;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function decide(id, body, email) {
  const headers = { "Content-Type": "application/json" };
  if (email) headers["x-user-email"] = email;
  const res = await fetch(`${BASE}/api/leaves/${id}/decision`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const bal = (b, type) => b?.balances?.find((x) => x.type === type)?.remaining;
const iso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

/* --- Item 1: employee applies → ONE record, status Pending ---------------- */
const app1 = await post("/api/leaves", {
  type: "casual", start: "2026-12-01", end: "2026-12-01", reason: "Checklist 1: personal errand",
}, EMP);
const id1 = app1.body.application?.id;
record(
  "1. apply → Pending record",
  app1.status === 200 && app1.body.application?.status === "pending" && id1?.startsWith("LV-"),
  `POST → ${app1.status}, id=${id1}, status=${app1.body.application?.status}, days=${app1.body.application?.days}`,
);

/* --- Item 2: HR and Admin both see the record ------------------------------ */
const hrList = await get("/api/leaves?status=pending", HR);
const admList = await get("/api/leaves?status=pending", ADMIN);
const hrSees = hrList.body.all?.some((r) => r.id === id1 && r.employeeName === "Taha Siddiqui");
const admSees = admList.body.all?.some((r) => r.id === id1);
record(
  "2. HR + Admin see it in the list",
  hrList.status === 200 && admList.status === 200 && hrSees && admSees,
  `HR sees=${hrSees}, Admin sees=${admSees} (?status=pending)`,
);

/* --- Item 3: HR approves → decidedBy/decidedAt + balance deductions -------- */
const annualApp = await post("/api/leaves", {
  type: "annual", start: "2026-12-08", end: "2026-12-09", reason: "Checklist 3: family event",
}, EMP);
const annualBefore = bal(annualApp.body.balance, "annual"); // 11
const okAnnual = await decide(annualApp.body.application.id, { action: "approve" }, HR);
const annualAfter = bal(okAnnual.body.balance, "annual");

const casualApp = await post("/api/leaves", {
  type: "casual", start: "2026-12-21", end: "2026-12-21", reason: "Checklist 3: casual day",
}, EMP);
const okCasual = await decide(casualApp.body.application.id, { action: "approve" }, HR);
const casualAfter = bal(okCasual.body.balance, "casual"); // 9 → 8

const sickApp = await post("/api/leaves", {
  type: "sick", start: "2026-12-22", end: "2026-12-23", reason: "Checklist 3: flu",
}, EMP);
const okSick = await decide(sickApp.body.application.id, { action: "approve" }, HR);
const sickAfter = bal(okSick.body.balance, "sick"); // 6 → 4

const annualRec = okAnnual.body.application;
record(
  "3. approve: fields saved + balance deducted",
  okAnnual.status === 200 &&
    annualRec?.status === "approved" &&
    annualRec?.decidedBy === "E-301" &&
    iso(annualRec?.decidedAt) &&
    annualBefore === 11 && annualAfter === 9 &&
    casualAfter === 8 && sickAfter === 4,
  `annual ${annualBefore}→${annualAfter}, casual 9→${casualAfter}, sick 6→${sickAfter}; decidedBy=${annualRec?.decidedBy}, decidedAt=${annualRec?.decidedAt}`,
);
const annualId = annualApp.body.application.id;

/* --- Item 4: second decision → 409, nothing changes ------------------------- */
const againApprove = await decide(annualId, { action: "approve" }, HR);
const againReject = await decide(annualId, { action: "reject" }, HR);
const balAfterDouble = (await get("/api/leaves", EMP)).body.balance;
record(
  "4. second decision → 409, no double deduction",
  againApprove.status === 409 && againReject.status === 409 && bal(balAfterDouble, "annual") === 9,
  `re-approve → ${againApprove.status}, re-reject → ${againReject.status}, annual still ${bal(balAfterDouble, "annual")}`,
);

/* --- Item 5: Admin on an already-decided request → 409 ---------------------- */
const admLate = await decide(annualId, { action: "approve" }, ADMIN);
record(
  "5. Admin on decided request → 409",
  admLate.status === 409 && /already approved/.test(admLate.body.error ?? ""),
  `→ ${admLate.status} "${admLate.body.error}"`,
);

/* --- Item 6: reject → Rejected, balance unchanged, note saved ---------------- */
const rejApp = await post("/api/leaves", {
  type: "casual", start: "2026-12-16", end: "2026-12-16", reason: "Checklist 6: day trip",
}, EMP);
const casualBeforeRej = bal(rejApp.body.balance, "casual"); // 8
const rej = await decide(rejApp.body.application.id, { action: "reject", note: "Quarter close that week" }, ADMIN);
const casualAfterRej = bal(rej.body.balance, "casual");
record(
  "6. reject: no balance change + note saved",
  rej.status === 200 &&
    rej.body.application?.status === "rejected" &&
    rej.body.application?.decidedBy === "E-100" &&
    iso(rej.body.application?.decidedAt) &&
    rej.body.application?.decisionNote === "Quarter close that week" &&
    casualBeforeRej === casualAfterRej,
  `→ ${rej.status}, status=${rej.body.application?.status}, note="${rej.body.application?.decisionNote}", casual ${casualBeforeRej}→${casualAfterRej}`,
);

/* --- Item 7: unpaid approval deducts nothing --------------------------------- */
const unpaidApp = await post("/api/leaves", {
  type: "unpaid", start: "2026-12-15", end: "2026-12-15", reason: "Checklist 7: unpaid day",
}, EMP);
const uSick = bal(unpaidApp.body.balance, "sick");
const uAnnual = bal(unpaidApp.body.balance, "annual");
const uCasual = bal(unpaidApp.body.balance, "casual");
const okUnpaid = await decide(unpaidApp.body.application.id, { action: "approve" }, ADMIN);
const uSickA = bal(okUnpaid.body.balance, "sick");
const uAnnualA = bal(okUnpaid.body.balance, "annual");
const uCasualA = bal(okUnpaid.body.balance, "casual");
record(
  "7. unpaid approved: no deduction",
  okUnpaid.status === 200 &&
    okUnpaid.body.application?.status === "approved" &&
    uSick === uSickA && uAnnual === uAnnualA && uCasual === uCasualA &&
    /no balance deduction/.test(okUnpaid.body.message ?? ""),
  `sick ${uSick}→${uSickA}, annual ${uAnnual}→${uAnnualA}, casual ${uCasual}→${uCasualA}`,
);

/* --- Item 8: employee cannot decide ------------------------------------------ */
const empDecide = await decide(id1, { action: "approve" }, EMP);
record(
  "8. employee decision → 403",
  empDecide.status === 403 && /Only Admin and HR/.test(empDecide.body.error ?? ""),
  `→ ${empDecide.status} "${empDecide.body.error}"`,
);

/* --- Item 9: nobody decides their own leave ---------------------------------- */
const hrSelf = await post("/api/leaves", {
  type: "casual", start: "2026-12-17", end: "2026-12-17", reason: "Checklist 9: HR own request",
}, HR);
const hrSelfCasualBefore = bal(hrSelf.body.balance, "casual"); // 9
const hrSelfTry = await decide(hrSelf.body.application.id, { action: "approve" }, HR);

const admSelf = await post("/api/leaves", {
  type: "casual", start: "2026-12-18", end: "2026-12-18", reason: "Checklist 9: admin own request",
}, ADMIN);
const admSelfTry = await decide(admSelf.body.application.id, { action: "approve" }, ADMIN);

const admOnHr = await decide(hrSelf.body.application.id, { action: "approve" }, ADMIN);
const hrSelfCasualAfter = bal(admOnHr.body.balance, "casual");
record(
  "9. self-decision 403 (HR & Admin); Admin decides HR's request",
  hrSelfTry.status === 403 && /own leave request/.test(hrSelfTry.body.error ?? "") &&
    admSelfTry.status === 403 && /own leave request/.test(admSelfTry.body.error ?? "") &&
    admOnHr.status === 200 && hrSelfCasualAfter === hrSelfCasualBefore - 1,
  `HR self → ${hrSelfTry.status}, Admin self → ${admSelfTry.status}, Admin→HR's leave → ${admOnHr.status} (HR casual ${hrSelfCasualBefore}→${hrSelfCasualAfter})`,
);

/* --- Item 10: employee A cannot see employee B's records ---------------------- */
const empView = await get("/api/leaves?status=pending", EMP);
const allOwn = (empView.body.mine ?? []).every((r) => r.employeeId === "E-102");
const othersLeak = (empView.body.mine ?? []).some((r) => r.employeeName === "Nadia Hussain" || r.employeeName === "Sikandar Hayat");
record(
  "10. employee sees only own records",
  empView.status === 200 && empView.body.all === undefined && allOwn && !othersLeak,
  `mine=${empView.body.mine?.length ?? 0} rows, all own=${allOwn}, officer list exposed=${empView.body.all !== undefined}`,
);

/* --- Item 11: over-balance / overlap → 422 on apply ---------------------------- */
const overBalance = await post("/api/leaves", {
  type: "annual", start: "2026-11-10", end: "2026-11-27", reason: "Checklist 11: too long",
}, EMP); // 14 working days > 11 remaining
const overlap = await post("/api/leaves", {
  type: "casual", start: "2026-12-09", end: "2026-12-10", reason: "Checklist 11: overlaps approved",
}, EMP); // overlaps approved annual Dec 8–9
record(
  "11. over-balance / overlap → 422",
  overBalance.status === 422 && /Not enough balance/.test(overBalance.body.error ?? "") &&
    overlap.status === 422 && /overlap/.test(overlap.body.error ?? ""),
  `over-balance → ${overBalance.status} "${overBalance.body.error}", overlap → ${overlap.status} "${overlap.body.error}"`,
);

/* --- Item 12: weekends + public holidays skipped ------------------------------- */
const weekendApp = await post("/api/leaves", {
  type: "sick", start: "2026-12-04", end: "2026-12-07", reason: "Checklist 12: spans weekend",
}, EMP); // Fri→Mon = 2 working days
const holidayApp = await post("/api/leaves", {
  type: "casual", start: "2026-12-24", end: "2026-12-28", reason: "Checklist 12: spans holiday",
}, EMP); // Thu, Fri(holiday Dec 25), Sat, Sun, Mon = 2 working days
record(
  "12. weekends + holidays skipped in day count",
  weekendApp.status === 200 && weekendApp.body.application?.days === 2 &&
    holidayApp.status === 200 && holidayApp.body.application?.days === 2,
  `Fri→Mon days=${weekendApp.body.application?.days} (want 2); Dec 24–28 (incl. Dec 25 holiday) days=${holidayApp.body.application?.days} (want 2)`,
);

/* --- Item 13: unauthenticated requests are rejected ---------------------------- */
const noAuthGet = await get("/api/leaves");
const badAuthGet = await get("/api/leaves", "intruder@evil.com");
const noAuthPost = await post("/api/leaves", { type: "casual", start: "2026-12-30", end: "2026-12-30", reason: "no session" });
const noAuthDecide = await decide(id1, { action: "approve" });
record(
  "13. no session → 401 everywhere",
  noAuthGet.status === 401 && badAuthGet.status === 401 && noAuthPost.status === 401 && noAuthDecide.status === 401,
  `GET ${noAuthGet.status}/${badAuthGet.status}, POST ${noAuthPost.status}, PATCH ${noAuthDecide.status}`,
);

/* --- Spec extra: approval-time revalidation → 422 ------------------------------- */
// Two non-overlapping annual requests, each within balance at apply time.
// After the first is approved the balance no longer covers the second → 422.
const revalA = await post("/api/leaves", {
  type: "annual", start: "2026-11-10", end: "2026-11-16", reason: "Revalidation A (5 wd)",
}, EMP);
const revalB = await post("/api/leaves", {
  type: "annual", start: "2026-11-17", end: "2026-11-23", reason: "Revalidation B (5 wd)",
}, EMP);
const okA = await decide(revalA.body.application.id, { action: "approve" }, HR);
const lateB = await decide(revalB.body.application.id, { action: "approve" }, ADMIN);
const unknown404 = await decide("LV-does-not-exist", { action: "approve" }, ADMIN);
record(
  "X. approval-time revalidation → 422; unknown id → 404",
  revalA.status === 200 && revalB.status === 200 &&
    okA.status === 200 && lateB.status === 422 && /Approval blocked/.test(lateB.body.error ?? "") &&
    unknown404.status === 404,
  `A approve → ${okA.status} (annual ${bal(okA.body.balance, "annual")}), B approve → ${lateB.status} "${lateB.body.error}", unknown → ${unknown404.status}`,
);

/* --- Item 14: build/lint/typecheck — executed by the loop, reported here -------- */
console.log("\nItem 14 (build/lint/typecheck) is run separately by the loop: npm run lint && npx tsc --noEmit && npm run build");

console.log("\n===== CHECKLIST SUMMARY =====");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.item}`);
}
if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED ❌`);
  process.exit(1);
}
console.log("\nALL CHECKLIST CHECKS PASSED ✅ (item 14 = build commands, run alongside)");
