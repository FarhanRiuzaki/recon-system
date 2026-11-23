"use client";

import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { CategoryChip, ColumnsMenu, type Column, CountBadge, DataTable, Failure, Notice, Panel, RouteTabs, ScrollFade, Segmented, Toolbar } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDateTime, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Select } from "@starterkit/ui/ui/select";
import { Icon } from "@starterkit/ui/ui/icon";
import { NetworkIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { BRAND } from "@starterkit/shared/brand";
import type { PassSpec, ReconRunItemDto, RunGroupMember } from "@starterkit/shared/contracts/recon";
import { recordFields } from "@starterkit/shared/recon";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText, isNotFound } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { reconRunItems, type RunItemFilters } from "@/lib/shared/queries-recon";
import { amountText, breakCounts, breakLabel, breakPair, breaksOf, breaksText, dayPasses, differenceText, isLive, pairDifference, rangeText, readIn, reasonOptions, runCurrency, runDays, scopeCaption } from "./run-model";
import { RunSummary } from "./run-summary";
import { CARRIED, carriedDay, dayLabel, dayTilesOf, strayDatePatch, tileOption } from "./run-days";
import { RECON_RUN_SHAPE } from "./shapes";
import type { Fields } from "./spec-model";
import { reconHref, reconsHref, useRecon, useReconVersion, useRun, useSideSource } from "./use-recons";

const RunExplain = dynamic(() => import("./run-explain"), { ssr: false });

const none = <span className="text-fg-3">—</span>;
const dateText = (d: string) => rangeText(d, d);
/** Members of one side, summed: "26,017.79", or the sum of several (a group pass). */
/**
 * One side of a group: its members' sum ("26,017.79", "(3 items)" for several), or, for the side whose members the
 * API cut off (`more` left out), how many there are without a sum that would be short.
 */
function sideAmount(ms: readonly RunGroupMember[], more = 0): { text: string; ccy: string | null } {
  const ccy = ms[0]?.currency ?? null;
  if (more > 0) return { text: ms.length ? `${formatNumber(ms.length)} items + ${formatNumber(more)} more` : `${formatNumber(more)} more items`, ccy };
  if (!ms.length || ms.some((m) => m.amountMinor === null || m.currency !== ccy)) return { text: "—", ccy };
  const sum = ms.reduce((t, m) => t + BigInt(m.amountMinor!), 0n);
  return { text: `${amountText(sum.toString(), ccy)}${ms.length > 1 ? ` (${ms.length} items)` : ""}`, ccy };
}

/** `name` and `count`: the line tab ("Pass 1" 32); `label`: the phone select's whole line. */
type Tab = { key: string; name: string; count: number; label: string; pass?: number; status?: "open" | "break" };
/** A pass tab's label: what it did ("Pass 1 · 937 matched · 30 duplicate"); counts of the picked day when one is. */
function passLabel(p: PassSpec, x: { matched: number; suggested: number; broken: number } | undefined) {
  const parts = [`Pass ${p.no}`];
  if (p.accept === "auto" || x?.matched) parts.push(`${formatNumber(x?.matched ?? 0)} matched`);
  if (p.accept === "suggest" || x?.suggested) parts.push(`${formatNumber(x?.suggested ?? 0)} suggested`);
  if (x?.broken) parts.push(`${formatNumber(x.broken)} ${breakLabel(p).toLowerCase()}`);
  return parts.join(" · ");
}

/** The summary card: the run's state, its facts, its counts and what day close would do with what waits. */
/** A date tile's filters: "" All dates, CARRIED the carry-over dates, else that date. */
const datePatch = (v: string): Partial<RunItemFilters> => (v === CARRIED ? { date: "", carried: "1" } : { date: v, carried: "" });

/**
 * A run's results per pass (Task 5, Figma page 03 v1.0.4 "Results per pass"): the summary, a strip of the run's
 * business dates (each a filter), a tab per pass and Waiting, and the server-paged items: a pass's pairs one row per
 * group (both sides' amounts and what differs, Explain for the evidence), the items it broke, or what waits.
 */
