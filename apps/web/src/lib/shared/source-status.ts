import type { StatusTone } from "@starterkit/ui/lib/status";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import type { SourcePullDto } from "@starterkit/shared/contracts/sources";
import type { VersionStatus } from "@starterkit/shared/sources";
import { statusChip, statusTone } from "./categories";

type Status = { health: StatusTone; label: string };
const STATE: Record<NonNullable<SourceRowDto["health"]>["state"], Status> = {
  healthy: statusChip("healthy", "Healthy"), degraded: statusChip("degraded", "Degraded"), down: statusChip("down", "Down"),
};

/**
 * One mapping for the status chip on every source screen: the API's health (sourceHealth; never judged here) on the
 * health states; a paused source is stopped on purpose until a new version is approved; a source without a published
 * version ingests nothing yet (Draft).
 */
export function sourceStatus(s: Pick<SourceRowDto, "status" | "health" | "publishedVersion">): Status {
  if (s.publishedVersion === null) return statusChip("draft", "Draft");
  if (s.status === "paused") return statusChip("paused", "Paused");
  return s.health ? STATE[s.health.state] : statusChip("unknown", "Unknown");
}

/** The legend of a card that shows source states (Panel `legend`). */
export const SOURCE_LEGEND: readonly (Status & { description: string })[] = [
  { ...STATE.healthy, description: "Data for the business date in progress is complete, or within half the grace." },
  { ...STATE.degraded, description: "Behind by more than half the grace, or the date's file or snapshot hasn't arrived and the daily deadline hasn't passed." },
  { ...STATE.down, description: "Behind by more than the grace, or the daily deadline passed without the date's file or snapshot." },
  { health: statusTone("paused"), label: "Paused", description: "The source table or file changed. Nothing is written until a new source version is approved." },
  { health: statusTone("draft"), label: "Draft", description: "No approved version yet, so nothing is ingested." },
];

/** A source version's state by meaning (owner 24 Nov): draft grey, in review blue, published green, retired grey. */
export const VERSION_STATUS: Record<VersionStatus, Status & { description: string }> = {
  draft: { health: statusTone("draft"), label: "Draft", description: "Being edited. Nothing uses it until it is submitted and approved." },
  in_review: { health: statusTone("in_review"), label: "In review", description: "Submitted. A config checker who didn't work on it approves or rejects it." },
  published: { health: statusTone("published"), label: "Published", description: "In use: pulls and files are read with it." },
  retired: { health: statusTone("retired"), label: "Retired", description: "Replaced by a newer published version; kept for the record." },
};
/** A draft a config checker sent back with a comment (its `reviewComment`), shown apart from a plain draft: its maker acts. */
export const SENT_BACK: Status & { description: string } = {
  health: statusTone("sent_back"), label: "Sent back", description: "A config checker sent it back with a comment; its maker edits and submits it again.",
};
export const VERSION_LEGEND = [VERSION_STATUS.draft, SENT_BACK, VERSION_STATUS.in_review, VERSION_STATUS.published, VERSION_STATUS.retired];
/** A version's chip: Sent back for a draft with a checker's comment, else its status. */
export const versionChip = (v: { status: VersionStatus; reviewComment: string | null }) => (v.status === "draft" && v.reviewComment ? SENT_BACK : VERSION_STATUS[v.status]);

/** A pull of a watermark source (owner 24 Nov): New rows green, Nothing new grey, Failed red, Paused grey. */
export const PULL_STATUS: Record<SourcePullDto["status"], Status & { description: string }> = {
  new: { ...statusChip("new_data", "New rows"), description: "The pull read rows and stored new records." },
  nothing_new: { ...statusChip("nothing", "Nothing new"), description: "The table had no row past the last watermark." },
  failed: { ...statusChip("failed", "Failed"), description: "The pull couldn't read the source; the next one tries again." },
  paused: { ...statusChip("paused", "Paused"), description: "The table no longer fits the source's version; pulls wait for a new version." },
};
