"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { BlockedButton, type Column, ColumnsMenu, DataTable, Failure, Field, FilterSearch, Notice, Panel, RequiredNote, Toolbar } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDate } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AlertsIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { CLOSE_RESOLUTIONS, RESOLUTION_NOTE_MAX } from "@starterkit/shared/recon";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { DetailNotFound } from "@/components/detail-not-found";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { ValueRows } from "@/components/version-layout";
import { useAuth } from "@/lib/client/auth-context";
import { api, errorText, isNotFound, retryUnlessNotFound } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { amountText } from "@/lib/shared/amount";
import { breakCandidates, breakDetail, ENGINE_KEY, spaceDetail } from "@/lib/shared/queries";
import { BreakActivity } from "./break-activity";
import { STATE_LABEL } from "./break-columns";
import { BREAK_SHAPE } from "./shapes";

const RESOLUTION_LABEL: Record<string, string> = {
  MATCHED_MANUAL: "Matched by a person", FORCE_MATCHED: "Force matched", WRITTEN_OFF: "Written off", ADJUSTED: "Adjusted",
  AUTO_MATCHED_LATE_DATA: "Matched by a later run", DUPLICATE: "Duplicate", NO_ACTION: "No action needed",
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
  const b = q.data;
  const list = { href: `/spaces/${encodeURIComponent(spaceId)}/breaks`, label: "Breaks" };

  if (isNotFound(q.error)) return <DetailNotFound title="Break" noun="break" list={list} />;
  if (q.error && !b) return <div className="grid gap-section"><PageHeader title="Break" /><Panel><Failure title="Couldn't load this break" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!b || skeleton) return <LoadingShape sections={BREAK_SHAPE} shown={skeleton} />;

  const open = b.state !== "resolved";
  const lead = isSuperadmin(user.roles) || roles.some((r) => r === "space_admin" || r === "reviewer");
  const worker = lead || roles.includes("operator");
  const mine = b.assignee?.id === user.id;
  const canWork = open && (lead || mine);

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
  async function take() {
    setBusy("take");
    try {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/take`, { method: "POST", body: JSON.stringify({ ids: [id] }) });
      toast("You have this break now.");
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
    } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  }

  return (
    <div className="grid gap-section">
      <PageHeader title={b.item.ref ?? "Break"} crumb={b.item.ref ?? "Break"}
        description={`${b.recon.name} · ${b.recon.sides[b.item.side === "a" ? 0 : 1]} · ${STATE_LABEL[b.state]}${b.assignee ? ` · ${b.assignee.id === user.id ? "yours" : b.assignee.name ?? "a removed user"}` : " · Unassigned"}`}
        actions={open && worker && !b.assignee ? (
          <Button type="button" onClick={() => void take()} disabled={!!busy} aria-busy={busy === "take" || undefined}>
            {busy === "take" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Take break
          </Button>
        ) : undefined} />
      {open && worker && !canWork && b.assignee && <Notice>{b.assignee.name ?? "Someone"} has this break. A reviewer or space admin can reassign it from Breaks.</Notice>}
      {open && worker && !b.assignee && <Notice>Take this break to resolve it.</Notice>}

      <Panel icon={AlertsIcon} title="The break">
        <ValueRows items={[
          ["Recon", b.recon.name],
          ["Side", `${b.recon.sides[b.item.side === "a" ? 0 : 1]}${b.item.source ? ` · ${b.item.source}` : ""}`],
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

      {canWork && <Counterparts spaceId={spaceId} id={id} b={b} busy={busy} onMatch={(ids) => act("match", "/match", { itemIds: ids }, "Matched.")} />}
      {canWork && <CloseForm busy={busy} onClose={(resolution, note) => act("close", "/close", { resolution, note }, "Break closed.")} />}
      <BreakActivity spaceId={spaceId} id={id} />
    </div>
  );
}

/** The other side's free items, nearest amount first; tick the counterpart (or several, for a group) and match. */
function Counterparts({ spaceId, id, b, busy, onMatch }: { spaceId: string; id: string; b: BreakDetailDto; busy: string | null; onMatch: (ids: string[]) => Promise<void> }) {
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
function CloseForm({ busy, onClose }: { busy: string | null; onClose: (resolution: string, note: string) => Promise<void> }) {
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
        <span>
          <Button type="submit" variant="secondary" disabled={!!busy} aria-busy={busy === "close" || undefined}>
            {busy === "close" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Close break
          </Button>
        </span>
      </form>
    </Panel>
  );
}
