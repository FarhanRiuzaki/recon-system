import type { Metadata } from "next";
import { MonitoringPage } from "@/features/imports/monitoring-page";
import { guardedTitle, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

export const generateMetadata = (): Promise<Metadata> => guardedTitle("Monitoring");

export default async function Page() {
  await requirePagePermission("import.view");
  return <Prefetch reads={[reads.importMonitor()]}><MonitoringPage /></Prefetch>;
}
