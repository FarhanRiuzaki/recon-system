// The approvals inbox's vocabulary, zod-free (client code imports it as values, AGENTS.md §9).

/**
 * What a checker can be asked to decide in a space (spec §11 maker-checker). Phase 1 today: a source version and a recon
 * version sent for approval; break requests (force-match, unmatch, write-off), reopen and rerun join with Breaks (Plan 5).
 */
export const APPROVAL_KINDS = ["source_version", "recon_version"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
/** Each kind as the inbox names it. */
export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = { source_version: "Source version", recon_version: "Recon version" };

/**
 * Why the caller can't decide a version sent for approval, or null (spec §11: a config checker of the space who had no
 * hand in it, compared by user id; a Superadmin decides anything, owner rule 22 Nov). The same words as the version's own page.
 */
export function approvalBlocked(kind: ApprovalKind, v: { makerId: string | null; contributorIds: readonly string[] }, me: string, checker: boolean, superadmin = false): string | null {
  if (superadmin) return null;
  if (v.makerId === me || v.contributorIds.includes(me)) return "You worked on this version. A config checker who didn't work on it approves it.";
  if (!checker) return `Only a config checker of this space approves ${kind === "source_version" ? "source" : "recon"} versions.`;
  return null;
}
