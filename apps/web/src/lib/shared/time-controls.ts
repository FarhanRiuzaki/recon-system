import { resolveTimeRange, timeRangeLabel } from "@starterkit/ui/lib/time-range";
import { appDate, appDayStart, shiftDate } from "@starterkit/ui/lib/format";
import { validDateRange } from "@starterkit/ui/lib/date-range";

export const REFRESH_SECONDS = [0, 10, 30, 60, 300] as const;
export const refreshInterval = (value: string | null): number => { const n = Number(value); return Number.isInteger(n) && n >= 5 && n <= 3600 ? n : 0; };
export function timeRange(sp: Pick<URLSearchParams, "get">, fallback = 14, now = Date.now()) {
  const selection = { start: sp.get("start") ?? "", end: sp.get("end") ?? "" };
  const timed = resolveTimeRange(selection, now);
  if (timed) return { range: { from: appDate(timed.start), to: appDate(timed.end - 1) }, params: selection, selection, custom: true, days: (timed.end - timed.start) / 86_400_000, label: timeRangeLabel(selection) };
  const from = sp.get("from") ?? "", to = sp.get("to") ?? "";
  if (validDateRange(from, to)) return { range: { from, to }, params: { from, to }, selection: { start: new Date(appDayStart(from)).toISOString(), end: new Date(appDayStart(shiftDate(to, 1))).toISOString() }, custom: true, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1, label: `${from} – ${to}` };
  const days = (fallback === 7 ? [7, 30, 90] : [7, 14, 30, 90]).find((d) => `${d}d` === sp.get("range")) ?? fallback;
  const end = appDate(now);
  return { range: { from: shiftDate(end, 1 - days), to: end }, params: { from: shiftDate(end, 1 - days), to: end }, selection: { start: new Date(appDayStart(shiftDate(end, 1 - days))).toISOString(), end: new Date(appDayStart(shiftDate(end, 1))).toISOString() }, custom: false, days, label: days === 1 ? "Today" : `Last ${days} days` };
}
export function patchTimeSearch(sp: URLSearchParams, patch: Record<string, string>): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (Object.keys(patch).some((key) => key !== "refresh")) next.delete("page");
  for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
  return next;
}
/**
 * The query keys (their first element, the owning module) the header's refresh reads again on `path`; `tab` = the
 * page's ?tab. Null = no refresh: forms never refetch underneath unsaved input (a new user, a source wizard, a recon's
 * Configuration, its builder).
 */
export function refreshScope(path: string, tab: string | null = null): readonly string[] | null {
  if (path === "/") return ["dashboard"];
  if (path === "/users") return ["users"];
  if (path === "/roles" || path === "/permissions") return ["rbac"];
  if (path === "/audit/activity" || path === "/audit/auth") return ["audit"];
  if (path === "/me/sessions") return ["me"];
  if (path === "/integrations/calls") return ["integrations"];
  // a space's pages with data (owner, 22 Nov: the header's refresh on every module that has it)
  const page = /^\/spaces\/[^/]+\/(.+)$/.exec(path)?.[1];
  if (!page) return null;
  if (page === "members") return ["spaces"];
  if (page === "today") return ["engine"];
  if (page === "sources") return ["sources"];
  if (page === "recons") return ["recon"];
  if (/^sources\/[^/]+$/.test(page) && page !== "sources/new") return ["sources", "ingest"];
  if (/^recons\/[^/]+$/.test(page) && page !== "recons/new") return tab === "configuration" ? null : ["recon", "engine"];
  if (/^recons\/[^/]+\/runs\/[^/]+$/.test(page)) return ["engine"];
  return null;
}

/**
 * Pages whose rows are dated, so the header's date range filters them, with the days it covers by default: the
 * dashboard (the last 7 days, RECON_DASHBOARD_DAYS), both logs, a source's Activity tab and a recon's History tab (their trail, TRAIL_DAYS in queries.ts).
 */
export function timeWindowDays(path: string, tab: string | null = null): number | null {
  if (path === "/") return 7;
  if (path.startsWith("/audit/")) return 7;
  if (path === "/integrations/calls") return 1; // the call log opens on today
  const detail = /^\/spaces\/[^/]+\/(sources|recons)\/([^/]+)$/.exec(path);
  if (detail && detail[2] !== "new" && (detail[1] === "sources" ? tab === "activity" : tab === "history" || tab === "activity")) return 90;
  return null;
}
