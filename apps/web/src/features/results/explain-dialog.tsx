"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Facts, Failure, StatusGlyph } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { appDayStart, formatDate, formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowRightIcon } from "@starterkit/ui/ui/icons";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import type { ResultFieldDto, ResultMemberDto, ResultMembersDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { APPROVAL_KIND_LABEL } from "@starterkit/shared/approvals";
import { BRAND } from "@starterkit/shared/brand";
import { POSTING_STATUS_LABEL, type PostingStatus } from "@starterkit/shared/posting";
import { api } from "@/lib/client/api";
import { amountText } from "@/lib/shared/amount";
import { resultMembers } from "@/lib/shared/queries-recon";
import { differences, explainFields, sideTotal, type SideTotal, totalsDiffer } from "./explain-model";
import { resultIcon, SIDE_HEADER } from "./result-model";

const ITEM_LABEL: Record<ResultMemberDto["status"], string> = { open: "Waiting for a counterpart", matched: "Matched", suggested: "Suggested", break: "Unmatch", closed: "Closed", not_required: "Not required" };
const GROUP_LABEL: Record<NonNullable<ResultMembersDto["summary"]["groupKind"]>, string> = { auto: "Matched by a run", suggested: "Suggested by a run", manual: "Matched by hand", force: "Force matched" };
const RESOLUTION_LABEL: Record<NonNullable<ResultMembersDto["summary"]["resolution"]>, string> = {
  MATCHED_MANUAL: "Matched by hand", FORCE_MATCHED: "Force matched", WRITTEN_OFF: "Written off", POSTED: "Posted", ADJUSTED: "Adjusted",
  AUTO_MATCHED_LATE_DATA: "Matched late", DUPLICATE: "Closed as a duplicate", NO_ACTION: "Closed, no action",
};
const REQUEST_STATUS: Record<NonNullable<ResultMembersDto["summary"]["request"]>["status"], string> = { pending: "waiting approval", approved: "approved", rejected: "rejected", cancelled: "cancelled" };

