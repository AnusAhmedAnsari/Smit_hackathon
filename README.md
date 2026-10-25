# HCM Lite — AI Assistant Module (M8)

Saylani Hackathon · Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Lucide icons · Google Gemini (env-configured model).

A self-contained Human-Capital-Management dashboard with a **governed AI assistant**: 7 role-scoped data tools, polite privacy refusals, human-confirmed writes, a full append-only audit trail, and clean fail-soft behaviour when the AI provider is unavailable or unconfigured.

## Quick start

```bash
npm install
npm run build
npm start          # production, http://localhost:3000
```

### Gemini configuration (server-side only)

Copy `.env.example` to `.env` (in this app root — the file is git-ignored and must never be committed) and set:

- The API key variable (name and placeholder in `.env.example`) — **required for the chat gateway.** Without it, `/api/ai/chat` answers a clean HTTP 500 `"AI is not configured."` (with a server-side warning and an audit-log row); it never crashes and never leaks details.
- The model variable (also in `.env.example`) — optional. When empty, the gateway falls back to the current stable Flash model per the official Google docs (`gemini-2.5-flash`).

Failures (timeout, quota, invalid key) return a friendly message to the UI, are written to the AI audit log, and never expose the key, stack traces, or raw provider errors. Dashboard summaries and Smart Leave keep their deterministic local fallbacks. In production (Vercel), set the same variables in the project's environment settings — the same rules apply.

## Demo sessions

The header switcher picks the active seat; the **server** resolves the role from its own registry (`x-user-email` header → `lib/session.ts`) and never trusts a client-declared role.

| Seat | Email | Role | Scope |
|---|---|---|---|
| Sikandar Hayat | `admin@saylani.com` | Admin | all departments + aggregate payroll + audit log |
| Nadia Hussain | `hr@saylani.com` | HR | all departments + aggregate payroll |
| Taha Siddiqui | `taha@saylani.com` | Employee | own leave balance + sanitized directory only |

## Architecture

```
lib/hcmData.ts      deterministic data engine (17 employees, attendance for every
                    working day of 2026, leave ledger, salaries — never exposed)
lib/services.ts     the ONE service layer used by the dashboard AND the AI tools
lib/permissions.ts  role × tool matrix (the ONE permission system)
lib/tools.ts        7-tool registry: zod validation → permission gate → service → audit
lib/aiLogs.ts       append-only audit log with redaction (salary/CNIC/bank/credentials)
lib/policy.ts       versioned system prompt (policy vM8-policy-3.2 + live date + role delimiter)
lib/aiGateway.ts    Gemini tool-calling loop (env-configured model, 15 s timeout,
                    ≤3 rounds, friendly failures + audit logging); SERVER-SIDE ONLY
lib/leaveParser.ts  server-side NL→leave parser ("next Monday and Tuesday" → ISO dates)

app/api/ai/chat              POST  chat gateway (rate limit 20 req/user/h → HTTP 429)
app/api/ai/dashboard-summary POST  Admin/HR-only insight bullets + number verification
app/api/ai/smart-leave       POST  Employee-only NL leave suggestion (ai_suggested: true)
app/api/ai/logs              GET   Admin-only audit feed
app/api/dashboard            GET   KPI cards (payroll hidden for Employee)
app/api/leaves               GET/POST — strict 401 auth; employees see ONLY their
                             own records; Admin/HR list all (?status= filter);
                             apply creates ONE pending record with `days` counted
                             as WORKING days (weekends + public holidays skipped)
                             and 422 on overlap or over-balance
app/api/leaves/[id]/decision PATCH — Admin/HR approve/reject, fully server-enforced:
                             401 no session · 403 employee · 404 unknown · 409
                             not-pending (first decision wins, no double
                             deduction) · 403 self-decision (NOBODY decides their
                             own request, Admin included) · 422 approval-time
                             re-validation (balance/overlap). Approve deducts the
                             ledger balance (Unpaid exempt — settled in payroll);
                             reject changes nothing. decidedBy/decidedAt/
                             decisionNote stored on the record.
```

### Constitution compliance

1. **DB is the single source of truth** — every number shown or spoken comes from `lib/services.ts`.
2. **One permission system** — `lib/permissions.ts`, evaluated server-side on every tool call.
3. **AI never writes without human confirmation** — the only write path is `POST /api/leaves`, triggered by the “Confirm & Submit” button; suggestions are marked `ai_suggested`.
4. **Refuse politely** — salary questions return the exact refusal: *“I am not authorized to disclose other employees' salary information.”* Uncovered policy questions return *“I don't have that policy information. Please check with HR.”*
5. **Fail soft** — no key, provider error, or timeout degrades to the local rules engine; malformed AI JSON in Smart Leave retries once, then falls back to the manual form.
6. **Transparency** — every request/tool call/refusal is in the append-only `ai_logs` (Admin → “AI Audit”), with redaction flags.

## Security notes (AT-11)

The browser talks **only** to internal `/api/ai/*` endpoints — verified via `performance.getEntriesByType("resource")`: the only host ever contacted is the app origin. The provider key lives in server env vars and is redacted if it ever appears in a log.

## Acceptance tests

With the production server running:

```bash
node scripts/test-leave.mjs http://localhost:3000          # full 14-item checklist suite
node scripts/verify-leave-rules.mjs http://localhost:3000  # quick decision-rules regression
node scripts/verify-at.mjs http://localhost:3000           # AT-01…AT-11 assistant suite
```

`test-leave.mjs` covers all 14 checklist items (pending creation, visibility, approve/reject fields + balance math, 409 first-decision-wins, 403 employee/self, 422 over-balance/overlap/approval-revalidation, working-day counting across weekends and public holidays, 401 strict auth). Run each suite against a freshly started server — the ledger is in-memory. Expected: `ALL CHECKLIST CHECKS PASSED ✅`.

## Key seeded test facts

- Engineering: **7 active** employees (8 total incl. 1 resigned) — AT-01
- October 2026 latecomer ranking: **Bilal Ahmed ×7**, Ayesha Khan ×4, … — AT-02
- October 2026 attendance rate: **96%** (matches dashboard) — AT-03
- Taha's sick balance: **6 of 8 remaining**, 2 days *pending* (not deducted) — AT-04
- “next Monday and Tuesday” (from Sun 2026-10-25) → **casual 2026-10-26 → 2026-10-27** — AT-06
- Payroll aggregate: **PKR 2,040,000/month** for 16 active employees (aggregates only, Admin/HR)
