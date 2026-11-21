"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { ColumnsMenu, type Column, DataTable, Failure, Notice, Panel, RouteTabs, Segmented, Toolbar } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { cn } from "@starterkit/ui/lib/cn";
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
import { reconRunItems, type RunItemFilters } from "@/lib/shared/queries";
import { writeTable } from "@/lib/shared/table-state";
import { amountText, breakCounts, breakLabel, dayPasses, dayTotals, differenceText, isLive, pairDifference, rangeText, reasonOptions, runDays, sidesText, standingTotals } from "./run-model";
import { RunSummary } from "./run-summary";
import { RECON_RUN_SHAPE } from "./shapes";
import type { Fields } from "./spec-model";
import { reconHref, reconRunHref, reconsHref, useRecon, useReconVersion, useRun, useSideSource } from "./use-recons";

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

type Tab = { key: string; label: string; pass?: number; status?: "open" | "break" };
/** A pass tab's label: what it did ("Pass 1 · 937 matched · 30 duplicate"); counts of the picked day when one is. */
function passLabel(p: PassSpec, x: { matched: number; suggested: number; broken: number } | undefined) {
  const parts = [`Pass ${p.no}`];
  if (p.accept === "auto" || x?.matched) parts.push(`${formatNumber(x?.matched ?? 0)} matched`);
  if (p.accept === "suggest" || x?.suggested) parts.push(`${formatNumber(x?.suggested ?? 0)} suggested`);
  if (x?.broken) parts.push(`${formatNumber(x.broken)} ${breakLabel(p).toLowerCase()}`);
  return parts.join(" · ");
}

