# One-way recon — design

Status: owner approved 2026-11-24 ("recon itu bisa oneway, bisa two way … sisi A sebagai pintu, cek ke sisi B sebagai
settle … ada juga yg 2 arah"). Decision: DEC-055.

## Intent

Some recons check that every side-A item settles in side B (A is the gate, B the settlement); B holds far more than A
and its leftovers are no one's work. Others need both sides to find their counterpart. A recon version says which.

## Contract

- `ReconSpec.direction`: `"two_way" | "a_to_b"`, optional; absent = two-way, so every stored spec reads as before
  (`isOneWay` in `packages/shared/src/recon.ts`). It is part of the spec, so the spec hash and the matching hash change
  with it: a new direction is a new draft, simulated and approved like any other setting.
- Item status `not_required` (`ITEM_STATUSES`; migration `0069_item_not_required.sql`: the status check and a partial
  index for the pool). Operation result: overall status `not_required` ("Not required", grey, after Unmatch in the
  status order) and side state `not_required` ("Record not required").

## Engine

The near-miss classifier (`sql/breaks.ts nearMissSql`) gets `oneWay`. In a one-way recon a side-B item with no near pair
answers `Not required` instead of `No counterpart`. Grace and day close (`sql/days.ts breakLocked`) write that item as
`status = 'not_required'`, no break reason, no late_match. Side A is unchanged.

## Rulings

1. Representation: a new item status `not_required`, not a marker on `break`. Every reader of breaks (Unmatch list,
   facets, summary, nav count, Today, the open count of the dashboard, `recon_days.counters`, `broke` of the rollup)
   filters `status = 'break'` or `break_reason is not null`, so they leave the item out without a change each.
2. Only the plain no-counterpart case is not required. A near miss with a side-B item (currency, amount, date differs),
   a pass's Duplicate or Ambiguous that holds one, and an unconfirmed suggestion stay unmatch: a real discrepancy. A
   tie break of a pass breaks a not-required item too (`breakItems`).
3. Late match: with carry over > 0 the pool of every pass holds not-required items of the window (on dates not signed
   off), like "No counterpart" breaks. An automatic pass that pairs one makes both items matched with no resolution (it
   was never a break, so Operation result says Matched, not Matched late). A suggesting pass may suggest one (it is not
   waiting for a person); day close then breaks the suggestion as it does every unconfirmed one. Carry over 0 never
   meets later data.
4. A side-A item of a later date whose near pair is a not-required item (amount differs, say) breaks with that reason;
   the side-B item stays not required. One work item, the side-A break, holds the pair. A person may match a break with
   a not-required item (`free`, the candidate list).
5. Carry over "always": not-required items do not widen the window (`effectiveCarry`). Side B of a one-way recon never
   settles by itself, so the window would grow without bound; they stay candidates inside the window side A keeps
   (at least 31 days).
6. A record replaced by its source closes a not-required item, as it closes an open one.
7. Dashboard: the auto-match rate's records leave not-required records out (`dashboard.ts records`); the rollup keeps
   their count under `not_required`.
8. Sign-off never counted breaks as blockers; `recon_days.counters.open` (its open count) leaves them out.
9. Simulation: pairs do not depend on direction (no recon_sim_changes difference); the projection of day close
   (`projectDayClose`, the same classifier) shows side B's no-counterpart items as "Not required", and the matching
   hash makes a direction change need a new simulation.

## Screens

- Setup, Sources step: "Direction" radio cards, "Two-way: Both sides must find their counterpart" / "One-way: Side A
  must settle in Side B" (`spec-model.ts DIRECTION_OPTIONS`).
- Review and the version page (`spec-view.tsx`): the direction under the sides; on a review, "Changed from the live
  version" with the live one. Overview's Run facts name it.
- Operation result: the status and side state with their legend rows; filterable and counted like every status.
