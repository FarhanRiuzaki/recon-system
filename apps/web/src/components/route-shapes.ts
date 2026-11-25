import { NEW_RECON_SHAPE, RECON_RUN_SHAPE, RECON_SETUP_SHAPE, RECON_SHAPE, RECON_VERSION_SHAPE, RECONS_SHAPE, TODAY_SHAPE } from "@/features/recon/shapes";
import { SOURCE_DETAIL_SHAPE, SOURCES_SHAPE, VERSION_SHAPE, WIZARD_SHAPE } from "@/features/sources/shapes";
import { MEMBERS_SHAPE } from "@/features/spaces/shapes";
import { APPROVALS_SHAPE, LIBRARY_EDITOR_SHAPE, LIBRARY_SHAPE } from "@/features/approvals/shapes";
import { CALLS_SHAPE, CONNECTOR_SHAPE, CONNECTORS_SHAPE, POSTING_SHAPE } from "@/features/integrations/shapes";
import { BREAK_SHAPE, BREAKS_SHAPE } from "@/features/breaks/shapes";
import { INBOX_SHAPE } from "@/features/inbox/shapes";
import { RESULTS_SHAPE } from "@/features/results/shapes";
import type { Section } from "./route-skeleton";

/**
 * The loading shape of each page a folder's loading.tsx can stand in for (ui-standard §3: loading in the page's own
 * shape; the neutral title and block only for a boundary whose page isn't listed). A navigation from outside a space
 * to one of its pages suspends at `spaces/loading.tsx`, and the entries /sources and /recons at `(main)/loading.tsx`:
 * those boundaries show the shape listed here for the page being opened. Every page under `spaces/[spaceId]` is
 * listed with the shape its own loading.tsx renders (`apps/web/src/test/page-anatomy.test.ts`); the entries show the
 * list they open.
 */
export const ROUTE_SHAPES: Record<string, readonly Section[]> = {
  "/sources": SOURCES_SHAPE,
  "/recons": RECONS_SHAPE,
  "/today": TODAY_SHAPE,
  "/approvals": APPROVALS_SHAPE,
  "/breaks": BREAKS_SHAPE,
  "/spaces/[spaceId]/members": MEMBERS_SHAPE,
  "/spaces/[spaceId]/sources": SOURCES_SHAPE,
  "/spaces/[spaceId]/sources/new": WIZARD_SHAPE,
  "/spaces/[spaceId]/sources/[sourceId]": SOURCE_DETAIL_SHAPE,
  "/spaces/[spaceId]/sources/[sourceId]/versions/new": WIZARD_SHAPE,
  "/spaces/[spaceId]/sources/[sourceId]/versions/[versionId]": VERSION_SHAPE,
  "/spaces/[spaceId]/recons": RECONS_SHAPE,
  "/spaces/[spaceId]/today": TODAY_SHAPE,
  "/spaces/[spaceId]/approvals": APPROVALS_SHAPE,
  "/spaces/[spaceId]/workflows": LIBRARY_SHAPE,
  "/spaces/[spaceId]/workflows/[id]": LIBRARY_EDITOR_SHAPE,
  "/integrations": CONNECTORS_SHAPE,
  "/integrations/calls": CALLS_SHAPE,
  "/spaces/[spaceId]/posting": POSTING_SHAPE,
  "/spaces/[spaceId]/results": RESULTS_SHAPE,
  "/spaces/[spaceId]/inbox": INBOX_SHAPE,
  "/integrations/[id]": CONNECTOR_SHAPE,
  "/spaces/[spaceId]/breaks": BREAKS_SHAPE,
  "/spaces/[spaceId]/breaks/[itemId]": BREAK_SHAPE,
  "/spaces/[spaceId]/recons/new": NEW_RECON_SHAPE,
  "/spaces/[spaceId]/recons/[configId]": RECON_SHAPE,
  "/spaces/[spaceId]/recons/[configId]/versions/new": RECON_SETUP_SHAPE,
  "/spaces/[spaceId]/recons/[configId]/versions/[versionId]": RECON_VERSION_SHAPE,
  "/spaces/[spaceId]/recons/[configId]/runs/[runId]": RECON_RUN_SHAPE,
};

/** The listed shape of a path ("/spaces/<id>/sources/new"): a literal segment wins over a dynamic one. Null: none listed. */
export function shapeOfPath(pathname: string): readonly Section[] | null {
  const parts = pathname.replace(/\/+$/, "").split("/");
  let best: [number, readonly Section[]] | null = null;
  for (const [pattern, shape] of Object.entries(ROUTE_SHAPES)) {
    const want = pattern.split("/");
    if (want.length !== parts.length) continue;
    let dynamic = 0;
    if (!want.every((w, i) => (/^\[\w+\]$/.test(w) ? (dynamic++, parts[i] !== "") : w === parts[i]))) continue;
    if (!best || dynamic < best[0]) best = [dynamic, shape];
  }
  return best?.[1] ?? null;
}