/** The summary card: the run's state, its facts, its counts and what day close would do with what waits. */
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
  // a date the run doesn't have (an old link): no date filter
  const setTable = t.set;
  const strayDate = !!t.state.date && !!run?.days && !run.days.some((d) => d.date === t.state.date);
  useEffect(() => { if (strayDate) setTable({ date: "" }, { history: "replace" }); }, [strayDate, setTable]);
  const skeleton = useDelayedFlag(!run || !spec || !recon);
  const labels = useMemo((): readonly [string, string] => (spec ? [spec.sides[0].label, spec.sides[1].label] : ["Side A", "Side B"]), [spec]);
  const columns = useColumns(t.state, labels);

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
  const day = s.date ? run.days?.find((d) => d.date === s.date) : undefined;
  // as they stand now once the API has the run's days (live), else what the run itself did
  const standing = run.live && run.days ? runDays(run) : null;
  const counts = day ? day.passes : standing ? dayPasses(standing) : run.counters.passes;
  const open = day ? day.open : (run.live?.open ?? run.counters.open);
  const path = reconRunHref(spaceId, id, runId);
  const href = (patch: Partial<RunItemFilters>) => { const q = writeTable(s, patch, def.spec); return q?.size ? `${path}?${q}` : path; };
  const go = (patch: Partial<RunItemFilters>) => (e: React.MouseEvent) => { e.preventDefault(); t.set(patch); };
  const breaks = breakCounts(run);
  const tabs: Tab[] = [...spec.passes.map((p) => ({ key: `p${p.no}`, label: passLabel(p, counts[String(p.no)]), pass: p.no })),
    { key: "waiting", label: `Waiting · ${formatNumber(open.a)} ${labels[0]} · ${formatNumber(open.b)} ${labels[1]}`, status: "open" as const },
    ...(breaks ? [{ key: "breaks", label: `Breaks · ${formatNumber(breaks.a)} ${labels[0]} · ${formatNumber(breaks.b)} ${labels[1]}`, status: "break" as const }] : [])];
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
  const strip = run.days ?? [];
  const dayTiles = [{ date: "", t: { ...standingTotals(run, spec), closed: false } }, ...strip.map((d) => ({ date: d.date, t: dayTotals(d, spec) }))];
  const dayLabel = (date: string) => (date ? rangeText(date, date).replace(/ \d{4}$/, "") : "All dates");
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
        description={run.mode === "simulation" ? "Not stored: after a real run these become breaks at day close." : undefined}
        toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}>
        <div className="grid gap-3 px-3 pb-3">
          {/* from 768 px: a tile per business date and a tab per pass; on a phone the same choices as two selects */}
          <div className="grid gap-2 md:hidden">
            {strip.length > 0 && (
              <Select aria-label="Business date" value={s.date} onChange={(e) => t.set({ date: e.target.value })} className="w-full">
                {dayTiles.map(({ date, t: d }) => <option key={date || "all"} value={date}>{dayLabel(date)}{d.closed ? " · closed" : ""} · {formatNumber(d.matched)} matched · {formatNumber(d.suggested)} suggested{d.breaks && (d.breaks.a || d.breaks.b) ? ` · ${sidesText(d.breaks, labels, "breaks")}` : ""}</option>)}
              </Select>
            )}
            <Select aria-label="Pass" value={tabKey} onChange={(e) => { const tab = tabs.find((x) => x.key === e.target.value); if (tab) t.set(tabPatch(tab)); }} className="w-full">
              {tabs.map((tab) => <option key={tab.key} value={tab.key}>{tab.label}</option>)}
            </Select>
          </div>
          {strip.length > 0 && (
            <div role="group" aria-label="Business dates" className="grid gap-2 max-md:hidden md:grid-cols-3 xl:grid-cols-5">
              {dayTiles.map(({ date, t: d }) => (
                <Link key={date || "all"} href={href({ date })} onClick={go({ date })} aria-current={s.date === date ? "true" : undefined}
                  className={cn("grid gap-0.5 rounded-md border bg-card p-2.5 text-left text-caption text-fg-3 tabular focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    s.date === date ? "border-fg shadow-sm" : "border-line hover:bg-tray")}>
                  <span className="text-label text-fg">{dayLabel(date)}{d.closed ? " · closed" : ""}</span>
                  <span>{formatNumber(d.matched)} matched · {formatNumber(d.suggested)} suggested{d.duplicate ? ` · ${formatNumber(d.duplicate)} duplicate` : ""}</span>
                  <span>{sidesText(d.waiting, labels, "waiting")}</span>
                  {d.breaks && (d.breaks.a > 0 || d.breaks.b > 0) && <span>{sidesText(d.breaks, labels, "breaks")}</span>}
                </Link>
              ))}
            </div>
          )}
          <RouteTabs aria-label="Passes" className="max-md:hidden">
            {tabs.map((tab) => {
              const patch = tabPatch(tab);
              const current = tab.key === tabKey;
              return <Link key={tab.key} href={href(patch)} onClick={go(patch)} aria-current={current ? "page" : undefined}>{tab.label}</Link>;
            })}
          </RouteTabs>
          <div className="flex flex-wrap items-center gap-3">
            {pass && <span className="text-body-sm text-fg-2">Pass {pass.no} · {pass.name}{status === "suggested" ? " · open until someone accepts them" : ""}</span>}
            {breaksTab && <span className="text-body-sm text-fg-2">Duplicates from the passes; the rest left open at day close.</span>}
            {breaksTab && reasons.length > 1 && (
              <Segmented label="Reason" value={s.reason || "all"} options={reasons.map((o) => ({ ...o, value: o.value || "all" }))}
                onChange={(v) => t.set({ reason: v === "all" ? "" : v })} />
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
          empty={breaksTab && !isLive(run) ? { icon: NetworkIcon, title: "No breaks on these dates.", description: "Breaks appear here when a date closes with items nothing paired." }
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
  if (!r.proposed) return "";
  return r.side === "a" ? pairDifference(r, r.proposed) : pairDifference(r.proposed, r);
}

/** The table's columns for the tab: a pass's pairs (both sides' amounts, what differs) or items (side, amount, why). */
function useColumns(s: RunItemFilters, labels: readonly [string, string]): Column<ReconRunItemDto>[] {
  const pairs = !(s.status === "open" || s.status === "break");
  return useMemo((): Column<ReconRunItemDto>[] => {
    const ref: Column<ReconRunItemDto> = { key: "ref", header: "Reference", mobile: "title", className: "font-mono text-mono", cell: (r) => r.extRef ?? none };
    const date: Column<ReconRunItemDto> = { key: "businessDate", header: "Business date", sortable: true, mobile: "meta", cell: (r) => dateText(r.group?.businessDate ?? r.businessDate) };
    if (pairs) {
      const side = (k: "a" | "b") => (r: ReconRunItemDto) => {
        const ms = r.group?.members ?? [], more = r.group ? r.group.memberCount - ms.length : 0;
        // the API lists side A first and cuts the rest, so the members left out are side B's
        // ponytail: a group with more than 50 side A members also hides some of A; the API would need a count per side
        const cut = more > 0 && k === "b";
        return sideAmount(ms.filter((m) => m.side === k), cut ? more : 0);
      };
      return [ref, date,
        { key: "amountA", header: `Amount ${labels[0]}`, align: "right", mobile: "meta", cell: (r) => side("a")(r).text },
        { key: "amountB", header: `Amount ${labels[1]}`, align: "right", mobile: "meta", cell: (r) => side("b")(r).text },
        { key: "currency", header: "Currency", mobile: "meta", cell: (r) => side("a")(r).ccy ?? none },
        { key: "difference", header: "Difference", mobile: "meta", cell: (r) => differenceText(r.group?.evidence, side("a")(r).ccy) || none },
      ];
    }
    const sideCol: Column<ReconRunItemDto> = { key: "side", header: "Side", mobile: "meta", cell: (r) => (r.side === "a" ? labels[0] : labels[1]) };
    const amount: Column<ReconRunItemDto>[] = [
      { key: "amount", header: "Amount", align: "right", mobile: "meta", cell: (r) => amountText(r.amountMinor, r.currency) },
      { key: "currency", header: "Currency", mobile: "meta", cell: (r) => r.currency ?? none },
    ];
    if (s.status === "break") {
      // Breaks (designer, Figma 205:6752): Reference, Business date, Side, Reason, Amount, Currency, Difference, Proposed pair
      const label = (k: "a" | "b") => (k === "a" ? labels[0] : labels[1]);
      return [ref, date, sideCol, { key: "reason", header: "Reason", mobile: "meta", cell: (r) => r.breakReason ?? none }, ...amount,
        { key: "difference", header: "Difference", mobile: "meta", cell: (r) => breakDifference(r) || none },
        { key: "proposed", header: "Proposed pair", mobile: "meta", cell: (r) => (r.proposed
          ? <span><span className="font-mono text-mono">{r.proposed.extRef ?? "—"}</span> · {label(r.proposed.side)} · pass {r.proposed.passNo}</span> : none) }];
    }
    return [ref, sideCol, date, ...amount];
  }, [pairs, s.status, labels]);
}
