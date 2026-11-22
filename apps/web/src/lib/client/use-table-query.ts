"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";
import type { DataTablePaging } from "@starterkit/ui/ds";
import type { TableDef } from "@/lib/shared/queries";
import { api } from "@/lib/client/api";
import { usePrefs } from "@/lib/client/prefs-context";
import type { FacetsDto, Page } from "@starterkit/shared/contracts/common";
import { REMEMBERED_VIEW_QUERY_MAX } from "@starterkit/shared/views";
import { MAX_PAGE, PAGE_SIZES, type PageSize } from "@starterkit/shared/paging";
import { type ColumnChoice, columnsKey, savedView, viewPageOf } from "@/lib/shared/prefs";
import { facetsRequest, historyMode, preserveTableParams, readTable, type SortState, sortState, tableRequest, tableView, type TableState, tableHref, toSortParam, withOtherTables, writeTable } from "@/lib/shared/table-state";

/**
 * A server-driven table: page, page size, sort and filters live in the URL (shareable; a change other than the page
 * goes back to page 1; a patch that changes nothing does nothing), the server pages, sorts and filters
 * (`GET path?…` → `Page<T>`), and the result plugs into `DataTable` (`rows`, `sort`, `onSortChange`, `paging`).
 * Committed changes push a history entry (Back undoes them); search keystrokes (`spec.search`) replace it.
 *
 * - `spec` must be a module constant (it keys the memo). `params` turns the URL filters into API parameters (e.g. a
 *   range preset into from/to); by default the filters are sent as they are. Empty values are never sent.
 * - `enabled = false` (second argument) stops fetching, e.g. while the owner of the rows is gone.
 * - While the next page or sort loads, the previous rows stay on screen (`paging.busy`).
 * - `loadError` = nothing valid to show (first load, or the rows on screen belong to other filters) → DataTable `error`;
 *   `staleError` = a refetch failed while the shown rows still match → page `Notice`.
 * - A page past the end (rows were deleted, an old link) moves to the last page, showing the loading shape meanwhile
 *   (never a "no match" flash).
 * - `filterQuery` = the same filters without paging, for an export (`${path}?${filterQuery}&format=csv`).
 * - `count` = the Panel count ("12,345", "100,000+"); rows, loading and errors come from `tableView` (table-state.ts).
 * - On a list page (`VIEW_PAGES`) the view (filters, sort, rows per page; not the page or the search) is remembered in
 *   the prefs cookie, and the navigation links reopen it (`viewHref`). So is each table's column choice (`columnsKey`: page +
 *   the table's API path): `hidden` and `setHidden` plug into ColumnsMenu and DataTable `hidden`; until the viewer
 *   chooses, `hidden` is undefined and the table's `Column.defaultHidden` columns start hidden.
 */
const NONE: readonly string[] = [];

