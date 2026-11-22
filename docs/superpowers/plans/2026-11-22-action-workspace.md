# Action workspace and field map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Approval step's actions edited in a full-screen workspace with an ERD-style field map (drag from row to row), clear sections, and the canvas parts as a design-system layer.

**Architecture:** `packages/ui/src/flow/` holds React Flow parts (moved `flow-parts`, theme CSS, new `TableNode`, `MapEdge`); `ds/workspace.tsx` the full-screen shell; the recon feature builds the graph from a pure model (`field-map.ts`) and renders it in `action-workspace.tsx`.

**Tech Stack:** `@xyflow/react` 13.0.2 (already in the web), Radix Dialog, React Query.

**Spec:** `docs/superpowers/specs/2026-11-22-action-workspace-design.md` (and `2026-11-22-recon-approval-and-posting-design.md` §4.5).

## Global Constraints

- First-load ≤ 300 kB per route; the workspace and canvas load through `next/dynamic` with `ssr: false`.
- Tokens only; no literal colours; motion tokens only; English sentence case, verb + object buttons.
- Every canvas has a list view; below 768 px the list only (DEC-041).
- Required fields show the red `*`; no field ids on screen as captions beyond the request path (machine value, mono).

## Review Focus

- A drag onto a Fixed/Auto field or from a target row → refused (no handle), nothing written.
- Connecting a second row to a mapped field joins both into a template (owner 22 Nov, "gabung beberapa column"); a fixed value or lookup is replaced.
- Changing the variant's operation keeps mappings whose paths still exist and drops only the rest.
- Done refused while a variant condition is unfinished or the name is empty; Cancel discards everything.
- Keyboard: every mapping can be made from the inspector without dragging.

---

### Task 1: flow layer in the design system
- [ ] Architecture test: layer `flow` = 2 (beside charts); only `packages/ui/src/flow/` and nothing else imports `@xyflow/react`. RED.
- [ ] Move `apps/web/src/features/recon/flow-parts.tsx` → `packages/ui/src/flow/flow-parts.tsx`, the generic part of `recon-canvas.css` → `packages/ui/src/flow/flow.css` (class `flow-canvas`); export `@starterkit/ui/flow`; add `@xyflow/react` 13.0.2 to `packages/ui`; recon canvases import from it. GREEN, commit.

### Task 2: field map model
- [ ] `apps/web/src/features/recon/field-map.test.ts`: `mapGraph(mapping, catalog, op, accounts)` → source tables (break/recon/side_a/side_b/approval/accounts, only groups with fields), request table rows with `required`, `filledBy`, `mapped`; edges for field, account, lookup key and template refs (label = transforms joined). `connect(mapping, sourceRow, targetPath)` → field or account source, replaces an existing one; refuses a fixed/auto target. `keepMapping(mapping, op)` keeps paths that exist. RED → GREEN, commit.

### Task 3: TableNode, MapEdge, Workspace
- [ ] `packages/ui/src/flow/table-node.tsx` (title, caption, rows with label, mono path, badges, handle left/right per row, states required/missing/fixed/auto/selected) and `map-edge.tsx` (bezier, label pill); `packages/ui/src/ds/workspace.tsx` (Radix Dialog full screen: header title/description/actions, `rail`, `inspector`, `dock`, body; phone = stacked). Markup tests for both (`table-node.test.ts`, `workspace.test.ts`). Commit.

### Task 4: action workspace
- [ ] `action-workspace.tsx`: settings rail (name, kind, when, variants list add/move/remove, condition, operation, per, amount 0), `FieldMapCanvas` (React Flow, TableNode, MapEdge, onConnect → `connect`, drag nodes, Reset layout, fit), inspector (source kind, `TransformPicker` chips from `TRANSFORMS`, sample value from the last preview, Remove mapping), dock (What gets posted), View as list (existing `Mapper`). `transform-picker.test.ts` for chip parsing. Commit.

### Task 5: Approval step sections
- [ ] Per change: section header + "1 Who approves" / "2 What is sent to the bank"; action cards (sentence, variants, gaps) with Edit → workspace (dynamic); accounts and lookups section last. Commit.

### Task 6: design system page, docs, check
- [ ] `/ds/data` examples: TableNode canvas and Workspace; `design-system.md` sections; Figma owed note; `bun run check`, budget, browser check; final review (opus); push.
