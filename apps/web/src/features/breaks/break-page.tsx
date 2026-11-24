"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { CategoryChip, CompareCard, CopyValue, Facts, Failure, Notice, PageZone, Panel, ScrollFade, StatusChip, Stepper } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { appDate, formatDate } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { RefreshIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { APPROVAL_KIND_LABEL } from "@starterkit/shared/approvals";
import { BRAND } from "@starterkit/shared/brand";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { DetailNotFound } from "@/components/detail-not-found";
import { RequestChain } from "@/components/request-chain";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { checkChip, compareRows, counterpartOf, dateText, DIRECTION_LABEL, money, recheckText, STATE_LABEL, sidesOf, workView } from "@/components/unmatch/break-model";
import { REQUEST_TITLE, RequestZone, SettleZone, UndoMatchButton, useUnmatchWork, WorkDialog } from "@/components/unmatch/unmatch-work";
import { useAuth } from "@/lib/client/auth-context";
import { api, errorText, isNotFound, retryUnlessNotFound } from "@/lib/client/api";
import { categoryChip, STATES } from "@/lib/shared/categories";
import { groupKeyText, postingChip, postingEvent, postingPipeline, postingPollMs, waitingText } from "@/lib/shared/posting";
import { spaceDetail } from "@/lib/shared/queries";
import { breakDetail, LIVE_POLL_MS } from "@/lib/shared/queries-recon";
import { BreakActivity } from "./break-activity";
import { BREAK_ACT_SHAPE, BREAK_SHAPE } from "./shapes";

const RESOLUTION_LABEL: Record<string, string> = {
  MATCHED_MANUAL: "Matched by a person", FORCE_MATCHED: "Force matched", WRITTEN_OFF: "Written off", POSTED: "Posted", ADJUSTED: "Adjusted",
  AUTO_MATCHED_LATE_DATA: "Matched by a later run", DUPLICATE: "Duplicate", NO_ACTION: "No action needed",
};

/**
 * One unmatch item (/spaces/[spaceId]/breaks/[itemId], audit B1–B12): Summary (this item beside its counterpart and
 * what differs, the posting result), then what you can do (take it; the ways to settle it, each with its consequence;
 * or the request that waits; components/unmatch, shared with Operation result's Explain), then its activity log.
 */