/** A value over items: the value, or "N values" when they differ, or nothing. */
const agreed = (a: { value: string | null; many: number | null }, fmt: (v: string) => string = (v) => v) => (a.many ? `${a.many} values` : a.value === null ? null : fmt(a.value));
/** A record's field as text: an amount in its currency, a date or time as one, the rest as stored. */
function valueText(key: string, v: string | null, currency: string | null): string | null {
  if (v === null) return null;
  if (key === "amount_minor") return /^-?\d+$/.test(v) ? `${amountText(v, currency)}${currency ? ` ${currency}` : ""}` : v;
  if (key === "business_date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(appDayStart(v));
  if (key === "event_time" && !Number.isNaN(Date.parse(v))) return formatDateTime(Date.parse(v));
  return v;
}
const totalText = (t: SideTotal) => (t.mixed ? "Mixed" : t.amount === null ? "–" : `${amountText(t.amount, t.currency)}${t.currency ? ` ${t.currency}` : ""}`);

/** One record: every field on its own one-line row, in the order both sides share, so a field faces its counterpart. */
function RecordBlock({ m, fields, differs, n }: { m: ResultMemberDto; fields: readonly ResultFieldDto[]; differs: ReadonlySet<string>; n: number | null }) {
  return (
    <section aria-label={n === null ? "Record" : `Record ${n}`} className="rounded-md border border-line">
      <p className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-label text-fg-2">
        <span>{n === null ? "Record" : `Record ${n}`}</span><span>{ITEM_LABEL[m.status]}</span>
      </p>
      <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] text-body-sm">
        {fields.map((f) => {
          const text = valueText(f.key, f.key in m.values ? m.values[f.key]! : null, m.currency), differ = differs.has(f.key);
          return (
            <div key={f.key} className={cn("contents", differ && "font-semibold")}>
              <dt className={cn("truncate border-l-2 px-3 py-1.5 text-fg-3", differ ? "border-l-line-strong text-fg-2" : "border-l-transparent")} title={f.label}>{f.label}{differ && <span className="sr-only">, differs</span>}</dt>
              <dd className={cn("truncate px-3 py-1.5 tabular", text === null ? "text-fg-3" : "text-fg", f.key === "ext_ref" && "font-mono")} title={text ?? undefined}>{text ?? "–"}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/** One side's column: "Side A", the side's name and record count, its total when it holds several, a block per record. */
function SideColumn({ i, name, members, more, fields, differs, total, totalDiffers }: {
  i: 0 | 1; name: string; members: readonly ResultMemberDto[]; more: number; fields: readonly ResultFieldDto[]; differs: ReadonlySet<string>; total: SideTotal; totalDiffers: boolean;
}) {
  const count = members.length + more;
  return (
    <section aria-label={`${SIDE_HEADER[i]}: ${name}`} className="grid content-start gap-2">
      <h3 className="grid">
        <span className="text-title-3">{SIDE_HEADER[i]} <span className="text-body-sm font-normal text-fg-3">{count === 1 ? "1 record" : `${count} records`}</span></span>
        <span className="truncate text-body-sm text-fg-2" title={name}>{name}</span>
      </h3>
      {count > 1 && (
        <p className={cn("flex justify-between gap-2 rounded-md border-l-2 bg-tray px-3 py-2 text-body-sm", totalDiffers ? "border-l-line-strong font-semibold" : "border-l-transparent")}>
          <span className="text-fg-2">Total{totalDiffers && <span className="sr-only">, differs</span>}</span><span className="tabular text-fg">{totalText(total)}</span>
        </p>
      )}
      {members.length === 0 ? <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-body-sm text-fg-2">No record on this side</p>
        : members.map((m, n) => <RecordBlock key={m.id} m={m} fields={fields} differs={differs} n={members.length > 1 ? n + 1 : null} />)}
      {more > 0 && <p className="text-caption text-fg-3">{`And ${more} more not listed here.`}</p>}
    </section>
  );
}

/**
 * Explain (loaded on demand: next/dynamic): the row's recon data on top, then side A left and side B right, head to
 * head (stacked below 768 px, where the dialog is a bottom sheet): every field of every record, a field on the same row
 * on both sides, what differs marked as the Unmatch item page's compare marks it (explain-model.ts).
 */
export default function ExplainDialog({ spaceId, configId, reconName, row, sides, onClose }: {
  spaceId: string; configId: string; reconName: string | null; row: ResultRowDto; sides: readonly [string, string]; onClose: () => void;
}) {
  const m = resultMembers(spaceId, configId, row.id, row.kind);
  const q = useQuery({ queryKey: m.key, queryFn: () => api<ResultMembersDto>(m.url) });
  const x = resultIcon(row.status);
  const d = q.data, s = d?.summary;
  const fields = d ? explainFields(d.labels.a, d.labels.b) : [];
  const differs = d ? differences(d.a, d.b) : new Set<string>();
  const totals = d ? ([sideTotal(d.a), sideTotal(d.b)] as const) : null;
  const totalDiffers = !!totals && (d!.a.length > 1 || d!.b.length > 1) && totalsDiffer(totals[0], totals[1]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{row.kind === "group" ? "Matched group" : "Item"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2"><StatusGlyph health={x.chip.health} icon={x.icon} label={x.chip.label} /><span className="text-fg">{x.chip.label}</span></DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-section">
            <Facts items={[
              ["Recon", reconName], ["Business date", formatDate(appDayStart(row.businessDate))],
              ["Pass", s?.pass ? `Pass ${s.pass}` : null], ["Match", s?.groupKind ? GROUP_LABEL[s.groupKind] : null],
              ["Resolution", s?.resolution ? RESOLUTION_LABEL[s.resolution] : null], ["Unmatch reason", s ? agreed(s.reason) : null], ["Assignee", s ? agreed(s.assignee) : null],
              ["Request", s?.request ? `${APPROVAL_KIND_LABEL[s.request.kind]}, ${REQUEST_STATUS[s.request.status]}` : null],
              ["Posting", s?.posting ? agreed(s.posting.status, (v) => POSTING_STATUS_LABEL[v as PostingStatus] ?? v) : null], ["Bank reference", s?.posting ? agreed(s.posting.bankReference) : null],
            ]} />
            {q.error ? <Failure title="Couldn't load the records" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} />
              : !d ? <div role="status" aria-label="Loading the records" className="grid gap-4 md:grid-cols-2"><Skeleton className="h-48" /><Skeleton className="h-48" /></div>
              : (
                <div className="grid gap-4 md:grid-cols-2">
                  <SideColumn i={0} name={sides[0]} members={d.a} more={d.more.a} fields={fields} differs={differs} total={totals![0]} totalDiffers={totalDiffers} />
                  <SideColumn i={1} name={sides[1]} members={d.b} more={d.more.b} fields={fields} differs={differs} total={totals![1]} totalDiffers={totalDiffers} />
                </div>
              )}
          </div>
        </DialogBody>
        <DialogFooter>
          {row.openItemId && <Button asChild variant="link"><Link href={`/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(row.openItemId)}`}>Open the item<Icon icon={ArrowRightIcon} /></Link></Button>}
          {row.explain.runId && <Button asChild variant="link"><Link href={`/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(configId)}/runs/${encodeURIComponent(row.explain.runId)}`}>See how the run matched it<Icon icon={ArrowRightIcon} /></Link></Button>}
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
