import type { Health } from "@starterkit/ui/lib/status";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";

type Status = { health: Health; label: string };
const STATE: Record<NonNullable<SourceRowDto["health"]>["state"], Status> = {
  healthy: { health: "healthy", label: "Healthy" }, degraded: { health: "degraded", label: "Degraded" }, down: { health: "down", label: "Down" },
};

/**
 * One mapping for the status chip on every source screen: the API's health (sourceHealth; never judged here) on the
 * health states; a paused source is stopped on purpose until a new version is approved; a source without a published
 * version ingests nothing yet (Draft).
 */
export function sourceStatus(s: Pick<SourceRowDto, "status" | "health" | "publishedVersion">): Status {
  if (s.publishedVersion === null) return { health: "stopped", label: "Draft" };
  if (s.status === "paused") return { health: "stopped", label: "Paused" };
  return s.health ? STATE[s.health.state] : { health: "unknown", label: "Unknown" };
}

/** The legend of a card that shows source states (Panel `legend`). */
export const SOURCE_LEGEND: readonly (Status & { description: string })[] = [
  { ...STATE.healthy, description: "Data for the business date in progress is complete, or within half the grace." },
  { ...STATE.degraded, description: "Behind by more than half the grace, or the date's file or snapshot hasn't arrived and the daily deadline hasn't passed." },
  { ...STATE.down, description: "Behind by more than the grace, or the daily deadline passed without the date's file or snapshot." },
  { health: "stopped", label: "Paused", description: "The source table or file changed. Nothing is written until a new source version is approved." },
  { health: "stopped", label: "Draft", description: "No approved version yet, so nothing is ingested." },
];