export function useTableQuery<T, F extends Record<string, string>>({ key, path, spec, params, transient = NONE, rawFilters = NONE, edit, facets: counted }: TableDef<F>, enabled = true) {
  const sp = useSearchParams();
  const pathname = usePathname();
  const state: TableState<F> = useMemo(() => readTable(sp, spec), [sp, spec]);
  const { prefs, update } = usePrefs();
  // The page's VIEW_PAGES entry: one view per list page, one for every space's members page.
  const listPage = viewPageOf(pathname);
  const view = listPage ? savedView(new URLSearchParams(sp.toString()), spec.search, listPage) : null;
  useEffect(() => {
    if (view === null || !listPage) return;
    // An oversized view explicitly clears the cookie even if SSR saw no entry:
    // the departing page may have written its older view after this request began.
    const remembered = view.length <= REMEMBERED_VIEW_QUERY_MAX ? view : "";
    if (remembered === prefs.views[listPage] || (view === "" && !prefs.views[listPage])) return;
    update({ views: { ...prefs.views, [listPage]: remembered } });
  }, [view, listPage, prefs.views, update]);

  const set = useCallback((patch: Partial<TableState<F>>, options?: { history: "push" | "replace" }) => {
    if (window.location.pathname !== pathname) return;
    const current = new URLSearchParams(window.location.search);
    const href = tableHref(pathname, current, patch, { spec, edit, transient });
    if (href === (current.size ? `${pathname}?${current}` : pathname)) return;
    // Native history (Next keeps useSearchParams in sync): the URL changes in place, without a server round trip for
    // the page, so the next page loads from /api with the previous rows kept and the busy dim. The server prefetch
    // covers document loads and route changes only.
    if ((options?.history ?? historyMode(patch, spec)) === "replace") window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }, [spec, pathname, transient, edit]);

  const { filterQuery, url } = tableRequest(path, state, spec, params, { search: sp, keys: rawFilters });
  const q = useQuery({ queryKey: [key, url], queryFn: () => api<Page<T>>(url), enabled, placeholderData: keepPreviousData });
  // the filters' counts (FacetsDto), read beside the rows with the same filters; the previous counts stay while it reloads
  const facetsUrl = facetsRequest(path, filterQuery);
  const fq = useQuery({ queryKey: [key, facetsUrl], queryFn: () => api<FacetsDto>(facetsUrl), enabled: enabled && !!counted, placeholderData: keepPreviousData });

  const tv = tableView(q, state.page);
  const lastPage = tv.pastEnd && tv.total ? Math.min(Math.ceil(tv.total / state.pageSize), MAX_PAGE) : 0;
  useEffect(() => {
    // replace, not push: Back should not return to the empty page.
    if (!lastPage || window.location.pathname !== pathname) return;
    const current = new URLSearchParams(window.location.search);
    const currentState = readTable(current, spec);
    if (tableRequest(path, currentState, spec, params, { search: current, keys: rawFilters }).url !== url) return;
    const patch = { page: lastPage } as Partial<TableState<F>>;
    const next = edit ? edit(current, patch) : writeTable(currentState, patch, spec);
    if (next) { preserveTableParams(next, current, transient); if (!edit) withOtherTables(next, current, spec); }
    if (next) window.history.replaceState(null, "", next.size ? `${pathname}?${next}` : pathname);
  }, [lastPage, state, spec, pathname, path, params, rawFilters, transient, url, edit]);

  const paging = {
    mode: "server", page: state.page, pageSize: state.pageSize, total: tv.total ?? 0, totalCapped: tv.totalCapped,
    maxPage: MAX_PAGE, pageSizes: PAGE_SIZES, busy: tv.busy,
    onPageChange: (page: number) => set({ page } as Partial<TableState<F>>),
    onPageSizeChange: (size: number) => set({ pageSize: size as PageSize } as Partial<TableState<F>>),
  } satisfies DataTablePaging;

  // One choice per table (page + the table's API path): two tables on one page never share it. undefined = no choice,
  // so DataTable and ColumnsMenu hide the `defaultHidden` columns (`hiddenColumns`).
  const colsKey = listPage ? columnsKey(listPage, path) : null;
  const hidden: ColumnChoice | undefined = colsKey ? prefs.columns[colsKey] : undefined;
  /** `null` = back to the default columns (ColumnsMenu "Reset to default", or ticked back to them). */
  const setHidden = useCallback((choice: ColumnChoice | null) => {
    if (!colsKey) return;
    const { [colsKey]: _, ...rest } = prefs.columns;
    update({ columns: choice ? { ...rest, [colsKey]: choice } : rest });
  }, [colsKey, prefs.columns, update]);

  /** The URL `set(patch)` goes to, for a filter drawn as a link (it opens in a new tab too). */
  const hrefOf = useCallback((patch: Partial<TableState<F>>) => tableHref(pathname, new URLSearchParams(sp.toString()), patch, { spec, edit, transient }), [sp, pathname, spec, edit, transient]);

  return {
    state, set, hrefOf, query: q, filterQuery, paging, hidden, setHidden, facets: fq.data,
    viewNotRemembered: view !== null && view.length > REMEMBERED_VIEW_QUERY_MAX,
    rows: tv.rows, total: tv.total, totalCapped: tv.totalCapped, count: tv.count,
    sort: sortState(state.sort),
    onSortChange: (s: SortState) => set({ sort: toSortParam(s) } as Partial<TableState<F>>),
    loading: tv.loading, loadError: tv.loadError, staleError: tv.staleError,
  };
}
