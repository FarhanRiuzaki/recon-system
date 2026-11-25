// The approvals inbox's vocabulary, zod-free (client code imports it as values, AGENTS.md §9).

/**
 * What a checker can be asked to decide in a space (spec §11 maker-checker): a source or recon version sent for
 * approval, and a change of a break (Plan 5 Task 3: force match, unmatch, write-off). Reopen and rerun follow.
 */
export const REQUEST_KINDS = ["posting", "force_match", "unmatch", "write_off"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const APPROVAL_KINDS = ["source_version", "recon_version", "report_version", ...REQUEST_KINDS] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
/** Each kind as the inbox names it. */
export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  source_version: "Source version", recon_version: "Recon version", report_version: "Report version", posting: "Posting", force_match: "Force match", unmatch: "Undo match", write_off: "Write-off",
};
export const isRequestKind = (k: string): k is RequestKind => (REQUEST_KINDS as readonly string[]).includes(k);

/**
 * Why the caller can't decide a break's request, or null: a reviewer or space admin of the space who didn't ask for it
 * (compared by user id, spec §11); a Superadmin decides anything (DEC-051).
 */
export function requestBlocked(requestedBy: string | null, me: string, lead: boolean, superadmin = false): string | null {
  if (superadmin) return null;
  if (requestedBy === me) return "You asked for this. A reviewer or space admin who didn't ask decides it.";
  if (!lead) return "Only a reviewer or space admin of this space decides unmatch requests.";
  return null;
}

/**
 * Why the caller can't decide a version sent for approval, or null (spec §11: a config checker of the space who had no
 * hand in it, compared by user id; a Superadmin decides anything, owner rule 22 Nov). The same words as the version's own page.
 */
export function approvalBlocked(kind: "source_version" | "recon_version" | "report_version", v: { makerId: string | null; contributorIds: readonly string[] }, me: string, checker: boolean, superadmin = false): string | null {
  if (superadmin) return null;
  if (v.makerId === me || v.contributorIds.includes(me)) return "You worked on this version. A config checker who didn't work on it approves it.";
  if (!checker) return `Only a config checker of this space approves ${kind === "source_version" ? "source" : kind === "report_version" ? "report" : "recon"} versions.`;
  return null;
}
