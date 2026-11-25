import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InboxPage } from "@/features/inbox/inbox-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a member (openSpace: through the API; the inbox is a member's data). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Inbox files · ${space.name}` : "Page not found");
}

/** The space root's folders, or one folder's files with `?folder=` (its first page prefetched). */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  const folder = sp.get("folder");
  const rs = [reads.space(spaceId), folder ? reads.inboxFiles(spaceId, folder, sp) : reads.inboxFolders(spaceId)];
  return <Prefetch reads={rs}><InboxPage spaceId={spaceId} /></Prefetch>;
}