export function ReconRunPage({ spaceId, id, runId }: { spaceId: string; id: string; runId: string }) {
  const rq = useRun(spaceId, id, runId);
  const recon = useRecon(spaceId, id).data;
  const run = rq.data;
  const vq = useReconVersion(spaceId, id, run?.versionId ?? "", !!run);
  const spec = vq.data?.spec;
  const sa = useSideSource(spaceId, spec?.sides[0].source_id ?? ""), sb = useSideSource(spaceId, spec?.sides[1].source_id ?? "");
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const def = useMemo(() => reconRunItems(spaceId, id, runId, spec?.passes ?? []), [spaceId, id, runId, spec]);
  const t = useTableQuery<ReconRunItemDto, RunItemFilters>(def, !!spec);
  // Explain: the row asked for (its button pending until the dialog's code has loaded) and the button to return to
  const [explain, setExplain] = useState<ReconRunItemDto | null>(null);
  const [shown, setShown] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openExplain = (r: ReconRunItemDto, from: HTMLElement) => { opener.current = from; setShown(false); setExplain(r); };
  // pending only when the dialog's code takes a while (no one-frame spinner); the button stays enabled and focused
  const explainBusy = useDelayedFlag(!!explain && !shown);
  // a run that ends while on screen: every items read of it (each tab, date and page) is read again
  const qc = useQueryClient();
  const was = useRef(run?.status);
  useEffect(() => {
    const before = was.current;
    was.current = run?.status;
    if (!isLive({ status: before ?? "" }) || isLive(run)) return;
    void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === def.key && String(x.queryKey[1]).startsWith(`${def.path}?`) });
  }, [run, qc, def]);
  // an old link: a carry-over date opens Carried over; a date, or Carried over, the run doesn't have, no date filter
  const setTable = t.set;
  const strayCarried = run ? strayDatePatch(run, t.state)?.carried : undefined; // the patch's date is always ""
  useEffect(() => { if (strayCarried !== undefined) setTable({ date: "", carried: strayCarried }, { history: "replace" }); }, [strayCarried, setTable]);
  const skeleton = useDelayedFlag(!run || !spec || !recon);
  const labels = useMemo((): readonly [string, string] => (spec ? [spec.sides[0].label, spec.sides[1].label] : ["Side A", "Side B"]), [spec]);
  // one currency for the run (both sources write it fixed): in the amount headers, no column of its own (§5.9); else a
  // Currency column on every page. ponytail: the sources' published specs, not the run's; a run DTO currency set would be exact
  const ccy = runCurrency(specA, specB);
  const columns = useColumns(t.state, labels, ccy);

  // a run is named by its time, in the title and the last crumb alike (Captain, R4-5): "Run 21 Nov, 01:40" (WIB)
  const title = run ? `${run.mode === "simulation" ? "Simulation" : "Run"} ${formatDateTime(Date.parse(run.finishedAt ?? run.startedAt))}` : "Recon run";
  const trail = recon ? [{ label: recon.name, href: reconHref(spaceId, id) }] : [];
  if (isNotFound(rq.error)) return <DetailNotFound title="Recon run" noun="run" list={{ href: reconsHref(spaceId), label: "Recons" }} />;
  if ((rq.error && !run) || (vq.error && !spec)) {
    return <div className="grid gap-section"><PageHeader title={title} trail={trail} /><Panel><Failure title="The run couldn't be loaded." error={rq.error ?? vq.error} source={BRAND.name} onRetry={() => { void rq.refetch(); void vq.refetch(); }} /></Panel></div>;
  }
  if (!run || !spec || !recon || skeleton) return <LoadingShape sections={RECON_RUN_SHAPE} shown={skeleton} />;

  const s = t.state;
  const waiting = s.status === "open" && !s.pass;
  // the Breaks tab: every break item of the run (a real run's; a simulation closes nothing)
  const breaksTab = s.status === "break" && !s.pass;
  const passNo = waiting || breaksTab ? 0 : Number(s.pass || "1");
  const pass = spec.passes[passNo - 1];
  // the picked tile: a date of the run, or Carried over (its carry-over dates as one); the tabs count what the table holds
  const day = s.carried ? (carriedDay(run) ?? undefined) : s.date ? run.days?.find((d) => d.date === s.date) : undefined;
  // as they stand now once the API has the run's days (live), else what the run itself did
  const standing = run.live && run.days ? runDays(run) : null;
  const counts = day ? day.passes : standing ? dayPasses(standing) : run.counters.passes;
  const open = day ? day.open : (run.live?.open ?? run.counters.open);
  const breaks = breakCounts(run);
  // breaks by the one definition (Duplicate included) over the run's own dates: the tab's title and the All dates tile
  const real = run.mode !== "simulation";
  const allBreaks = real ? breaksOf(day ? day.breakReasons : run.live?.breakReasons) : null;
  const passCount = (p: PassSpec) => { const c = counts[String(p.no)]; return (p.accept === "suggest" ? c?.suggested : c?.matched) ?? 0; };
  const breakTotal = allBreaks ? allBreaks.breaks.a + allBreaks.breaks.b : breaks ? breaks.a + breaks.b : 0;
  const tabs: Tab[] = [...spec.passes.map((p) => ({ key: `p${p.no}`, name: `Pass ${p.no}`, count: passCount(p), label: passLabel(p, counts[String(p.no)]), pass: p.no })),
    { key: "waiting", name: "Waiting", count: open.a + open.b, label: `Waiting · ${formatNumber(open.a)} ${labels[0]} · ${formatNumber(open.b)} ${labels[1]}`, status: "open" as const },
    ...(breaks ? [{ key: "breaks", name: "Unmatch", count: breakTotal, label: `Unmatch · ${allBreaks ? breaksText(allBreaks, labels, false) : `${formatNumber(breaks.a)} ${labels[0]} · ${formatNumber(breaks.b)} ${labels[1]}`}`, status: "break" as const }] : [])];
  const tabKey = waiting ? "waiting" : breaksTab ? "breaks" : `p${passNo}`;
  const x = pass ? counts[String(pass.no)] : undefined;
  const own = pass?.accept === "suggest" ? "suggested" : "matched";
  const status = waiting ? "open" : breaksTab ? "break" : s.status || own;
  const statusOptions = pass ? [
    ...(pass.accept === "auto" || x?.matched ? [{ value: "matched", label: "Matched", count: x?.matched ?? 0 }] : []),
    ...(pass.accept === "suggest" || x?.suggested ? [{ value: "suggested", label: "Suggested", count: x?.suggested ?? 0 }] : []),
    ...(x?.broken ? [{ value: "break", label: breakLabel(pass), count: x.broken }] : []),
  ] : [];
  const items = status === "open" || status === "break";
  const dayTiles = dayTilesOf(run, spec);
  // one business date: its tile says what All dates says, so no strip (owner, 22 Nov: nothing twice)
  const strip = dayTiles.length > 2 ? (run.days ?? []) : [];
  // the table's caption names what it holds (audit R8): the tab, its rows, of the records read on its dates
  const what = waiting ? "waiting items" : breaksTab ? "unmatch items" : status === "break" ? `${breakLabel(pass!).toLowerCase()} items` : `${status} pairs`;
  const scopeDays = day ? [day] : runDays(run);
  const caption = t.total == null ? "" : scopeCaption(`${tabs.find((x) => x.key === tabKey)?.name ?? "Pass"}${day ? ` · ${dayLabel(day.date)}` : ""}`, t.total, what, readIn(scopeDays));
  const tabPatch = (tab: Tab): Partial<RunItemFilters> => (tab.status ? { pass: "", status: tab.status, side: "", reason: "" } : { pass: tab.pass === 1 ? "" : String(tab.pass), status: "", side: "", reason: "" });
  // the Breaks tab's reasons, on the picked date or over the run's own dates
  const byReason = (day ? day.breakReasons : run.live?.breakReasons) ?? null;
  const reasons = byReason ? reasonOptions(byReason) : [];

  return (
    <div className="grid gap-section">
      <PageHeader title={title} trail={trail}
        description={`${recon.name} · ${run.mode === "simulation" ? `Draft v${run.version}` : `Version ${run.version}`} · ${rangeText(run.from, run.to)}${run.mode === "simulation" ? " · not stored" : ""}`} />
      <RunSummary run={run} spec={spec} labels={labels} stalled={rq.stalled} />
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the items; showing the rows loaded before. {errorText(t.staleError)}</Notice>}
      <Panel flush icon={NetworkIcon} title="Results per pass"
        description={run.mode === "simulation" ? "Not stored: after a real run these stay unmatched at day close." : undefined}
        toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}>
        <div className="grid gap-3 p-card">
          {/* from 768 px: a tile per business date and a tab per pass; on a phone the same choices as two selects */}
          <div className="grid gap-2 md:hidden">
            {strip.length > 0 && (
              <Select aria-label="Business date" value={s.carried ? CARRIED : s.date} onChange={(e) => t.set(datePatch(e.target.value))} className="w-full">
                {dayTiles.map((x) => <option key={x.date || "all"} value={x.date}>{tileOption(x, labels)}</option>)}
              </Select>
            )}
            <Select aria-label="Pass" value={tabKey} onChange={(e) => { const tab = tabs.find((x) => x.key === e.target.value); if (tab) t.set(tabPatch(tab)); }} className="w-full">
              {tabs.map((tab) => <option key={tab.key} value={tab.key}>{tab.label}</option>)}
            </Select>
          </div>
          {/* from 768 px: the business dates as one segmented choice (it scrolls sideways past the card's width) and the
              passes as line tabs with their counts (audit R8) */}
          {strip.length > 0 && (
            <ScrollFade className="scroll-quiet overflow-x-auto max-md:hidden">
              <Segmented label="Business date" value={s.carried ? CARRIED : s.date || "all"} onChange={(v) => t.set(datePatch(v === "all" ? "" : v))}
                options={dayTiles.map((x) => ({ value: x.date || "all", label: `${dayLabel(x.date)}${x.t.closed ? " · closed" : ""}` }))} />
            </ScrollFade>
          )}
          {/* each pass is a link to its URL (opens in a new tab too); a plain click changes the URL in place */}
          <RouteTabs aria-label="Passes" className="max-md:hidden">
            {tabs.map((tab) => (
              <a key={tab.key} href={t.hrefOf(tabPatch(tab))} aria-current={tab.key === tabKey ? "page" : undefined} className="gap-1.5"
                onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); t.set(tabPatch(tab)); }}>
                {tab.name}<CountBadge>{formatNumber(tab.count)}</CountBadge>
              </a>
            ))}
          </RouteTabs>
          <div className="flex flex-wrap items-center gap-3">
            <span role="status" className="text-body-sm text-fg-2">{caption}{pass ? ` · ${pass.name}` : ""}{status === "suggested" ? " · open until someone accepts them" : ""}</span>
            {breaksTab && <span className="text-body-sm text-fg-2">Duplicates from the passes; the rest left open at day close.</span>}
            {breaksTab && reasons.length > 1 && (
              <>
                {/* from 768 px a Segmented; on a phone a select like the date and pass ones (it would push the card wider) */}
                <span className="max-md:hidden">
                  <Segmented label="Reason" value={s.reason || "all"} options={reasons.map((o) => ({ ...o, value: o.value || "all" }))}
                    onChange={(v) => t.set({ reason: v === "all" ? "" : v })} />
                </span>
                <Select aria-label="Reason" value={s.reason} onChange={(e) => t.set({ reason: e.target.value })} className="w-full md:hidden">
                  {reasons.map((o) => <option key={o.value || "all"} value={o.value}>Reason · {o.label} {formatNumber(o.count)}</option>)}
                </Select>
              </>
            )}
            {statusOptions.length > 1 && (
              <Segmented label={`Pass ${pass!.no} outcome`} value={status} options={statusOptions}
                onChange={(v) => t.set({ status: v === own ? "" : v, side: "", pass: v === "break" || pass!.no !== 1 ? String(pass!.no) : "" })} />
            )}
            {items && (
              <Segmented label="Side" value={s.side || "both"} options={[{ value: "both", label: "Both sides" }, { value: "a", label: labels[0] }, { value: "b", label: labels[1] }]}
                onChange={(v) => t.set({ side: v === "both" ? "" : v })} />
            )}
          </div>
        </div>
        <DataTable label="Items" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          rowActions={(r) => {
            // every break explains itself (its group, its proposed pair, or what day close looked for); pairs need a group
            if (!r.group && !breaksTab) return null;
            const busy = explainBusy && explain?.id === r.id;
            return (
              <Button type="button" variant="secondary" size="sm" aria-label={`Explain ${r.extRef ?? "this pair"}`} aria-busy={busy || undefined}
                onClick={(e) => openExplain(r, e.currentTarget)}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Explain</Button>
            );
          }}
          error={t.loadError ? { title: "Couldn't load the items", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={breaksTab && !isLive(run) ? { icon: NetworkIcon, title: "No unmatch on these dates.", description: "Unmatch appears here when a date closes with items nothing paired." }
            : { icon: NetworkIcon, title: isLive(run) ? "Nothing here yet" : "No items here",
              description: isLive(run) ? "Items appear here once the run is over." : "Pick another pass, outcome or date to see its items." }} />
      </Panel>
      {explain && <RunExplain item={explain} spec={spec} fields={fields} labels={labels} onShown={() => setShown(true)}
        returnFocus={() => opener.current?.isConnected && opener.current.focus()} onClose={() => setExplain(null)} />}
    </div>
  );
}

