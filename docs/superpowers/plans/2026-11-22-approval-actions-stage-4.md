# Approval actions and posting (stage 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recon version says, per change, what to send to the bank at each approval event (a level approved, the
final approval, a reject), which variant fits a break, and how each request field is filled from the recon's data; the
approval writes those calls to an outbox in its own transaction and a worker sends each once, in order, in the
background; the break, the Breaks list and Today show the posting result.

**Architecture:** The action setup lives in the recon version (`approvals.accounts`, `approvals.lookups`,
`approvals.changes.<kind>.actions`), checked like the workflow setup (stage 1). A pure mapping engine in
`packages/shared/src/mapping.ts` builds a payload from a break context (stage 1 catalog + approval fields). The
approvals module calls `enqueueActions` (integrations) inside the decision's transaction; `action_runs` (space-owned,
RLS) is the outbox; a pg-boss queue `integrations.action` sends one run per job through `sendOperation` (stage 3), with
`queued → sending` taken atomically, never resent, and a janitor turning a stale `sending` into `timeout`.

**Tech Stack:** Bun, Elysia, Drizzle, PG18, pg-boss, Next 16, React Query, React Flow (`@xyflow/react`, installed).

**Spec:** `docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md` §4.4–4.7, §4.8 (break, Breaks list,
Today), §5, §10; DEC-052 amendment 2, DEC-053 (and its amendment). Stage 5 (group mode, Posting groups, Closing) is not
here: `dispatch.mode` is `each` only in this stage's contract.

## Global Constraints

- O4: a run is sent at most once; no retry, no resend, no transition back to `queued`; `sending` older than the operation's limit + 60 s becomes `timeout` (janitor).
- O5: the approval never waits for the bank; posting results never change the break's state.
- O6: no variant fits → run `no_rule` (no call). O9: `per: "item"` (default) or `per: "request"`.
- Pinned references: workflow `{id, version}` (stage 1); operation `{connectorId, version, key}` (DEC-053: one reviewed connector version).
- Payload queued encrypted (`encryptSecret`); after sending only a masked copy is kept (operation `masked`); never in logs, activity or CSV.
- Limits: 10 actions per change, 20 variants per action, 300 mapped fields per variant, 50 accounts, 20 lookups of 500 rows.
- Override fires, in order, `level_approved` for every level it skips (from the current one), then `approved`, all marked override (§10).
- Runs of one request are sent in `seq` order; a run waits until every earlier run of its request is finished.
- Circuit per (connector, environment): 5 transport failures in a row → open 60 s → `not_sent` without a call (state in PostgreSQL).
- Copy: English, sentence case, verb + object; posting statuses "Posted", "Failed", "Not sent", "Timeout", "No posting rule", "Skipped".

## Review Focus

- Double click Approve / two workers on one job → exactly one run per (request, action, event, item) and one call. Test in Task 4.
- A required operation field the break doesn't have (empty attr) → run `failed` with `build_error <field>`, no call. Test in Task 2/4.
- An approval-only recon change after the recon is live → a request opened before keeps its own config version's actions. Test in Task 4.
- The worker dies after the request left → `timeout`, never sent again. Test in Task 5.
- A force match with `per: "item"` → one run per item, each built from that item's side fields. Test in Task 4.

---

### Task 1: Contract — accounts, lookups, actions, variants, mapping sources

**Files:** `packages/shared/src/contracts/recon.ts` (extend `ReconApprovalSpec`), `packages/shared/src/mapping.ts` (types + `TRANSFORMS` list), test `packages/shared/src/mapping.test.ts`.

**Interfaces (produced):**
- `Source = { kind: "field"; key: string; transforms: Transform[] } | { kind: "const"; value: string } | { kind: "template"; text: string } | { kind: "lookup"; table: string; key: Source; fallback?: string } | { kind: "account"; account: string; part: "number" | "label" | "currency" }`.
- `Transform` = string `"date:<pattern>" | "amount:minor" | "amount:major:<n>" | "pad_left:<n>:<c>" | "pad_right:<n>:<c>" | "trim" | "upper" | "lower" | "truncate_left:<n>" | "truncate_right:<n>" | "default:<v>" | "abs"`.
- `ReconApprovalSpec.accounts: { key, label, number, currency }[]`, `.lookups: { name, rows: { key, value }[] }[]`, `.changes.<kind>.actions: Action[]` with `Action = { name, kind: "posting" | "notify", on: { event: "level_approved"; level: number } | { event: "approved" } | { event: "rejected" }, variants: Variant[] }`, `Variant = { name, when: Condition, operation: { connectorId, version, key }, mapping: Record<string, Source>, per: "item" | "request", zeroOrNegative: "skip" | "absolute_swap" }`.
- Catalog grows `approval.level`, `approval.by`, `approval.at`, `request.note`, `request.kind` (shared `BREAK_FIELDS`).

