# Recon approval, stage 1 (workflows per space, conditions, approval in the recon version) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workflows become space-owned; a recon's config version carries its approval binding (per change: a default workflow and optional condition rules over a dynamic field catalog); requests resolve their chain from the recon's live version; Space → Approval rules and the global library go away.

**Architecture:** A pure field catalog + condition evaluator in `packages/shared` (reused later by posting variants). `ReconSpec` gains an optional `approvals` block validated on save (shape) and on submit/approve (references), with the simulation check hashing the spec without `approvals`. `openRequest` reads the recon's published version, evaluates its rules against the break's context (break fields + side source attrs) and snapshots the pinned workflow version's chain.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle, PostgreSQL 18, zod, Next 16, React Query, DS Combobox, dnd-kit (installed).

**Spec:** `docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md` (§4.1, §4.3, §4.4 workflow part, §4.6.1, §4.8 Workflows + recon tab, §6, §7 stages 1–2, §10). Actions, connectors and posting are later plans (stages 3–5).

## Global Constraints

- O1 workflows owned by a space; O3 approval binding lives in `recon_config_versions.spec` and is reviewed with the recon version; §10 the recon pins `{ id, version }` of the workflow.
- An approval-only change never requires a new simulation: submit compares `simulated_hash` with `matchingHash(spec)` (spec minus `approvals`).
- Workflow editors: space admin of that space or `workflow.manage`; publisher must be another editor; Superadmin's own only by override + reason; only a draft's maker saves it (existing rules, keep their tests).
- Approvers count only as active members of the request's space (existing `approversOf`).
- Limits: 20 workflow rules per change, 20 clauses per rule, nesting 2 levels; names ≤ 80.
- UX (owner, mandatory): defaults first ("Every unmatch in <recon> is approved by [workflow]"), conditions read as sentences, preview with real data before publish, errors in place with what to do, no field keys on screen (labels from the catalog), autosave + URL (the recon setup wizard already does), micro-interactions per Figma "06 · v1.0.2" board, read-only view for live versions. Workflow editor and rules follow Figma direction A (`06 · v1.0.2`, frames A and Rules).
- Repo rules: AGENTS.md §11–§13 (route order, activity in the transaction, docs table + `bun run api:schemas`, conformance allowlists); no Playwright runs (affected tests + `bun run check`; MCP browser checks allowed); push only to `recon feat/recon-phase1`; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A recon's published version pins a workflow version that is later superseded: requests keep using the pinned version; Used by marks the recon as on an older version. Test in Task 4.
- A rule clause names a source attr that a new source version no longer maps: saving the recon draft keeps it (warning), submit is refused naming rule and field. Test in Task 3.
- A break whose side record has no value for the clause's field: the clause is false (rule skipped), never an error. Test in Task 1.
- Changing only `approvals` on a simulated draft still allows submit; changing a pass afterwards still requires a new simulation. Test in Task 3.
- Archiving a workflow referenced by a recon's published or open version is refused, naming recon and change. Test in Task 2.

---

### Task 1: Field catalog and condition evaluator (shared)

**Files:**
- Create: `packages/shared/src/conditions.ts`, `packages/shared/src/conditions.test.ts`
- Modify: `packages/shared/src/contracts/recon.ts` (zod `Condition`, `ReconApprovalSpec`, `approvals` on `ReconSpec`)

**Interfaces:**
- Produces (`conditions.ts`, zod-free): `type FieldKind` reuse from `recon.ts`; `type CatalogField = { key: string; label: string; group: "break" | "recon" | "side_a" | "side_b"; kind: "number" | "money" | "text" | "date" | "list" | "person" }`;
  `buildCatalog(sides: readonly [{ label: string; fields: Map<string, RecordField> }, { label: string; fields: Map<string, RecordField> }]): CatalogField[]` — break group: `break.amount`(money), `break.currency`(list), `break.business_date`(date), `break.age_days`(number), `break.side`(list), `break.reason`(list), `break.state`(list), `break.reference`(text); recon group: `recon.code`(text); side groups: `side_a.<field>` / `side_b.<field>` for every `recordFields` key, label `"<side label> · <field label>"` (attrs label = the attr name humanised: `e2e_id` → `E2e id`);
  `type Clause = { field: string; op: Op; value?: string | string[] }`, `type Condition = { all: (Clause | Condition)[] } | { any: (Clause | Condition)[] }`; `OPS_BY_KIND: Record<CatalogField["kind"], Op[]>` with `Op = "eq" | "ne" | "in" | "not_in" | "starts_with" | "contains" | "gte" | "gt" | "lte" | "lt" | "empty" | "not_empty"`;
  `evaluate(c: Condition, ctx: Readonly<Record<string, string | number | null | undefined>>): boolean`;
  `conditionText(c: Condition, catalog: CatalogField[]): string` (sentence: "Amount is at least 25,000,000 and Side A · Channel is one of RTGS");
  `conditionFields(c: Condition): string[]`.
