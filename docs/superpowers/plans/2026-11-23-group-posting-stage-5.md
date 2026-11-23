# Group posting (stage 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A posting variant can say "grouped by Merchant ID, sent at 16:00 (or at day close)": each approved break
joins the open group of its key values, currency and period in the approval's transaction, and the group is sent to the
bank once, as one call, when its time comes; the recon shows its Posting groups, the break shows "In group … waiting
until …" then the group's result, and sign-off waits for the day's groups.

**Architecture:** The variant's `per` grows `"group"` with `group: { key, at, cutoff }` (contract only, no new source
kind: the group's values are catalog fields `group.*` the mapper reads like any other field). `enqueueActions`
(integrations) joins a member (`posting_group_items`) under a row lock on the open `posting_groups` row instead of
writing a run. Closing (`closeGroup`) builds one payload from the members' saved contexts, writes one `action_runs`
row (`group_id`, no request) and enqueues it; the stage 4 worker sends it unchanged. Closing is called by a per-minute
job (cutoff passed) and by the engine's day close (`closeDay`, the moment the close time has passed).

**Tech Stack:** Bun, Elysia, Drizzle, PG18, pg-boss, Next 16, React Query.

**Spec:** `docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md` §1 O7/O9/O10, §4.4 (dispatch group,
validation 6), §4.5 (`group` sources), §4.6.2 and §4.6.5, §4.8 "Recon → Posting groups", §5 (approved after cutoff;
day closed with an open group), §7 stage 5. Stage 4 plan: `docs/superpowers/plans/2026-11-22-approval-actions-stage-4.md`.

## Global Constraints

- O4: a group run is sent at most once (stage 4 worker: no retry, `queued → sending` atomic); one run per group (unique `action_runs.group_id`).
- O7: no extra approval; sent at the variant's time: `cutoff` HH:mm Asia/Jakarta, or `day_close` (the recon day's close).
- O10: period = approval date in Asia/Jakarta; with a cutoff, an approval at or after it belongs to the next day.
- A closed group never takes members; once the recon day of a period has started closing, new members go to the next period.
- At most 500 members per group (`GROUP_MAX`); the 501st opens part 2 of the same period.
- An empty group never sends; a member whose break is reopened later stays (no reversal, §5).
- Sign-off (prepare and sign) is refused while the day has an open group or a group run queued or sending.
- Group mode only on a `posting` action fired on `level_approved` or `approved`; key fields are catalog fields of kind text, date, list or number from the break, recon or either side (not approval fields); at most 5.
- Copy: English, sentence case, verb + object; the key is shown as its field label and value ("Merchant ID 0012345"), an empty key as "No Merchant ID"; never a field key or id on screen.
- Statuses on screen: group Open / Closing (its run queued or sending) / the run's result; a waiting member "Waiting for group".

## Review Focus

- Two approvals joining the same new group at once → one group row, two members (insert on conflict, then lock). Test in Task 2.
- An approval that waited on the group's lock while the cutoff job closed it → joins the next period, never the closed group. Test in Task 2.
- A break of a request approved twice (double click) → one member. Test in Task 2.
- Day close and the cutoff job both closing one group → one run. Test in Task 3.
- A key field empty on a break → member in a group whose key value is "" (shown "No …"), not dropped. Test in Task 2 and Task 6 (web text).

---

### Task 1: Contract and the group payload (shared, pure)

**Files:** `packages/shared/src/contracts/recon.ts` (Variant), `packages/shared/src/mapping.ts`, `packages/shared/src/conditions.ts`, tests `mapping.test.ts`.

**Interfaces (produced):**
- `Variant.per: "item" | "request" | "group"`; `Variant.group?: { key: string[] (catalog keys, ≤ 5), at: "cutoff" | "day_close", cutoff: "HH:MM" | null }`; refine: `per === "group"` ⇒ `group` set, `at === "cutoff"` ⇒ `cutoff` set. Source `field` key regex also takes `group.`.
- `GROUP_MAX = 500`, `GROUP_KEY_MAX = 5` (mapping.ts); `groupFields(keys: string[], catalog: CatalogField[]): CatalogField[]` (conditions.ts, group `"group"`): `group.sum` "Total amount" money, `group.count` "Number of items" number, `group.period` "Period" date, `group.key.<field>` "Group key: <label>" (kind of the field). `KEY_KINDS = ["text","date","list","number"]`.
- `periodOf(at: Date, cutoff: string | null): string` (yyyy-MM-dd, Jakarta, at/after cutoff → next day); `closesAtOf(period, cutoff): Date`.
- `buildGroupPayload(v, op, members: Context[], group: { period; keys: { field; value }[] }, setup, handled): Built` — group context = first member + `group.*` + `break.amount` = sum; sum ≤ 0 with `zeroOrNegative: "skip"` → skipped; fields under an `array` request field are built once per member (items[]); everything else from the group context.

