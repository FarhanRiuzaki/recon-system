"use client";

// The work on one unmatch item, one implementation for its page (features/breaks/break-page.tsx) and Operation
// result's Explain (features/results/explain-dialog.tsx; owner 24 Nov, DEC-056): take it, settle it (each way with its
// consequence and why it is blocked), the counterpart finder Match and Force match use, the waiting request's decision
// (approve, reject, override, cancel), and Request undo match. Every change reads the item again and refreshes the
// lists, counts and dashboard that show it (ENGINE_KEY, APPROVALS_KEY, DASHBOARD_KEY).
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionCard, BlockedButton, CategoryChip, type Column, DataTable, Disclosure, Field, FilterSearch, focusBack, Notice, PageZone, Panel, RequiredNote, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon, type IconData } from "@starterkit/ui/ui/icon";
import { AlertsIcon, ErrorIcon, ForceMatchIcon, SpinnerIcon, TakeIcon, WriteOffIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { APPROVAL_KIND_LABEL, type RequestKind } from "@starterkit/shared/approvals";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import { CLOSE_RESOLUTIONS, RESOLUTION_NOTE_MAX } from "@starterkit/shared/recon";
import { RequestChain } from "@/components/request-chain";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { categoryChip } from "@/lib/shared/categories";
import { APPROVALS_KEY, DASHBOARD_KEY, ENGINE_KEY } from "@/lib/shared/queries";
import { breakCandidates, breakDetail } from "@/lib/shared/queries-recon";
import { amountDelta, approverText, candidateState, dateText, DIRECTION_LABEL, findToggled, money, oppositeWays, picksAfter, type Settle, takeText, type WorkView } from "./break-model";

type Dialogue = { title: string; description: string; action: string; optional?: boolean; placeholder: string; onSubmit: (note: string) => Promise<void> };
const NoteDialog = dynamic(() => import("./note-dialog"), { ssr: false });
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/** What each request asks, in the dialog that sends it; `who` = who approves it by default (approverText). */
const ASK: Record<RequestKind, (who: string) => Omit<Dialogue, "onSubmit">> = {
  force_match: (who) => ({ title: "Request a force match", description: `These items total differently. ${cap(who)} approves the match; not whoever asks.`, action: "Send for approval", placeholder: "Why the difference is right" }),
  write_off: (who) => ({ title: "Request a write-off", description: `The item closes as written off once ${who} approves; not whoever asks.`, action: "Send for approval", placeholder: "Why it is written off" }),
  unmatch: (who) => ({ title: "Request to undo the match", description: `Once ${who} approves, the match is undone and its items go back to unmatch.`, action: "Send for approval", placeholder: "Why the match is wrong" }),
  posting: (who) => ({ title: "Request posting", description: `${cap(who)} approves. On the final approval it closes as posted and its posting action sends it to the bank.`, action: "Send for approval", placeholder: "What the posting is for" }),
};
export const REQUEST_TITLE: Record<NonNullable<BreakDetailDto["request"]>["status"], string> = { pending: "Waiting for approval", approved: "Last request · approved", rejected: "Last request · rejected", cancelled: "Last request · cancelled" };
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
 * The state and changes of the work on item `id` (`b` its detail, once loaded): what is busy, the open note dialog,
 * the ticked counterparts, the finder and the close form; each change answers with a toast and moves focus to the
 * next step once it has rendered.
 */
export function useUnmatchWork(spaceId: string, id: string, b: BreakDetailDto | undefined) {
  const qc = useQueryClient();
  const d = breakDetail(spaceId, id);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogue | null>(null);
  const [picked, setPicked] = useState<ReadonlyMap<string, BreakItemDto>>(new Map());
  const [finding, setFinding] = useState(false);
  const [closing, setClosing] = useState(false);
  const focusTo = useRef<readonly string[] | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusNext = (sel: string | readonly string[]) => { focusTo.current = typeof sel === "string" ? [sel] : sel; setFocusTick((n) => n + 1); };
  // focus moves once the change has rendered (the new state's next step, or the title when the zone is gone)
  useEffect(() => {
    if (!focusTo.current) return;
    focusBack(null, document, { skipOrigin: true, fallbacks: focusTo.current });
    focusTo.current = null;
  }, [focusTick, b]);
  // a new proposed pair clears the ticks: Find another closes behind it, and nothing hidden is matched
  const pairKey = b && b.state !== "resolved" && b.proposed?.available ? b.proposed.item.id : null;
  const [pairSeen, setPairSeen] = useState(pairKey);
  if (pairKey !== pairSeen) { setPairSeen(pairKey); setPicked((p) => picksAfter(p, pairSeen, pairKey)); }
  const others = () => { void qc.invalidateQueries({ queryKey: APPROVALS_KEY }); void qc.invalidateQueries({ queryKey: DASHBOARD_KEY }); };

  /** A change of the item: its answer replaces the cached copy; the lists that show it are read again. */
  async function act(label: string, path: string, body: object, done: string) {
    setBusy(label);
    try {
      const next = await api<BreakDetailDto>(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(id)}${path}`, { method: "POST", body: JSON.stringify(body) });
      qc.setQueryData(d.key, next);
      toast(done);
      focusNext(LANDING);
      void qc.invalidateQueries({ queryKey: ENGINE_KEY });
      others();
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
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY });
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
      others();
      focusNext(NEXT);
    } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  }
  const ask = (kind: RequestKind, itemIds?: string[]) => setDialog({ ...ASK[kind](approverText(b!.recon, kind)), onSubmit: async (note) => {
    await act("request", "/request", { kind, note, ...(itemIds ? { itemIds } : {}) }, "Sent for approval.");
    setPicked(new Map());
    setDialog(null);
  } });
  const onFind = (o: boolean) => { setFinding(o); setPicked((p) => findToggled(p, o)); };
  return { spaceId, id, busy, dialog, setDialog, picked, setPicked, finding, onFind, closing, setClosing, act, decide, take, ask, focusNext };
}
export type UnmatchWork = ReturnType<typeof useUnmatchWork>;

/** The note dialog a request or a decision opens. */
export function WorkDialog({ u }: { u: UnmatchWork }) {
  return u.dialog ? <NoteDialog {...u.dialog} landing={LANDING} onClose={() => u.setDialog(null)} /> : null;
}

/** Request undo match: rare, a quiet button under the comparison; only for whoever may ask (WorkView `undo`). */
export function UndoMatchButton({ u, v }: { u: UnmatchWork; v: WorkView }) {
  return v.undo ? <Button type="button" variant="ghost" size="sm" disabled={!!u.busy} onClick={() => u.ask("unmatch")}>Request undo match</Button> : null;
}

/** The request that waits for a decision: its chain, and Approve, Reject, Override, Cancel request for whoever may. */
export function RequestZone({ u, b }: { u: UnmatchWork; b: BreakDetailDto }) {
  const r = b.request;
  if (r?.status !== "pending") return null;
  const busy = u.busy;
  return (
    <PageZone title="Waiting for a decision">
      <Panel title={<span data-focus="request">{REQUEST_TITLE[r.status]}</span>} description={[r.workflowName ?? "Default chain", r.ruleName && !["Default", "Otherwise", "Every request"].includes(r.ruleName) ? `rule “${r.ruleName}”` : null].filter(Boolean).join(" · ")}
        actions={<CategoryChip label={APPROVAL_KIND_LABEL[r.kind]} slot={categoryChip("changeKind", r.kind)} />}>
        <div className="grid gap-4">
          {r.blocked && <p className="text-body-sm text-fg-2">{r.blocked}</p>}
          <RequestChain r={r} />
          {(r.canCancel || r.canOverride || !r.blocked) && (
            <div className="flex flex-wrap items-start gap-2 border-t border-line pt-4">
              {!r.blocked && <Button type="button" data-next="true" disabled={!!busy} onClick={() => u.setDialog({ title: `Approve level ${r.currentLevel + 1} of ${r.levels.length}`, description: r.currentLevel + 1 < r.levels.length ? "The request moves to the next level." : DONE_TEXT[r.kind], action: "Approve", optional: true, placeholder: "What you checked", onSubmit: async (note) => { await u.decide("approve", note ? { note } : {}, "Approved."); u.setDialog(null); } })}>Approve</Button>}
              {!r.blocked && <Button type="button" variant="caution" disabled={!!busy} onClick={() => u.setDialog({ title: "Reject the request", description: "The request ends and the item goes back to where it stood. Your note tells whoever asked why.", action: "Reject request", placeholder: "What is missing", onSubmit: async (note) => { await u.decide("reject", { note }, "Request rejected."); u.setDialog(null); } })}><Icon icon={ErrorIcon} />Reject</Button>}
              {r.canOverride && (
                <span className="grid gap-1">
                  <Button type="button" variant="secondary" disabled={!!busy} onClick={() => u.setDialog({ title: "Override the approval chain", description: "As Superadmin you approve every level left at once. Your reason is recorded with the request.", action: "Approve by override", placeholder: "Why it can't wait for the chain", onSubmit: async (reason) => { await u.decide("override", { reason }, "Approved by override."); u.setDialog(null); } })}>Override</Button>
                  <span className="text-caption text-fg-3">Approves every level left at once, with your reason.</span>
                </span>
              )}
              {r.canCancel && <Button type="button" variant="caution" className="ml-auto" disabled={!!busy} onClick={() => void u.decide("cancel", {}, "Request cancelled.").catch(() => {})}><Icon icon={ErrorIcon} />Cancel request</Button>}
            </div>
          )}
        </div>
      </Panel>
    </PageZone>
  );
}

/**
 * What you can do with an open item: take it, the ways to settle it (each with its consequence, blocked with why), and
 * the counterpart finder Match and Force match act on. Nothing while there is nothing to settle (WorkView `settle`).
 * `other` = the other side's name.
 */
export function SettleZone({ u, v, b, other }: { u: UnmatchWork; v: WorkView; b: BreakDetailDto; other: string }) {
  if (!v.settle.length) return null;
  const { access, settle, target, proposedFree } = v;
  const { busy, picked, closing } = u;
  const run: Record<Settle["key"], () => void> = {
    posting: () => u.ask("posting"),
    match: () => void (picked.size
      ? u.act("match", "/match", { itemIds: target }, "Matched.").then(() => u.setPicked(new Map()))
      : u.act("match", "/match-pair", {}, "Matched with the proposed pair.")).catch(() => {}),
    force: () => u.ask("force_match", target),
    writeOff: () => u.ask("write_off"),
    close: () => u.setClosing(true),
  };
  const picker = (panel?: boolean) => <Counterparts spaceId={u.spaceId} id={u.id} other={other} item={b.item} picked={picked} onPick={u.setPicked} panel={panel} />;
  return (
    <PageZone title="What you can do">
      {access.take && (
        <Panel>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="min-w-0 flex-1 basis-64 text-body-sm text-fg-2">{takeText(access.take)}</p>
            <Button type="button" variant={access.take === "first" ? "default" : "secondary"} data-next={access.take === "first" || undefined} onClick={() => void u.take()} disabled={!!busy} aria-busy={busy === "take" || undefined}>{busy === "take" ? spin : <Icon icon={TakeIcon} />}Take item</Button>
          </div>
        </Panel>
      )}
      {!access.take && access.blocked && <Notice>{access.blocked}</Notice>}
      {/* an even count stays 2 a row (4 = 2 × 2, no orphan); an odd count 3 a row from 1280 (audit 2, Unmatch item) */}
      <div className={`grid items-stretch gap-gutter md:grid-cols-2 ${settle.length % 2 ? "xl:grid-cols-3" : ""}`}>
        {settle.map((s) => (
          <ActionCard key={s.key} title={s.title} consequence={s.consequence} meta={s.meta || s.warning ? <>{s.meta}{s.warning && <span className="block text-degraded-ink">{s.warning}</span>}</> : undefined} className={s.key === "close" && closing ? "md:col-span-full" : undefined}
            action={s.key === "close" && closing
              ? <CloseForm busy={busy} onCancel={() => { u.setClosing(false); u.focusNext(CLOSE_BUTTON); }} onClose={(resolution, note) => u.act("close", "/close", { resolution, note }, "Item closed.")} />
              : (
                <BlockedButton type="button" variant={s.primary ? "default" : "secondary"} reason={s.blocked} disabled={!!busy} data-next={s.primary || undefined} data-settle={s.key}
                  aria-busy={(s.key === "match" && busy === "match") || undefined} onClick={run[s.key]}>
                  {s.key === "match" && busy === "match" ? spin : SETTLE_ICON[s.key] && <Icon icon={SETTLE_ICON[s.key]!} />}{s.label}
                </BlockedButton>
              )} />
        ))}
      </div>
      {access.canWork && (proposedFree
        ? <Disclosure summary="Find another counterpart" onToggle={u.onFind}>{u.finding && picker()}</Disclosure>
        : picker(true))}
    </PageZone>
  );
}

const PICKER_ROWS = 5;
/**
 * The other side's free items, nearest amount first (audit B7): tick the counterpart, or several for a group; Match
 * and Force match above act on them. Five rows, then Show more pages on. No saved views or column chooser: it is a
 * picker inside the work, not a list page (architecture.test.ts allowlist).
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
    { key: "reason", header: "Reason", mobile: "meta", cell: (r) => (r.status === "break" && r.reason ? <CategoryChip label={r.reason} slot={categoryChip("reason", r.reason)} /> : <span className="text-fg-3">{candidateState(r)}</span>) },
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
