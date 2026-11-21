"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@starterkit/ui/ui/toast";
import { BlockedButton, CategoryChip, type Column, DataTable, Failure, Notice, Panel, RouteTabs, StatTile, StatTiles } from "@starterkit/ui/ds";
import { formatDate, formatDateTime, formatNumber, formatTime } from "@starterkit/ui/lib/format";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { CheckIcon, DiskIcon, KeyIcon, NetworkIcon, TimeIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import type { DbEngine } from "@starterkit/shared/sources";
import { BRAND } from "@starterkit/shared/brand";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { api, isNotFound } from "@/lib/client/api";
import { SOURCES_KEY } from "@/lib/shared/queries";
import { discardConfirm } from "./discard-dialog";
import type { PlainAction } from "@/components/shell/page-header";
import { ActivityTable, FilesTable, QuarantineTable, SnapshotsTable, VersionsTable } from "./ingest-tables";
import { SourceStatusChip } from "./source-columns";
import { SOURCE_DETAIL_SHAPE } from "./shapes";
import { SOURCE_TABS, type SourceTab } from "./source-text";
import { at, completeText, day, errorSentence, KIND_LABEL, lagText, missingText, scheduleText } from "./source-text";
import { EDIT_REASON, newVersionHref, RUN_REASON, sourceApi, sourceHref, sourcesHref, useRunSource, useSource, useSpaceRoles, useStartVersion, versionHref } from "./use-sources";

export const ENGINE: Record<DbEngine, string> = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", oracle: "Oracle" };
const TAB_LABEL: Record<SourceTab, string> = { overview: "Overview", quarantine: "Quarantine", versions: "Versions", activity: "Activity" };

/**
 * "Edit source" (Build notes 02): the open draft in the wizard, a version in review on its page, or a new draft made
 * from the published version; a role that may not change sources gets the reason.
 */
/** A source nobody submitted or shared (DELETE …/sources/{id} takes it), for a source admin (designer review 03). */
export const discardable = (s: SourceDto, roles: readonly string[]) =>
  roles.includes("source_admin") && !s.owner && s.publishedVersion === null && !s.draft?.submitterId && !s.draft?.reviewComment && !s.shares.length;

export function editAction(s: SourceDto, spaceId: string, roles: readonly string[], start: { busy: boolean; run: () => void }): PlainAction {
  const may = roles.includes("source_admin") || roles.includes("config_maker");
  if (!may) return { label: "Edit source", reason: EDIT_REASON };
  if (s.draft?.status === "in_review") return { label: `Open version ${s.draft.version}`, href: versionHref(spaceId, s.id, s.draft.id) };
  if (s.draft) return { label: "Edit source", href: newVersionHref(spaceId, s.id, roles.includes("source_admin") ? 1 : 2) };
  return { label: "Edit source", onSelect: start.run, busy: start.busy };
}
const PAUSED_REASON = "This source is paused. Pulls start again once a new source version is approved.";

/** Label / value rows of a card (as on a user's details). */
function Rows({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-2">
      {items.map((i) => (
        <div key={i.label} className="flex items-baseline gap-3 border-b border-line pb-2 last:border-b-0 last:pb-0">
          <dt className="w-36 shrink-0 text-label text-fg">{i.label}</dt>
          <dd className="min-w-0 text-body-sm wrap-anywhere text-fg-2">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Version 1 · Database · snapshot per date · Oracle · Daily at 06:00 WIB": what the source is, never where it connects. */
function summary(s: SourceDto): string {
  const input = s.published?.spec?.input;
  return [
    s.owner ? `Shared from ${s.owner.name} · read-only here` : null,
    s.publishedVersion ? `Version ${s.publishedVersion}` : "No approved version yet",
    KIND_LABEL[s.kind],
    s.connection ? ENGINE[s.connection.engine] : null,
    input?.kind === "file_inbox" ? `files ${input.pattern}, checked every minute` : input?.kind === "db_snapshot" ? scheduleText(input.schedule) : input ? "pulled every minute" : null,
  ].filter(Boolean).join(" · ");
}

type DriftColumn = NonNullable<SourceDto["drift"]>["columns"][number];
const DRIFT_COLUMNS = (version: number | null): Column<DriftColumn>[] => [
  { key: "column", header: "Column", mobile: "title", cell: (c) => <span className="font-mono text-mono text-fg">{c.column}</span> },
  { key: "expected", header: `Version ${version ?? ""} expects`, mobile: "meta", cell: (c) => c.expected },
  { key: "found", header: "Found now", mobile: "meta", cell: (c) => c.found ?? "Missing" },
  { key: "effect", header: "Effect", mobile: "meta", className: "whitespace-normal min-w-64 w-full", cell: (c) => c.effect },
];

/**
 * Figma 96:8690 / 99:9757 (state c): the source stopped because its table changed; per column what its version
 * expects, what is there now and the effect (a card per column on a phone), and the way out: a new source version
 * (the wizard, Task 7).
 */
function Drift({ s, spaceId, edit }: { s: SourceDto; spaceId: string; edit: PlainAction }) {
  const d = s.drift!;
  return (
    <Panel flush title="What changed in the source table" description={`Checked against version ${s.publishedVersion ?? "–"} at ${at(d.checkedAt)}`}
      footnote={!s.owner && (
        <span className="flex flex-wrap items-center gap-3">
          {edit.href
            ? <Button asChild><Link href={s.draft?.status === "in_review" ? edit.href : newVersionHref(spaceId, s.id)}>{s.draft?.status === "in_review" ? edit.label : "Create a source version"}</Link></Button>
            : <BlockedButton reason={edit.reason ?? null} disabled={edit.busy} aria-busy={edit.busy || undefined} onClick={edit.onSelect}>Create a source version</BlockedButton>}
          <span className="max-w-[72ch] text-caption text-fg-3">Opens step 2 with the columns the table has now. Recons keep reading the stored data until the new version is approved.</span>
        </span>
      )}>
      <DataTable label={`Columns that no longer fit version ${s.publishedVersion ?? ""}`} columns={DRIFT_COLUMNS(s.publishedVersion)} rows={d.columns} rowKey={(c) => c.column}
        empty={{ icon: NetworkIcon, title: "No column changed", description: "The source paused for another reason; see the notice above." }} />
    </Panel>
  );
}

/**
 * A source (Figma page 02 detail frames, Build notes 02): its health as the API judged it, then per kind what its
 * ingest did: files (file inbox), snapshots (snapshot per date) or the pull's position (watermark); the Quarantine tab
 * lists rejected lines (own sources only: a shared one's quarantine stays with its owner). Pull now is a source admin's
 * on the space's own source. No credential is ever shown: the connection is its engine and options.
 */
/**
 * Today's numbers of a published source (Figma 02 Sources v1.0.6), above its files, snapshots or pull: the business
 * date in progress's records and quarantined lines, how far it is complete, and when it is read next.
 */
function TodayTiles({ s }: { s: SourceDto }) {
  const h = s.health!;
  // the value is what is complete (a date, or a moment for a watermark); the caption what is still awaited or how late
  const ct = h.completeThrough ? Date.parse(h.completeThrough) : null;
  const complete = ct === null ? "None yet" : s.kind === "db_watermark" ? formatDateTime(ct) : formatDate(ct - 1);
  // a watermark source without a grace: its lag is shown but not judged (a table with no new rows lags too), so the
  // status can say Healthy beside a long lag; the caption says why
  const unjudged = s.kind === "db_watermark" && !h.graceMinutes && !!lagText(s);
  const waiting = h.missingDate ? `Waiting for ${day(h.missingDate)}` : unjudged ? `${lagText(s)} · not judged: no grace set` : lagText(s) ?? "Up to date";
  return (
    <StatTiles>
      <StatTile icon={DiskIcon} label="Records today" value={s.rowsToday === null ? "—" : formatNumber(s.rowsToday)} caption={`Business date ${day(h.businessDate)}`} />
      <StatTile icon={WarningIcon} label="Quarantined today" value={s.quarantinedToday === null ? "—" : formatNumber(s.quarantinedToday)}
        caption={s.quarantinedToday === null ? "Kept by the owning space" : s.quarantinedToday ? "See why in Quarantine" : "No line refused"} />
      <StatTile icon={CheckIcon} label="Complete through" value={complete} caption={waiting} />
      <StatTile icon={TimeIcon} label="Next read" value={s.nextRunAt ? formatTime(Date.parse(s.nextRunAt)) : "—"}
        caption={s.nextRunAt ? formatDate(Date.parse(s.nextRunAt)) : "Not while paused"} />
    </StatTiles>
  );
}

export function SourceDetail({ spaceId, id, tab }: { spaceId: string; id: string; tab: SourceTab }) {
  const q = useSource(spaceId, id);
  const roles = useSpaceRoles(spaceId);
  const run = useRunSource(spaceId, id, q.data?.kind);
  const start = useStartVersion(spaceId, id);
  const router = useRouter();
  const qc = useQueryClient();
  const skeleton = useDelayedFlag(!q.data && !q.error);

  if (isNotFound(q.error)) return <DetailNotFound title="Source" noun="source" list={{ href: sourcesHref(spaceId), label: "Sources" }} />;
  if (q.error && !q.data) return <div className="grid gap-section"><PageHeader title="Source" /><Panel><Failure title="Couldn't load this source" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  const s = q.data;
  if (!s || skeleton) return <LoadingShape sections={SOURCE_DETAIL_SHAPE} shown={skeleton} />;

  const own = !s.owner;
  const h = s.health;
  /** Why the viewer can't pull now, or null. */
  const blocked = !roles.includes("source_admin") ? RUN_REASON : s.status === "paused" ? PAUSED_REASON : null;
  const date = s.kind === "db_snapshot" ? h?.businessDate : undefined;
  // Never published: nothing can be pulled (the API answers 400), so the page offers no Pull now at all.
  const pull = own && !!s.publishedVersion && (
    <BlockedButton variant="secondary" reason={blocked} disabled={run.isPending} aria-busy={run.isPending || undefined} onClick={() => run.mutate(date)}>
      {date ? `Pull ${day(date)} now` : s.kind === "file_inbox" ? "Check the folder now" : "Pull now"}
    </BlockedButton>
  );
  const shown: SourceTab = own ? tab : "overview";
  const missing = !!h?.missingDate;
  const edit = editAction(s, spaceId, roles, { busy: start.isPending, run: () => start.mutate() });
  const tabHref = (t: SourceTab) => (t === "overview" ? sourceHref(spaceId, id) : `${sourceHref(spaceId, id)}?tab=${t}`);

  return (
    <div className="grid gap-section">
      <PageHeader title={s.name} status={<SourceStatusChip s={s} />} description={summary(s)} actions={pull || undefined}
        more={own ? [edit, ...(discardable(s, roles) ? [{ label: "Delete draft source", destructive: true as const, confirm: discardConfirm(s.name, async () => {
          await api(sourceApi(spaceId, id), { method: "DELETE" });
          toast(`Deleted the draft source ${s.name}.`);
          await qc.invalidateQueries({ queryKey: SOURCES_KEY });
          router.push(sourcesHref(spaceId));
        }) }] : [])] : undefined} />
      {s.owner && (
        <>
          <span><CategoryChip label={`Shared from ${s.owner.name}`} slot="neutral" /></span>
          <Notice>{s.owner.name} owns this source. Only {s.owner.name}&apos;s source admins change it; here you can read its files and snapshots and use it in recons.</Notice>
        </>
      )}
      {own && (
        <RouteTabs aria-label="Source sections">
          {SOURCE_TABS.map((t) => (
            <Link key={t} href={tabHref(t)} aria-current={shown === t ? "page" : undefined}>
              {TAB_LABEL[t]}{t === "quarantine" && s.quarantinedToday ? ` · ${s.quarantinedToday} today` : ""}
            </Link>
          ))}
        </RouteTabs>
      )}
      {shown === "quarantine" ? <QuarantineTable spaceId={spaceId} id={id} />
        : shown === "versions" ? <VersionsTable spaceId={spaceId} id={id} />
        : shown === "activity" ? <ActivityTable spaceId={spaceId} id={id} /> : (
        <>
          {q.error && <Notice tone="warn" live>Couldn&apos;t refresh this source; showing the last loaded details.</Notice>}
          {s.status === "paused" && (
            <Notice tone="warn">Paused. {h?.lastError ? errorSentence(h.lastError) : "The source changed."} Pulls stay paused until a source version matches it; data already stored is kept.</Notice>
          )}
          {s.status === "paused" && s.drift && <Drift s={s} spaceId={spaceId} edit={edit} />}
          {missing && <Notice tone="warn">{missingText(s)}</Notice>}
          {h && <TodayTiles s={s} />}
          {s.kind === "file_inbox" && <FilesTable spaceId={spaceId} id={id} />}
          {s.kind === "db_snapshot" && (
            <SnapshotsTable spaceId={spaceId} id={id} run={own ? { blocked, pending: run.isPending, onPull: (d) => run.mutate(d) } : null} />
          )}
          {s.kind === "db_watermark" && h && (
            <Panel icon={NetworkIcon} title="Pull" description="By watermark, every minute">
              <Rows items={[
                { label: "Complete through", value: completeText(s) },
                { label: "Behind by", value: lagText(s) ?? "–" },
                { label: "Grace", value: h.graceMinutes ? `${h.graceMinutes} min` : "Not set: the lag isn't judged. A recon that reads this source, or the source's own health settings, sets one." },
                { label: "Last error", value: h.lastError ? errorSentence(h.lastError) : "None" },
                { label: "Next pull", value: s.nextRunAt ? at(s.nextRunAt) : "None while paused" },
              ]} />
            </Panel>
          )}
          {s.connection && (
            <Panel icon={KeyIcon} title="Connection" description="The credential is stored encrypted and never shown">
              <Rows items={[
                { label: "Engine", value: ENGINE[s.connection.engine] },
                { label: "TLS", value: s.connection.options.tls ? "On" : "Off" },
                // a test waits 8 s at most (the API's interactive deadline); this is the scheduled pull's connect option
                { label: "Connect timeout for scheduled pulls", value: `${s.connection.options.connectTimeoutSeconds} s` },
                { label: "Changed", value: at(s.connection.updatedAt) },
              ]} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