- [ ] Tests: limits refused (11 actions, 21 variants, 301 mapped fields); a template referring to `{accounts.nope.number}` refused at parse; defaults (`per: "item"`, `zeroOrNegative: "skip"`, `actions: []`, `accounts: []`); old specs (no actions) parse.
- [ ] Implement; `bun run --filter @starterkit/shared test` → PASS; commit `feat(shared): approval actions, variants and mapping sources in the recon version`.

### Task 2: The mapping engine (pure)

**Files:** `packages/shared/src/mapping.ts`, test `mapping.test.ts`.

**Interfaces (produced):**
- `applyTransforms(value: string, ts: readonly Transform[], ctx: { currency?: string }): string`.
- `renderTemplate(text: string, ctx: Context, accounts, lookups): string` — `{field|t1|t2}` and `{accounts.<key>.<part>}`.
- `buildPayload(v: Variant, op: { request: OpField[] }, ctx: Context, setup: { accounts; lookups }): { ok: true; payload: unknown; sources: Record<string, string> } | { ok: false; code: "build_error" | "lookup"; field: string; message: string }` — dot paths into nested objects; required fields of `op.request` that end up empty (and have no preset/auto in the operation) → `build_error`; a value longer than `maxLength` without a truncate transform → `build_error`; numbers typed `numeric` sent as numbers.
- `pickVariant(variants, ctx): { index: number; variant: Variant } | null`.
- Amount: `amount:minor` uses `CURRENCY_EXPONENT` (JPY 0, KWD 3, default 2); `zeroOrNegative: "skip"` → `null` payload signal `{ ok: false, code: "skipped" }`.

- [ ] Tests: each transform (dates in Asia/Jakarta `yyMMdd`, minor units for IDR/JPY/KWD, pads, truncates, default, abs); the owner's remark example `{side_a.attrs.e2e_id}{accounts.suspense.number}{break.business_date|date:yyMMdd}`; a lookup hit, miss with fallback, miss without (`lookup` + message names table and value); required empty → `build_error` naming the field; nested paths `DE48.Remark`.
- [ ] Implement; PASS; commit `feat(shared): mapping engine — sources, templates, transforms, lookups`.

### Task 3: Checked in the recon version

**Files:** `apps/api/src/modules/recon/rules.ts` (`checkActions`), `service.ts` (save warns, submit/approve refuse), `usedFields` (mapping and condition fields count), `apps/api/src/modules/integrations/index.ts` (`connectorFacts(tx, ids)` → published/retired versions, operations by key with request fields, disabled).

- [ ] Tests (unit + recon integration): unknown connector, version never published, operation key missing in that version, a mapped request path the operation doesn't have, a required field neither mapped nor preset nor auto, a catalog field no longer read, an account or lookup that doesn't exist — each refused on submit naming change, action, variant and field ("Unmatch · Post to GL · Default: DE48.Remark is required. Map it, or give it a fixed or auto value."); saved as warnings.
- [ ] Implement; commit `feat(recon): actions checked in the recon version`.

### Task 4: Outbox — action_runs written with the decision

**Files:** `apps/api/src/modules/integrations/{schema,actions}.ts`, migration `0054_action_runs.sql` (RLS via `recon_enable_space_rls`), `apps/api/src/modules/approvals/requests.ts` (call `enqueueActions` in approve, override, reject), `apps/api/src/modules/engine/index.ts` (export `breakContextOf(tx, spaceId, itemId, counterparts)`).

**Interfaces (produced):**
- `action_runs (id, space_id, request_id, config_version_id, action_index, action_name, kind, event, level, item_id null, seq, override bool, connector_id, connector_version, operation_key, status queued|sending|posted|failed|not_sent|timeout|no_rule|skipped, payload_enc, payload_masked, response_masked, external_id, bank_reference, code, message, filled jsonb, sending_at, finished_at, created_at)`; unique `(request_id, action_index, event, level, coalesce(item_id, '00000000-…'))`.
- `enqueueActions(tx, ctx, rq, events: { event; level?; override }[]): Promise<number>` — reads the request's `config_version_id` spec (never the live one), builds each run (variant per item or request), inserts with `on conflict do nothing`, enqueues a job per queued run in the same transaction (`enqueue(..., { tx })`).

