"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { ColumnsMenu, type Column, DataTable, Failure, Notice, Panel, RouteTabs, Segmented, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { cn } from "@starterkit/ui/lib/cn";
import { formatNumber, formatTime, APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { NetworkIcon } from "@starterkit/ui/ui/icons";
import { BRAND } from "@starterkit/shared/brand";
import type { PassSpec, ReconRunDto, ReconRunItemDto, ReconSpec, RunGroupMember } from "@starterkit/shared/contracts/recon";
import { recordFields } from "@starterkit/shared/recon";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText, isNotFound } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { reconRunItems, type RunItemFilters } from "@/lib/shared/queries";
import { writeTable } from "@/lib/shared/table-state";
import { amountText, breakLabel, countLine, dayTotals, differenceText, isLive, projectionText, rangeText, runTotals } from "./run-model";
import { RECON_RUN_SHAPE } from "./shapes";
import type { Fields } from "./spec-model";
import { reconHref, reconRunHref, reconsHref, useRecon, useReconVersion, useRun, useSideSource } from "./use-recons";

const RunExplain = dynamic(() => import("./run-explain"), { ssr: false });

const none = <span className="text-fg-3">—</span>;
const dateText = (d: string) => rangeText(d, d);
/** Members of one side, summed: "26,017.79", or the sum of several (a group pass). */
function sideAmount(ms: readonly RunGroupMember[]): { text: string; ccy: string | null } {
  const ccy = ms[0]?.currency ?? null;
  if (!ms.length || ms.some((m) => m.amountMinor === null || m.currency !== ccy)) return { text: "—", ccy };
  const sum = ms.reduce((t, m) => t + BigInt(m.amountMinor!), 0n);
  return { text: `${amountText(sum.toString(), ccy)}${ms.length > 1 ? ` (${ms.length} items)` : ""}`, ccy };
}

type Tab = { key: string; label: string; pass?: number; status?: "open" };
/** A pass tab's label: what it did ("Pass 1 · 937 matched · 30 duplicate"); counts of the picked day when one is. */
function passLabel(p: PassSpec, x: { matched: number; suggested: number; broken: number } | undefined) {
  const parts = [`Pass ${p.no}`];
  if (p.accept === "auto" || x?.matched) parts.push(`${formatNumber(x?.matched ?? 0)} matched`);
  if (p.accept === "suggest" || x?.suggested) parts.push(`${formatNumber(x?.suggested ?? 0)} suggested`);
  if (x?.broken) parts.push(`${formatNumber(x.broken)} ${breakLabel(p).toLowerCase()}`);
  return parts.join(" · ");
}

