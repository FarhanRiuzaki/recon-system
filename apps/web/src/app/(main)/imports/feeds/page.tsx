import type { Metadata } from "next";
import { FeedsPage } from "@/features/imports/feeds-page";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Feeds");

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePagePermission("import.view");
  return <Prefetch reads={[reads.importFeeds(toSearch(await searchParams))]}><FeedsPage /></Prefetch>;
}
