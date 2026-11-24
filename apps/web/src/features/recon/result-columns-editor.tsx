"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, ArrowDownIcon, ArrowUpIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { toast } from "@starterkit/ui/ui/toast";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { ResultColumn, ResultColumnsDto } from "@starterkit/shared/contracts/results";
import { recordFields } from "@starterkit/shared/recon";
import { RESULT_COLUMNS_MAX, RESULT_LABEL_MAX } from "@starterkit/shared/results";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { api, errorText } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { resultColumns } from "@/lib/shared/queries-recon";
import { addColumn, columnChoices, type ColumnSide, columnValue, fieldText, moveColumn } from "./result-columns-model";
import { useSideSource } from "./use-recons";

/**
 * The columns' editor in place (loaded on Edit): each column's heading, order and removal, a field to add (each side's
 * fields under its name, then recon info), Save, Cancel and Back to default. A save applies at once (no approval).
 */
export default function ResultColumnsEditor({ spaceId, configId, spec, value, onDone }: {
  spaceId: string; configId: string; spec: ReconSpec; value: ResultColumnsDto; onDone: () => void;
}) {
  const qc = useQueryClient();
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const pa = sa.data?.published?.spec, pb = sb.data?.published?.spec;
  const sides = useMemo((): [ColumnSide, ColumnSide] => [
    { label: spec.sides[0].label, fields: pa ? recordFields(pa) : null }, { label: spec.sides[1].label, fields: pb ? recordFields(pb) : null },
  ], [spec.sides, pa, pb]);
  const choices = useMemo(() => columnChoices(sides), [sides]);
  const groups = [...new Set(choices.map((c) => c.group))];
  const [cols, setCols] = useState<ResultColumn[]>(value.columns);
  const [pick, setPick] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "default" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(cols) !== JSON.stringify(value.columns);
  const guard = useLeaveGuard(dirty && !busy);
  const missing = new Set(value.missing.map(columnValue));
  const blank = cols.some((c) => !c.label.trim());
  const sideOf = (c: ResultColumn) => (c.kind === "recon" ? "Recon" : `${sides[c.kind === "a" ? 0 : 1].label} · ${fieldText(c.field)}`);

  async function save(columns: ResultColumn[], how: "save" | "default") {
    setBusy(how);
    setError(null);
    try {
      const cq = resultColumns(spaceId, configId);
      const saved = await api<ResultColumnsDto>(cq.url, { method: "PUT", body: JSON.stringify({ columns: columns.map((c) => ({ ...c, label: c.label.trim() })) }) });
      qc.setQueryData(cq.key, saved);
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
      toast(how === "default" ? "Back to the default columns." : "Saved the Operation result columns.");
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  function add() {
    const r = addColumn(cols, pick, sides);
    if ("error" in r) { setAddError(r.error); return; }
    setCols(r.columns);
    setPick("");
    setAddError(null);
  }
  const setLabel = (i: number, label: string) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, label } : c)));

  return (
    <div className="grid gap-4">
      <ol aria-label="Columns in order" className="grid gap-2">
        {cols.map((c, i) => {
          const id = `result-col-${i}`;
          return (
            <li key={columnValue(c)} className="grid items-end gap-2 rounded-md border border-line bg-card p-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <Field id={id} label={`Column ${i + 1} heading`} required note={missing.has(columnValue(c)) ? `${sideOf(c)}: field not in the source` : sideOf(c)}
                error={c.label.trim() ? null : "Give the column a heading."}>
                <Input id={id} value={c.label} maxLength={RESULT_LABEL_MAX} onChange={(e) => setLabel(i, e.target.value)} />
              </Field>
              <span className="flex items-center gap-1">
                <Button type="button" size="icon" variant="ghost" aria-label={`Move ${c.label || `column ${i + 1}`} up`} disabled={i === 0} onClick={() => setCols(moveColumn(cols, i, -1))}><Icon icon={ArrowUpIcon} /></Button>
                <Button type="button" size="icon" variant="ghost" aria-label={`Move ${c.label || `column ${i + 1}`} down`} disabled={i === cols.length - 1} onClick={() => setCols(moveColumn(cols, i, 1))}><Icon icon={ArrowDownIcon} /></Button>
                <Button type="button" size="icon" variant="remove" aria-label={`Remove ${c.label || `column ${i + 1}`}`} onClick={() => setCols(cols.filter((_, j) => j !== i))}><Icon icon={RemoveIcon} /></Button>
              </span>
            </li>
          );
        })}
        {!cols.length && <li className="text-body-sm text-fg-2">No columns: saving shows the default columns.</li>}
      </ol>

      <div className="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <Field id="result-col-add" label="Field to add" optional note={`${cols.length} of ${RESULT_COLUMNS_MAX} columns`} error={addError}>
          <Select id="result-col-add" className="w-full" value={pick} onChange={(e) => { setPick(e.target.value); setAddError(null); }}>
            <option value="">{sa.isPending || sb.isPending ? "Loading the sources' fields…" : "Pick a field"}</option>
            {groups.map((g) => (
              <optgroup key={g} label={g}>{choices.filter((c) => c.group === g).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</optgroup>
            ))}
          </Select>
        </Field>
        <Button type="button" variant="create" disabled={!pick} onClick={add}><Icon icon={AddIcon} />Add column</Button>
      </div>

      {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!value.isDefault && <Button type="button" variant="secondary" className="mr-auto" disabled={!!busy} aria-busy={busy === "default" || undefined}
          onClick={() => void save([], "default")}>{busy === "default" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Back to default</Button>}
        <Button type="button" variant="ghost" disabled={!!busy} onClick={onDone}>Cancel</Button>
        <Button type="button" disabled={!!busy || blank || !dirty} aria-busy={busy === "save" || undefined} onClick={() => void save(cols, "save")}>
          {busy === "save" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Save columns
        </Button>
      </div>
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without saving" description="Your column changes aren't saved."
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }}
          impact={["The column changes are discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </div>
  );
}
