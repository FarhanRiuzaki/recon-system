import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Page as Paged } from "@starterkit/shared/contracts/common";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { NoSpace } from "@/features/spaces/no-space";
import { spaceHref } from "@/features/spaces/use-spaces";
import { backendJson, v1Path } from "@/lib/server/backend";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { getSession } from "@/lib/server/session";
import { PREFS_COOKIE, parsePrefs } from "@/lib/shared/prefs";
import { spaceOptions } from "@/lib/shared/queries";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Spaces");

/**
 * The space entry: the remembered space (`space` pref) while the caller can still open it, else their first space
 * (name A–Z), at its members page; no space → NoSpace. A failed read throws (error.tsx: "Try again"), never NoSpace.
 */
export default async function Page() {
  await requirePagePermission(null);
  const { token } = await getSession();
  const { status, data } = await backendJson<Paged<SpaceRowDto>>(v1Path(spaceOptions().url)!, { token, req: { headers: await headers() } });
  if (status !== 200 || !data) throw new Error(`GET /v1/spaces answered ${status}`);
  const remembered = parsePrefs((await cookies()).get(PREFS_COOKIE)?.value).space;
  const open = data.items.find((s) => s.id === remembered) ?? data.items[0];
  if (open) redirect(spaceHref(open.id, "members"));
  return <NoSpace />;
}
