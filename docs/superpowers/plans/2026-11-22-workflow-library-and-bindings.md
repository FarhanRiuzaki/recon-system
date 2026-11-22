# Workflow library and approval rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split phase A's per-space workflows into a global, versioned workflow library (chains of levels) and per-space approval rules (bindings) that pick a library workflow per trigger by conditions.

**Architecture:** The `approvals` API module keeps ownership. New global tables `workflows` + `workflow_versions` (no space, no RLS) hold named chains; phase A's `approval_workflows` becomes `approval_bindings` (same versioning, RLS), whose rules now carry `workflowId` instead of `levels`, plus `otherwise`. `openRequest` resolves binding → workflow → its latest published version and snapshots the chain as today.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle, PostgreSQL 18, zod, Next 16, React Query, dnd-kit (installed), DS Combobox.

**Spec:** `docs/superpowers/specs/2026-11-22-workflow-library-and-bindings-design.md` (read with `2026-11-22-approval-workflow-engine-design.md`, still valid outside §4.2–§4.3 and §5).

## Global Constraints

- Only `workflow.manage` holders create or edit library workflows; another `workflow.manage` holder publishes; a Superadmin publishes their own version only by override with a reason (spec §4.2).
- Approval rules: a space admin of the space or a `workflow.manage` holder edits; another one of them publishes (unchanged from phase A).
- Every approver (space role, app role or named user) counts only if they are an active member of the request's space (spec §4.2).
- Rules always use the referenced workflow's latest published version at request open; requests keep their snapshot (`chain`, `workflow_name`, `rule_name`).
- Publishing a workflow is never blocked by a space that would be short of approvers; Used by and the review panel flag it; request open still refuses a short level.
- Limits unchanged: 20 rules, 8 conditions, 5 levels, 4 groups, 20 people; names ≤ 80 (`RULE_NAME_MAX`).
- Trigger keys stay `force_match`, `unmatch`, `write_off` (path-safe for the BFF catch-all `[a-z0-9/_-]`); request `kind` values unchanged.
- Repo rules: AGENTS.md §11–§13 (route order, `recordActivity` in the transaction, `pageQuery` for lists, docs table + `bun run api:schemas`, conformance allowlists with reasons), copy guide (verb + object, no slop), owner rules: no ids or field names on screen, autosave + URL for anything typed, red `*` for required, scroll fade, symmetric layout.
- No Playwright runs: affected tests + `bun run check` only; browser checks through the MCP Playwright tool on :3000 are fine. Push only to remote `recon`, branch `feat/recon-phase1`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A rule pointing at a workflow that gets archived or has no live version: save/submit of the rules refuses it (400 naming the workflow); archive refuses while any published or open rules version references it (409 naming space and trigger). Tests in Tasks 3 and 4.
- A named approver who is not a member of the request's space: not counted, so the level is short in that space; Who approves and Used by show it. Tests in Tasks 3 and 5.
- Two managers editing the same workflow draft concurrently / a second "start draft": the one-open-version unique index answers 409 `invalid_state`, never two drafts. Test in Task 3.
- A request opened while the workflow's new version is being published: it takes whichever version is published at its own transaction's read; the earlier request never changes. Test in Task 5 (open, publish v2, the open request still shows v1 levels).
- A space admin without `workflow.view` editing rules still sees the library to pick from (the rules detail carries `library`); `GET /v1/workflows` stays 403 for them. Test in Task 4.

---

### Task 1: Shared vocabulary and contracts

**Files:**
- Modify: `packages/shared/src/workflows.ts`
- Modify: `packages/shared/src/contracts/workflows.ts`
- Modify: `packages/shared/src/audit.ts` (labels), `packages/shared/src/permissions.ts` (comment on `workflow`)
- Test: `packages/shared/src/workflows.test.ts` (create if absent)

