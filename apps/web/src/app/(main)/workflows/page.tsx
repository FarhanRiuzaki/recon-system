import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Page as Paged } from "@starterkit/shared/contracts/common";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { backendJson, v1Path } from "@/lib/server/backend";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { getSession } from "@/lib/server/session";
import { spaceEntry } from "@/lib/shared/nav";
import { PREFS_COOKIE, parsePrefs, viewHref } from "@/lib/shared/prefs";
import { spaceOptions } from "@/lib/shared/queries";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Workflows");

/**
 * The Workflows entry (the navigation's "Workflows"): the remembered space while the caller holds a role there, else
 * their first such space (name A–Z), at its workflows (DEC-052 rev 2: a space owns its workflows); with none → /spaces.
 */
export default async function Page() {
  await requirePagePermission(null);
  const { token } = await getSession();
  const { status, data } = await backendJson<Paged<SpaceRowDto>>(v1Path(spaceOptions().url)!, { token, req: { headers: await headers() } });
  if (status !== 200 || !data) throw new Error(`GET /v1/spaces answered ${status}`);
  const prefs = parsePrefs((await cookies()).get(PREFS_COOKIE)?.value);
  const to = spaceEntry("workflows", data.items, prefs.space);
  redirect(to ? viewHref(to, prefs) : "/spaces");
}
