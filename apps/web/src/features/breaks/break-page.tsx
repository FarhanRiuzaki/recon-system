"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { BlockedButton, type Column, ColumnsMenu, DataTable, Failure, Field, FilterSearch, Notice, Panel, RequiredNote, ScrollFade, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDate, formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AlertsIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
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
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { ValueRows } from "@/components/version-layout";
import { useAuth } from "@/lib/client/auth-context";
import { api, errorText, isNotFound, retryUnlessNotFound } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { amountText } from "@/lib/shared/amount";
import { postingChip, postingEvent } from "@/lib/shared/posting";
import { APPROVALS_KEY, ENGINE_KEY, spaceDetail } from "@/lib/shared/queries";
import { breakCandidates, breakDetail } from "@/lib/shared/queries-recon";
import { BreakActivity } from "./break-activity";
import { STATE_LABEL } from "./break-columns";
import { BREAK_SHAPE } from "./shapes";

const RESOLUTION_LABEL: Record<string, string> = {
  MATCHED_MANUAL: "Matched by a person", FORCE_MATCHED: "Force matched", WRITTEN_OFF: "Written off", POSTED: "Posted", ADJUSTED: "Adjusted",
  AUTO_MATCHED_LATE_DATA: "Matched by a later run", DUPLICATE: "Duplicate", NO_ACTION: "No action needed",
};
type Dialogue = { title: string; description: string; action: string; optional?: boolean; placeholder: string; onSubmit: (note: string) => Promise<void> };
const NoteDialog = dynamic(() => import("./note-dialog"), { ssr: false });
/** What each request asks, in the dialog that sends it. */
const ASK: Record<RequestKind, Omit<Dialogue, "onSubmit">> = {
  force_match: { title: "Request a force match", description: "These items total differently. A reviewer or space admin who didn't ask approves the match.", action: "Send for approval", placeholder: "Why the difference is right" },
  write_off: { title: "Request a write-off", description: "The break closes as written off once a reviewer or space admin who didn't ask approves it.", action: "Send for approval", placeholder: "Why it is written off" },
  unmatch: { title: "Request to undo the match", description: "Once approved, the match is undone and its items go back to unmatch.", action: "Send for approval", placeholder: "Why the match is wrong" },
  posting: { title: "Request posting", description: "It goes through the recon's posting workflow. On the final approval it closes as posted and its posting action sends it to the bank.", action: "Send for approval", placeholder: "What the posting is for" },
};
/** What approving does. */
const REQUEST_TITLE: Record<NonNullable<BreakDetailDto["request"]>["status"], string> = { pending: "Waiting for approval", approved: "Last request · approved", rejected: "Last request · rejected", cancelled: "Last request · cancelled" };
const DONE_TEXT: Record<RequestKind, string> = {
  force_match: "The items are matched now, by you, as force matched.",
  write_off: "The break closes now as written off.",
  unmatch: "The match is undone now; its items go back to unmatch.",
  posting: "It closes now as posted; its posting action sends it to the bank.",
};
const dateText = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));
const money = (i: Pick<BreakItemDto, "amountMinor" | "currency">) => `${amountText(i.amountMinor, i.currency)}${i.currency ? ` ${i.currency}` : ""}`;
const itemLine = (i: BreakItemDto, sides: readonly [string, string]) => `${i.ref ?? "No reference"} · ${sides[i.side === "a" ? 0 : 1]} · ${money(i)} · ${dateText(i.businessDate)}`;

/**
 * One break (/spaces/[spaceId]/breaks/[itemId], Plan 5 Task 2): what it is and where it stands; then, while it is open
 * and the viewer may work it (whoever has it, or a reviewer, space admin or Superadmin), the pair a later pass proposed
 * in one click, a counterpart to match from the other side, or closing it without a match with a note; its trail.
 */
