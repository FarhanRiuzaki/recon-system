"use client";

// `/` Dashboard: the recon performance of a period over the viewer's spaces (docs/superpowers/specs/2026-11-24-recon-
// dashboard-design.md; each number's definition and list in docs/superpowers/plans/2026-11-24-recon-dashboard.md).
// Filters: Space and Recon here (URL), the period in the header's date range (default the last 7 days). Every number
// opens the list that holds it with the same filters when one space is in scope; across spaces the per-space rows do.
// The user and sign-in numbers follow at the bottom for holders of user.view or audit.view (AdminSection).
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BarChart, BreakdownCard, CHART_HEIGHT, ChartLegend, legendItems, TimeSeriesChart } from "@starterkit/ui/charts";
import { EmptyState, ErrorState, InfoTip, LazyMount, Notice, Panel, RelativeTime, StatTile, StatTiles, StatTileSkeletons, StatusChip } from "@starterkit/ui/ds";
import { categoryColor } from "@starterkit/ui/ds/badges";
import { Reveal } from "@starterkit/ui/motion";
import { appDayStart, formatDate, formatDateTime, formatDuration, formatNumber, formatPercent } from "@starterkit/ui/lib/format";
import { CheckIcon, ColumnChartIcon, ForceMatchIcon, LineChartIcon, OverviewIcon, ReportsIcon, SuccessIcon, TimeIcon, WaitIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import type { ReconDashboardDto } from "@starterkit/shared/contracts/dashboard";
import { AGE_GROUPS, CLOSED_PARTS, RESOLVED_STATUSES } from "@starterkit/shared/dashboard";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { categoryChip, statusChip } from "@/lib/shared/categories";
import { reconDashboardRead } from "@/lib/shared/queries";
import { timeRange } from "@/lib/shared/time-controls";
import { AdminSection } from "./admin-section";
import { adminSection, approvalsHref, countDelta, idrHeadline, linkSpace, pendingNotice, postingFailedHref, rate, rateDelta, resultsHref, unmatchHref } from "./dashboard-model";

type D = ReconDashboardDto;
// series (chart slots 1–3): auto match, by hand and force, new unmatch; the rate line its own chart
const SERIES = [{ label: "Auto match", slot: 0 }, { label: "By hand and force", slot: 1 }, { label: "New unmatch", slot: 2 }];
const RUN_CHIP = {
  succeeded: statusChip("success", "Succeeded"), failed: statusChip("failed", "Failed"), running: statusChip("running", "Running"), queued: statusChip("queued", "Queued"),
} as const;
const RUN_LEGEND = [RUN_CHIP.succeeded, RUN_CHIP.running, RUN_CHIP.queued, RUN_CHIP.failed];
const pct = (r: number | null) => (r === null ? "–" : formatPercent(r, 1));
const minutes = (m: number | null) => (m === null ? "–" : formatDuration(m * 60));
const day = (d: string) => formatDate(appDayStart(d));
/** Period numbers wait while a date of the period is still computing; a change waits for both periods (C2). */
const pendingOf = (d: D) => ({ now: d.pending.days > 0, compare: d.pending.days === 0 && d.pending.prevDays === 0 });
const STILL = "Still computing";

/** A tile that opens its list when it has one. */
function Linked({ href, label, children }: { href: string | null; label: string; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return <Link href={href} aria-label={label} className="block rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary [&>*]:h-full">{children}</Link>;
}

/** The amount in IDR with the other currencies behind an info button (never added in). */
function Money({ amounts }: { amounts: D["open"]["amounts"] }) {
  const h = idrHeadline(amounts);
  return (
    <span className="inline-flex items-center gap-1 tabular">{h.value} IDR
      {h.others.length > 0 && <InfoTip label="other currencies" title="Other currencies">{h.others.join(", ")}</InfoTip>}
    </span>
  );
}

function Kpis({ d, space, recon }: { d: D; space: string | null; recon: string | null }) {
  const auto = rate(d.autoRate.matched, d.autoRate.records), prevAuto = rate(d.autoRate.prevMatched, d.autoRate.prevRecords);
  const post = rate(d.posting.posted, d.posting.finished), prevPost = rate(d.posting.prevPosted, d.posting.prevFinished);
  const h = idrHeadline(d.open.amounts);
  const p = pendingOf(d);
  return (
    <StatTiles>
      <Linked href={space && recon ? resultsHref(space, recon, d.period, ["matched"]) : null} label="Open the auto-matched results">
        <StatTile icon={LineChartIcon} label="Auto-match rate" value={p.now ? "–" : pct(auto)} delta={p.compare ? rateDelta(auto, prevAuto, "up") : undefined}
          caption={p.now ? STILL : `${formatNumber(d.autoRate.matched)} of ${formatNumber(d.autoRate.records)} records`} />
      </Linked>
      <Linked href={space ? unmatchHref(space, { recon }) : null} label="Open the unmatch list">
        <StatTile icon={WarningIcon} label="Unmatch open" value={h.value} unit="IDR" delta={p.compare ? countDelta(d.open.broke, d.open.prevBroke, "down") : undefined}
          caption={`${formatNumber(d.open.count)} items · ${formatNumber(d.open.pastCarryOver)} past carry over${h.others.length ? ` · also ${h.others.join(", ")}` : ""}`} />
      </Linked>
      <Linked href={space && recon ? resultsHref(space, recon, d.period, RESOLVED_STATUSES) : null} label="Open the resolved results">
        <StatTile icon={SuccessIcon} label="Resolved" value={p.now ? "–" : formatNumber(d.resolved.rows)} delta={p.compare ? countDelta(d.resolved.rows, d.resolved.prevRows, "up") : undefined}
          caption={p.now ? STILL : `Median ${minutes(d.resolved.medianMinutes)} from break to resolution`} />
      </Linked>
      <Linked href={space ? postingFailedHref(space, d.period, recon) : null} label="Open the failed postings">
        <StatTile icon={ReportsIcon} label="Posting success" value={pct(post)} delta={rateDelta(post, prevPost, "up")}
          caption={`${formatNumber(d.posting.failed)} failed of ${formatNumber(d.posting.finished)} finished`} />
      </Linked>
      <Linked href={space ? approvalsHref(space) : null} label="Open the approvals inbox">
        <StatTile icon={WaitIcon} label="Waiting approval" value={formatNumber(d.approvals.waiting)} delta={countDelta(d.approvals.requested, d.approvals.prevRequested, "down")}
          caption={d.approvals.oldestAt ? `Oldest since ${formatDate(Date.parse(d.approvals.oldestAt))}` : "Nothing waits"} />
      </Linked>
    </StatTiles>
  );
}

function PerDay({ d, label }: { d: D; label: string }) {
  const any = d.days.some((x) => x.records > 0);
  return (
    <Panel bodyClassName="overflow-clip" icon={ColumnChartIcon} title="Results per day" description={`${label} · records per business date`} actions={<ChartLegend items={legendItems(SERIES)} />}>
      {pendingOf(d).now ? <EmptyState icon={ColumnChartIcon} title="Still computing this period" description="The chart shows once every date of the period is in." />
        : !any ? <EmptyState icon={ColumnChartIcon} title="No results in this period" description="Each business date's records count here once a run of it finishes." />
        : (
          <div className="grid gap-4">
            <LazyMount minHeight={CHART_HEIGHT.standard}>
              <BarChart label="Results per day" stacked hideLegend format={formatNumber} categories={d.days.map((x) => day(x.date))}
                series={[
                  { ...SERIES[0]!, values: d.days.map((x) => x.auto) }, { ...SERIES[1]!, values: d.days.map((x) => x.manual) }, { ...SERIES[2]!, values: d.days.map((x) => x.broke) },
                ]} />
            </LazyMount>
            <LazyMount minHeight={CHART_HEIGHT.compact}>
              <TimeSeriesChart label="Auto-match rate per day" height={CHART_HEIGHT.compact} curve="linear" format={(v) => formatPercent(v, 1)}
                series={[{ label: "Auto-match rate", slot: 0, points: d.days.flatMap((x) => (x.records ? [[appDayStart(x.date) / 1000, x.matched / x.records] as [number, number]] : [])) }]} />
            </LazyMount>
          </div>
        )}
    </Panel>
  );
}

function Breakdowns({ d, space, recon }: { d: D; space: string | null; recon: string | null }) {
  const ageOf = (k: string) => d.age.find((a) => a.key === k)!;
  const old = ageOf("gt7");
  const closedRows = d.closed.reduce((n, c) => n + c.rows, 0), pend = pendingOf(d).now;
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <BreakdownCard icon={TimeIcon} title="Unmatch by age" description="Open now, by business date" unit="items" max={4} otherLabel="Older"
        parts={AGE_GROUPS.map((g, i) => ({ id: g.key, label: `${g.label} · ${idrHeadline(ageOf(g.key).amounts).value} IDR`, value: ageOf(g.key).count, slot: i }))}
        footnote={old.count > 0 ? <span className="text-body-sm text-fg-2">{formatNumber(old.count)} open longer than 7 days{space && <> · <Link className="text-primary underline-offset-4 hover:underline" href={unmatchHref(space, { recon, age: ["d8_30", "gt30"] })}>Open them</Link></>}</span> : undefined}
        empty={{ title: "No open unmatch", description: "Items appear here when a date closes with items nothing paired." }} />
      <BreakdownCard icon={WarningIcon} title="Unmatch by reason" description="Open now" unit="items" max={5} otherLabel="Other reasons"
        parts={d.reasons.map((r) => ({ id: r.reason, label: r.reason, value: r.count, color: categoryColor(categoryChip("reason", r.reason)) }))}
        footnote={space ? <Link className="text-body-sm text-primary underline-offset-4 hover:underline" href={unmatchHref(space, { recon })}>Open the unmatch list</Link> : undefined}
        empty={{ title: "No open unmatch", description: "Items appear here when a date closes with items nothing paired." }} />
      <BreakdownCard icon={CheckIcon} title="How items were closed" description="Results of the period's business dates" unit="results" max={6} otherLabel="Other"
        parts={closedRows && !pend ? CLOSED_PARTS.map((p, i) => ({ id: p.key, label: p.label, value: d.closed.find((c) => c.key === p.key)!.rows, slot: i })) : []}
        footnote={d.writtenOff.length && !pend ? <span className="text-body-sm text-fg-2">Written off <Money amounts={d.writtenOff} /></span> : undefined}
        empty={pend ? { title: "Still computing this period", description: "The parts show once every date of the period is in." } : { title: "Nothing closed in this period", description: "Results count here once a run or a person closes them." }} />
    </div>
  );
}

function BySpace({ d }: { d: D }) {
  const pend = pendingOf(d).now;
  return (
    <Panel flush icon={OverviewIcon} title="By space" description="Open unmatch now; auto-match rate and write-offs over the period">
      <Table aria-label="Numbers per space">
        <TableHeader><TableRow>
          <TableHead>Space</TableHead><TableHead className="text-right">Open unmatch</TableHead><TableHead className="text-right">Open value</TableHead>
          <TableHead className="text-right">Auto-match rate</TableHead><TableHead className="text-right">Written off</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {d.bySpace.map((s) => (
            <TableRow key={s.id}>
              <TableCell><Link className="text-fg underline-offset-4 hover:underline" href={unmatchHref(s.id)}>{s.name}</Link></TableCell>
              <TableCell className="text-right tabular">{formatNumber(s.open)}</TableCell>
              <TableCell className="text-right"><Money amounts={s.amounts} /></TableCell>
              <TableCell className="text-right tabular">{pend ? "–" : pct(rate(s.matched, s.records))}</TableCell>
              <TableCell className="text-right">{pend ? "–" : <Money amounts={s.writtenOff} />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function Recons({ d }: { d: D }) {
  const pend = pendingOf(d).now;
  return (
    <Panel flush icon={ForceMatchIcon} title="Recons" description="Volume and auto-match rate over the period; unmatch open now" legend={RUN_LEGEND}>
      {!d.rows.length ? <EmptyState icon={ForceMatchIcon} title="No recons yet" description="A recon shows here once someone creates it in one of your spaces." />
        : (
          <Table aria-label="Recons in the period">
            <TableHeader><TableRow>
              <TableHead>Recon</TableHead><TableHead>Space</TableHead><TableHead className="text-right">Records</TableHead><TableHead className="text-right">Auto-match rate</TableHead>
              <TableHead className="text-right">Unmatch open</TableHead><TableHead className="text-right">Open value</TableHead><TableHead>Oldest open</TableHead>
              <TableHead className="text-right">Posting failures</TableHead><TableHead>Last run</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {d.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Link className="text-fg underline-offset-4 hover:underline" href={resultsHref(r.spaceId, r.id, d.period)}>{r.name}</Link></TableCell>
                  <TableCell className="text-fg-2">{r.spaceName}</TableCell>
                  <TableCell className="text-right tabular">{pend ? "–" : formatNumber(r.records)}</TableCell>
                  <TableCell className="text-right tabular">{pend ? "–" : pct(rate(r.matched, r.records))}</TableCell>
                  <TableCell className="text-right tabular"><Link className="underline-offset-4 hover:underline" href={unmatchHref(r.spaceId, { recon: r.id })}>{formatNumber(r.open)}</Link></TableCell>
                  <TableCell className="text-right"><Money amounts={r.amounts} /></TableCell>
                  <TableCell>{r.oldest ? day(r.oldest) : "–"}</TableCell>
                  <TableCell className="text-right tabular">{r.postingFailed ? <Link className="underline-offset-4 hover:underline" href={postingFailedHref(r.spaceId, d.period, r.id)}>{formatNumber(r.postingFailed)}</Link> : "0"}</TableCell>
                  <TableCell>{r.lastRun ? <span className="inline-flex items-center gap-2"><StatusChip {...RUN_CHIP[r.lastRun.status]} /><RelativeTime at={Date.parse(r.lastRun.at)} /></span> : "No run yet"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </Panel>
  );
}

function Approvals({ d }: { d: D }) {
  const a = d.approvals;
  const fact = (label: string, value: string) => <div className="grid gap-1"><dt className="text-body-sm text-fg-2">{label}</dt><dd className="text-stat tabular">{value}</dd></div>;
  return (
    <Panel icon={WaitIcon} title="Approvals in the period" bodyClassName="p-4">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {fact("Requests made", formatNumber(a.requested))}
        {fact("Median time to decision", minutes(a.medianMinutes))}
        {fact("Rejected", `${formatNumber(a.rejected)} of ${formatNumber(a.decided)}`)}
      </dl>
    </Panel>
  );
}

/** Space and Recon pickers, in the URL (a new space clears the recon). */
function Filters({ d, space, recon }: { d: D | undefined; space: string | null; recon: string | null }) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    router.replace(next.size ? `${path}?${next}` : path, { scroll: false });
  };
  const recons = (d?.recons ?? []).filter((r) => !space || r.spaceId === space);
  return (
    <div className="grid gap-3 md:flex">
      <Select aria-label="Space" className="w-full md:w-64" value={space ?? ""} disabled={!d} onChange={(e) => set({ space: e.target.value, recon: "" })}>
        <option value="">All my spaces</option>
        {d?.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </Select>
      <Select aria-label="Recon" className="w-full md:w-64" value={recon ?? ""} disabled={!d} onChange={(e) => set({ recon: e.target.value })}>
        <option value="">All recons</option>
        {recons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select>
    </div>
  );
}

export function DashboardPage() {
  const sp = useSearchParams(), read = reconDashboardRead(sp);
  const q = useQuery({ queryKey: read.key, queryFn: () => api<D>(read.path), placeholderData: keepPreviousData });
  const showAdmin = adminSection(useAuth().can);
  const d = q.data;
  const picked = new URLSearchParams(read.path.split("?")[1] ?? "");
  const space = d ? linkSpace(d, picked.get("space")) : null, recon = picked.get("recon");
  const reconSpace = recon ? d?.recons.find((r) => r.id === recon)?.spaceId ?? space : space;
  const label = timeRange(sp, 7).label;

  return (
    <div className="grid gap-section">
      <PageHeader title="Dashboard" description={`Reconciliation over ${label.toLowerCase()}, against the same number of days before`} />
      <Filters d={d} space={picked.get("space")} recon={recon} />
      {q.isPlaceholderData && <Notice live>Updating the numbers…</Notice>}
      {d && pendingNotice(d.pending) && <Notice tone="progress" live>{pendingNotice(d.pending)}</Notice>}
      {q.error && d && <Notice tone="warn" live>Couldn&apos;t refresh the dashboard; showing the numbers loaded before. {errorText(q.error)}</Notice>}
      {q.error && !d ? (
        <Panel><ErrorState title="Couldn't load the dashboard" cause={errorText(q.error)} onRetry={() => void q.refetch()} /></Panel>
      ) : d && !d.spaces.length ? (
        <Panel><EmptyState icon={ReportsIcon} title="No spaces yet" description="Numbers appear here once you hold a role in a space." /></Panel>
      ) : (
        <>
          <Reveal loading={!d} skeleton={<StatTiles><StatTileSkeletons count={5} /></StatTiles>}>
            {d && <Kpis d={d} space={reconSpace} recon={recon} />}
          </Reveal>
          {!d ? <Skeleton className="w-full rounded-xl" style={{ height: CHART_HEIGHT.standard + CHART_HEIGHT.compact }} /> : (
            <>
              {d.computedAt && <p className="text-caption text-fg-3">Period numbers as of {formatDateTime(Date.parse(d.computedAt))}; unmatch and approvals are live.</p>}
              <PerDay d={d} label={label} />
              <Breakdowns d={d} space={reconSpace} recon={recon} />
              {d.bySpace.length > 1 && <BySpace d={d} />}
              <Recons d={d} />
              <Approvals d={d} />
            </>
          )}
        </>
      )}
      {showAdmin && <AdminSection />}
    </div>
  );
}
