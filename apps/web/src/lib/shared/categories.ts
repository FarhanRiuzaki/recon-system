import type { CategorySlot, StatusChipProps } from "@starterkit/ui/ds";
import type { Health } from "@starterkit/ui/lib/status";
import type { ApprovalKind } from "@starterkit/shared/approvals";
import type { ActionRunRowDto } from "@starterkit/shared/contracts/breaks";
import type { LiveReconDto, SignoffRowDto } from "@starterkit/shared/contracts/recon";
import type { Environment } from "@starterkit/shared/integrations";
import type { BreakReason, BreakState } from "@starterkit/shared/recon";
import type { SpaceRole } from "@starterkit/shared/spaces";

/**
 * Status chips by meaning (owner 24 Nov): every status, state or result chip takes its colour from this one map,
 * through `statusTone(meaning)` or `statusChip(meaning, label)`, never a tone literal (architecture.test "status chips
 * take their tone from the shared map"). The meaning, not the word on the chip: "New rows" is `new_data`, "Waiting to
 * send" is `queued`. Green = it worked; red = it failed; amber = it needs a look; grey = nothing happened or it is off
 * on purpose; blue = under way; unknown = no data to judge.
 */
const TONE_OF = {
  healthy: ["success", "new", "new_data", "posted", "healthy", "matched", "active", "live", "published", "done", "on", "set", "ready"],
  down: ["error", "failed", "timeout", "refused", "down", "missing"],
  degraded: ["warning", "degraded", "stale", "late", "out_of_date", "check", "sent_back", "unanswered"],
  stopped: ["nothing", "idle", "skipped", "not_sent", "no_rule", "off", "paused", "draft", "retired", "superseded", "inactive", "archived", "not_live", "signed_out"],
  progress: ["in_progress", "queued", "sending", "open", "running", "loading", "in_review", "waiting"],
  unknown: ["unknown", "no_data"],
} as const satisfies Record<Health, readonly string[]>;
export type StatusMeaning = (typeof TONE_OF)[Health][number];
export const STATUS_TONE = Object.fromEntries(Object.entries(TONE_OF).flatMap(([tone, ms]) => ms.map((m) => [m, tone]))) as Record<StatusMeaning, Health>;
export const statusTone = (meaning: StatusMeaning): Health => STATUS_TONE[meaning];
export const statusChip = (meaning: StatusMeaning, label: string): { health: Health; label: string } => ({ health: STATUS_TONE[meaning], label });

/** Statuses that used to be categories (owner 24 Nov): a break's work state (New green, open work blue, Resolved green), a recon's business date, a sign-off stage. */
export const STATES = {
  workState: { new: statusTone("new"), assigned: statusTone("in_progress"), investigating: statusTone("in_progress"), pending_external: statusTone("waiting"),
    proposed_resolution: statusTone("in_progress"), pending_approval: statusTone("waiting"), resolved: statusTone("done") } satisfies Record<BreakState, Health>,
  // a recon's business date: open and closing are under way, closed is done
  dayState: { open: statusTone("open"), closing: statusTone("in_progress"), closed: statusTone("done") } satisfies Record<LiveReconDto["state"], Health>,
  // a closed day's sign-off: waiting for it, prepared, signed off
  signoffStage: { closed: statusTone("waiting"), prepared: statusTone("in_progress"), signed: statusTone("done") } satisfies Record<SignoffRowDto["stage"], Health>,
} as const;

/**
 * Categorical values as chips (design-system.md §5.8 "Categories"): a status is a StatusChip (above); every other set
 * of values is a CategoryChip whose slot comes from this one map, so the same value has the same colour on every
 * screen. A slot is a chart hue at 10 %, and never 2 (orange), 3 (green) or 5 (ochre), which beside a status chip read
 * as Degraded or Healthy. The plain or starting member of a set is neutral. Sets that are all neutral (source kind,
 * engine, read mode, Fixed / Auto generated) need no entry here: pass `slot="neutral"`.
 */
export const CATEGORIES = {
  reason: {
    "No counterpart": "neutral", "Amount differs": 4, "Date differs": 1,
    Duplicate: 6, Ambiguous: 6, "Currency differs": 6, "Unconfirmed suggestion": 6,
  } satisfies Record<BreakReason, CategorySlot>,
  // a version sent for approval is not a change of data: neutral
  changeKind: { posting: 1, force_match: 4, write_off: 6, unmatch: 6, source_version: "neutral", recon_version: "neutral" } satisfies Record<ApprovalKind, CategorySlot>,
  // what an approved change ran: a posting as the posting change kind; a notification only tells
  actionKind: { posting: 1, notify: "neutral" } satisfies Record<ActionRunRowDto["kind"], CategorySlot>,
  environment: { dev: "neutral", prod: 4 } satisfies Record<Environment, CategorySlot>,
  spaceRole: { space_admin: 4, source_admin: 4, config_maker: 1, config_checker: 6, operator: 1, reviewer: 6, viewer: "neutral" } satisfies Record<SpaceRole, CategorySlot>,
} as const;

export type CategoryDomain = keyof typeof CATEGORIES;

/** The chip slot of `value` in `domain`; a value the map doesn't know is neutral. */
export function categoryChip(domain: CategoryDomain, value: string): CategorySlot {
  const map: Record<string, CategorySlot> = CATEGORIES[domain];
  return Object.hasOwn(map, value) ? map[value]! : "neutral";
}

/** A chip's content: a status as a StatusChip, any other value as a CategoryChip (`components/state-chip.tsx` draws either). */
export type Chip = { health: StatusChipProps["health"]; label: string } | { slot: CategorySlot; label: string };
