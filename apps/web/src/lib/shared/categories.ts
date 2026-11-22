import type { CategorySlot, StatusChipProps } from "@starterkit/ui/ds";
import type { ApprovalKind } from "@starterkit/shared/approvals";
import type { ActionRunRowDto } from "@starterkit/shared/contracts/breaks";
import type { LiveReconDto } from "@starterkit/shared/contracts/recon";
import type { Environment } from "@starterkit/shared/integrations";
import type { BreakReason, BreakState } from "@starterkit/shared/recon";
import type { SpaceRole } from "@starterkit/shared/spaces";

/**
 * Categorical values as chips (design-system.md §5.8 "Categories"): health is a StatusChip; every other set of
 * values is a CategoryChip whose slot comes from this one map, so the same value has the same colour on every
 * screen. A slot is a chart hue at 10 %, never a health colour. The plain or starting member of a set is neutral.
 * Sets that are all neutral (source kind, engine, read mode, Fixed / Auto generated, Simulated) need no entry here:
 * pass `slot="neutral"`. Version state, posting result and a credential set / not set stay StatusChips.
 */
export const CATEGORIES = {
  workState: { new: "neutral", assigned: 1, investigating: 1, pending_external: 5, proposed_resolution: 3, pending_approval: 4, resolved: 3 } satisfies Record<BreakState, CategorySlot>,
  reason: {
    "No counterpart": "neutral", "Amount differs": 2, "Date differs": 5,
    Duplicate: 6, Ambiguous: 6, "Currency differs": 6, "Unconfirmed suggestion": 6,
  } satisfies Record<BreakReason, CategorySlot>,
  // a version sent for approval is not a change of data: neutral
  changeKind: { posting: 1, force_match: 4, write_off: 2, unmatch: 6, source_version: "neutral", recon_version: "neutral" } satisfies Record<ApprovalKind, CategorySlot>,
  // what an approved change ran: a posting as the posting change kind; a notification only tells
  actionKind: { posting: 1, notify: "neutral" } satisfies Record<ActionRunRowDto["kind"], CategorySlot>,
  // a recon's business date: open is the plain state (not Healthy); closing waits as Pending external; closed is done as Resolved
  dayState: { open: "neutral", closing: 5, closed: 3 } satisfies Record<LiveReconDto["state"], CategorySlot>,
  environment: { dev: "neutral", prod: 2 } satisfies Record<Environment, CategorySlot>,
  spaceRole: { space_admin: 4, source_admin: 3, config_maker: 1, config_checker: 6, operator: 5, reviewer: 2, viewer: "neutral" } satisfies Record<SpaceRole, CategorySlot>,
} as const;

export type CategoryDomain = keyof typeof CATEGORIES;

/** The chip slot of `value` in `domain`; a value the map doesn't know is neutral. */
export function categoryChip(domain: CategoryDomain, value: string): CategorySlot {
  const map: Record<string, CategorySlot> = CATEGORIES[domain];
  return Object.hasOwn(map, value) ? map[value]! : "neutral";
}

/** A chip's content: health as a StatusChip, any other value as a CategoryChip (`components/state-chip.tsx` draws either). */
export type Chip = { health: StatusChipProps["health"]; label: string } | { slot: CategorySlot; label: string };