**Interfaces:**
- Produces (in `workflows.ts`): `TRIGGERS = ["force_match","unmatch","write_off"] as const`, `type Trigger`, `TRIGGER_LABEL`, `TRIGGER_TEXT` (the old `WORKFLOW_ACTION_*` values), `TRIGGER_MODULE: Record<Trigger, "Breaks">`; `type Chain = { name: string; levels: Level[] }`; `type BindingRule = { name: string; when: Condition[]; workflowId: string }`; `type BindingSpecShape = { rules: BindingRule[]; otherwise: string | null }`; `DEFAULT_CHAIN: Chain = { name: "Default", levels: DEFAULT_LEVELS }`; `pickBinding(spec: BindingSpecShape | null, a: Attributes): { index: number | null; ruleName: string; workflowId: string | null }` (first rule whose conditions all hold → its `name`/`workflowId`; none → `index: null`, `ruleName: "Otherwise"`, `workflowId: spec?.otherwise ?? null`; no spec → `ruleName: "Default"`, `workflowId: null`). `holds`, `groupNeeds`, `Level`, `Group`, `Need`, `Condition`, limits stay. Remove `Rule`, `WorkflowSpecShape`, `DEFAULT_RULE`, `pickRule`, `WORKFLOW_ACTIONS*` (no aliases; fix callers in later tasks).
- Produces (in `contracts/workflows.ts`): `ChainSpec` = `{ name: 1..80 trimmed, levels: Level[1..5] }`; `BindingSpec` = `{ rules: { name, when, workflowId: uuid }[0..20], otherwise: uuid | null }`; `ChainVersionDto` (= old `WorkflowVersionDto` with `spec: ChainSpec`); `LibraryRowDto { id, name, levels: int, published: { version, decidedAt } | null, open: { version, status: "draft"|"in_review", updatedAt } | null, rulesUsing: int, spacesUsing: int, archived: boolean }`; `LibraryDetailDto { id, name, archived, published: ChainVersionDto|null, open: ChainVersionDto|null, globalRoles, people, canEdit, reviewBlocked, overrideOnly }`; `UsedByRowDto { spaceId, spaceName, trigger, ruleName, rulesVersion, rulesStatus: "published"|"draft"|"in_review", short: string[] }` (short = level labels like `"Level 2 (Treasury head)"` that would lack people in that space); `CreateWorkflowBody { spec: ChainSpec }`; `SaveChainBody { spec: ChainSpec }`; `RulesVersionDto` (old version DTO with `spec: BindingSpec`); `RulesRowDto { trigger, published: { version, rules: int, otherwise: string|null /* workflow name */, decidedAt } | null, open }`; `RulesListDto { items }`; `RulesDetailDto { trigger, published, open, library: { id, name, levels: int }[], canEdit, reviewBlocked, overrideOnly }`; `SaveRulesBody { spec: BindingSpec }`; `PreviewRulesBody { spec?: BindingSpec, attributes }`; `PreviewDto` gains `workflow: { id, name } | null`; `RequestViewDto` gains `workflowName: string | null`; `ReviewWorkflowBody`, `ApproveBody`, `RejectBody`, `OverrideBody` unchanged. `TriggerParam = z.enum(TRIGGERS)`.
- Audit labels: add `workflow.create` "Workflow created", `workflow.archive` "Workflow archived", `rules.save` "Approval rules draft saved", `rules.submit` "Approval rules sent for approval", `rules.publish` "Approval rules published", `rules.reject` "Approval rules sent back", `rules.discard` "Approval rules draft discarded"; keep the `workflow.*` ones.