- Produces (`contracts/recon.ts`): `Condition` zod (depth ≤ 2, ≤ 20 clauses total, values ≤ 64 chars, ≤ 50 list items), `WorkflowRef = { id: uuid, version: int ≥ 1 }`, `ReconApprovalSpec = { changes: Partial<Record<"force_match" | "unmatch" | "write_off", { workflow: { default: WorkflowRef | null; rules: { name: string(1..80); when: Condition; workflow: WorkflowRef }[] (≤ 20) } }>> }`, `ReconSpec.approvals: ReconApprovalSpec.optional()`.

- [ ] **Step 1: Write failing tests** (`conditions.test.ts`):
  - `evaluate({ all: [{ field: "break.amount", op: "gte", value: "2500000000" }] }, { "break.amount": "2500000000" })` → true; `"1"` → false.
  - missing field: `evaluate({ all: [{ field: "side_a.attrs.channel", op: "in", value: ["RTGS"] }] }, {})` → false (no throw).
  - `any` with nested `all`: `{ any: [{ all: [type = "A", status = "C"] }, { field: type, op: eq, value: "1" }] }` true for `{type:"A",status:"C"}` and `{type:"1"}`, false for `{type:"A",status:"B"}`.
  - text ops trim and `starts_with`/`contains` ignore case: `"  rtgs-01 "` starts_with `"RTGS"` → true.
  - money compares as bigint (no float): `"999999999999999999" gte "999999999999999998"` → true.
  - `buildCatalog` gives `side_b.attrs.e2e_id` labelled `"Core · E2e id"` for a side labelled "Core".
  - `conditionText` renders the sentence above for a two-clause `all`.
  - zod: `ReconApprovalSpec.safeParse` rejects 21 rules and a 3-level nesting.
- [ ] **Step 2:** `cd packages/shared && bunx vitest run src/conditions.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(shared): field catalog and condition evaluator for approval and posting rules`.

### Task 2: Workflows owned by a space (API + migration)

**Files:**
- Modify: `apps/api/src/modules/approvals/schema.ts`, `library.ts` (→ space-scoped), `controller.ts`, `requests.ts` (`openRequest` placeholder until Task 4 keeps the default chain), `index.ts`
- Delete: `apps/api/src/modules/approvals/rules.ts`, `tests/integration/rules.test.ts`
- Create: `apps/api/drizzle/0050_workflows_per_space.sql` (+ meta)
- Modify: `apps/api/test/architecture/conformance.test.ts`, `docs/api/README.md`, `apps/web/scripts/emit-api-schemas.ts`, `AGENTS.md` (ownership: drop approval_bindings)
- Test: `apps/api/src/modules/approvals/tests/integration/library.test.ts` (rewrite to space routes)