/** The summary card: the run's state, its facts, its counts and what day close would do with what waits. */
function RunSummary({ run, spec, version }: { run: ReconRunDto; spec: ReconSpec; version: number }) {
  const t = runTotals(run.counters, spec);
  const live = isLive(run);
  const chip = live ? { health: "unknown" as const, label: "Running" } : run.status === "failed" ? { health: "down" as const, label: "Stopped" }
    : { health: "healthy" as const, label: run.mode === "simulation" ? "Simulated" : "Done" };
  const what = run.mode === "simulation" ? `Draft v${version}` : `Version ${version}`;
  const at = run.finishedAt ? ` · ${formatTime(Date.parse(run.finishedAt))} ${APP_TIME_ZONE_LABEL}` : "";
  const day = run.projection ? projectionText(run.projection) : "";
  return (
    <section aria-label="Run" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-card p-4 shadow-xs">
      <StatusChip health={chip.health} label={chip.label} />
      <div role="status" className="grid min-w-0 flex-1 basis-64 gap-0.5">
        <span className="text-body-sm text-fg">
          {run.status === "failed" ? `The run stopped: ${run.error ?? "it ended before it finished."}` : `${what} · ${rangeText(run.from, run.to)} · ${formatNumber(t.items)} items${at}`}
        </span>
        {run.status !== "failed" && <span className={cn("text-caption text-fg-3 tabular", live && "opacity-60")}>{countLine(t)}</span>}
        {day && <span className="text-caption text-fg-3 tabular">At day close: {day}</span>}
      </div>
    </section>
  );
}

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
  const [explain, setExplain] = useState<ReconRunItemDto | null>(null);
  const skeleton = useDelayedFlag(!run || !spec || !recon);
  const labels = useMemo((): readonly [string, string] => (spec ? [spec.sides[0].label, spec.sides[1].label] : ["Side A", "Side B"]), [spec]);
  const columns = useColumns(t.state, labels);

  const title = run?.mode === "simulation" ? `Simulation of draft v${run.version}` : run ? `Run of version ${run.version}` : "Recon run";
  const trail = recon ? [{ label: recon.name, href: reconHref(spaceId, id) }] : [];
  if (isNotFound(rq.error)) return <DetailNotFound title="Recon run" noun="run" list={{ href: reconsHref(spaceId), label: "Recons" }} />;
  if ((rq.error && !run) || (vq.error && !spec)) {
    return <div className="grid gap-section"><PageHeader title={title} trail={trail} /><Panel><Failure title="The run couldn't be loaded." error={rq.error ?? vq.error} source={BRAND.name} onRetry={() => { void rq.refetch(); void vq.refetch(); }} /></Panel></div>;
  }
  if (!run || !spec || !recon || skeleton) return <LoadingShape sections={RECON_RUN_SHAPE} shown={skeleton} />;

  const s = t.state;
  const waiting = s.status === "open" && !s.pass;
  const passNo = waiting ? 0 : Number(s.pass || "1");
  const pass = spec.passes[passNo - 1];
  const day = s.date ? run.days?.find((d) => d.date === s.date) : undefined;
  const counts = day ? day.passes : run.counters.passes;
  const open = day ? day.open : run.counters.open;
  const path = reconRunHref(spaceId, id, runId);
  const href = (patch: Partial<RunItemFilters>) => { const q = writeTable(s, patch, def.spec); return q?.size ? `${path}?${q}` : path; };
  const go = (patch: Partial<RunItemFilters>) => (e: React.MouseEvent) => { e.preventDefault(); t.set(patch); };
  const tabs: Tab[] = [...spec.passes.map((p) => ({ key: `p${p.no}`, label: passLabel(p, counts[String(p.no)]), pass: p.no })),
    { key: "waiting", label: `Waiting · ${formatNumber(open.a)} ${labels[0]} · ${formatNumber(open.b)} ${labels[1]}`, status: "open" as const }];
  const x = pass ? counts[String(pass.no)] : undefined;
  const own = pass?.accept === "suggest" ? "suggested" : "matched";
  const status = waiting ? "open" : s.status || own;
  const statusOptions = pass ? [
    ...(pass.accept === "auto" || x?.matched ? [{ value: "matched", label: "Matched", count: x?.matched ?? 0 }] : []),
    ...(pass.accept === "suggest" || x?.suggested ? [{ value: "suggested", label: "Suggested", count: x?.suggested ?? 0 }] : []),
    ...(x?.broken ? [{ value: "break", label: breakLabel(pass), count: x.broken }] : []),
  ] : [];
  const items = status === "open" || status === "break";
  const allDays = run.counters;
  const strip = run.days ?? [];

  return (
    <div className="grid gap-section">
      <PageHeader title={title} trail={trail} description={`${recon.name} · ${rangeText(run.from, run.to)}${run.mode === "simulation" ? " · not stored" : ""}`} />
      <RunSummary run={run} spec={spec} version={run.version} />
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the items; showing the rows loaded before. {errorText(t.staleError)}</Notice>}
      <Panel flush icon={NetworkIcon} title="Results per pass" count={t.count}
        description={run.mode === "simulation" ? "Not stored: after a real run the same pairs wait in Breaks" : undefined}
        toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}>
        <div className="grid gap-3 px-3 pb-3">
          {strip.length > 0 && (
            <div role="group" aria-label="Business dates" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
              {[{ date: "", t: { ...runTotals(allDays, spec), waiting: allDays.open } }, ...strip.map((d) => ({ date: d.date, t: dayTotals(d, spec) }))].map(({ date, t: d }) => (
                <Link key={date || "all"} href={href({ date })} onClick={go({ date })} aria-current={s.date === date ? "true" : undefined}
                  className={cn("grid gap-0.5 rounded-md border bg-card p-2.5 text-left text-caption text-fg-3 tabular focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    s.date === date ? "border-fg shadow-sm" : "border-line hover:bg-tray")}>
                  <span className="text-label text-fg">{date ? rangeText(date, date).replace(/ \d{4}$/, "") : "All dates"}</span>
                  <span>{formatNumber(d.matched)} matched · {formatNumber(d.suggested)} suggested{d.duplicate ? ` · ${formatNumber(d.duplicate)} duplicate` : ""}</span>
                  <span>{formatNumber(d.waiting.a)} {labels[0]} · {formatNumber(d.waiting.b)} {labels[1]} waiting</span>
                </Link>
              ))}
            </div>
          )}
          <RouteTabs aria-label="Passes">
            {tabs.map((tab) => {
              const patch = tab.status ? { pass: "", status: "open", side: "" } : { pass: tab.pass === 1 ? "" : String(tab.pass), status: "", side: "" };
              const current = tab.status ? waiting : !waiting && passNo === tab.pass;
              return <Link key={tab.key} href={href(patch)} onClick={go(patch)} aria-current={current ? "page" : undefined}>{tab.label}</Link>;
            })}
          </RouteTabs>
          <div className="flex flex-wrap items-center gap-3">
            {pass && <span className="text-body-sm text-fg-2">Pass {pass.no} · {pass.name}{status === "suggested" ? " · open until someone accepts them" : ""}</span>}
            {statusOptions.length > 1 && (
              <Segmented label={`Pass ${pass!.no} outcome`} value={status} options={statusOptions}
                onChange={(v) => t.set({ status: v === own ? "" : v, side: "" })} />
            )}
            {items && (
              <Segmented label="Side" value={s.side || "both"} options={[{ value: "both", label: "Both sides" }, { value: "a", label: labels[0] }, { value: "b", label: labels[1] }]}
                onChange={(v) => t.set({ side: v === "both" ? "" : v })} />
            )}
          </div>
        </div>
        <DataTable label="Items" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          rowActions={items ? undefined : (r) => r.group ? <Button type="button" variant="secondary" size="sm" onClick={() => setExplain(r)}>Explain</Button> : null}
          error={t.loadError ? { title: "Couldn't load the items", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon: NetworkIcon, title: isLive(run) ? "Nothing here yet" : "No items here",
            description: isLive(run) ? "Items appear as the run works through its dates." : "Pick another pass, outcome or date to see its items." }} />
      </Panel>
      {explain?.group && <RunExplain item={explain} spec={spec} fields={fields} labels={labels} onClose={() => setExplain(null)} />}
    </div>
  );
}

