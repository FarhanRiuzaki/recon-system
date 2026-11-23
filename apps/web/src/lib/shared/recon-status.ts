import type { Health } from "@starterkit/ui/lib/status";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import type { VersionStatus } from "@starterkit/shared/sources";
import { statusTone } from "./categories";

type Status = { health: Health; label: string; description: string };

/**
 * One mapping for a recon's chip on every recon screen: no published version yet = Draft (nothing runs), or In review
 * while its draft waits for a config checker; paused =
 * stopped on purpose, otherwise Live. Matching results get their own states once the engine runs (Plan 3 Task 3).
 */
export function reconStatus(r: Pick<ReconRowDto, "status" | "publishedVersion" | "draftStatus">): Status {
  // a recon not live yet whose open version waits for a checker reads "In review", in the list and on its page alike
  if (r.publishedVersion === null) return r.draftStatus === "in_review" ? RECON_LEGEND[1]! : RECON_LEGEND[0]!;
  return r.status === "paused" ? RECON_LEGEND[3]! : RECON_LEGEND[2]!;
}

/** The legend of a card that shows recon states (Panel `legend`). */
export const RECON_LEGEND: readonly Status[] = [
  { health: statusTone("draft"), label: "Draft", description: "No approved version yet, so it never runs." },
  { health: statusTone("in_review"), label: "In review", description: "No approved version yet; its first version waits for a config checker." },
  { health: statusTone("live"), label: "Live", description: "A version is approved; it runs on its schedule." },
  { health: statusTone("paused"), label: "Paused", description: "Stopped on purpose; nothing runs until it is resumed." },
];

/** A recon version's state, as source versions: draft grey, in review blue, published green, retired grey. */
export const RECON_VERSION_STATUS: Record<VersionStatus, Status> = {
  draft: { health: statusTone("draft"), label: "Draft", description: "Being edited. Nothing runs with it until it is submitted and approved." },
  in_review: { health: statusTone("in_review"), label: "In review", description: "Submitted. A config checker who didn't work on it approves or rejects it." },
  published: { health: statusTone("published"), label: "Published", description: "In use: runs read their passes and settings from it." },
  retired: { health: statusTone("retired"), label: "Retired", description: "Replaced by a newer published version; kept for the record." },
};
/** A draft a config checker sent back with a comment. */
export const RECON_SENT_BACK: Status = {
  health: statusTone("sent_back"), label: "Sent back", description: "A config checker sent it back with a comment; its maker edits and submits it again.",
};
export const RECON_VERSION_LEGEND = [RECON_VERSION_STATUS.draft, RECON_SENT_BACK, RECON_VERSION_STATUS.in_review, RECON_VERSION_STATUS.published, RECON_VERSION_STATUS.retired];
/** A version's chip: Sent back for a draft with a checker's comment, else its status. */
export const reconVersionChip = (v: { status: VersionStatus; reviewComment: string | null }) =>
  (v.status === "draft" && v.reviewComment ? RECON_SENT_BACK : RECON_VERSION_STATUS[v.status]);