**Interfaces:**
- Schema: `workflows.space_id uuid NOT NULL` + RLS (`select recon_enable_space_rls('workflows')`; `workflow_versions` gets `space_id` too, RLS); unique `(space_id, lower(name))` replaces `workflows_name`; drop table `approval_bindings`; `approval_requests` add `config_version_id uuid`, drop `binding_version_id`.
- Migration guard: `do $$ … raise exception 'workflows without a space: …' $$` if any `workflows` row is referenced by a pending request; otherwise delete every existing `workflows` row (dev-only test data), then add the NOT NULL column.
- Routes (replace `/v1/workflows…`): `GET /v1/spaces/:spaceId/workflows` (pageQuery, q, sort name|createdAt), `POST …/workflows`, `GET …/workflows/:id`, `GET …/workflows/:id/used-by` (pageQuery: recon name, change, version, status published|draft|in_review, pinned workflow version, `outdated` = pinned < live), `POST|PATCH …/:id/draft`, `…/draft/submit`, `…/draft/discard`, `…/review/approve|reject`, `…/archive`. Guards: reads `{ space: SPACE_ROLES, or: "workflow.manage" }`; writes `{ space: ["space_admin"], or: "workflow.manage" }` (allowlist in `OR_WITH_SPACE`: "workflow.manage configures any space's workflows (DEC-052 rev 2); workflows only").
- `canEdit(ctx)` = `workflow.manage` or space admin of `ctx.space`.
- Used by / archive read recon versions of the space whose `spec->'approvals'` names the workflow id (`jsonb_path_exists(spec, '$.approvals.changes.*.workflow.** ? (@.id == $id)')` with the id as a bound parameter), statuses draft|in_review|published.

- [ ] **Step 1:** Rewrite `library.test.ts` to the space routes, keeping every existing case (create/publish by another editor, SA without manage on a space they admin **can** edit now, Superadmin override, one open draft, duplicate name per space (same name allowed in another space), only the maker saves, archive race) and add:
  - "a workflow of space B is 404 from space A".
  - "archive refused while a recon version uses it": insert a recon version whose `spec.approvals.changes.unmatch.workflow.default = { id: W, version: 1 }` → POST archive 409 with message containing the recon name and "Unmatch".
- [ ] **Step 2:** `cd apps/api && bun test src/modules/approvals` → FAIL.
- [ ] **Step 3:** Schema + migration (`bun run db:generate -- --name=workflows_per_space` via the `expect` wrapper used for 0049 when drizzle-kit prompts; append the guard and RLS SQL), service and routes.
- [ ] **Step 4:** `bun test src/modules/approvals test/architecture test/db` → PASS; `bun run api:schemas`.
- [ ] **Step 5:** Commit `feat(approvals): workflows belong to a space; approval rules per space removed`.

### Task 3: Approval binding in the recon version (validation)

**Files:**
- Modify: `apps/api/src/modules/recon/rules.ts` (`checkApprovals`), `apps/api/src/modules/recon/service.ts` (`checked`, `submitVersion`, `approveVersion`, `updateVersion`), `apps/api/src/modules/recon/index.ts`
- Modify: `packages/shared/src/recon.ts` (`matchingHash(spec): string` = hash of the spec without `approvals`, same hashing as `specHash`)
- Test: `apps/api/src/modules/recon/tests/unit/rules.test.ts`, `tests/integration/recon.test.ts` (or the file that holds submit/approve tests)

**Interfaces:**
- `checkApprovals(approvals: ReconApprovalSpec | undefined, catalog: CatalogField[], workflows: ReadonlyMap<string, { spaceId: string; versions: ReadonlySet<number>; archived: boolean; name: string }>, spaceId: string): { errors: string[]; warnings: string[] }` — errors: workflow unknown / other space / pinned version never published / archived ("Unmatch: workflow “X” is archived. Pick another one."); clause field not in catalog ("Unmatch · rule “Large”: Side A · channel is no longer read from the source."); op not allowed for the field kind. On save these errors are **warnings** (draft keeps them); on submit and approve they are errors.
- `submitVersion`: compare `simulatedHash` with `matchingHash(spec)`; `markSimulated` stores `matchingHash` too (rename semantics in its comment).
- Activity `recon.version_update` unchanged.

- [ ] **Step 1: Failing tests:**
  - unit: `checkApprovals` flags each error above with the exact messages.
  - integration "approval-only change keeps the simulation": simulate a draft, PATCH it adding `approvals.changes.unmatch.workflow.default`, submit → 200.
  - integration "a pass change still needs a new simulation": then change a pass, submit → 400 "The draft changed after the last simulation. Run it again."
  - integration "submit refuses a rule naming an attr the source no longer maps" → 400 naming rule and field; the PATCH that saved it → 200 with the warning.