- [x] Tests: `periodOf` (15:59 → same day, 16:00 → next, null cutoff → same day, 23:30 UTC+7 boundary); a group variant without `group` refused; `buildGroupPayload` sums minor units (`group.sum|amount:major:2`), counts, reads `group.key.side_a.attrs.merchant_id`, an array `Items` with one element per member, required element field empty → `build_error` naming `Items[1].Ref`, sum 0 → skipped.
- [x] Implement; `bun run --filter @starterkit/shared test`; commit `feat(shared): grouped variants and the group payload`.

### Task 2: Groups — tables, joining in the approval

**Files:** `apps/api/src/modules/integrations/{schema,groups,actions,index}.ts`, migration `0059_posting_groups.sql` (generated + RLS lines), test `apps/api/src/modules/engine/tests/integration/break-groups.test.ts`.

**Interfaces (produced):**
- `posting_groups (id, space_id, config_id, config_version_id, action_index, variant_index, action_name, variant_name, keys jsonb [{field,label,value}], key_text, currency, period date, part smallint, at, closes_at null, status open|closed, members int, total_minor numeric, run_id null, closed_at, created_at)`; unique `(config_version_id, action_index, variant_index, key_text, currency, period, part)`; RLS.
- `posting_group_items (group_id, space_id, request_id, item_id, action_index, ref, amount_minor, currency, context jsonb null, joined_at)`; unique `(request_id, action_index, item_id)` (a break joins once per request and action); RLS.
- `action_runs.request_id` nullable, `action_runs.group_id uuid` unique where not null.
- `joinGroup(tx, spaceId, at: { configId, configVersionId, actionIndex, variantIndex, action, variant, labels }, member: { requestId, itemId, context }, now): Promise<{ groupId } | null>` (null = already a member).
- In `enqueueActions`: a picked variant with `per: "group"` (posting, approved/level approved) joins instead of writing a run; `skip` amount still writes a `skipped` run.

- [x] Tests: approve → one open group (period today Jakarta, key value, members 1, total), no run; second break, same key → same group; other key → other group; key empty → value "" group; approve after the cutoff → next day's period; recon day of the period already closing → next period; double approve → one member; concurrent joins of a new group → one group; group full (members 500, set in the test) → part 2; a closed group → next period.
- [x] Implement; commit `feat(integrations): approved breaks join their posting group`.

### Task 3: Closing — cutoff job, day close, the group run

**Files:** `integrations/groups.ts` (`closeGroup`, `closeDueGroups`, `closeGroupsOfDay`), `integrations/worker.ts` (handler `{ groups: true }`), `apps/api/src/worker.ts` (schedule every minute), `engine/breaks.ts` (`closeDay` calls `closeGroupsOfDay` once the close moment passed), test `break-groups.test.ts`.

**Interfaces (produced):**
- `closeGroup(tx, spaceId, groupId): Promise<"sent" | "empty" | "already">` — locks the open group, builds `buildGroupPayload` from members' contexts, inserts the run (`group_id`, `seq` 1, `queued` + encrypted payload, or `failed`/`skipped` finished), enqueues it in `tx`, sets `status closed, run_id, closed_at`, clears member contexts. Empty → closed, no run.
- `closeDueGroups(on: Tx, now): Promise<number>` — every space's open `cutoff` groups with `closes_at <= now`, one transaction each.
- `closeGroupsOfDay(tx, spaceId, configId, date): Promise<number>` — every open group of the config with `period <= date`.

- [x] Tests: cutoff passed → one run with the summed payload, members point at it, worker sends it (stub fetch as worker.test.ts); `closeDay` past its close moment closes the day's day_close and cutoff groups; closing twice → one run; empty group → no run.
- [x] Implement; commit `feat(integrations): posting groups close at their cutoff or at day close`.

### Task 4: Sign-off waits; publish checks

**Files:** `engine/signoff.ts` (`groupsWaiting(tx, spaceId, configId, dates)` from integrations), `recon/rules.ts` (`checkActions`), tests `signoff.test.ts`, `recon` rules unit test.