export function BreakPage({ spaceId, id }: { spaceId: string; id: string }) {
  const { user } = useAuth();
  const d = breakDetail(spaceId, id);
  // asks again while a posting it sent is on its way, and every 15 s while its request waits for someone else's approval
  const q = useQuery({ queryKey: d.key, queryFn: () => api<BreakDetailDto>(d.url), retry: retryUnlessNotFound,
    refetchInterval: (x) => postingPollMs(x.state.data?.actions.map((a) => a.status) ?? []) || (x.state.data?.request?.status === "pending" ? LIVE_POLL_MS : false) });
  const rolesQ = useQuery({ queryKey: spaceDetail(spaceId).key, queryFn: () => api<SpaceRowDto>(spaceDetail(spaceId).url) });
  const roles = rolesQ.data?.roles ?? [];
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const [today] = useState(() => appDate(Date.now())); // read once: a render stays pure
  const b = q.data;
  const u = useUnmatchWork(spaceId, id, b);
  const list = { href: `/spaces/${encodeURIComponent(spaceId)}/breaks`, label: "Unmatch" };

  if (isNotFound(q.error)) return <DetailNotFound title="Unmatch item" noun="item" list={list} />;
  if (q.error && !b) return <div className="grid gap-section"><PageHeader title="Unmatch item" /><Panel><Failure title="Couldn't load this item" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!b || skeleton) return <LoadingShape sections={BREAK_SHAPE} shown={skeleton} />;

  const v = workView(b, { user, roles, picked: u.picked });
  const { open, mine, pending } = v;
  const side = (s: "a" | "b") => b.recon.sides[s === "a" ? 0 : 1];
  const other = side(b.item.side === "a" ? "b" : "a");
  // the counterpart the summary compares with: the ticked items, the request's, the matched ones, else the proposed pair
  const shown = counterpartOf({ picked: [...u.picked.values()], request: b.request, matchedWith: b.matchedWith, proposed: b.proposed, open });
  // side against side: this item with its own side's members (a group on both sides) against the other side's
  const compared = shown ? sidesOf(b.item, shown.items) : null;
  const counterpart = compared?.theirs ?? null;
  const r = b.request;

  return (
    <div className="grid gap-zone">
      <PageHeader title={`${money(b.item)} · ${side(b.item.side)}`} crumb={b.item.ref ?? "Unmatch item"}
        status={<span className="flex flex-wrap items-center gap-1.5">
          {b.item.reason && <CategoryChip label={b.item.reason} slot={categoryChip("reason", b.item.reason)} />}
          <StatusChip label={STATE_LABEL[b.state]} health={STATES.workState[b.state]} />
          {open && checkChip(b.recon.recheck, today, pending) && <CategoryChip label={checkChip(b.recon.recheck, today, pending)!} slot="neutral" />}
          <CategoryChip label={b.assignee ? (mine ? "Yours" : b.assignee.name ?? "A removed user") : "Unassigned"} slot="neutral" />
        </span>}
        description={<span className="grid gap-0.5">
          {b.item.ref ? <CopyValue value={b.item.ref} label="reference" /> : <span>No reference</span>}
          <span>{[b.recon.name, dateText(b.item.businessDate), open ? recheckText(b.recon.recheck, today, pending) : b.resolution ? RESOLUTION_LABEL[b.resolution] ?? null : null].filter(Boolean).join(" · ")}</span>
        </span>} />

      <PageZone title="Summary">
        {counterpart && shown ? (
          <div className="grid gap-2">
            <CompareCard title="This item and its counterpart" sides={["This item", `${shown.label} · ${other}`]}
              rows={compareRows(compared!.mine, counterpart)} />
            {/* several counterparts: each one, so whoever approves sees exactly what they approve */}
            {shown.items.length > 1 && <CounterpartList items={shown.items} side={side} />}
            {(shown.note || v.undo) && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-caption text-fg-3">
                {shown.note && <span>{shown.note}</span>}
                {/* undoing a match is rare: a quiet button under the comparison */}
                <UndoMatchButton u={u} v={v} />
              </p>
            )}
          </div>
        ) : (
          <Panel title="This item" description={open ? `No ${other} item is proposed for it yet; each run looks for one.` : undefined}>
            <Facts items={[["Source", b.item.source ?? "–"], ["Age", b.ageDays === 0 ? "Today" : `${b.ageDays} ${b.ageDays === 1 ? "day" : "days"} old`]]} />
          </Panel>
        )}
        {b.actions.length > 0 && <PostingPanel b={b} spaceId={spaceId} />}
      </PageZone>

      {r?.status === "pending" ? <RequestZone u={u} b={b} /> : open && !pending && rolesQ.error && !rolesQ.data ? (
        // who may act comes with the space's roles: without them say so, never hide the zone
        <PageZone title="What you can do">
          <Notice tone="warn">
            <span className="grid justify-items-start gap-2">
              <span>Couldn&apos;t load your roles in this space, so the ways to settle this item can&apos;t be shown. {errorText(rolesQ.error)}</span>
              <Button type="button" variant="secondary" size="sm" disabled={rolesQ.isFetching} aria-busy={rolesQ.isFetching || undefined} onClick={() => void rolesQ.refetch()}><Icon icon={rolesQ.isFetching ? SpinnerIcon : RefreshIcon} className={rolesQ.isFetching ? "motion-safe:animate-spin" : undefined} />Try again</Button>
            </span>
          </Notice>
        </PageZone>
      ) : open && !pending && rolesQ.isPending ? (
        // who may act comes with the space's roles: the zone's shape holds its place until they are in
        <LoadingShape sections={BREAK_ACT_SHAPE} shown />
      ) : <SettleZone u={u} v={v} b={b} other={other} />}

      <PageZone title="Activity log">
        {r && r.status !== "pending" && (
          <Panel tone="quiet" title={REQUEST_TITLE[r.status]} actions={<CategoryChip label={APPROVAL_KIND_LABEL[r.kind]} slot={categoryChip("changeKind", r.kind)} />}>
            <RequestChain r={r} />
          </Panel>
        )}
        <BreakActivity spaceId={spaceId} id={id} />
      </PageZone>
      <WorkDialog u={u} />
    </div>
  );
}

