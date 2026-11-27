// Pure rules of the Import section (unit-tested).
import type { ImportFeedPatchBody, ImportFeedSpec } from "@starterkit/shared/contracts/imports";

/**
 * What still keeps a feed's scheduler from going on, as sentences for the screen (spec §4–§6); empty = complete.
 * Monitoring needs none of it: a feed is watched from its history source alone.
 */
export function blockers(spec: ImportFeedSpec, tableState: "missing" | "created" | "adopted"): string[] {
  const out: string[] = [];
  if (!spec.connectionId) out.push("Set the host connection.");
  if (!spec.query) out.push("Write the query.");
  if (!spec.readinessQuery) out.push("Write the readiness query.");
  if (!spec.table) out.push("Define the target table.");
  else if (tableState === "missing") out.push("Create or adopt the target table.");
  if (!spec.mapping?.length) out.push("Map the table's columns.");
  if (!spec.schedule) out.push("Set the run times.");
  return out;
}

type Editable = { name: string; spec: ImportFeedSpec };

/**
 * The fields of `b` that differ from `cur`, as the activity entry's before / after (changed fields only); null when
 * nothing changes. A spec is compared whole, as JSON.
 */
export function feedChanges(cur: Editable, b: ImportFeedPatchBody): { before: Partial<Editable>; after: Partial<Editable> } | null {
  const before: Partial<Editable> = {};
  const after: Partial<Editable> = {};
  if (b.name !== undefined && b.name !== cur.name) { before.name = cur.name; after.name = b.name; }
  if (b.spec !== undefined && JSON.stringify(b.spec) !== JSON.stringify(cur.spec)) { before.spec = cur.spec; after.spec = b.spec; }
  return Object.keys(after).length ? { before, after } : null;
}

/** Whether `next` renames what history is keyed by (refused once the feed has a history row). */
export const renamesHistory = (cur: ImportFeedSpec, next: ImportFeedSpec): boolean =>
  cur.historySource !== next.historySource || cur.batchPrefix !== next.batchPrefix;
