# Match / Unmatch and carry over modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Carry over 0 / N days / always, and the screens say Match and Unmatch (undoing a pair is Undo match).

**Architecture:** `carry_over_days` becomes `number | null` (null = always); the engine resolves an effective carry per
run from the recon's oldest still-checkable unmatch item, so every window keeps its arithmetic. Words change on
screen only (no enum or column renamed).

**Tech Stack:** Bun, Drizzle, PostgreSQL, Next.

**Spec:** `docs/superpowers/specs/2026-11-22-match-unmatch-design.md`

## Global Constraints

- Stored specs stay valid (a number still parses); `null` only from the editor.
- Internal keys stay: status `open|matched|suggested|break|closed`, change kind `unmatch`, `breaks` routes and tables.
- Copy: sentence case, glossary updated (copy-guide): Match, Unmatch, Undo match.

## Review Focus

- Always with no unmatch at all → window is the run's own dates (carry 0 effective, `late` still on).
- Always with an unmatch 200 days old → the run reads from that date; a late counterpart closes it as AUTO_MATCHED_LATE_DATA.
- Carry 0 → a No counterpart break is never re-matched (late_match false).
- An approval-only edit doesn't stale simulations (matching hash includes carry: a mode change does).
- Undo match keeps working on existing requests of kind `unmatch`.

---

### Task 1: contract and engine — carry over null = always
- [ ] Test (engine integration): with `carry_over_days: null`, a No counterpart break 40 days old is closed by a late counterpart in today's run (AUTO_MATCHED_LATE_DATA); with 0 it stays. RED.
- [ ] `ReconSpec.carry_over_days: z.number().int().min(0).max(31).nullable()`; `effectiveCarry(tx, k, spec, from)` in the engine (null → days from the oldest open or late-match break of the live config to `from`, at least 0); every use site takes the resolved number; recon rules' cross-day gate skips null. GREEN, commit.

### Task 2: Schedule step — the three modes
- [ ] The carry over control: "Only on its day" (0) / "Up to day + N" (1–31) / "Always, until matched or closed" (null); version review and inspector text; `carryOverText` helper with a unit test. Commit.

### Task 3: words on screen — Match, Unmatch, Undo match
- [ ] Item statuses shown as Match / Unmatch (suggested pair, no longer checked as notes); Breaks → Unmatch (nav, page, detail, Today); approval change and request "Unmatch" → "Undo match"; copy-guide glossary; tests that pin the labels updated. Commit.

### Task 4: docs, check, review
- [ ] DEC-043 amendment (carry modes, words), `bun run check`, final review (opus), push.
