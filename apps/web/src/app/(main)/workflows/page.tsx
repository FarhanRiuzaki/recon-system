import type { Metadata } from "next";
import { LibraryPage } from "@/features/approvals/library-page";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Workflows");

/** The global workflow library (DEC-052 revision): workflow.view reads it, workflow.manage creates and edits. */
export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission("workflow.view");
  return <Prefetch reads={[reads.library(toSearch(await searchParams))]}><LibraryPage canManage={perms.includes("workflow.manage")} /></Prefetch>;
}
