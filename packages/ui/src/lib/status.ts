// The six status tones (design-system.md §3.1): names equal the `--<health>-mark/ink/soft` tokens. `progress` (owner
// 24 Nov) is the blue of something under way: queued, sending, open, running, in review.
// This file is the single source of generic status wording; copy that states real thresholds belongs next to the
// feature that owns them, not here.
export type Health = "healthy" | "degraded" | "down" | "stopped" | "unknown" | "progress";

declare const TONE_BRAND: unique symbol;
/**
 * A status colour a chip may draw (review 24 Nov): a Health that came from the meaning map (`statusTone` /
 * `statusChip` in apps/web `lib/shared/categories.ts`) or from the design system itself. `StatusChip` and a legend
 * entry take only this, so a literal, `as Health` or a hand-written map fails typecheck.
 */
export type StatusTone = Health & { readonly [TONE_BRAND]: true };
/** The one constructor; only categories.ts, the design system and tests call it (architecture.test "status tones"). */
export const toStatusTone = (h: Health): StatusTone => h as StatusTone;

/** `order` = severity for rollups (stopped is the quietest, down the loudest). */
export const HEALTH: Record<Health, { label: string; description: string; order: number }> = {
  healthy: { label: "Healthy", description: "Working normally; no action needed.", order: 1 },
  progress: { label: "In progress", description: "Under way: queued, sending, open or running.", order: 2 },
  degraded: { label: "Degraded", description: "Running, but something needs attention.", order: 4 },
  down: { label: "Down", description: "Not working; check the reason and fix it first.", order: 5 },
  stopped: { label: "Stopped", description: "Turned off on purpose.", order: 0 },
  unknown: { label: "Unknown", description: "No current data, so the status can't be determined.", order: 3 },
};

export function worstHealth(list: Health[]): Health {
  if (list.length === 0) return "unknown";
  return list.reduce((a, b) => (HEALTH[b].order > HEALTH[a].order ? b : a));
}
