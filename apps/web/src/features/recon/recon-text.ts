// Sentences of the recon screens that aren't the builder's: activity entries, who may decide on a version, when.
import { APP_TIME_ZONE_LABEL, formatDateTime } from "@starterkit/ui/lib/format";

/** "21 Nov 2026 14:20 WIB": an instant as the app writes it. */
export const at = (iso: string) => `${formatDateTime(Date.parse(iso))} ${APP_TIME_ZONE_LABEL}`;

/** The tabs of a recon's page (in the URL as ?tab=). */
export const RECON_TABS = ["overview", "versions", "activity"] as const;
export type ReconTab = (typeof RECON_TABS)[number];

type Entry = { action: string; actor: { name: string }; before: unknown; after: unknown };
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
/** One sentence per entry of a recon's activity: who did what to which draft, never a hash; a checker's comment is quoted. */
export function activitySentence(e: Entry): string {
  const who = e.actor.name || "Someone";
  const v = String(field(e.after, "version") ?? field(e.before, "version") ?? "");
  switch (e.action) {
    case "recon.create": return `${who} created the recon with Draft v1.`;
    case "recon.version_create": { const from = field(e.after, "from"); return `${who} started Draft v${v}${from ? ` from version ${String(from)}` : ""}.`; }
    case "recon.version_update": return `${who} saved Draft v${v}.`;
    case "recon.version_submit": return `${who} sent version ${v} for approval.`;
    case "recon.version_approve": { const retired = field(e.after, "retired"); return `${who} approved version ${v}${retired ? `; version ${String(retired)} retired` : ""}.`; }
    case "recon.version_reject": return `${who} sent version ${v} back: “${String(field(e.after, "comment") ?? "")}”`;
    case "recon.discard": return `${who} deleted the draft recon.`;
    default: return `${who} changed the recon.`;
  }
}

/** Why the viewer can't approve or reject this version, or null (maker ≠ checker, spec §11). */
export function reviewReason(v: { status: string; submitterId: string | null; makerId: string | null; contributorIds: string[] }, me: string, checker: boolean, act: "approve" | "reject"): string | null {
  if (v.status !== "in_review") return "This version is no longer waiting for approval.";
  if (v.submitterId === me) return `You sent this version for approval. Another config checker ${act}s it.`;
  if (v.makerId === me || v.contributorIds.includes(me)) return `You worked on this version. A config checker who didn't work on it ${act}s it.`;
  if (!checker) return `Only a config checker of this space ${act}s recon versions.`;
  return null;
}
