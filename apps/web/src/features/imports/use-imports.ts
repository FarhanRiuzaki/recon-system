import { useQuery } from "@tanstack/react-query";
import type { ImportDateDto, ImportFeedDto, ImportMonitorDto } from "@starterkit/shared/contracts/imports";
import { api, retryUnlessNotFound } from "@/lib/client/api";
import { IMPORTS_KEY, importDate, importFeed, importMonitor } from "@/lib/shared/queries";

export { IMPORTS_KEY };

/** How often Monitoring reads again while open (late data and stuck schedulers show up without a reload). */
const MONITOR_POLL_MS = 60_000;

/** GET /api/imports/monitor: every feed's scheduler and its last 14 MIS dates; refreshed every minute and on focus. */
export function useMonitor() {
  return useQuery({ queryKey: importMonitor.key, queryFn: () => api<ImportMonitorDto>(importMonitor.url), refetchInterval: MONITOR_POLL_MS, refetchOnWindowFocus: true });
}

/** One feed; a 404 is final. */
export function useFeed(id: string, enabled = true) {
  const { key, url } = importFeed(id);
  return useQuery({ queryKey: key, queryFn: () => api<ImportFeedDto>(url), enabled, retry: retryUnlessNotFound });
}

/** One cell of the grid opened: its checks and history versions. */
export function useFeedDate(id: string, date: string) {
  const { key, url } = importDate(id, date);
  return useQuery({ queryKey: key, queryFn: () => api<ImportDateDto>(url), retry: retryUnlessNotFound });
}
