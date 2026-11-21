import type { Health } from "@starterkit/ui/lib/status";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import type { VersionStatus } from "@starterkit/shared/sources";

type Status = { health: Health; label: string; description: string };

/**
 * One mapping for a recon's chip on every recon screen: no published version yet = Draft (nothing runs), or In review
 * while its draft waits for a config checker; paused =
 * stopped on purpose, otherwise Live. Matching results get their own states once the engine runs (Plan 3 Task 3).
 */
export function reconStatus(r: Pick<ReconRowDto, "status" | "publishedVersion"> & { draft?: { status: VersionStatus } | null; draftStatus?: VersionStatus | null }): Status {
  // a recon not live yet whose draft waits for a checker reads "In review": the recon's page knows its draft, a list
  // row its draftStatus (one mapping for both)
  const draft = r.draftStatus ?? r.draft?.status ?? null;
  if (r.publishedVersion === null) return draft === "in_review" ? RECON_LEGEND[1]! : RECON_LEGEND[0]!;
  return r.status === "paused" ? RECON_LEGEND[3]! : RECON_LEGEND[2]!;
}

/** The legend of a card that shows recon states (Panel `legend`). */
export const RECON_LEGEND: readonly Status[] = [
  { health: "stopped", label: "Draft", description: "No approved version yet, so it never runs." },
  { health: "unknown", label: "In review", description: "No approved version yet; its first version waits for a config checker." },
  { health: "healthy", label: "Live", description: "A version is approved; it runs on its schedule." },
  { health: "stopped", label: "Paused", description: "Stopped on purpose; nothing runs until it is resumed." },
];

/** A recon version's state: draft and in review neutral, published healthy, retired stopped (as source versions). */
export const RECON_VERSION_STATUS: Record<VersionStatus, Status> = {
  draft: { health: "unknown", label: "Draft", description: "Being edited. Nothing runs with it until it is submitted and approved." },
  in_review: { health: "unknown", label: "In review", description: "Submitted. A config checker who didn't work on it approves or rejects it." },
  published: { health: "healthy", label: "Published", description: "In use: runs read their passes and settings from it." },
  retired: { health: "stopped", label: "Retired", description: "Replaced by a newer published version; kept for the record." },
};
/** A draft a config checker sent back with a comment. */
export const RECON_SENT_BACK: Status = {
  health: "unknown", label: "Sent back", description: "A config checker sent it back with a comment; its maker edits and submits it again.",
};
export const RECON_VERSION_LEGEND = [RECON_VERSION_STATUS.draft, RECON_SENT_BACK, RECON_VERSION_STATUS.in_review, RECON_VERSION_STATUS.published, RECON_VERSION_STATUS.retired];
/** A version's chip: Sent back for a draft with a checker's comment, else its status. */
export const reconVersionChip = (v: { status: VersionStatus; reviewComment: string | null }) =>
  (v.status === "draft" && v.reviewComment ? RECON_SENT_BACK : RECON_VERSION_STATUS[v.status]);