/** Each counterpart of a comparison of several (a force match's request, a group): reference, side, amount, date. */
function CounterpartList({ items, side }: { items: readonly BreakItemDto[]; side: (s: "a" | "b") => string }) {
  return (
    <Panel title={`${items.length} items`} flush>
      <ul className="grid divide-y divide-line text-body-sm">
        {items.map((i) => (
          <li key={i.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-3 py-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_7rem]">
            <span className="min-w-0 font-mono wrap-anywhere text-fg">{i.ref ?? "No reference"}</span>
            <span className="text-fg-3 max-md:order-last">{side(i.side)}</span>
            <span className="tabular text-right whitespace-nowrap text-fg">{money(i)}{i.direction && <span className="text-fg-3"> · {DIRECTION_LABEL[i.direction]}</span>}</span>
            <span className="whitespace-nowrap text-fg-2 md:text-right">{dateText(i.businessDate)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * What its latest request sent to the bank (stage 4): each action in sending order with its status, the bank's code
 * and reference, its pipeline (queued → in group → sending → the answer, with times), and the masked request and response
 * for an Open API reader or the space admin.
 */
function PostingPanel({ b, spaceId }: { b: BreakDetailDto; spaceId: string }) {
  const chip = b.posting ? postingChip(b.posting.status) : null;
  return (
    <Panel title="Posting" description={b.posting ? `${b.posting.action}: ${chip!.label.toLowerCase()}${b.posting.bankReference ? ` · bank reference ${b.posting.bankReference}` : ""}` : "What the approval sent to the bank"}
      actions={chip ? <StatusChip health={chip.health} label={chip.label} /> : undefined}>
      <ol className="grid divide-y divide-line">
        {b.actions.map((a) => {
          const c = postingChip(a.status);
          return (
            <li key={a.id} className="grid gap-3 py-4 first:pt-0 last:pb-0">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm text-fg">{a.name}<span className="text-fg-3"> · {postingEvent(a)}{a.override ? " (override)" : ""}{a.variant ? ` · ${a.variant}` : ""}</span></span>
                <StatusChip health={c.health} label={c.label} />
              </span>
              {/* grouped (stage 5): the group it waits in, or was sent in with how many others, on the recon's Posting groups tab */}
              {a.group && (
                <Link href={`/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(a.group.configId)}?tab=posting&group=${encodeURIComponent(a.group.id)}`}
                  className="justify-self-start text-caption text-fg-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary">
                  {a.status === "grouped" ? waitingText(a.group) : `Sent in the ${formatDate(Date.parse(`${a.group.period}T00:00:00+07:00`))} group · ${groupKeyText(a.group.keys)} · ${a.group.items === 1 ? "1 item" : `${a.group.items} items`}`}
                </Link>
              )}
              <Stepper layout="horizontal" label={`${a.name} pipeline`} steps={postingPipeline(a)} />
              {(a.message || a.code || a.bankReference || a.externalId) && (
                <span className="flex flex-wrap gap-x-4 text-caption text-fg-3">
                  {a.message && <span className={a.status === "posted" || a.status === "skipped" ? "" : "text-down-ink"}>{a.message}</span>}
                  {a.code && <span>Code <span className="font-mono">{a.code}</span></span>}
                  {a.bankReference && <span>Bank reference <span className="font-mono">{a.bankReference}</span></span>}
                  {a.externalId && <span>External ID <span className="font-mono">{a.externalId}</span></span>}
                </span>
              )}
              {/* the API call itself, masked as the connector says, for whoever may read it */}
              {a.status !== "grouped" && (b.seesPayload ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {([["Request", a.payload, "Not built yet"], [`Response${a.httpStatus != null ? ` · HTTP ${a.httpStatus}` : ""}`, a.response, a.finishedAt ? "No response" : "Not answered yet"]] as const).map(([title, body, none]) => (
                    <div key={title} className="grid min-w-0 gap-1.5">
                      <span className="text-caption text-fg-3">{title} (masked)</span>
                      <ScrollFade className="max-h-64 rounded-md border border-line bg-tray" tabIndex={0} aria-label={title}>
                        <pre className="p-3 font-mono text-caption text-fg">{body == null ? none : JSON.stringify(body, null, 2)}</pre>
                      </ScrollFade>
                    </div>
                  ))}
                </div>
              ) : <span className="text-caption text-fg-3">The request and response show to an Open API reader or the space admin.</span>)}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
