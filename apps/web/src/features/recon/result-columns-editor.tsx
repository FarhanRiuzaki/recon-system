"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Checkbox, Combobox, Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { ResultColumn, ResultColumnsDto } from "@starterkit/shared/contracts/results";
import { recordFields } from "@starterkit/shared/recon";
import { RESULT_COLUMNS_MAX, RESULT_LABEL_MAX } from "@starterkit/shared/results";
import type { ColumnFormat } from "@starterkit/shared/contracts/reports";
import { ColumnFormatFields, NUMBER_FORMAT } from "@/components/column-format-fields";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { SortableList } from "@/components/sortable-list";
import { api, errorText } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { resultColumns } from "@/lib/shared/queries-recon";
import { addColumn, columnChoices, type ColumnSide, columnValue, fieldText } from "./result-columns-model";
import { useSideSource } from "./use-recons";

/** A number format a column starts from: an amount with 2 decimals, anything else whole. */
const numberFor = (c: ResultColumn): Extract<ColumnFormat, { kind: "number" }> =>
  (c.kind !== "recon" && /amount/.test(c.field) ? { ...NUMBER_FORMAT, decimals: 2 } : NUMBER_FORMAT);

/**
 * The columns' editor in place (loaded on Edit): each column's heading, its format (as is, a number, a date, text: the
 * report designer's, owner 26 Nov), its order (drag, or the grip's keyboard) and removal, a field to add (each side's
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
  // each choice says which side (or the recon) it comes from, and the search matches that too
  const choiceOptions = useMemo(() => choices.map((c) => ({ value: c.value, label: c.label, description: c.group })), [choices]);
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
  // as is = no format kept: the screen's own reading (an amount in its currency, a date in words)
  const setFormat = (i: number, f: ColumnFormat) => setCols((cs) => cs.map((c, j) => {
    if (j !== i) return c;
    const { format: _, ...rest } = c;
    return f.kind === "auto" ? rest as ResultColumn : { ...c, format: f };
  }));

  return (
    <div className="grid gap-4">
      <SortableList items={cols} getKey={columnValue} noun="Column" label="Columns in order" className="gap-2" onReorder={(next) => setCols(next)}
        itemClassName="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2 rounded-md border border-line bg-card p-3"
        renderItem={(c, { index: i, handle }) => {
          const id = `result-col-${i}`;
          return (
            <>
              <span className="flex h-8 items-center">{handle}</span>
              <Field id={id} label={`Column ${i + 1} heading`} required note={missing.has(columnValue(c)) ? `${sideOf(c)}: field not in the source` : sideOf(c)}
                error={c.label.trim() ? null : "Give the column a heading."}>
                <Input id={id} value={c.label} maxLength={RESULT_LABEL_MAX} onChange={(e) => setLabel(i, e.target.value)} />
              </Field>
              {/* customer data (an account, a name) is masked in report files unless an official report shows it (DEC-060) */}
              {c.kind !== "recon" && <span className="flex h-8 items-center"><Checkbox checked={!!c.customer} label="Customer data" onToggle={() => setCols((cs) => cs.map((x, j) => (j === i && x.kind !== "recon" ? { ...x, customer: !x.customer } : x)))} /></span>}
              <Button type="button" size="icon" variant="remove" aria-label={`Remove ${c.label || `column ${i + 1}`}`} onClick={() => setCols(cols.filter((_, j) => j !== i))}><Icon icon={RemoveIcon} /></Button>
              <div className="col-span-full md:pl-8">
                <ColumnFormatFields id={`${id}-fmt`} value={c.format ?? { kind: "auto" }} number={numberFor(c)} onChange={(f) => setFormat(i, f)} />
              </div>
            </>
          );
        }} />
      {!cols.length && <p className="text-body-sm text-fg-2">No columns: saving shows the default columns.</p>}

      {/* the button sits on the field's line (owner 24 Nov: the note under the field pushed it below); the count under both */}
      <div className="grid gap-2">
      <div className="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <Field id="result-col-add" label="Field to add" optional error={addError}>
          {/* searchable and scrollable, like the app's other column pickers (owner 24 Nov: the native select didn't scroll) */}
          <Combobox id="result-col-add" className="w-full min-w-0" label="Field to add" placeholder={sa.isPending || sb.isPending ? "Loading the sources' fields…" : "Pick a field"}
            options={choiceOptions} value={choiceOptions.find((o) => o.value === pick) ?? null}
            onChange={(o) => { setPick(o?.value ?? ""); setAddError(null); }} />
        </Field>
        <Button type="button" variant="create" className={addError ? "md:mb-6" : undefined} disabled={!pick} onClick={add}><Icon icon={AddIcon} />Add column</Button>
      </div>
      <p className="text-caption text-fg-3">{cols.length} of {RESULT_COLUMNS_MAX} columns</p>
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