- [ ] **Step 2:** `bun test src/modules/recon` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(recon): approval binding in the recon version, checked on submit and approve`.

### Task 4: Requests resolve through the recon's live version

**Files:**
- Modify: `apps/api/src/modules/approvals/requests.ts` (`openRequest`), `apps/api/src/modules/engine/break-requests.ts` (context), `apps/api/src/modules/engine/index.ts`
- Create: `apps/api/src/modules/engine/break-context.ts` (`breakContext(tx, spaceId, itemId): Promise<{ ctx: Record<string, string | number | null>; configId: string }>`: break fields + `recon.code` + `side_<s>.<field>` from the item's record core columns and `attrs`)
- Create: `POST /v1/spaces/:spaceId/recons/:id/versions/:versionId/approvals/preview` in `recon/controller.ts` (guard `{ space: SPACE_ROLES }`; body `{ change, itemId?: uuid, values?: Record<string,string> }` → `{ rule: { name, index } , workflow: { id, name, version } | null, levels: PreviewDto["levels"] }`), `NO_ACTIVITY` + `NON_LIST_GETS` entries
- Test: `apps/api/src/modules/engine/tests/integration/break-requests.test.ts`

**Interfaces:**
- `openRequest`: read the recon's **published** version; `approvals.changes[kind]` → first rule whose `when` holds on `breakContext` (else `default`, else default chain) → `workflow_versions` row of the pinned `{ id, version }` → chain; insert `config_version_id`, `workflow_version_id`, `workflow_name`, `rule_name` ("Default" when no rules/default chain, "Every request" when the default workflow is used). A pinned version missing → 409 "The <recon> approval setup points to a workflow version that no longer exists. Ask a config maker to fix the recon." Short-level refusal unchanged.
- `RequestViewDto` unchanged (workflowName, ruleName).

- [ ] **Step 1: Failing tests** in `break-requests.test.ts` (replace the `publish` helper with one that writes `approvals` into the recon's published version):
  - "unmatch of recon X takes its default workflow" (chain = W's levels, `workflowName` W).
  - "a rule on a side attr picks another workflow": rule `side_a.attrs.channel in ["RTGS"]` → W2 for a break whose record attrs `{ channel: "RTGS" }`; another break → default.
  - "a later workflow version does not move the recon": publish W v2 → new requests still use v1 (pinned).
  - "a recon without approvals uses the default chain".
  - preview: values `{ "side_a.attrs.channel": "RTGS" }` → rule name and W2's levels with approvers.
- [ ] **Step 2:** `bun test src/modules/engine src/modules/approvals src/modules/recon` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `bun test test/architecture` → PASS after README rows + `bun run api:schemas`.
- [ ] **Step 5:** Commit `feat(approvals): requests take the recon's pinned workflow by its rules`.

### Task 5: Web — Space → Workflows (direction A) and removals

**Files:**
- Move/modify: `apps/web/src/features/approvals/library-page.tsx`, `library-editor.tsx`, `used-by.tsx`, `levels-editor.tsx` to space routes `app/(main)/spaces/[spaceId]/workflows/{page,loading}.tsx`, `[id]/{page,loading}.tsx`; `app/(main)/workflows/page.tsx` becomes the space entry redirect (like `/approval-rules` today)
- Delete: `rules-page.tsx`, `rules-editor.tsx`, `binding-rules.tsx`, `who-approves.tsx` (its preview moves to Task 6), routes `app/(main)/approval-rules/**`, `spaces/[spaceId]/approval-rules/**`
- Modify: `lib/shared/nav.ts` (Space → "Workflows" `/workflows` G W `space: "workflows"`; remove Access → Workflows and "Approval rules"), `nav-icon.tsx`, `SPACE_PAGES`, `route-shapes.ts`, `prefs.ts` `VIEW_PAGES`, `queries-recon.ts`, `prefetch.tsx`, `copy-guide.md` nav labels, `nav.test.ts`
- Look (Figma 06 v1.0.2 frame A): header with title, status chip, summary line ("2 levels · Used by 3 recons"), Saved indicator, Send for approval; chain on the left (numbered nodes + connector), read view of a level as text + role/person chips, one level in an edit card at a time (Done), dashed "Add level" node; Used by on the right as a list with the "can't pass Level N" callout and "older version" marks.
- Micro-interactions (board rows "Workflow editor"): add/remove/reorder level, add group divider, token add/remove, autosave check draw, short-of-people rise — using existing `Reveal`/`StaggerItem`/`animate-*`/`DUR` tokens; reduced motion per board.

