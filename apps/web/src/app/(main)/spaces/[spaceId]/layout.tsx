import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { openSpace, requirePagePermission, spacePageRefused } from "@/lib/server/page-guard";

/**
 * Every page of one space (/spaces/<id>/…): a caller who can't open the space (not a member, no `space.view`, no such
 * space, an id that is no UUID) gets "Page not found", except on its workflows with `workflow.view` (the API's `or`;
 * spacePageRefused). On a client navigation this is the check; on a document load the (main) layout has already
 * answered the real 404 (this layout renders inside the (main) loading boundary, after the response has started).
 * openSpace is cached per request, so the page's own read costs no second call.
 */
export default async function SpaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ spaceId: string }> }) {
  if (!(await openSpace((await params).spaceId))) {
    const { perms } = await requirePagePermission(null);
    if (spacePageRefused((await headers()).get("x-pathname") ?? "", null, perms)) notFound();
  }
  return children;
}