export function BreakPage({ spaceId, id }: { spaceId: string; id: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const d = breakDetail(spaceId, id);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<BreakDetailDto>(d.url), retry: retryUnlessNotFound });
  const roles = useQuery({ queryKey: spaceDetail(spaceId).key, queryFn: () => api<SpaceRowDto>(spaceDetail(spaceId).url) }).data?.roles ?? [];
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogue | null>(null);
  const b = q.data;
  const list = { href: `/spaces/${encodeURIComponent(spaceId)}/breaks`, label: "Breaks" };

  if (isNotFound(q.error)) return <DetailNotFound title="Break" noun="break" list={list} />;
  if (q.error && !b) return <div className="grid gap-section"><PageHeader title="Break" /><Panel><Failure title="Couldn't load this break" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!b || skeleton) return <LoadingShape sections={BREAK_SHAPE} shown={skeleton} />;

  const open = b.state !== "resolved";
  const lead = isSuperadmin(user.roles) || roles.some((r) => r === "space_admin" || r === "reviewer");
  const worker = lead || roles.includes("operator");
  const mine = b.assignee?.id === user.id;
  const pending = b.state === "pending_approval";
  const canWork = open && !pending && (lead || mine);
  const asks = b.request?.status !== "pending" && (lead || mine);

  /** A change of the break: its answer replaces the page's copy; the queue is read again. */
  async function act(label: string, path: string, body: object, done: string) {
    setBusy(label);
    try {
      const next = await api<BreakDetailDto>(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(id)}${path}`, { method: "POST", body: JSON.stringify(body) });
      qc.setQueryData(d.key, next);
      toast(done);
      void qc.invalidateQueries({ queryKey: ENGINE_KEY });
    } catch (e) {
      toast.error(errorText(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }
  /** A decision on the break's request (approve, reject, override, cancel): then the break is read again. */
  async function decide(how: "approve" | "reject" | "override" | "cancel", body: object, done: string) {
    setBusy(how);
    try {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/approval-requests/${encodeURIComponent(b!.request!.id)}/${how}`, { method: "POST", body: JSON.stringify(body) });
      toast(done);
      await Promise.all([qc.invalidateQueries({ queryKey: ENGINE_KEY }), qc.invalidateQueries({ queryKey: APPROVALS_KEY })]);
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
      toast("You have this break now.");
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
    } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  }

  const ask = (kind: RequestKind, itemIds?: string[]) => setDialog({ ...ASK[kind], onSubmit: async (note) => {
    await act("request", "/request", { kind, note, ...(itemIds ? { itemIds } : {}) }, "Sent for approval.");
    setDialog(null);
  } });

  return (
    <div className="grid gap-section">
      <PageHeader title={b.item.ref ?? "Break"} crumb={b.item.ref ?? "Break"}
        description={`${b.recon.name} · ${b.recon.sides[b.item.side === "a" ? 0 : 1]} · ${STATE_LABEL[b.state]}${b.assignee ? ` · ${b.assignee.id === user.id ? "yours" : b.assignee.name ?? "a removed user"}` : " · Unassigned"}`}
        actions={open && worker && !b.assignee ? (
          <Button type="button" onClick={() => void take()} disabled={!!busy} aria-busy={busy === "take" || undefined}>
            {busy === "take" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Take break
          </Button>
        ) : undefined} />
      {open && !pending && worker && !canWork && b.assignee && !mine && <Notice>{b.assignee.name ?? "Someone"} has this break. A reviewer or space admin can reassign it from Breaks.</Notice>}
      {open && !pending && worker && !b.assignee && <Notice>Take this break to resolve it.</Notice>}

      {b.request && (
        <Panel title={REQUEST_TITLE[b.request.status]} description={[APPROVAL_KIND_LABEL[b.request.kind], b.request.workflowName, b.request.ruleName && !["Default", "Otherwise"].includes(b.request.ruleName) ? `rule “${b.request.ruleName}”` : null].filter(Boolean).join(" · ")}
          toolbar={b.request.status === "pending" ? <Toolbar end={<>
            {b.request.canCancel && <Button type="button" variant="ghost" disabled={!!busy} onClick={() => void decide("cancel", {}, "Request cancelled.").catch(() => {})}>Cancel request</Button>}
            {b.request.canOverride && <Button type="button" variant="secondary" disabled={!!busy} onClick={() => setDialog({ title: "Override the approval chain", description: "As Superadmin you approve every level left at once. Your reason is recorded with the request.", action: "Approve by override", placeholder: "Why it can't wait for the chain", onSubmit: async (reason) => { await decide("override", { reason }, "Approved by override."); setDialog(null); } })}>Override</Button>}
            {!b.request.blocked && <>
              <Button type="button" variant="secondary" disabled={!!busy} onClick={() => setDialog({ title: "Reject the request", description: "The request ends and the break goes back to where it stood. Your note tells whoever asked why.", action: "Reject request", placeholder: "What is missing", onSubmit: async (note) => { await decide("reject", { note }, "Request rejected."); setDialog(null); } })}>Reject</Button>
              <Button type="button" disabled={!!busy} onClick={() => setDialog({ title: `Approve level ${b.request!.currentLevel + 1} of ${b.request!.levels.length}`, description: b.request!.currentLevel + 1 < b.request!.levels.length ? "The request moves to the next level." : DONE_TEXT[b.request!.kind], action: "Approve", optional: true, placeholder: "What you checked", onSubmit: async (note) => { await decide("approve", note ? { note } : {}, "Approved."); setDialog(null); } })}>Approve</Button>
            </>}
          </>}>{null}</Toolbar> : undefined}>
          <div className="grid gap-4 p-4">
            {b.request.status === "pending" && b.request.blocked && <p className="text-body-sm text-fg-2">{b.request.blocked}</p>}
            {b.request.items.length > 0 && (
              <p className="grid text-body-sm"><span className="text-fg-3">Match with</span>{b.request.items.map((i) => <span key={i.id} className="text-fg">{itemLine(i, b.recon.sides)}</span>)}</p>
            )}
            <RequestChain r={b.request} />
          </div>
        </Panel>
      )}

      {b.actions.length > 0 && <PostingPanel b={b} />}

      {/* an unmatch is usually settled by posting it (owner, 22 Nov): the maker asks, the workflow approves, the posting
          action sends it; undoing a match is rare, so it stays a quiet button */}
      <Panel icon={AlertsIcon} title="The break" toolbar={b.item.status === "matched" && asks ? <Toolbar end={
        <Button type="button" variant="ghost" disabled={!!busy} onClick={() => ask("unmatch")}>Request undo match</Button>}>{null}</Toolbar>
        : canWork && b.recon.posts ? <Toolbar end={<Button type="button" disabled={!!busy} onClick={() => ask("posting")}>Request posting</Button>}>{null}</Toolbar> : undefined}>
        <ValueRows items={[
          ["Recon", b.recon.name],
          ["Side", b.recon.sides[b.item.side === "a" ? 0 : 1]],
          ...(b.item.source ? [["Source", b.item.source] as const] : []),
          ["Amount", money(b.item)],
          ["Business date", `${dateText(b.item.businessDate)} · ${b.ageDays === 0 ? "today" : `${b.ageDays} ${b.ageDays === 1 ? "day" : "days"} old`}`],
          ["Reason", b.item.reason ?? "—"],
          ["State", STATE_LABEL[b.state]],
          ...(b.resolution ? [["Resolution", RESOLUTION_LABEL[b.resolution] ?? b.resolution] as const] : []),
          ...(b.matchedWith.length ? [["Matched with", <span key="m" className="grid">{b.matchedWith.map((i) => <span key={i.id}>{itemLine(i, b.recon.sides)}</span>)}</span>] as const] : []),
        ]} />
      </Panel>

      {open && b.proposed && (
        <Panel title="Proposed pair" description={b.proposed.pass ? `A later run's pass ${b.proposed.pass} suggested it` : "A later run suggested it"}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="min-w-0 flex-1 basis-64 text-body-sm text-fg">{itemLine(b.proposed.item, b.recon.sides)}</span>
            <BlockedButton type="button" reason={!canWork ? "Take this break first." : !b.proposed.available ? "That item was matched or resolved meanwhile." : null}
              disabled={!!busy} aria-busy={busy === "pair" || undefined} onClick={() => void act("pair", "/match-pair", {}, "Matched with the proposed pair.").catch(() => {})}>
              {busy === "pair" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Match pair
            </BlockedButton>
          </div>
        </Panel>
      )}

      {canWork && <Counterparts spaceId={spaceId} id={id} b={b} busy={busy} onMatch={(ids) => act("match", "/match", { itemIds: ids }, "Matched.")} onForce={(ids) => ask("force_match", ids)} />}
      {canWork && <CloseForm busy={busy} onClose={(resolution, note) => act("close", "/close", { resolution, note }, "Break closed.")} onWriteOff={() => ask("write_off")} />}
      <BreakActivity spaceId={spaceId} id={id} />
      {dialog && <NoteDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** The other side's free items, nearest amount first; tick the counterpart (or several, for a group) and match. */
/**
 * What its latest request sent to the bank (stage 4): each action in sending order with its status, the bank's code
 * and reference; the masked request and answer behind a disclosure, for an Open API reader or the space admin.
 */
function PostingPanel({ b }: { b: BreakDetailDto }) {
  const chip = b.posting ? postingChip(b.posting.status) : null;
  return (
    <Panel title="Posting" description={b.posting ? `${b.posting.action}: ${chip!.label.toLowerCase()}${b.posting.bankReference ? ` · bank reference ${b.posting.bankReference}` : ""}` : "What the approval sent to the bank"}
      actions={chip ? <StatusChip health={chip.health} label={chip.label} /> : undefined}>
      <ol className="grid divide-y divide-line">
        {b.actions.map((a) => {
          const c = postingChip(a.status);
          return (
            <li key={a.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm text-fg">{a.name}<span className="text-fg-3"> · {postingEvent(a)}{a.override ? " (override)" : ""}{a.variant ? ` · ${a.variant}` : ""}</span></span>
                <StatusChip health={c.health} label={c.label} />
              </span>
              {(a.message || a.code || a.bankReference || a.externalId) && (
                <span className="flex flex-wrap gap-x-4 text-caption text-fg-3">
                  {a.message && <span className={a.status === "posted" ? "" : "text-down-ink"}>{a.message}</span>}
                  {a.code && <span>Code <span className="font-mono">{a.code}</span></span>}
                  {a.bankReference && <span>Bank reference <span className="font-mono">{a.bankReference}</span></span>}
                  {a.externalId && <span>External ID <span className="font-mono">{a.externalId}</span></span>}
                  <span>{formatDateTime(Date.parse(a.at))}</span>
                </span>
              )}
              {(a.payload !== null || a.response !== null) && (
                <details className="text-caption">
                  <summary className="cursor-pointer text-fg-2">Request and answer (masked)</summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <ScrollFade className="max-h-64 rounded-md border border-line bg-tray" tabIndex={0} aria-label="Request sent"><pre className="p-2 font-mono text-fg">{JSON.stringify(a.payload, null, 2)}</pre></ScrollFade>
                    <ScrollFade className="max-h-64 rounded-md border border-line bg-tray" tabIndex={0} aria-label="Bank's answer"><pre className="p-2 font-mono text-fg">{a.response === null ? "No answer" : JSON.stringify(a.response, null, 2)}</pre></ScrollFade>
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function Counterparts({ spaceId, id, b, busy, onMatch, onForce }: { spaceId: string; id: string; b: BreakDetailDto; busy: string | null; onMatch: (ids: string[]) => Promise<void>; onForce: (ids: string[]) => void }) {
  const def = useMemo(() => breakCandidates(spaceId, id), [spaceId, id]);
  const t = useTableQuery<BreakItemDto, { q: string }>(def);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const toggle = (x: string) => setPicked((s) => { const n = new Set(s); if (!n.delete(x)) n.add(x); return n; });
  const columns: Column<BreakItemDto>[] = [
    { key: "pick", header: "Pick", className: "w-8", mobile: "lead", cell: (r) => (
      <label className="inline-grid size-7 cursor-pointer place-items-center"><input type="checkbox" aria-label={`Pick ${r.ref ?? "item"}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} className="size-4 cursor-pointer accent-primary" /></label>
    ) },
    { key: "ref", header: "Reference", mobile: "title", cell: (r) => <span className="font-mono text-body-sm">{r.ref ?? "No reference"}</span> },
    { key: "amount", header: "Amount", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => <span className="tabular">{money(r)}</span> },
    { key: "date", header: "Business date", mobile: "meta", className: "whitespace-nowrap", cell: (r) => dateText(r.businessDate) },
    { key: "status", header: "Now", mobile: "meta", cell: (r) => (r.status === "break" ? `Break · ${r.reason ?? ""}` : "Waiting") },
  ];
  return (
    <Panel flush title="Find a counterpart" description={`${b.recon.sides[b.item.side === "a" ? 1 : 0]} items free to match, nearest amount first`}
      toolbar={<Toolbar end={<>
        <SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} />
        <BlockedButton type="button" variant="secondary" reason={picked.size ? null : "Pick the counterpart first."} disabled={!!busy} onClick={() => onForce([...picked])}>Request force match</BlockedButton>
        <BlockedButton type="button" reason={picked.size ? null : "Pick the counterpart first."} disabled={!!busy} aria-busy={busy === "match" || undefined}
          onClick={() => void onMatch([...picked]).then(() => setPicked(new Set())).catch(() => {})}>
          {busy === "match" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Match {picked.size > 1 ? `${picked.size} items` : "item"}
        </BlockedButton></>}>
        <FilterSearch label="Search by reference" value={t.state.q} onChange={(q) => t.set({ q }, { history: "replace" })} placeholder="Reference" />
      </Toolbar>}>
      <DataTable label="Counterparts" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
        isSelected={(r) => picked.has(r.id)}
        error={t.loadError ? { title: "Couldn't load the counterparts", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
        empty={t.state.q
          ? { icon: AlertsIcon, title: "No item matches", description: "Change the reference, or clear it to see every free item." }
          : { icon: AlertsIcon, title: "Nothing free to match", description: "Items of the other side appear here while they wait or are breaks themselves." }} />
    </Panel>
  );
}

const CLOSE_LABEL: Record<(typeof CLOSE_RESOLUTIONS)[number], string> = { DUPLICATE: "Duplicate", NO_ACTION: "No action needed" };

/** Close without a match: why (duplicate, no action) and a note, both required. */
function CloseForm({ busy, onClose, onWriteOff }: { busy: string | null; onClose: (resolution: string, note: string) => Promise<void>; onWriteOff: () => void }) {
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const why = !resolution ? "Pick why it closes." : !note.trim() ? "Say why it closes without a match." : null;
  return (
    <Panel title="Close without a match" description="It leaves the queue and no longer counts as an open break">
      <form noValidate className="grid gap-4 md:max-w-xl" onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!why) void onClose(resolution, note.trim()).then(() => { setResolution(""); setNote(""); setTried(false); }).catch(() => {});
      }}>
        <RequiredNote />
        <Field id="close-why" label="Why" required error={tried && !resolution ? "Pick why it closes." : null}>
          <Select id="close-why" value={resolution} className="w-full" onChange={(e) => setResolution(e.target.value)}>
            <option value="">Choose a reason</option>
            {CLOSE_RESOLUTIONS.map((r) => <option key={r} value={r}>{CLOSE_LABEL[r]}</option>)}
          </Select>
        </Field>
        <Field id="close-note" label="Note" required error={tried && !note.trim() ? "Say why it closes without a match." : null}>
          <Textarea id="close-note" value={note} limit={RESOLUTION_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="What you checked" />
        </Field>
        <span className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" disabled={!!busy} aria-busy={busy === "close" || undefined}>
            {busy === "close" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Close break
          </Button>
          <Button type="button" variant="ghost" disabled={!!busy} onClick={onWriteOff}>Request write-off</Button>
        </span>
      </form>
    </Panel>
  );
}
