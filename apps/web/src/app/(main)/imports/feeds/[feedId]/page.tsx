import type { Metadata } from "next";
import { FeedPage } from "@/features/imports/feed-form";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Feed");

export default async function Page({ params }: { params: Promise<{ feedId: string }> }) {
  await requirePagePermission("import.view");
  const { feedId } = await params;
  return <Prefetch reads={[reads.importFeed(feedId)]}><FeedPage id={feedId} /></Prefetch>;
}