/** The table's columns for the tab: a pass's pairs (both sides' amounts, what differs) or items (side, amount, why). */
function useColumns(s: RunItemFilters, labels: readonly [string, string]): Column<ReconRunItemDto>[] {
  const pairs = !(s.status === "open" || s.status === "break");
  return useMemo((): Column<ReconRunItemDto>[] => {
    const ref: Column<ReconRunItemDto> = { key: "ref", header: "Reference", mobile: "title", className: "font-mono text-mono", cell: (r) => r.extRef ?? none };
    const date: Column<ReconRunItemDto> = { key: "businessDate", header: "Business date", sortable: true, mobile: "meta", cell: (r) => dateText(r.group?.businessDate ?? r.businessDate) };
    if (pairs) {
      const side = (k: "a" | "b") => (r: ReconRunItemDto) => sideAmount(r.group?.members.filter((m) => m.side === k) ?? []);
      return [ref, date,
        { key: "amountA", header: `Amount ${labels[0]}`, align: "right", mobile: "meta", cell: (r) => side("a")(r).text },
        { key: "amountB", header: `Amount ${labels[1]}`, align: "right", mobile: "meta", cell: (r) => side("b")(r).text },
        { key: "currency", header: "Currency", mobile: "meta", cell: (r) => side("a")(r).ccy ?? none },
        { key: "difference", header: "Difference", mobile: "meta", cell: (r) => differenceText(r.group?.evidence, side("a")(r).ccy) || none },
      ];
    }
    return [ref,
      { key: "side", header: "Side", mobile: "meta", cell: (r) => (r.side === "a" ? labels[0] : labels[1]) },
      date,
      { key: "amount", header: "Amount", align: "right", mobile: "meta", cell: (r) => amountText(r.amountMinor, r.currency) },
      { key: "currency", header: "Currency", mobile: "meta", cell: (r) => r.currency ?? none },
      ...(s.status === "break" ? [{ key: "reason", header: "Reason", mobile: "meta" as const, cell: (r: ReconRunItemDto) => r.breakReason ?? none }] : []),
    ];
  }, [pairs, s.status, labels]);
}