- [ ] Tests: level 1 of 2 approved fires `level_approved:1` actions only; final fires `approved`; reject fires `rejected`; override from level 1 of 3 fires `level_approved:1`, `:2`, `:3`, `approved` in seq order, marked override; a double approve writes no second run; force match `per: item` → one run per item; no variant → `no_rule`; empty required → `failed build_error`; a request opened before a new recon version keeps its version's actions.
- [ ] Implement; commit `feat(integrations): approval decisions write their actions to an outbox`.

### Task 5: Worker, circuit and janitor

**Files:** `apps/api/src/kernel/jobs.ts` (queue `integrations.action`, its own policy `standard`, concurrency 4), `apps/api/src/modules/integrations/{worker,schema}.ts` (`connector_circuits`), `apps/api/src/worker.ts`, `apps/api/src/db/janitor.ts`.

- [ ] Tests: two workers on one run → one call (`queued → sending` atomic); a run waits while an earlier `seq` of its request is queued/sending (re-enqueued `startAfter` 2 s); posted / failed (bank code + message) / not_sent / timeout map from `sendOperation` and the success rule; payload_enc cleared and payload_masked kept after sending; 5 transport failures open the circuit → next run `not_sent` "The bank is unreachable: calls paused for 60 s." without a call; a disabled connector → `not_sent`; janitor turns a stale `sending` into `timeout`.
- [ ] Implement; commit `feat(integrations): action worker — sent once, in order, with a circuit breaker`.

### Task 6: Read side — posting on the break, the list and Today

**Files:** `apps/api/src/modules/integrations/actions.ts` (`runsOfRequest`, `postingOf(itemIds)`), engine break detail (`posting` block), break list filter `posting` + facets + column + CSV, Today summary; contracts and README rows. Routes: the break detail grows `posting`; one new route `POST /v1/spaces/:spaceId/recons/:configId/versions/:versionId/actions/preview` (body: change, action index, itemId → the variant picked, the payload masked, and each field's source).

- [ ] Tests: break detail shows the last posting run (status, bank reference, code, message, time); request/response masked only for `integration.view` or the space admin; list filter Posting with counts; CSV carries status/code/reference only; preview with a real break picks the variant and shows the payload masked.
- [ ] Implement; commit `feat(breaks): posting result on the break, the list, Today and a payload preview`.

### Task 7: Web — Approval step actions, variants, mapper, preview

**Files:** `apps/web/src/features/recon/{actions-editor,variant-editor,mapper,payload-preview}.tsx`, `approval-step.tsx` (per change: "When level N is approved / when approved / when rejected → do [action]" sentences), accounts and lookups panel.

- Mapper: left the catalog (break, recon, side A, side B, approval, accounts), right the operation's request tree (required `*`, preset/auto dimmed "Fixed" / "Auto generated", missing required red); click a right field → panel: source kind (field, fixed, template, lookup, account), transforms as chips, the sample value from a real break; lines drawn with React Flow when wide (≥ 1280), a list of rows below that (touch and keyboard never need drag).
- [ ] Tests (pure helpers): mapping completeness per variant; sentence of an action; then typecheck, lint, budget ≤ 300 kB (load the mapper with `next/dynamic`).
- [ ] Browser check; commit `feat(web): approval actions, variants and the field mapper in the recon setup`.

### Task 8: Web — posting on the break, Breaks list and Today

- [ ] Break page panel "Posting" (status chip, bank reference, code, message, time; request/response masked behind a disclosure for permitted users); Breaks list column and filter; Today "3 failed, 1 timeout" per recon. Tests for the pure helpers; commit `feat(web): posting results on breaks, the list and Today`.

### Task 9: Docs, Figma, final review

- [ ] DEC-052 amendment 3 (actions, outbox, worker, statuses); spec status line; Figma 06 v1.0.4 actions + mapper + swimlane request view (owner's reference, 22 Nov) and 07 Open API (owed since stage 3); `bun run check`; final whole-branch review (opus); fixes; push.
