import type { Metadata } from "next";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { adminSection } from "@/features/dashboard/dashboard-model";
import { requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, toSearch, type SearchParams } from "@/lib/server/prefetch";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Any signed-in user: the recon numbers of the spaces they hold a role in; the user and sign-in numbers below only for
 * holders of user.view or audit.view (read only for them, so nobody else's first paint waits on them).
 */
export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission(null);
  const sp = toSearch(await searchParams);
  const admin = adminSection((p) => perms.includes(p));
  return <Prefetch reads={[reads.reconDashboard(sp), ...(admin ? [reads.dashboard(sp)] : [])]}><DashboardPage /></Prefetch>;
}
