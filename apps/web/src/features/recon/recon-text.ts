// Sentences of the recon screens that aren't the builder's: activity entries, who may decide on a version, when.
import { APP_TIME_ZONE_LABEL, formatDateTime } from "@starterkit/ui/lib/format";
import { rangeText } from "./run-model";

/** "21 Nov 2026 14:20 WIB": an instant as the app writes it. */
export const at = (iso: string) => `${formatDateTime(Date.parse(iso))} ${APP_TIME_ZONE_LABEL}`;

/**
 * The tabs of a recon's page (in the URL as ?tab=), four (owner, 22 Nov: few tabs, details merged): Overview = how it
 * runs (its day, runs, trend, pipeline, sources), Configuration = what it is (the builder over a draft, else the
 * published spec), Posting groups = what its grouped postings collect and send (stage 5), History = its versions and its activity.
 */
export const RECON_TABS = ["overview", "configuration", "posting", "history"] as const;
export type ReconTab = (typeof RECON_TABS)[number];
/** ?tab= as a tab; the tabs before the merge (live, versions, activity) open the tab that now holds them. */
export function reconTabOf(v: string | null): ReconTab {
  if (v === "versions" || v === "activity") return "history";
  return RECON_TABS.find((t) => t === v) ?? "overview";
}

type Entry = { action: string; actor: { name: string }; before: unknown; after: unknown };
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
/** " for 2–5 Nov 2026" from an entry's business dates (from, to), or nothing without them. */
const dates = (o: unknown) => {
  const from = field(o, "from"), to = field(o, "to");
  return typeof from === "string" && typeof to === "string" ? ` for ${rangeText(from, to)}` : "";
};
/** One sentence per entry of a recon's activity: who did what to which draft, never a hash; a checker's comment is quoted. */
export function activitySentence(e: Entry): string {
  const who = e.actor.name || "Someone";
  const v = String(field(e.after, "version") ?? field(e.before, "version") ?? "");
  switch (e.action) {
    case "recon.create": return `${who} created the recon with Draft v1.`;
    case "recon.version_create": { const from = field(e.after, "from"); return `${who} started Draft v${v}${from ? ` from version ${String(from)}` : ""}.`; }
    case "recon.version_update": return `${who} saved Draft v${v}.`;
    case "recon.version_submit": return `${who} sent version ${v} for approval.`;
    case "recon.version_approve": {
      const retired = field(e.after, "retired"), reopened = field(e.after, "reopened");
      return `${who} approved version ${v}${retired ? `; version ${String(retired)} retired` : ""}${reopened ? `; ${String(reopened)} side-B items not required are checked again` : ""}.`;
    }
    case "recon.version_reject": return `${who} sent version ${v} back: “${String(field(e.after, "comment") ?? "")}”`;
    case "recon.discard": return `${who} deleted the draft recon.`;
    case "recon.version_discard": return `${who} discarded Draft v${String(field(e.before, "version") ?? "")}; the live version kept running.`;
    case "recon.run": return `${who} ran version ${v}${dates(e.after)}.`;
    case "recon.simulate": return `${who} simulated draft v${v}${dates(e.after)}.`;
    case "day.prepare": { const d = field(e.after, "date"); return `${who} prepared ${typeof d === "string" ? rangeText(d, d) : "a day"} for sign-off.`; }
    case "day.sign": { const d = field(e.after, "date"); return `${who} signed off ${typeof d === "string" ? rangeText(d, d) : "a day"}.`; }
    default: return `${who} changed the recon.`;
  }
}

/** Why the viewer can't approve or reject this version, or null (maker ≠ checker, spec §11). */
export function reviewReason(v: { status: string; submitterId: string | null; makerId: string | null; contributorIds: string[] }, me: string, checker: boolean, act: "approve" | "reject", superadmin = false): string | null {
  if (v.status !== "in_review") return "This version is no longer waiting for approval.";
  if (superadmin) return null; // a Superadmin decides anything, their own too (owner rule, 22 Nov)
  if (v.submitterId === me) return `You sent this version for approval. Another config checker ${act}s it.`;
  if (v.makerId === me || v.contributorIds.includes(me)) return `You worked on this version. A config checker who didn't work on it ${act}s it.`;
  if (!checker) return `Only a config checker of this space ${act}s recon versions.`;
  return null;
}
