import type { Metadata } from "next";
import { CallsPage } from "@/features/integrations/calls-page";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Call log");

/** The connector call log: integration.view reads it masked; integration.debug also shows a call in full. */
export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission("integration.view");
  return <Prefetch reads={[reads.connectorCalls(toSearch(await searchParams)), reads.connectorOptions()]}><CallsPage canDebug={perms.includes("integration.debug")} /></Prefetch>;
}
