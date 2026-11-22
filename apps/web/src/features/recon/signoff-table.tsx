"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { BlockedButton, CategoryChip, type Column, ColumnsMenu, ConfirmActionDialog, DataTable, Notice, Panel, RelativeTime, Toolbar } from "@starterkit/ui/ds";
import { formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon, SuccessIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { SignoffRowDto } from "@starterkit/shared/contracts/recon";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { categoryChip } from "@/lib/shared/categories";
import { reconSignoffs, type SignoffFilters } from "@/lib/shared/queries-recon";

const dayText = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));
const STAGE_LABEL: Record<SignoffRowDto["stage"], string> = { closed: "Waiting for sign-off", prepared: "Prepared", signed: "Signed off" };
/** Who did a step and when, or a dash. */
const Step = ({ by, at }: { by: SignoffRowDto["preparedBy"]; at: string | null }) =>
  at ? <span className="grid"><span className="text-fg">{by?.name ?? "A removed user"}</span><span className="text-caption text-fg-3"><RelativeTime at={Date.parse(at)} /></span></span> : <span className="text-fg-3">—</span>;

/**
 * A recon's closed days and their sign-off (Plan 5 Task 4, spec §11b), on its Overview: a reviewer or space admin
 * prepares a day, another one signs it off (not whoever prepared it or resolved its breaks; a Superadmin may), never
 * while a break request of that day waits. Signing off freezes the day's breaks, so it asks first.
 */
export function SignoffTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => reconSignoffs(spaceId, id), [spaceId, id]);
  const t = useTableQuery<SignoffRowDto, SignoffFilters>(def);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);

  async function step(date: string, what: "prepare" | "sign") {
    setBusy(date);
    try {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(id)}/signoffs/${what}`, { method: "POST", body: JSON.stringify({ date }) });
      toast(what === "prepare" ? `${dayText(date)} is prepared for sign-off.` : `${dayText(date)} is signed off.`);
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<SignoffRowDto>[] = [
    { key: "date", header: "Business date", sortable: true, mobile: "title", className: "whitespace-nowrap", cell: (r) => <span className="text-fg">{dayText(r.date)}</span> },
    { key: "stage", header: "Stage", mobile: "meta", cell: (r) => <CategoryChip slot={categoryChip("signoffStage", r.stage)} label={STAGE_LABEL[r.stage]} /> },
    { key: "open", header: "Open", align: "right", mobile: "meta", cell: (r) => <span className="tabular">{formatNumber(r.openBreaks)}</span> },
    { key: "pending", header: "Requests waiting", align: "right", mobile: "meta", cell: (r) => <span className={r.pending ? "tabular text-fg" : "tabular text-fg-3"}>{formatNumber(r.pending)}</span> },
    { key: "prepared", header: "Prepared by", mobile: "meta", cell: (r) => <Step by={r.preparedBy} at={r.preparedAt} /> },
    { key: "signed", header: "Signed by", mobile: "meta", cell: (r) => <Step by={r.signedBy} at={r.signedAt} /> },
    { key: "action", header: "Next step", mobile: "meta", hideable: false, className: "min-w-40", cell: (r) => r.stage === "signed"
      ? <span className="text-body-sm text-fg-3">Frozen</span>
      : (
        <BlockedButton type="button" size="sm" variant={r.stage === "prepared" ? "default" : "secondary"} reason={r.blocked} disabled={!!busy} aria-busy={busy === r.date || undefined}
          onClick={() => (r.stage === "prepared" ? setSigning(r.date) : void step(r.date, "prepare").catch((e) => toast.error(errorText(e))))}>
          {busy === r.date && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{r.stage === "prepared" ? "Sign off" : "Prepare"}
        </BlockedButton>
      ) },
  ];

  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the sign-off; showing the days loaded before. {errorText(t.staleError)}</Notice>}
      <Panel flush icon={SuccessIcon} title="Sign-off" count={t.count} description="Closed days, newest first · a reviewer or space admin prepares, another signs off"
        toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}>
        <DataTable label="Sign-off" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.date} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load the sign-off", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon: SuccessIcon, title: "No closed days yet", description: "A business date appears here once the recon closes it." }} />
      </Panel>
      {signing && (
        <ConfirmActionDialog open onOpenChange={(o) => { if (!o) setSigning(null); }} auditFields={false} reasons={[]}
          title={`Sign off ${dayText(signing)}`} description="Signing off closes the day's books for this recon."
          impact={["Its unmatch items no longer change: matching, closing and requests on them are refused.", "It can't be reopened in this release."]}
          actionLabel="Sign off day"
          onConfirm={async () => { await step(signing, "sign"); setSigning(null); }} />
      )}
    </>
  );
}