- [x] Tests: prepare refused `invalid_state` "1 posting group of this day is still open or being sent. Wait for it to be sent." while a group of period ≤ date is open or its run queued/sending; signoff list `blocked` says the same. checkActions: group on a notify action, on rejected, a key on `break.amount` (money) or `approval.by`, an unknown key, `group.*` read by a non-group variant → each refused naming the place.
- [x] Implement; commit `feat(engine): sign-off waits for the day's posting groups; grouped variants checked on publish`.

### Task 5: Read side — Posting groups, break detail, posting list

**Files:** `integrations/groups.ts` (`groupPage`, `groupOf`), `integrations/controller.ts` (`GET /v1/spaces/:spaceId/recons/:configId/posting-groups`, `…/posting-groups/:groupId`), `integrations/actions.ts` (`runsOf` adds the break's group entries; run rows carry `group`), `packages/shared/src/contracts/breaks.ts` (`PostingGroupListQuery`, `PostingGroupRowDto`, `PostingGroupDto`; `ActionRunDto.group`, status `grouped`; `ActionRunRowDto.group`), `packages/shared/src/paging.ts`, `posting.ts` (label "Waiting for group"), `apps/web/scripts/emit-api-schemas.ts`, `docs/api/README.md`, `bun run api:schemas`.

- [x] Tests: list pages and sorts by period, status filter open/closed; detail lists members; another space's group 404; break detail of a waiting member → entry `grouped` with period and closes at, then the group run's status once sent; the posting list row of a group run names its group and member count.
- [x] Implement; commit `feat(integrations): posting groups list and detail; the break's group`.

### Task 6: Web — variant editor, mapper, Posting groups tab, break panel

**Files:** `apps/web/src/features/recon/{action-screen,actions-model,posting-groups,recon-detail,recon-text}.tsx|ts`, `apps/web/src/lib/shared/{queries,posting}.ts`, `apps/web/src/lib/server/prefetch.tsx`, `app/(main)/spaces/[spaceId]/recons/[configId]/page.tsx`, `features/breaks/break-page.tsx`, `features/integrations/posting-page.tsx`.

- Variant editor: "Send" select (One call per item / One call for the request / Grouped); grouped shows "Group by" (multi-pick, key-capable fields, caption "e.g. Merchant ID") and "Send at" (Cutoff time + time input, red * / At day close) on aligned rows; the mapper's catalog grows the Group fields.
- Posting groups tab: table (Period, Group key, Items, Total, Status chip, Sends at), row opens a sheet (`?group=`) with its members (item link, amount, approved at) and run result.
- Break panel: a `grouped` entry reads "In group 23 Nov 2026 · Merchant ID 0012345 · waiting until 16:00" (or "until day close").
- [x] Tests (pure): `groupKeyText([{label:"Merchant ID",value:""}])` = "No Merchant ID"; `groupStatus` Open/Closing/result; `unfinishedReason` for a grouped cutoff without time; typecheck, lint, budget ≤ 300 kB.
- [x] Commit `feat(web): grouped posting in the variant editor, Posting groups tab and the break`.

### Task 7: Docs and final check

- [x] DEC-052 amendment 4 in `docs/decisions.md` (group mode, rulings), spec status line "tahap 5 dikirim", AGENTS.md ownership line (`posting_groups`, `posting_group_items`); `bun run check`; budget; commit.

## Rulings (owner: "ambil rekomendasi lo"; each with its cost if wrong)

Recorded in `.superpowers/sdd/2026-11-23-group-posting-stage-5/progress.md` as they are made.

| # | Ruling | Cost if wrong |
|---|---|---|
| R1 | Identity = (recon **version**, action index, variant index, key values, currency, period, part): the version pins the mapping and operation a payload is built with | a recon published mid-day splits that day's members into two sends |
| R2 | Currency is always part of the key | a bank that wants several currencies in one call needs a new mode |
| R3 | Period = approval date in Asia/Jakarta; with a cutoff, at/after HH:mm → next day; once the recon day of the period has started closing (a `recon_days` row) or its group is closed, a joiner goes to the next period | a member approved after Closing waits a full day |
| R4 | Members join in the approval transaction under a row lock on the open group (insert part on conflict do nothing, then `for update`); one member per (request, action, break) | a hot group (one merchant) serialises its approvals on one row |
| R5 | A per-minute job (`integrations.action` `{ groups: true }`) closes cutoff groups past `closes_at`; day close (`closeDay`, once the close moment passed) closes every open group of the recon with period ≤ that date, cutoff ones early | a day_close group of a date without a recon day waits for the next day's close |
| R6 | Closing writes one `action_runs` row (`group_id` unique, no request, seq 1) from the members' contexts saved at join; the stage 4 worker sends it once | member data is the approval-time snapshot, not re-read at close |
| R7 | Cap 500 members; the 501st opens part 2 of the same period (`ponytail:`) | a bank limit below 500 needs a setting |
| R8 | An empty group never sends (closed, no run); a reopened member's break stays in its group | — (spec §5) |
| R9 | Sign-off prepare/sign refused while a group of period ≤ the day is open or its run queued/sending | a stuck worker blocks sign-off until the 15-minute sweep marks the run not sent |
| R10 | Group mode only on `kind: posting` fired on `level_approved`/`approved`; keys ≤ 5 catalog fields of kind text, date, list **or number** (owner 23 Nov: ID-like codes catalogued as numbers, exact match), from break/recon/sides, not approval fields; checked on submit (saved as warnings) | a number key with decimals groups 1.0 and 1 apart (exact text match) |
| R11 | `group` sources are catalog fields, not a new source kind: `group.sum` (sum(amount)), `group.count`, `group.key.<field>`, `group.period`; plain fields outside an array read the first member (first(field)); fields under an `array` request field are built once per member (items[]) | a bank wanting a one-element array built from the group needs an explicit marker |
| R12 | An empty key value groups as "" and shows "No <label>" | — (owner 23 Nov) |
| R13 | Key labels are saved on the group at join (catalog label then) | a renamed source column keeps its old label on old groups |
| R14 | Zero/negative: a member ≤ 0 with `skip` writes its own `skipped` run and doesn't join; a group whose sum ≤ 0 with `skip` ends `skipped` | — |
| R15 | No manual "send now" (YAGNI) | a stuck cutoff can't be forced from the screen |
| R16 | The unmatch list has no posting facet at 6b5bbed (break-queue.ts, Batch 8's file); "Waiting for group" shows in the break's panel and on the Posting groups tab; the facet is left to the posting-facet work | an operator can't filter the unmatch list by "Waiting for group" |
| R17 | Group detail is a sheet on the tab (`?group=<id>`), not a page of its own | no breadcrumb for a group |
| R18 | (while building) The change (unmatch, write_off, …) is part of the identity: action indexes count per change | none |
| R19 | (while building) `closeDay` closes the groups once its close moment has passed, before its wait for complete data | late data's breaks approved after that go to the next period |
| R20 | (while building) A break waiting in a group shows its event as "Approved" (groups keep no event) until the group's run exists | a level-approved group reads "Approved" while it waits |
| R21 | (review C1) In a group's context every money field of the break (`break.amount`, `side_*.amount_minor`) is the group's total of it, signed; other plain fields outside an array stay the first break's, and a save warns (never refuses) when a grouped variant reads one that is neither a key nor money. The editor's sample group = the chosen break + the first other break of the recon (of 10 read) with the same key, currency and sign, else a copy of it | a field every break shares by data (not by key) still shows the warning |
| R22 | (review I2) Joining a group holds a per-config advisory lock shared (`postingGroupsLock`, kind 5), closing groups holds it exclusive | an approval waits for a running day close's transaction |
| R23 | (review I3) A day_close group keeps `closes_at` = its period's close moment by the version's schedule (none: end of the period day); the per-minute job sends it at `closes_at` + the version's grace (60 min when none); open 5 min past `closes_at` = late (Degraded chip, Today line). Existing rows are backfilled to the end of their period | a recon whose day close always runs later than close + grace sends its groups from the job instead |
| R24 | (review I4) The sign (`break.amount` < 0) is part of the identity (`negative`, migration 0060); absolute_swap sends a negative group's total through the mapping's `abs` as a single run does | a bank that wants one netted call per key needs a new mode |
| R25 | (review I5) A numeric field beyond 2^53 − 1, or a decimal of more than 15 digits, is a `build_error` (alone or a group's total) | such an amount needs a text field at the bank |
| R26 | (review) A member's values are encrypted (`context_enc`, `encryptSecret`, as `payload_enc`); a plaintext `context` from before is read once and cleared | — |
| R27 | (review) A group whose build throws ends as a failed run (`build_error`) in its own savepoint; the job goes on to the next group | the cause is only in the log |
| R28 | (review) A sixth key field is refused in the picker itself: the other options are disabled with the reason as their second line | — |
