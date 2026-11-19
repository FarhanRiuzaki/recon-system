import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { MembersPage } from "@/features/spaces/members-page";
import { backendJson, v1Path } from "@/lib/server/backend";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";
import { getSession } from "@/lib/server/session";
import { spaceDetail } from "@/lib/shared/queries";

type Params = Promise<{ spaceId: string }>;

/**
 * The space as the caller may see it (once per request: the title and the page share it). Any signed-in user reaches
 * this route (pagePerm null); the API decides membership: 403 (not a member, no space.manage) and 404 (no such space,
 * an id that is not a UUID) both give null, so the page and the title name no space the caller can't open.
 */
const openSpace = cache(async (id: string): Promise<SpaceRowDto | null> => {
  const path = v1Path(spaceDetail(id).url);
  if (!path) return null;
  const { status, data } = await backendJson<SpaceRowDto>(path, { token: (await getSession()).token, req: { headers: await headers() } });
  if (status === 403 || status === 404) return null;
  if (status !== 200 || !data) throw new Error(`GET /v1/spaces/:spaceId answered ${status}`);
  return data;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.name ?? "Page not found");
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  if (!(await openSpace(spaceId))) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.spaceMembers(spaceId, toSearch(await searchParams))]}><MembersPage id={spaceId} /></Prefetch>;
}