/** What differs in a break's pair: its suggested group's evidence, else its proposed pair's amount and date (B − A). */
function breakDifference(r: ReconRunItemDto): string {
  if (r.group) return differenceText(r.group.evidence, r.currency);
  const p = breakPair(r);
  if (!p) return "";
  return r.side === "a" ? pairDifference(r, p) : pairDifference(p, r);
}

/** The table's columns for the tab: a pass's pairs (both sides' amounts, what differs) or items (side, amount, why). */
function useColumns(s: RunItemFilters, labels: readonly [string, string], ccy: string | null): Column<ReconRunItemDto>[] {
  const pairs = !(s.status === "open" || s.status === "break");
  const unit = ccy ? ` (${ccy})` : "";
  return useMemo((): Column<ReconRunItemDto>[] => {
    const ref: Column<ReconRunItemDto> = { key: "ref", header: "Reference", mobile: "title", className: "font-mono text-mono", cell: (r) => r.extRef ?? none };
    // a pair row counts on its group's date (the later member's); an item list shows the item's own (re-check 5, B3)
    const date: Column<ReconRunItemDto> = { key: "businessDate", header: "Business date", sortable: true, mobile: "meta", cell: (r) => dateText(pairs ? (r.group?.businessDate ?? r.businessDate) : r.businessDate) };
    if (pairs) {
      const side = (k: "a" | "b") => (r: ReconRunItemDto) => {
        const ms = r.group?.members ?? [], more = r.group ? r.group.memberCount - ms.length : 0;
        // the API lists side A first and cuts the rest, so the members left out are side B's
        // ponytail: a group with more than 50 side A members also hides some of A; the API would need a count per side
        const cut = more > 0 && k === "b";
        return sideAmount(ms.filter((m) => m.side === k), cut ? more : 0);
      };
      // §5.9: Reference · date · amount A · amount B · Difference · pass; the currency in the headers when there is one
      return [ref, date,
        { key: "amountA", header: `Amount ${labels[0]}${unit}`, align: "right", mobile: "meta", cell: (r) => side("a")(r).text },
        { key: "amountB", header: `Amount ${labels[1]}${unit}`, align: "right", mobile: "meta", cell: (r) => side("b")(r).text },
        ...(ccy ? [] : [{ key: "currency", header: "Currency", mobile: "meta" as const, cell: (r: ReconRunItemDto) => side("a")(r).ccy ?? none }]),
        { key: "difference", header: "Difference", mobile: "meta", cell: (r) => differenceText(r.group?.evidence, side("a")(r).ccy) || none },
        { key: "pass", header: "Pass", mobile: "meta", cell: (r) => (r.group ? <CategoryChip slot="neutral" label={`Pass ${r.group.passNo}`} /> : none) },
      ];
    }
    const sideCol: Column<ReconRunItemDto> = { key: "side", header: "Side", mobile: "meta", cell: (r) => (r.side === "a" ? labels[0] : labels[1]) };
    const amount: Column<ReconRunItemDto>[] = [
      { key: "amount", header: `Amount${unit}`, align: "right", mobile: "meta", cell: (r) => amountText(r.amountMinor, r.currency) },
      ...(ccy ? [] : [{ key: "currency", header: "Currency", mobile: "meta" as const, cell: (r: ReconRunItemDto) => r.currency ?? none }]),
    ];
    if (s.status === "break") {
      // Breaks (designer, Figma 205:6752): Reference, Business date, Side, Reason, Amount, Currency, Difference, Proposed pair
      const label = (k: "a" | "b") => (k === "a" ? labels[0] : labels[1]);
      return [ref, date, sideCol, { key: "reason", header: "Reason", mobile: "meta", cell: (r) => r.breakReason ?? none }, ...amount,
        { key: "difference", header: "Difference", mobile: "meta", cell: (r) => breakDifference(r) || none },
        { key: "proposed", header: "Proposed pair", mobile: "meta", cell: (r) => { const p = breakPair(r); return p
          ? <span><span className="font-mono text-mono">{p.extRef ?? "—"}</span> · {label(p.side)} · pass {p.passNo}</span> : none; } }];
    }
    return [ref, sideCol, date, ...amount];
  }, [pairs, s.status, labels, ccy, unit]);
}
