import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Page as Paged } from "@starterkit/shared/contracts/common";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { spaceHref } from "@/features/spaces/use-spaces";
import { backendJson, v1Path } from "@/lib/server/backend";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { getSession } from "@/lib/server/session";
import { PREFS_COOKIE, parsePrefs, viewHref } from "@/lib/shared/prefs";
import { spaceOptions } from "@/lib/shared/queries";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Recons");

/**
 * The Recons entry (the navigation's "Recons"): the remembered space while the caller holds a role there, else
 * their first such space (name A–Z), at its recons in the view last left there. Recons are a space's data, so a
 * space seen through space.view alone doesn't count; with none → /spaces (it explains or opens members).
 */
export default async function Page() {
  await requirePagePermission(null);
  const { token } = await getSession();
  const { status, data } = await backendJson<Paged<SpaceRowDto>>(v1Path(spaceOptions().url)!, { token, req: { headers: await headers() } });
  if (status !== 200 || !data) throw new Error(`GET /v1/spaces answered ${status}`);
  const prefs = parsePrefs((await cookies()).get(PREFS_COOKIE)?.value);
  const mine = data.items.filter((s) => s.roles.length);
  const open = mine.find((s) => s.id === prefs.space) ?? mine[0];
  redirect(open ? viewHref(spaceHref(open.id, "recons"), prefs) : "/spaces");
}
