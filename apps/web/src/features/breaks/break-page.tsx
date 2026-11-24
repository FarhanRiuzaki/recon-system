"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionCard, BlockedButton, CategoryChip, type Column, CompareCard, CopyValue, DataTable, Disclosure, Facts, Failure, Field, FilterSearch, focusBack, Notice, PageZone, Panel, RequiredNote, ScrollFade, StatusChip, Stepper, Toolbar } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { appDate, formatDate } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon, type IconData } from "@starterkit/ui/ui/icon";
import { AlertsIcon, ErrorIcon, ForceMatchIcon, RefreshIcon, SpinnerIcon, TakeIcon, WriteOffIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { APPROVAL_KIND_LABEL, type RequestKind } from "@starterkit/shared/approvals";
import { BRAND } from "@starterkit/shared/brand";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { CLOSE_RESOLUTIONS, RESOLUTION_NOTE_MAX } from "@starterkit/shared/recon";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { DetailNotFound } from "@/components/detail-not-found";
import { RequestChain } from "@/components/request-chain";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { useAuth } from "@/lib/client/auth-context";
import { api, errorText, isNotFound, retryUnlessNotFound } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { categoryChip, STATES } from "@/lib/shared/categories";
import { groupKeyText, postingChip, postingEvent, postingPipeline, postingPollMs, waitingText } from "@/lib/shared/posting";
import { APPROVALS_KEY, ENGINE_KEY, spaceDetail } from "@/lib/shared/queries";
import { breakCandidates, breakDetail, LIVE_POLL_MS } from "@/lib/shared/queries-recon";
import { BreakActivity } from "./break-activity";
import { amountDelta, approverText, checkChip, compareRows, counterpartOf, dateText, DIRECTION_LABEL, findToggled, money, picksAfter, oppositeWays, recheckText, type Settle, STATE_LABEL, settleActions, sidesOf, takeText, workAccess } from "./break-model";
import { BREAK_ACT_SHAPE, BREAK_SHAPE } from "./shapes";

const RESOLUTION_LABEL: Record<string, string> = {
  MATCHED_MANUAL: "Matched by a person", FORCE_MATCHED: "Force matched", WRITTEN_OFF: "Written off", POSTED: "Posted", ADJUSTED: "Adjusted",
  AUTO_MATCHED_LATE_DATA: "Matched by a later run", DUPLICATE: "Duplicate", NO_ACTION: "No action needed",
};
type Dialogue = { title: string; description: string; action: string; optional?: boolean; placeholder: string; onSubmit: (note: string) => Promise<void> };
const NoteDialog = dynamic(() => import("./note-dialog"), { ssr: false });
/** What each request asks, in the dialog that sends it; `who` = who approves it by default (approverText). */
const ASK: Record<RequestKind, (who: string) => Omit<Dialogue, "onSubmit">> = {
  force_match: (who) => ({ title: "Request a force match", description: `These items total differently. ${cap(who)} approves the match; not whoever asks.`, action: "Send for approval", placeholder: "Why the difference is right" }),
  write_off: (who) => ({ title: "Request a write-off", description: `The item closes as written off once ${who} approves; not whoever asks.`, action: "Send for approval", placeholder: "Why it is written off" }),
  unmatch: (who) => ({ title: "Request to undo the match", description: `Once ${who} approves, the match is undone and its items go back to unmatch.`, action: "Send for approval", placeholder: "Why the match is wrong" }),
  posting: (who) => ({ title: "Request posting", description: `${cap(who)} approves. On the final approval it closes as posted and its posting action sends it to the bank.`, action: "Send for approval", placeholder: "What the posting is for" }),
};
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const REQUEST_TITLE: Record<NonNullable<BreakDetailDto["request"]>["status"], string> = { pending: "Waiting for approval", approved: "Last request · approved", rejected: "Last request · rejected", cancelled: "Last request · cancelled" };
/** What approving does. */
const DONE_TEXT: Record<RequestKind, string> = {
  force_match: "The items are matched now, by you, as force matched.",
  write_off: "The item closes now as written off.",
  unmatch: "The match is undone now; its items go back to unmatch.",
  posting: "It closes now as posted; its posting action sends it to the bank.",
};
const spin = <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />;
/** The verb icons of the second choices (intent table). */
const SETTLE_ICON: Partial<Record<Settle["key"], IconData>> = { force: ForceMatchIcon, writeOff: WriteOffIcon };
/** Where focus goes once a change has rendered: the next primary (else the page title), or Close item's button. */
const NEXT = '[data-next="true"]', CLOSE_BUTTON = '[data-settle="close"]';
/** After a request or a decision: the next primary, else the waiting request's heading, else the page title. */
const LANDING = [NEXT, '[data-focus="request"]'];

/**
 * One unmatch item (/spaces/[spaceId]/breaks/[itemId], audit B1–B12): Summary (this item beside its counterpart and
 * what differs, the posting result), then what you can do (take it; the ways to settle it, each with its consequence;
 * or the request that waits), then its activity log.
 */
export function BreakPage({ spaceId, id }: { spaceId: string; id: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const d = breakDetail(spaceId, id);
  // asks again while a posting it sent is on its way, and every 15 s while its request waits for someone else's approval
  const q = useQuery({ queryKey: d.key, queryFn: () => api<BreakDetailDto>(d.url), retry: retryUnlessNotFound,
    refetchInterval: (x) => postingPollMs(x.state.data?.actions.map((a) => a.status) ?? []) || (x.state.data?.request?.status === "pending" ? LIVE_POLL_MS : false) });
  const rolesQ = useQuery({ queryKey: spaceDetail(spaceId).key, queryFn: () => api<SpaceRowDto>(spaceDetail(spaceId).url) });
  const roles = rolesQ.data?.roles ?? [];
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogue | null>(null);
  const [picked, setPicked] = useState<ReadonlyMap<string, BreakItemDto>>(new Map());
  const [finding, setFinding] = useState(false);
  const [closing, setClosing] = useState(false);
  const focusTo = useRef<readonly string[] | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusNext = (sel: string | readonly string[]) => { focusTo.current = typeof sel === "string" ? [sel] : sel; setFocusTick((n) => n + 1); };
  const [today] = useState(() => appDate(Date.now())); // read once: a render stays pure
  // focus moves once the change has rendered (the new state's next step, or the title when the zone is gone)
  useEffect(() => {
    if (!focusTo.current) return;
    focusBack(null, document, { skipOrigin: true, fallbacks: focusTo.current });
    focusTo.current = null;
  }, [focusTick, q.data]);
  const b = q.data;
  // a new proposed pair clears the ticks: Find another closes behind it, and nothing hidden is matched
  const pairKey = b && b.state !== "resolved" && b.proposed?.available ? b.proposed.item.id : null;
  const [pairSeen, setPairSeen] = useState(pairKey);
  if (pairKey !== pairSeen) { setPairSeen(pairKey); setPicked((p) => picksAfter(p, pairSeen, pairKey)); }
  const list = { href: `/spaces/${encodeURIComponent(spaceId)}/breaks`, label: "Unmatch" };

  if (isNotFound(q.error)) return <DetailNotFound title="Unmatch item" noun="item" list={list} />;
  if (q.error && !b) return <div className="grid gap-section"><PageHeader title="Unmatch item" /><Panel><Failure title="Couldn't load this item" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!b || skeleton) return <LoadingShape sections={BREAK_SHAPE} shown={skeleton} />;

  const open = b.state !== "resolved";
  const lead = isSuperadmin(user.roles) || roles.some((r) => r === "space_admin" || r === "reviewer");
  const mine = b.assignee?.id === user.id;
  const pending = b.state === "pending_approval";
  const access = workAccess({ lead, operator: roles.includes("operator"), mine, assignee: b.assignee ? b.assignee.name ?? "A removed user" : null, open, pending });
  const asks = b.request?.status !== "pending" && (lead || mine);
  const side = (s: "a" | "b") => b.recon.sides[s === "a" ? 0 : 1];
  const other = side(b.item.side === "a" ? "b" : "a");

  /** A change of the item: its answer replaces the page's copy; the queue is read again. */
  async function act(label: string, path: string, body: object, done: string) {
    setBusy(label);
    try {
      const next = await api<BreakDetailDto>(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(id)}${path}`, { method: "POST", body: JSON.stringify(body) });
      qc.setQueryData(d.key, next);
      toast(done);
      focusNext(LANDING);
      void qc.invalidateQueries({ queryKey: ENGINE_KEY });
    } catch (e) {
      toast.error(errorText(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }
  /** A decision on the item's request (approve, reject, override, cancel): then the item is read again. */
  async function decide(how: "approve" | "reject" | "override" | "cancel", body: object, done: string) {
    setBusy(how);
    try {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/approval-requests/${encodeURIComponent(b!.request!.id)}/${how}`, { method: "POST", body: JSON.stringify(body) });
      toast(done);
      await Promise.all([qc.invalidateQueries({ queryKey: ENGINE_KEY }), qc.invalidateQueries({ queryKey: APPROVALS_KEY })]);
      focusNext(LANDING);
    } catch (e) {
      toast.error(errorText(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }
  async function take() {
    setBusy("take");
    try {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/take`, { method: "POST", body: JSON.stringify({ ids: [id] }) });
      toast("You have this item now.");
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
      focusNext(NEXT);
    } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  }
  const ask = (kind: RequestKind, itemIds?: string[]) => setDialog({ ...ASK[kind](approverText(b.recon, kind)), onSubmit: async (note) => {
    await act("request", "/request", { kind, note, ...(itemIds ? { itemIds } : {}) }, "Sent for approval.");
    setPicked(new Map());
    setDialog(null);
  } });

  // the counterpart the summary compares with: the ticked items, the request's, the matched ones, else the proposed pair
  const proposedFree = open && b.proposed?.available ? b.proposed : null;
  const shown = counterpartOf({ picked: [...picked.values()], request: b.request, matchedWith: b.matchedWith, proposed: b.proposed, open });
  // side against side: this item with its own side's members (a group on both sides) against the other side's
  const compared = shown ? sidesOf(b.item, shown.items) : null;
  const counterpart = compared?.theirs ?? null;
  // Match and Force match act on the items ticked below, else on the proposed pair
  const target = picked.size ? [...picked.keys()] : proposedFree ? [proposedFree.item.id] : [];
  const settle = open && !pending && access.worker
    ? settleActions({ recon: b.recon, access, target: picked.size ? { kind: "picked", count: picked.size } : proposedFree ? { kind: "proposed" } : { kind: "none" } }) : [];
  const run: Record<Settle["key"], () => void> = {
    posting: () => ask("posting"),
    match: () => void (picked.size
      ? act("match", "/match", { itemIds: target }, "Matched.").then(() => setPicked(new Map()))
      : act("match", "/match-pair", {}, "Matched with the proposed pair.")).catch(() => {}),
    force: () => ask("force_match", target),
    writeOff: () => ask("write_off"),
    close: () => setClosing(true),
  };
  const onFind = (o: boolean) => { setFinding(o); setPicked((p) => findToggled(p, o)); };
  const r = b.request;
  const picker = (panel?: boolean) => <Counterparts spaceId={spaceId} id={id} other={other} item={b.item} picked={picked} onPick={setPicked} panel={panel} />;

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
            {(shown.note || (b.item.status === "matched" && asks)) && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-caption text-fg-3">
                {shown.note && <span>{shown.note}</span>}
                {/* undoing a match is rare: a quiet button under the comparison */}
                {b.item.status === "matched" && asks && <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => ask("unmatch")}>Request undo match</Button>}
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

      {r?.status === "pending" ? (
        <PageZone title="Waiting for a decision">
          <Panel title={<span data-focus="request">{REQUEST_TITLE[r.status]}</span>} description={[r.workflowName ?? "Default chain", r.ruleName && !["Default", "Otherwise", "Every request"].includes(r.ruleName) ? `rule “${r.ruleName}”` : null].filter(Boolean).join(" · ")}
            actions={<CategoryChip label={APPROVAL_KIND_LABEL[r.kind]} slot={categoryChip("changeKind", r.kind)} />}>
            <div className="grid gap-4">
              {r.blocked && <p className="text-body-sm text-fg-2">{r.blocked}</p>}
              <RequestChain r={r} />
              {(r.canCancel || r.canOverride || !r.blocked) && (
                <div className="flex flex-wrap items-start gap-2 border-t border-line pt-4">
                  {!r.blocked && <Button type="button" data-next="true" disabled={!!busy} onClick={() => setDialog({ title: `Approve level ${r.currentLevel + 1} of ${r.levels.length}`, description: r.currentLevel + 1 < r.levels.length ? "The request moves to the next level." : DONE_TEXT[r.kind], action: "Approve", optional: true, placeholder: "What you checked", onSubmit: async (note) => { await decide("approve", note ? { note } : {}, "Approved."); setDialog(null); } })}>Approve</Button>}
                  {!r.blocked && <Button type="button" variant="caution" disabled={!!busy} onClick={() => setDialog({ title: "Reject the request", description: "The request ends and the item goes back to where it stood. Your note tells whoever asked why.", action: "Reject request", placeholder: "What is missing", onSubmit: async (note) => { await decide("reject", { note }, "Request rejected."); setDialog(null); } })}><Icon icon={ErrorIcon} />Reject</Button>}
                  {r.canOverride && (
                    <span className="grid gap-1">
                      <Button type="button" variant="secondary" disabled={!!busy} onClick={() => setDialog({ title: "Override the approval chain", description: "As Superadmin you approve every level left at once. Your reason is recorded with the request.", action: "Approve by override", placeholder: "Why it can't wait for the chain", onSubmit: async (reason) => { await decide("override", { reason }, "Approved by override."); setDialog(null); } })}>Override</Button>
                      <span className="text-caption text-fg-3">Approves every level left at once, with your reason.</span>
                    </span>
                  )}
                  {r.canCancel && <Button type="button" variant="caution" className="ml-auto" disabled={!!busy} onClick={() => void decide("cancel", {}, "Request cancelled.").catch(() => {})}><Icon icon={ErrorIcon} />Cancel request</Button>}
                </div>
              )}
            </div>
          </Panel>
        </PageZone>
      ) : open && !pending && rolesQ.error && !rolesQ.data ? (
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
      ) : settle.length > 0 && (
        <PageZone title="What you can do">
          {access.take && (
            <Panel>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="min-w-0 flex-1 basis-64 text-body-sm text-fg-2">{takeText(access.take)}</p>
                <Button type="button" variant={access.take === "first" ? "default" : "secondary"} data-next={access.take === "first" || undefined} onClick={() => void take()} disabled={!!busy} aria-busy={busy === "take" || undefined}>{busy === "take" ? spin : <Icon icon={TakeIcon} />}Take item</Button>
              </div>
            </Panel>
          )}
          {!access.take && access.blocked && <Notice>{access.blocked}</Notice>}
          {/* an even count stays 2 a row (4 = 2 × 2, no orphan); an odd count 3 a row from 1280 (audit 2, Unmatch item) */}
          <div className={`grid items-stretch gap-gutter md:grid-cols-2 ${settle.length % 2 ? "xl:grid-cols-3" : ""}`}>
            {settle.map((s) => (
              <ActionCard key={s.key} title={s.title} consequence={s.consequence} meta={s.meta || s.warning ? <>{s.meta}{s.warning && <span className="block text-degraded-ink">{s.warning}</span>}</> : undefined} className={s.key === "close" && closing ? "md:col-span-full" : undefined}
                action={s.key === "close" && closing
                  ? <CloseForm busy={busy} onCancel={() => { setClosing(false); focusNext(CLOSE_BUTTON); }} onClose={(resolution, note) => act("close", "/close", { resolution, note }, "Item closed.")} />
                  : (
                    <BlockedButton type="button" variant={s.primary ? "default" : "secondary"} reason={s.blocked} disabled={!!busy} data-next={s.primary || undefined} data-settle={s.key}
                      aria-busy={(s.key === "match" && busy === "match") || undefined} onClick={run[s.key]}>
                      {s.key === "match" && busy === "match" ? spin : SETTLE_ICON[s.key] && <Icon icon={SETTLE_ICON[s.key]!} />}{s.label}
                    </BlockedButton>
                  )} />
            ))}
          </div>
          {access.canWork && (proposedFree
            ? <Disclosure summary="Find another counterpart" onToggle={onFind}>{finding && picker()}</Disclosure>
            : picker(true))}
        </PageZone>
      )}

      <PageZone title="Activity log">
        {r && r.status !== "pending" && (
          <Panel tone="quiet" title={REQUEST_TITLE[r.status]} actions={<CategoryChip label={APPROVAL_KIND_LABEL[r.kind]} slot={categoryChip("changeKind", r.kind)} />}>
            <RequestChain r={r} />
          </Panel>
        )}
        <BreakActivity spaceId={spaceId} id={id} />
      </PageZone>
      {dialog && <NoteDialog {...dialog} landing={LANDING} onClose={() => setDialog(null)} />}
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

const PICKER_ROWS = 5;
/**
 * The other side's free items, nearest amount first (audit B7): tick the counterpart, or several for a group; Match
 * and Force match above act on them. Five rows, then Show more pages on. No saved views or column chooser: it is a
 * picker inside the page, not a list page (architecture.test.ts allowlist).
 */
function Counterparts({ spaceId, id, other, item, picked, onPick, panel }: { spaceId: string; id: string; other: string; item: BreakItemDto; picked: ReadonlyMap<string, BreakItemDto>; onPick: (s: ReadonlyMap<string, BreakItemDto>) => void; panel?: boolean }) {
  const def = useMemo(() => breakCandidates(spaceId, id), [spaceId, id]);
  const t = useTableQuery<BreakItemDto, { q: string }>(def);
  const [all, setAll] = useState(false);
  const toggle = (x: BreakItemDto) => { const n = new Map(picked); if (!n.delete(x.id)) n.set(x.id, x); onPick(n); };
  const columns: Column<BreakItemDto>[] = [
    { key: "pick", header: "Pick", className: "w-8", mobile: "lead", cell: (r) => (
      <label className="inline-grid size-7 cursor-pointer place-items-center"><input type="checkbox" aria-label={`Pick ${r.ref ?? "item"}`} checked={picked.has(r.id)} onChange={() => toggle(r)} className="size-4 cursor-pointer accent-primary" /></label>
    ) },
    { key: "ref", header: "Reference", mobile: "title", cell: (r) => <span className="font-mono text-body-sm">{r.ref ?? "No reference"}</span> },
    { key: "amount", header: "Amount", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => <span className="tabular">{money(r)}{oppositeWays(item, r) && r.direction && <span className="text-fg-3"> · {DIRECTION_LABEL[r.direction]}</span>}</span> },
    { key: "difference", header: "Difference", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => <span className="tabular text-fg-2">{amountDelta(item, r) ?? "–"}</span> },
    { key: "date", header: "Business date", mobile: "meta", className: "whitespace-nowrap", cell: (r) => dateText(r.businessDate) },
    { key: "reason", header: "Reason", mobile: "meta", cell: (r) => (r.status === "break" && r.reason ? <CategoryChip label={r.reason} slot={categoryChip("reason", r.reason)} /> : <span className="text-fg-3">Waiting</span>) },
  ];
  const rows = all ? t.rows : t.rows.slice(0, PICKER_ROWS);
  const more = !all && t.rows.length > PICKER_ROWS;
  const body = (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the counterparts; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      <DataTable label="Counterparts" columns={columns} hidden={t.hidden} rows={rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={all ? t.paging : undefined}
        isSelected={(r) => picked.has(r.id)}
        error={t.loadError ? { title: "Couldn't load the counterparts", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
        empty={t.state.q
          ? { icon: AlertsIcon, title: "No item matches", description: "Change the reference, or clear it to see every free item." }
          : { icon: AlertsIcon, title: "Nothing free to match", description: "Items of the other side appear here while they wait or are unmatch themselves." }} />
      {more && <div className="flex justify-center p-2"><Button type="button" variant="ghost" onClick={() => setAll(true)}>Show more</Button></div>}
    </>
  );
  const search = <FilterSearch label="Search by reference" value={t.state.q} onChange={(q) => t.set({ q }, { history: "replace" })} placeholder="Reference" />;
  if (!panel) return <div className="grid gap-3 pt-2"><p className="text-body-sm text-fg-3">{other} items free to match, nearest amount first. Tick one or more; Match and Force match use them.</p>{search}<div className="overflow-hidden rounded-lg border border-line">{body}</div></div>;
  return (
    <Panel flush title="Find a counterpart" description={`${other} items free to match, nearest amount first. Tick one or more; Match and Force match use them.`}
      toolbar={<Toolbar>{search}</Toolbar>}>
      {body}
    </Panel>
  );
}

const CLOSE_LABEL: Record<(typeof CLOSE_RESOLUTIONS)[number], string> = { DUPLICATE: "Duplicate", NO_ACTION: "No action needed" };

/** Close without a match, inline in its card: why (duplicate, no action) and a note, both required. */
function CloseForm({ busy, onClose, onCancel }: { busy: string | null; onClose: (resolution: string, note: string) => Promise<void>; onCancel: () => void }) {
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);
  const why = !resolution ? "Pick why it closes." : !note.trim() ? "Say why it closes without a match." : null;
  return (
    <form noValidate className="grid w-full animate-enter gap-4 md:max-w-xl" onSubmit={(e) => {
      e.preventDefault();
      setTried(true);
      if (!why) void onClose(resolution, note.trim()).catch(() => {});
    }}>
      <RequiredNote />
      <Field id="close-why" label="Why" required error={tried && !resolution ? "Pick why it closes." : null}>
        <Select ref={first} id="close-why" value={resolution} className="w-full" onChange={(e) => setResolution(e.target.value)}>
          <option value="">Choose a reason</option>
          {CLOSE_RESOLUTIONS.map((r) => <option key={r} value={r}>{CLOSE_LABEL[r]}</option>)}
        </Select>
      </Field>
      <Field id="close-note" label="Note" required error={tried && !note.trim() ? "Say why it closes without a match." : null}>
        <Textarea id="close-note" value={note} limit={RESOLUTION_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="What you checked" />
      </Field>
      <span className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={!!busy} aria-busy={busy === "close" || undefined}>{busy === "close" && spin}Close item</Button>
        <Button type="button" variant="ghost" disabled={!!busy} onClick={onCancel}>Cancel</Button>
      </span>
    </form>
  );
}
