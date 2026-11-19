"use client";

import Link from "next/link";
import { BlockedButton, CategoryChip, Failure, Notice, Panel, RouteTabs } from "@starterkit/ui/ds";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { KeyIcon, NetworkIcon } from "@starterkit/ui/ui/icons";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import type { DbEngine } from "@starterkit/shared/sources";
import { BRAND } from "@starterkit/shared/brand";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { isNotFound } from "@/lib/client/api";
import { FilesTable, QuarantineTable, SnapshotsTable } from "./ingest-tables";
import { SourceStatusChip } from "./source-columns";
import { SOURCE_DETAIL_SHAPE } from "./shapes";
import { at, completeText, day, KIND_LABEL, lagText, missingText, withDays } from "./source-text";
import { newVersionHref, RUN_REASON, sourceHref, sourcesHref, useRunSource, useSource, useSpaceRoles } from "./use-sources";

export const ENGINE: Record<DbEngine, string> = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", oracle: "Oracle" };
export type SourceTab = "overview" | "quarantine";
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

/** "Version 1 · Database · snapshot per date · Oracle · daily cron 0 6 * * *": what the source is, never where it connects. */
function summary(s: SourceDto): string {
  const input = s.published?.spec?.input;
  return [
    s.owner ? `Shared from ${s.owner.name} · read-only here` : null,
    s.publishedVersion ? `Version ${s.publishedVersion}` : "No approved version yet",
    KIND_LABEL[s.kind],
    s.connection ? ENGINE[s.connection.engine] : null,
    input?.kind === "file_inbox" ? `files ${input.pattern}` : input?.kind === "db_snapshot" ? `scheduled ${input.schedule} (${APP_TIME_ZONE_LABEL})` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * Figma 96:8690 (state c): the source stopped because its table changed; per column what its version expects, what is
 * there now and the effect, and the way out: a new source version (the wizard, Task 7).
 */
function Drift({ s, spaceId }: { s: SourceDto; spaceId: string }) {
  const d = s.drift!;
  return (
    <Panel title="What changed in the source table" description={`Checked against version ${s.publishedVersion ?? "–"} at ${at(d.checkedAt)}`}>
      <div className="grid gap-4">
        <div className="scroll-quiet overflow-x-auto" tabIndex={0} role="region" aria-label="What changed, per column">
          <table className="w-full text-body-sm">
            <caption className="sr-only">Columns that no longer fit version {s.publishedVersion}</caption>
            <thead><tr className="text-left text-fg-3">{["Column", `Version ${s.publishedVersion ?? ""} expects`, "Found now", "Effect"].map((h) => <th key={h} scope="col" className="py-2 pr-4 font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {d.columns.map((c) => (
                <tr key={c.column} className="border-t border-line align-top">
                  <td className="py-2 pr-4 font-mono text-mono text-fg">{c.column}</td>
                  <td className="py-2 pr-4 text-fg-2">{c.expected}</td>
                  <td className="py-2 pr-4 text-fg-2">{c.found ?? "Missing"}</td>
                  <td className="py-2 text-fg-2">{c.effect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!s.owner && (
          <div className="flex flex-wrap items-center gap-3">
            {/* no prefetch: the wizard's route arrives with Task 7 */}
            <Button asChild><Link href={newVersionHref(spaceId, s.id)} prefetch={false}>Create a source version</Link></Button>
            <p className="max-w-[72ch] text-caption text-fg-3">Opens step 2 with the columns the table has now. Recons keep reading the stored data until the new version is approved.</p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * A source (Figma page 02 detail frames, Build notes 02): its health as the API judged it, then per kind what its
 * ingest did: files (file inbox), snapshots (snapshot per date) or the pull's position (watermark); the Quarantine tab
 * lists rejected lines (own sources only: a shared one's quarantine stays with its owner). Pull now is a source admin's
 * on the space's own source. No credential is ever shown: the connection is its engine and options.
 */
export function SourceDetail({ spaceId, id, tab }: { spaceId: string; id: string; tab: SourceTab }) {
  const q = useSource(spaceId, id);
  const roles = useSpaceRoles(spaceId);
  const run = useRunSource(spaceId, id);
  const skeleton = useDelayedFlag(!q.data && !q.error);

  if (isNotFound(q.error)) return <DetailNotFound title="Source" noun="source" list={{ href: sourcesHref(spaceId), label: "Sources" }} />;
  if (q.error && !q.data) return <div className="grid gap-section"><PageHeader title="Source" /><Panel><Failure title="Couldn't load this source" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  const s = q.data;
  if (!s || skeleton) return <LoadingShape sections={SOURCE_DETAIL_SHAPE} shown={skeleton} />;

  const own = !s.owner;
  const h = s.health;
  /** Why the viewer can't pull now, or null. */
  const blocked = !roles.includes("source_admin") ? RUN_REASON : s.status === "paused" ? PAUSED_REASON : !s.publishedVersion ? "Nothing to pull until a version is approved." : null;
  const date = s.kind === "db_snapshot" ? h?.businessDate : undefined;
  const pull = own && (
    <BlockedButton variant="secondary" reason={blocked} disabled={run.isPending} aria-busy={run.isPending || undefined} onClick={() => run.mutate(date)}>
      {date ? `Pull ${day(date)} now` : "Pull now"}
    </BlockedButton>
  );
  const quarantineTab = own ? (tab === "quarantine" ? "quarantine" : "overview") : "overview";
  const missing = !!h && s.status === "active" && s.kind !== "db_watermark" && !!h.reason?.startsWith("No ");

  return (
    <div className="grid gap-section">
      <PageHeader title={s.name} status={<SourceStatusChip s={s} />} description={summary(s)} actions={pull || undefined} />
      {s.owner && (
        <>
          <span><CategoryChip label={`Shared from ${s.owner.name}`} slot={1} /></span>
          <Notice>{s.owner.name} owns this source. Only {s.owner.name}&apos;s source admins change it; here you can read its files and snapshots and use it in recons.</Notice>
        </>
      )}
      {own && (
        <RouteTabs aria-label="Source sections">
          <Link href={sourceHref(spaceId, id)} aria-current={quarantineTab === "overview" ? "page" : undefined}>Overview</Link>
          <Link href={`${sourceHref(spaceId, id)}?tab=quarantine`} aria-current={quarantineTab === "quarantine" ? "page" : undefined}>
            Quarantine{s.quarantinedToday ? ` · ${s.quarantinedToday} today` : ""}
          </Link>
        </RouteTabs>
      )}
      {quarantineTab === "quarantine" ? <QuarantineTable spaceId={spaceId} id={id} /> : (
        <>
          {q.error && <Notice tone="warn" live>Couldn&apos;t refresh this source; showing the last loaded details.</Notice>}
          {s.status === "paused" && (
            <Notice tone="warn">Paused: {withDays(h?.lastError ?? "the source changed.")} Pulls stay paused until a source version matches it; data already stored is kept.</Notice>
          )}
          {s.status === "paused" && s.drift && <Drift s={s} spaceId={spaceId} />}
          {missing && <Notice tone="warn">{missingText(s)}</Notice>}
          {s.kind === "file_inbox" && <FilesTable spaceId={spaceId} id={id} />}
          {s.kind === "db_snapshot" && (
            <SnapshotsTable spaceId={spaceId} id={id} run={own ? { blocked, pending: run.isPending, onPull: (d) => run.mutate(d) } : null} />
          )}
          {s.kind === "db_watermark" && h && (
            <Panel icon={NetworkIcon} title="Pull" description="By watermark, every minute">
              <Rows items={[
                { label: "Complete through", value: completeText(s) },
                { label: "Behind by", value: lagText(s) ?? "–" },
                { label: "Grace", value: h.graceMinutes ? `${h.graceMinutes} min` : "Not set" },
                { label: "Last error", value: h.lastError ? withDays(h.lastError) : "None" },
                { label: "Next pull", value: s.nextRunAt ? at(s.nextRunAt) : "None while paused" },
              ]} />
            </Panel>
          )}
          {s.connection && (
            <Panel icon={KeyIcon} title="Connection" description="The credential is stored encrypted and never shown">
              <Rows items={[
                { label: "Engine", value: ENGINE[s.connection.engine] },
                { label: "TLS", value: s.connection.options.tls ? "On" : "Off" },
                { label: "Connect timeout", value: `${s.connection.options.connectTimeoutSeconds} s` },
                { label: "Changed", value: at(s.connection.updatedAt) },
              ]} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
