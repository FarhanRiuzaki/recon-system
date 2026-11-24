"use client";

import { Panel, ReviewList, StatusChip } from "@starterkit/ui/ds";
import { computeSteps, stepText } from "@starterkit/shared/compute";
import type { ValueRef } from "@starterkit/shared/contracts/sources";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import type { SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { KIND_LABEL, scheduleText, type WatermarkKind } from "../source-text";
import { inputRows, keepText, UNIT_LABEL } from "../spec-draft";
import type { Draft } from "./model";
import { statusTone } from "@/lib/shared/categories";

/** The recon fields the summary lists after the business date, in step 2's order. */
const MAPPED = [["amount_minor", "Amount"], ["currency", "Currency"], ["direction", "Direction"], ["event_time", "Event time"], ["ext_ref", "Reference"], ["account_ref", "Account"]] as const;
/** Where a recon field's value comes from: a column or computed column by name, or an expression. */
const refText = (r: ValueRef) => ("field" in r ? r.field : `Expression ${r.cel}`);

type Check = { check: string; ready: boolean; details: string };

/**
 * What step 3 says before submitting (Figma 26:6915): each check Ready or Check. A Check never blocks: the checker
 * sees it too (Build notes 02 "Decisions I took"); what would block (no business date, a type the API refuses) stops
 * the wizard on step 2 already.
 */
export function readiness(s: SourceSpec, preview: SourcePreviewDto | null, publishedTable: string | null = null): Check[] {
  const i = s.input;
  const arrive = i.kind === "file_inbox"
    ? { check: "Files arrive", details: `${i.path} · ${i.pattern} · complete ${i.completion.kind === "stable_seconds" ? `after ${i.completion.seconds} s with no size change` : "when its .done file arrives"}` }
    : i.kind === "db_snapshot" ? { check: "Snapshots are pulled", details: `${scheduleText(i.schedule)} · the query takes the business date` }
      : { check: "Rows are pulled", details: `${i.table ? i.table : "a SELECT"} · after ${i.watermark.column}, then ${i.watermark.id_columns.join(", ")}` };
  const bd = s.mapping.business_date;
  const quarantined = preview?.quarantine.map((q) => q.line) ?? [];
  // a new table is a new version (PO decision 3): the change is said here as on the version page
  const table = i.kind === "db_watermark" && i.table && publishedTable && publishedTable !== i.table ? [{ check: "Table", ready: true, details: `${publishedTable} → ${i.table}` }] : [];
  return [
    { ...arrive, ready: true },
    ...table,
    { check: "Core fields", ready: true, details: `Business date from ${"field" in bd ? bd.field : bd.cel === "file_date" ? "the file name" : bd.cel === "arrived_date" ? "the day it arrives" : `expression ${bd.cel}`} · ${s.mapping.amount_minor ? `amount from ${"field" in s.mapping.amount_minor ? s.mapping.amount_minor.field : "an expression"}${s.mapping.amount_minor.unit ? ` in ${UNIT_LABEL[s.mapping.amount_minor.unit].toLowerCase()}` : ""}` : "no amount"}` },
    // a match key matters only for rows that can change (the newest per key counts); a source whose rows never change has none
    ...(!s.mutable ? [] : [s.key_fields.length
      ? { check: "Match key", ready: true, details: `${s.key_fields.join(" + ")}, never empty` }
      : { check: "Match key", ready: false, details: "Rows can change, but no match key says which row a newer one replaces." }]),
    !preview
      ? { check: "Preview", ready: false, details: "Not previewed with this version's columns." }
      : preview.quarantined === 0
        ? { check: "Preview", ready: true, details: `All ${preview.lines} sample rows become records.` }
        : { check: "Preview", ready: false, details: `${preview.ok} of ${preview.lines} sample rows become records; ${quarantined.length === 1 ? `row ${quarantined[0]} would be` : `rows ${quarantined.slice(0, 5).join(", ")}${quarantined.length > 5 ? " …" : ""} would be`} quarantined.` },
  ];
}

/** A watermark's own columns are picked in step 2; every other reading setting on step 1. */
const STEP_OF_INPUT: Record<string, number> = { watermark: 1, id_columns: 1 };

/**
 * The summary rows (owner rule, maker-checker: every setting the checker approves is listed before submitting): how the
 * source is read in the words of the Configuration tab and the version diff (inputRows), then columns, recon fields,
 * rows to load and computed columns. Change opens the step that sets the answer; the connection step is a source
 * admin's only, so for anyone else its rows have no Change.
 */
export function summaryRows(d: Draft, canConnect: boolean, wmKind: WatermarkKind | null): { label: string; value: string; step?: number }[] {
  const s = d.spec;
  const stored = Object.keys(s.mapping.attrs);
  const conn = canConnect ? { step: 0 } : {};
  return [
    { label: "Comes from", value: KIND_LABEL[d.kind], ...conn },
    ...inputRows(s.input, wmKind).map((r) => ({ label: r.label, value: r.value, ...(STEP_OF_INPUT[r.key] !== undefined ? { step: STEP_OF_INPUT[r.key] } : conn) })),
    { label: "Columns", value: `${s.fields.length} · ${stored.length} stored${s.key_fields.length ? ` · match key ${s.key_fields.join(" + ")}` : ""}`, step: 1 },
    { label: "Business date", value: "field" in s.mapping.business_date ? s.mapping.business_date.field : s.mapping.business_date.cel === "arrived_date" ? "The day it arrives" : "From the file name", step: 1 },
    // every other recon field and computed column as set in step 2 (what was given, shown once more before submit)
    ...MAPPED.flatMap(([k, label]) => {
      const r = s.mapping[k];
      if (k === "currency" && !r && s.currency) return [{ label, value: `${s.currency} for every row`, step: 1 }];
      return r ? [{ label, value: refText(r), step: 1 }] : [];
    }),
    { label: "Rows to load", value: keepText(s), step: 1 },
    ...Object.entries(s.derive).map(([name, expr]) => {
      const b = computeSteps(expr);
      return { label: `Computed: ${name}`, value: b ? `${b.source}${b.steps.length ? ` → ${b.steps.map(stepText).join(" → ")}` : ""}` : `Expression ${expr}`, step: 1 };
    }),
  ];
}

export function ReviewStep({ d, version, spaceName, preview, onEdit, canConnect, wmKind, publishedTable = null }: {
  d: Draft; version: number; spaceName: string; preview: SourcePreviewDto | null; onEdit: (step: number) => void; canConnect: boolean;
  /** The watermark's kind (its look back's default). */
  wmKind: WatermarkKind | null;
  /** The published version's table, to say a change of it. */
  publishedTable?: string | null;
}) {
  const s = d.spec;
  return (
    <div className="grid gap-section">
      <Panel flush title="Ready to submit?" footnote="Checks marked Check don't block submitting. The checker sees them.">
        <div className="min-w-0">
          <Table aria-label="Ready to submit">
            <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Result</TableHead><TableHead>Details</TableHead></TableRow></TableHeader>
            <TableBody>
              {readiness(s, preview, publishedTable).map((c) => (
                <TableRow key={c.check}>
                  <TableCell className="text-fg">{c.check}</TableCell>
                  <TableCell><StatusChip health={statusTone(c.ready ? "ready" : "check")} label={c.ready ? "Ready" : "Check"} /></TableCell>
                  <TableCell className="min-w-72 whitespace-normal text-fg-2">{c.details}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
      <Panel title="Summary" description={`${d.name}${d.code.trim().toLowerCase() === d.name.trim().toLowerCase() ? "" : ` · ${d.code}`} · version ${version}`}
        footnote={`Any config checker in ${spaceName} who didn't work on this version approves it. Nothing is ingested until version ${version} is approved.`}>
        <ReviewList onChange={onEdit} rows={summaryRows(d, canConnect, wmKind)} />
      </Panel>
    </div>
  );
}