- [ ] **Step 1:** Update `nav.test.ts` expectations (Space: Members, Workflows; no Access → Workflows, no Approval rules) → FAIL.
- [ ] **Step 2:** Implement; `bunx vitest run src/lib/shared src/test src/lib/server` in `apps/web` → PASS; typecheck + lint.
- [ ] **Step 3:** Browser check on :3000 (Treasury → Workflows: create, add level, Done, autosave, reload keeps it); restore dev data.
- [ ] **Step 4:** Commit `feat(web): Space → Workflows in the calm chain layout; approval rules pages removed`.

### Task 6: Web — recon setup step "Approval"

**Files:**
- Modify: `apps/web/src/features/recon/spec-model.ts` (`SetupStep = 1|2|3|4|5|6`, `SETUP_STEPS = { 1: "Sources", 2: "Matching", 3: "Schedule", 4: "Approval", 5: "Test", 6: "Review and submit" }`; `stepReasons` for 4 = null, optional step), `builder.tsx` (step 4 renders `ApprovalStep`; submit on step 6), `recon-setup.tsx` (`asStep` 1..6; live recon opens on 6), `version-review.tsx` + `spec-view.tsx` ("Approval" section and diff)
- Create: `apps/web/src/features/recon/approval-step.tsx`, `condition-editor.tsx` (sentence rules: field picker grouped Break / Recon / Side A / Side B from `buildCatalog`, op per kind, value input/picker, "and"/"or" groups, `conditionText` summary when collapsed), `approval-preview.tsx` (Who approves: pick a break of this recon or fill only the fields the rules use → `POST …/approvals/preview`)
- Test: `apps/web/src/features/recon/spec-model.test.ts` (steps), `condition-editor` has no unit test (UI); `packages/shared` covers the logic

**Interfaces:**
- Consumes: Task 1 catalog/evaluator/contracts; Task 4 preview route; workflows list of the space (`GET /api/spaces/:spaceId/workflows`, published only, with live version).
- Step content (Figma Rules frames): per change a card "Every <change> in <recon> is approved by [workflow ▾]" (default chain option first: "Default · 1 of Reviewer or Space admin"), chain preview of the picked version, a dashed "Use another workflow in some cases" opening rules; rules as collapsible sentence cards (drag to reorder, copy, remove); "Every other <change> → [default]" row; Who approves at the side.
- Picking a workflow pins its live version; when a newer live version exists than the pinned one, show "Version N is newer · Use it" inline.

- [ ] **Step 1:** Update `spec-model.test.ts` for six steps ("Approval" at 4, optional, Review at 6) → FAIL.
- [ ] **Step 2:** Implement; web tests + typecheck + lint → PASS; `NEXT_DIST_DIR=.next-e2e bun run build && NEXT_DIST_DIR=.next-e2e bun run budget` from the repo root → all routes ≤ 300 kB (load `approval-step` with `next/dynamic` if the setup route grows past it).
- [ ] **Step 3:** Browser check: BI-FAST recon → Edit → Approval: default workflow, one rule on a side attr, preview with a real break; Test (simulation) not required again after only this change; submit; another checker approves; request an unmatch and see the chain; restore dev data.
- [ ] **Step 4:** `bun run check` green; commit `feat(web): recon setup step Approval — workflow per change with sentence rules and preview`; push.

### Task 7: Design and docs

**Files:**
- Figma file `fbGv05DvfJnw6XU0fwZebO`: page "06 Approval workflows · v1.0.3" duplicated from v1.0.2: keep direction A frames as the chosen look, add the recon setup step "Approval" (desktop), mark B and C as not chosen in the Read me; release index entry; lock v1.0.2 frames.
- Docs: `docs/decisions.md` DEC-052 amendment 2 (O1–O10, §10 builder calls), `2026-11-22-recon-approval-and-posting-design.md` status line (stage 1 shipped), AGENTS.md ownership line.

- [ ] **Step 1:** Figma page and screenshots checked.
- [ ] **Step 2:** Docs; commit `docs(approvals): DEC-052 amendment 2, Figma 06 v1.0.3`; push.