- [ ] **Step 1: Write failing tests** in `workflows.test.ts`:
  - `pickBinding(null, {amount:"5"})` → `{ index: null, ruleName: "Default", workflowId: null }`.
  - spec `{ rules: [{ name: "Large", when: [{attr:"amount",op:"gte",value:"2500000000"}], workflowId: "W1" }], otherwise: "W2" }`: amount `"2500000000"` → `{ index: 0, ruleName: "Large", workflowId: "W1" }`; amount `"1"` → `{ index: null, ruleName: "Otherwise", workflowId: "W2" }`; same spec with `otherwise: null` and amount `"1"` → `workflowId: null`.
  - `BindingSpec.safeParse({ rules: [], otherwise: "not-a-uuid" }).success === false`; `ChainSpec.safeParse({ name: " ", levels: [] }).success === false`.
- [ ] **Step 2:** `bunx vitest run src/workflows.test.ts` in `packages/shared` → FAIL (`pickBinding` not exported).
- [ ] **Step 3:** Implement the Interfaces above.
- [ ] **Step 4:** Same command → PASS. `bun run --filter @starterkit/shared typecheck` may fail on removed names used in `apps/*`; that is expected until Tasks 2–8 (do not add aliases).
- [ ] **Step 5:** Commit `feat(shared): workflow library and approval rules vocabulary (DEC-052 revision)`.

### Task 2: Schema and migration

**Files:**
- Modify: `apps/api/src/modules/approvals/schema.ts`
- Create: `apps/api/drizzle/0049_workflow_library.sql` (+ `meta/` from drizzle-kit)
- Modify: `apps/api/src/modules/approvals/index.ts`, `AGENTS.md` §12 ownership line
- Test: `apps/api/test/db/schema-drift.test.ts`, `apps/api/test/architecture/boundaries.test.ts` (existing)

**Interfaces:**
- Produces: `workflows` (`id uuid pk, name text not null, archived_at timestamptz, created_at`; unique index on `lower(name)`), `workflowVersions` (`workflow_versions`: id, workflow_id → workflows.id on delete cascade, version, status, spec, maker_id, submitted_by, submitted_at, decided_by, decided_at, review_comment, override_reason, created_at, updated_at; partial unique `one_open` (status in draft,in_review) and `one_published` per workflow_id; unique (workflow_id, version); status check as phase A). `approvalBindings` = renamed `approval_workflows` with `trigger` (was `action`), indexes renamed `approval_bindings_one_open|one_published|version`. `approvalRequests` gains `bindingVersionId uuid`, `workflowName text`. Exported from `index.ts`: `approvalBindings, workflows, workflowVersions` (drop `approvalWorkflows`).

- [ ] **Step 1:** Edit `schema.ts` per Interfaces; run `cd apps/api && bun run db:generate -- --name=workflow_library`. If drizzle-kit asks about the table/column, answer "rename"; the file must contain `ALTER TABLE "approval_workflows" RENAME TO "approval_bindings"` and `RENAME COLUMN "action" TO "trigger"`, never a DROP of `approval_workflows`.
- [ ] **Step 2:** Append custom SQL to the same file, before the renames:
  ```sql
  do $$ begin
    if exists (select 1 from approval_workflows w, jsonb_array_elements(w.spec->'rules') r where r ? 'levels') then
      raise exception 'approval_workflows has phase A rules with levels: convert them to library workflows first (DEC-052 revision)';
    end if;
  end $$;
  ```
  and after: `update approval_bindings set spec = jsonb_build_object('rules', spec->'rules', 'otherwise', null);` and `update approval_requests set workflow_version_id = null;`. RLS on the renamed table carries over; `workflows`/`workflow_versions` have no `space_id`, so no RLS.
- [ ] **Step 3:** `cd apps/api && bun test test/db test/architecture/boundaries.test.ts` → PASS (drift, ownership, no `"public".`). Update AGENTS.md ownership: `approvals` workflows, workflow_versions, approval_bindings, approval_requests, approval_decisions.
- [ ] **Step 4:** Commit `feat(approvals): workflow library tables; space workflows become approval rules`.

### Task 3: Library API

