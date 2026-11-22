import type { Metadata } from "next";
import { ConnectorsPage } from "@/features/integrations/connectors-page";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Open API");

/** Open API connectors (DEC-053): integration.view reads, integration.manage edits. */
export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission("integration.view");
  return <Prefetch reads={[reads.connectors(toSearch(await searchParams))]}><ConnectorsPage canManage={perms.includes("integration.manage")} /></Prefetch>;
}
