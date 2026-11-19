import type { Metadata } from "next";
import { UserDetail } from "@/features/users/user-detail";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("User");

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission("user.view");
  const { id } = await params;
  // The user, their sessions table, the Superadmin check and their spaces (space.view only) in one server pass (no detail → sessions waterfall).
  return (
    <Prefetch reads={[reads.user(id), reads.userSessions(id, toSearch(await searchParams)), reads.superadmins(), ...(perms.includes("space.view") ? [reads.userSpaces(id)] : [])]}>
      <UserDetail id={id} />
    </Prefetch>
  );
}