**Files:**
- Create: `apps/api/src/modules/approvals/library.ts`
- Modify: `apps/api/src/modules/approvals/controller.ts`, `requests.ts` (only `approversOf`, see Task 5 for its membership rule — implement it here first since Used by needs it)
- Modify: `docs/api/README.md`, `apps/api/test/architecture/conformance.test.ts` allowlists if needed, `apps/web/scripts/emit-api-schemas.ts` (new DTOs), then `bun run api:schemas`
- Test: `apps/api/src/modules/approvals/tests/integration/library.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts, Task 2 tables.
- Produces routes (guard in braces): `GET /v1/workflows` {`workflow.view`} pageQuery (q on name, sort `name|-name|updatedAt|-updatedAt`, default `name`) → `Page<LibraryRowDto>`; `GET /v1/workflows/:id` {view} → `LibraryDetailDto`; `GET /v1/workflows/:id/used-by` {view} pageQuery → `Page<UsedByRowDto>`; `POST /v1/workflows` {`workflow.manage`} body `CreateWorkflowBody` → creates workflow + draft v1 → `LibraryDetailDto`; `POST /v1/workflows/:id/draft` (start from live), `PATCH /v1/workflows/:id/draft` (`SaveChainBody`, autosave, no entry when unchanged), `POST …/draft/submit`, `POST …/draft/discard` (discarding v1 of a never-published workflow deletes the workflow), `POST …/review/approve|reject` (`ReviewWorkflowBody`), `POST …/archive` — all {`workflow.manage`}.
- `approversOf(tx, spaceId, g, exclude)` (requests.ts): result restricted to users with any `space_members` row in `spaceId` and `isActive`.
- Library functions run in `db.transaction` (no space); `usedBy` reads `approval_bindings` through `withSpace({ spaceIds: <every space id from the spaces module's table>, userId: null }, …)`; name it in a conformance allowlist with reason "workflow.view lists which spaces' approval rules use a library workflow (spec §4.2)" if the conformance test requires it.
- `workflows.name` = the published version's `spec.name` (set on publish; a never-published workflow shows its draft name). Unique `lower(name)` violation → 409 `duplicate` "A workflow with this name exists."
- Activity: `workflow.create|save|submit|publish|reject|discard|archive`, target `{ type: "workflow", id, label: name }`.

- [ ] **Step 1: Write failing tests** (`library.test.ts`, signed-in fixtures like `workflows.test.ts`: a `workflow.manage` holder M1, a second M2, a space admin SA without it, a Superadmin S):
  - "M1 creates, M2 publishes": POST → 200, `open.status` "draft"; submit by M1; approve by M1 → 409 `self_approval`; approve by M2 → `published.version` 1, list row `published.version` 1.
  - "SA cannot create or read the library": POST /v1/workflows → 403; GET /v1/workflows → 403.
  - "Superadmin publishes own only by override": S creates+submits; approve without `override` → 409 `self_approval`; with `{override:true, comment:"x"}` → published, `overrideReason` "x".
  - "second start draft is 409": with an open draft, POST …/draft → 409 `invalid_state`.
  - "duplicate name": two workflows published with name "Checker only" → second publish 409 `duplicate`.
  - "archive refused while used": a published rules version in space A uses W → POST …/archive → 409 `invalid_state` with message containing the space name and "Write-off"; after the rules stop using it → 200, list row `archived: true`.
  - "used-by flags a short level": W level 1 names user U only (`users:[U]`); U not a member of space B; rules in B use W → used-by row for B has `short: ["Level 1"]`, row for A (U member) `short: []`.
  - activity entries exist for create/submit/publish/archive.
- [ ] **Step 2:** `cd apps/api && bun test src/modules/approvals/tests/integration/library.test.ts` → FAIL.
- [ ] **Step 3:** Implement `library.ts` + routes; reuse phase A's `reviewRule`/`dto` shape (move shared helpers to `library.ts` or a small `versions.ts` if both files need them).
- [ ] **Step 4:** Same command → PASS; `bun test test/architecture` → PASS after README rows and `bun run api:schemas`.
- [ ] **Step 5:** Commit `feat(approvals): global workflow library API`.

### Task 4: Approval rules API (phase A workflows → bindings)

**Files:**
- Rename: `apps/api/src/modules/approvals/workflows.ts` → `rules.ts`; controller routes `…/workflows…` → `/v1/spaces/:spaceId/approval-rules`, `…/approval-rules/:trigger`, `…/:trigger/preview`, `…/:trigger/draft` (POST, PATCH), `…/draft/submit`, `…/draft/discard`, `…/review/approve|reject` (same guards as phase A)
- Modify: `conformance.test.ts` (rename the `WF` allowlist keys, `NON_LIST_GETS`, `NO_ACTIVITY` preview), `docs/api/README.md`, `bun run api:schemas`
- Rename test: `tests/integration/workflows.test.ts` → `rules.test.ts`

**Interfaces:**
- Consumes: `approvalBindings`, `workflows`, `workflowVersions`, `pickBinding`, `approversOf`.
- Produces: `rulesList(ctx) → RulesListDto`, `rulesDetail(ctx, trigger) → RulesDetailDto` (`library` = every non-archived workflow with a published version: id, name, level count), `startDraft/saveDraft/submitDraft/discardDraft/reviewDraft` as phase A on `approvalBindings`, `previewRules(ctx, trigger, b) → PreviewDto` (pickBinding → workflow's published spec, or `DEFAULT_CHAIN`; `workflow` null for default). Save and submit refuse (400 `bad_request`) a `workflowId` that is unknown, archived or has no published version: "“<name>” has no live version. Publish it in Workflows first." (unknown: "A picked workflow no longer exists."). Activity `rules.save|submit|publish|reject|discard`, target `{ type: "approval_rules", id: "<spaceId>:<trigger>", label: trigger }`.

- [ ] **Step 1:** Port the phase A tests to `rules.test.ts` with the new paths and spec shape, and add:
  - "rules refer to a published workflow": save with `workflowId` of a draft-only workflow → 400 containing "has no live version".
  - "space admin sees the library in the detail without workflow.view": SA GET …/approval-rules/write_off → `library` contains the published workflow's name.
  - "preview picks the rule's workflow": rules `[{ name:"Large", when:[amount ≥ 2500000000], workflowId: W }]`, otherwise null; preview amount "2500000000" → `rule.name` "Large", `workflow.name` = W's name, `levels.length` = W's level count; amount "1" → `rule.name` "Otherwise", `workflow` null, levels = default chain.
- [ ] **Step 2:** `bun test src/modules/approvals/tests/integration/rules.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `bun test test/architecture` → PASS.
- [ ] **Step 5:** Commit `feat(approvals): per-space approval rules pick library workflows`.

### Task 5: Requests resolve through rules

**Files:**
- Modify: `apps/api/src/modules/approvals/requests.ts` (`openRequest`, `requestView`), `apps/api/src/modules/engine/break-requests.ts` (kind type → `Trigger`)
- Test: `apps/api/src/modules/approvals/tests/integration/approvals.test.ts`, `apps/api/src/modules/engine/tests/integration/break-resolve.test.ts` (existing request flows must stay green)

**Interfaces:**
- `openRequest(tx, ctx, { kind: Trigger, … })` unchanged signature; inside: published `approvalBindings` row for (space, kind) → `pickBinding` → workflow id → latest `workflowVersions` row with status `published` for it; none (id null) → `DEFAULT_CHAIN`; id set but no published version → 409 `invalid_state` "The <Trigger label> approval rules point to a workflow with no live version. Ask a space admin to fix the rules." Inserts `bindingVersionId`, `workflowVersionId`, `workflowName` (null for default), `ruleName` (from pickBinding), `chain`. Short-level refusal unchanged, message "Level N (name) of the “<workflow name>” workflow has nobody else who can approve it. Ask a workflow manager to fix it." (default chain: "…of the default chain…").
- `RequestViewDto.workflowName` from the row.

- [ ] **Step 1: Failing tests** in `approvals.test.ts`:
  - "a request takes the rule's workflow": W (2 levels) published; rules in A route write-off ≥ 0 to W; maker requests a write-off → request view `workflowName` = W's name, `levels.length` 2, `ruleName` = the rule's name.
  - "a later publish never moves an open request": then publish W v2 with 3 levels → the same request still has 2 levels.
  - "a named approver outside the space doesn't count": W level 1 `users:[U]`, U not in A → requesting → 409 `invalid_state` containing "has nobody else who can approve it".
  - existing default-chain tests stay green (no rules → `workflowName` null).
- [ ] **Step 2:** `bun test src/modules/approvals src/modules/engine` → FAIL on the new cases.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS. Then `bun run check` (API part) green.
- [ ] **Step 5:** Commit `feat(approvals): requests resolve rules → workflow → live version`.

### Task 6: Web — shared levels editor and the library screens

**Files:**
- Create: `apps/web/src/features/approvals/levels-editor.tsx` (move `Levels`, `NeedPicker`, `ApproverPicker`, `newLevel`, `Options` out of `workflow-rules.tsx`; `Levels` takes `{ levels: Level[]; onChange(levels): void; options; disabled; label: string }`)
- Create: `library-page.tsx` (server `DataTable`: Name, Levels (LevelDots), Live (version or "Not live"), Used by ("3 rules in 2 spaces"), Updated; `SavedViewsMenu` + `ColumnsMenu`; header action "New workflow"), `library-editor.tsx` (name field, `Levels`, autosave, Send for approval, review panel, Draft/Live switch, Discard/Archive in ⋯ with confirm — the phase A `workflow-editor.tsx` minus rules), `used-by.tsx` (Panel "Used by" with a server `DataTable`: Space, Trigger, Rule, Rules version; a `short` row shows "Short of people at Level 2 (Treasury head)" in `text-down-ink`)
- Modify: `lib/shared/queries-recon.ts` (`WORKFLOWS` table def on `/api/workflows`, `workflowLibraryDetail(id)`, `USED_BY` table def), `lib/server/prefetch.tsx` (`reads.library`, `reads.libraryWorkflow`), `app/(main)/workflows/page.tsx` (the list, guard `workflow.view`), `app/(main)/workflows/[id]/{page,loading}.tsx`, `components/route-shapes.ts`, `lib/shared/nav.ts` (Workflows: `href "/workflows"`, group `access`, `perm "workflow.view"`, no `space`), `lib/shared/prefs.ts` (`VIEW_PAGES` "/workflows"), `docs/standards/copy-guide.md` navigation labels
- Test: `lib/shared/nav.test.ts`, `src/test/architecture.test.ts`, `lib/server/prefetch.test.ts` (existing suites), plus `levels-editor` has no logic test (UI only)

**Interfaces:**
- Consumes: Task 1 DTOs; routes of Task 3.
- "New workflow" posts `{ spec: { name: "New workflow", levels: [newLevel()] } }` and routes to `/workflows/<id>` (the draft is saved, so reload never loses it).

- [ ] **Step 1:** Update `nav.test.ts` expectations (Workflows in Access with `workflow.view`; a user without it does not see it) → run `bun run --filter @starterkit/web test -- nav` → FAIL.
- [ ] **Step 2:** Implement the files above.
- [ ] **Step 3:** `bun run --filter @starterkit/web test -- nav architecture prefetch page-anatomy` → PASS; typecheck web.
- [ ] **Step 4:** Browser check on :3000 as superadmin: create "Treasury head" with 2 levels, autosave "Saved", reload keeps it, send for approval; log in as another manager (seed has none: grant `workflow.manage` to the `approver` dev user through Roles, note it for restore) and publish; Used by empty. Restore dev data afterwards.
- [ ] **Step 5:** Commit `feat(web): workflow library list and editor`.

### Task 7: Web — approval rules per space

**Files:**
- Rename: `workflows-page.tsx` → `rules-page.tsx` (rows grouped under "Breaks": Force match, Unmatch, Write-off; line "2 rules · otherwise Default"), `workflow-editor.tsx` → `rules-editor.tsx`, `workflow-rules.tsx` → `binding-rules.tsx` (RuleCard: name, When conditions as today, **Use workflow** = single-select `Combobox` over `detail.library` showing `LevelDots`; required red `*`; a link "Open workflow" to `/workflows/<id>` for `workflow.view` holders), add an **Otherwise** row (Combobox, option "Default · 1 of Reviewer or Space admin" = null)
- Modify: `who-approves.tsx` (body `PreviewRulesBody`; shows "Rule 1 · Large → Treasury head" then the levels)
- Routes: `app/(main)/spaces/[spaceId]/approval-rules/{page,loading}.tsx`, `[trigger]/{page,loading}.tsx`; delete `spaces/[spaceId]/workflows/**`; `app/(main)/approval-rules/page.tsx` redirect like the old `/workflows` one; nav item "Approval rules" (`/approval-rules`, group `space`, `space: "approval-rules"`, shortcut "G L"), `SPACE_PAGES` swap `workflows` → `approval-rules`, nav icon, route shapes, queries/prefetch keys renamed (`approvalRules`, `approvalRulesDetail`)
- Modify: `components/request-chain.tsx` consumers: break page panel subtitle `Write-off · <workflowName> · rule “<ruleName>”` (omit the workflow part when null, omit the rule part for "Default"/"Otherwise")
- Test: `nav.test.ts` (shortcut unique, space page), `architecture.test.ts`, `page-anatomy.test.ts`

- [ ] **Step 1:** Update `nav.test.ts` for "Approval rules" → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Web tests above → PASS; `bun run check` → green (all workspaces); `NEXT_DIST_DIR=.next-e2e bun run build && NEXT_DIST_DIR=.next-e2e bun run budget` → every route ≤ 300 kB.
- [ ] **Step 4:** Browser check: Treasury → Approval rules → Write-off: start draft, rule "Large" amount ≥ 25,000,000 IDR → Treasury head, otherwise Default; Who approves at 25,000,000 shows "Treasury head" levels; send for approval; publish as another space admin or manager; request a write-off on the test break ≥ 25M (or lower the threshold) and see the 2-level chain with the workflow name; cancel it and restore the break and rules to their prior state.
- [ ] **Step 5:** Commit `feat(web): approval rules per space pick library workflows`, push to `recon feat/recon-phase1`.

### Task 8: Design and docs

**Files:**
- Figma file `fbGv05DvfJnw6XU0fwZebO`: duplicate page "06 Approval workflows · v1.0.0" → "06 Approval workflows · v1.0.1" (Draft), per `docs/standards/figma-versioning.md`: replace the space Workflows list/editor frames with Workflows library list, library editor with Used by (one row short of people), Approval rules list and rules editor (Use workflow combobox, Otherwise row, Who approves); sidebar local component gets Access → Workflows and Space → Approval rules (new local component version, v1.0.0's stays); update the release index entry; lock v1.0.0's frames.
- Modify: `docs/decisions.md` (DEC-052 amendment: library + rules, the four builder calls of spec §4.2), `docs/superpowers/specs/2026-11-22-approval-workflow-engine-design.md` §10 status line pointing to the new spec.

- [ ] **Step 1:** Build the Figma page; screenshot each changed frame and check against the running app.
- [ ] **Step 2:** Docs edits; commit `docs(approvals): DEC-052 amendment, Figma 06 v1.0.1`; push.
