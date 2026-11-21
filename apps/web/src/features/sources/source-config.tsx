"use client";

import Link from "next/link";
import { useState } from "react";
import { CategoryChip, EmptyState, InfoTip, Pagination, Panel } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { BranchIcon, ComponentsIcon, DiskIcon, NetworkIcon, ShareIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { computeSteps, stepText } from "@starterkit/shared/compute";
import type { SourceDto, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import { readWhenText } from "@starterkit/shared/sources";
import { scheduleText } from "./source-text";
import { ARRIVED_DATE, FILE_DATE, fieldText, storedName, UNIT_LABEL } from "./spec-draft";
import { conditionText } from "./steps/conditions";
import { newVersionHref } from "./use-sources";

/** The recon fields as step 2 names them. */
const RECON_FIELD: Record<string, string> = {
  business_date: "Business date", amount_minor: "Amount", currency: "Currency", direction: "Direction",
  event_time: "Event time", ext_ref: "Reference", account_ref: "Account",
};
const PAGE = 25;

/** Where a recon field's value comes from, in words (a JSON value as column › path). */
function refText(r: ValueRef): string {
  if ("field" in r) return r.field;
  if (r.cel === FILE_DATE.cel) return "the file name's date";
  if (r.cel === ARRIVED_DATE.cel) return "the day the rows arrive";
  const b = computeSteps(r.cel);
  return b?.steps.length === 1 && b.steps[0]!.type === "json" ? `${b.source} › ${b.steps[0]!.args[0]}` : `expression ${r.cel}`;
}

/** The recon fields each column (or computed column) fills, by its name. */
function usesOf(s: SourceSpec): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const { attrs: _attrs, ...core } = s.mapping;
  for (const [k, r] of Object.entries(core)) {
    if (!r || typeof r !== "object") continue;
    const ref = r as ValueRef;
    const col = "field" in ref ? ref.field : computeSteps(ref.cel)?.source;
    if (col) out.set(col, [...(out.get(col) ?? []), RECON_FIELD[k] ?? k]);
  }
  return out;
}

/** Label / value rows of a card. */
function Rows({ items }: { items: [string, string | null | undefined][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 md:grid-cols-[12rem_minmax(0,1fr)]">
      {items.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-label text-fg">{k}</dt>
          <dd className="min-w-0 text-body-sm wrap-anywhere text-fg-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The Configuration tab (owner, 21 Nov: what the source reads and how, without opening a version): the published
 * version's reading, columns with the recon fields they fill, computed columns, rows to load and the recons that read
 * the source. A draft or a version in review is named, with a link to it.
 */
export function SourceConfig({ s, spaceId }: { s: SourceDto; spaceId: string }) {
  const spec = s.published?.spec ?? null;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  if (!spec) {
    return <Panel><EmptyState icon={ComponentsIcon} title="No approved version yet" description="The configuration shows here once a config checker approves the source's first version." /></Panel>;
  }
  const i = spec.input;
  const uses = usesOf(spec);
  const fields = spec.fields.filter((f) => !query.trim() || f.name.toLowerCase().includes(query.trim().toLowerCase()));
  const last = Math.max(1, Math.ceil(fields.length / PAGE));
  const shown = fields.slice((Math.min(page, last) - 1) * PAGE, Math.min(page, last) * PAGE);
  const amount = spec.mapping.amount_minor;
  return (
    <div className="grid gap-section">
      {s.draft && (
        <p className="text-body-sm text-fg-2">
          Version {s.draft.version} {s.draft.status === "in_review" ? "is waiting for approval" : "is a draft"} with other settings; this is version {s.publishedVersion}, the one ingest runs.{" "}
          <Link className="text-primary underline-offset-4 hover:underline" href={newVersionHref(spaceId, s.id, 2)}>Open version {s.draft.version}</Link>
        </p>
      )}
      <Panel icon={NetworkIcon} title="How it is read" description={`Version ${s.publishedVersion}`}>
        <Rows items={i.kind === "file_inbox" ? [
          ["Folder", i.path], ["File name pattern", i.pattern],
          ["Format", `${i.format.delimiter === "\t" ? "Tab" : `"${i.format.delimiter}"`} separated, ${i.format.header ? "first row is a header" : "no header row"}, ${i.format.encoding}`],
          ["Checked", readWhenText(i.when)],
          ["A file is complete", i.completion.kind === "marker_file" ? "once its marker file is there" : `once it hasn't changed for ${i.completion.seconds} s`],
        ] : i.kind === "db_snapshot" ? [
          ["Query", i.query], ["Schedule", scheduleText(i.schedule)],
        ] : [
          [i.table !== undefined ? "Table" : "Query", i.table ?? i.query], ["Watermark column", i.watermark.column], ["Id column", i.watermark.id_column],
          ["Pulled", readWhenText(i.when)],
          ["Looks back", i.lookback_seconds ? `${formatNumber(i.lookback_seconds)} s` : "No"], ["Rows per page", formatNumber(i.chunk)],
        ]} />
      </Panel>

      <Panel flush icon={DiskIcon} title="Columns" description={`${formatNumber(spec.fields.length)} columns · what each is read as and what the recons use it as`}>
        {spec.fields.length > PAGE && (
          <div className="px-4 pt-3">
            <Input type="search" aria-label="Find a column" placeholder="Find a column" className="w-full md:max-w-72" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }} autoComplete="off" spellCheck={false} />
          </div>
        )}
        <Table aria-label="Columns of the published version">
          <TableHeader><TableRow>
            <TableHead>Column</TableHead><TableHead>Read as</TableHead><TableHead>Stored as</TableHead><TableHead>Use as</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {shown.map((f) => (
              <TableRow key={f.name}>
                <TableCell className="font-mono text-mono text-fg">{f.name}</TableCell>
                <TableCell className="text-fg-2">{fieldText(f)}</TableCell>
                <TableCell className="font-mono text-mono text-fg-2">{storedName(spec, f.name) ?? <span className="font-sans text-fg-3">Not stored</span>}</TableCell>
                <TableCell className="text-fg">{uses.get(f.name)?.join(", ") ?? <span className="text-fg-3">—</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {fields.length > PAGE && <Pagination label="Columns" page={Math.min(page, last)} pageSize={PAGE} total={fields.length} onPageChange={setPage} />}
      </Panel>

      <Panel icon={ComponentsIcon} title="Recon fields and rules">
        <Rows items={[
          ...Object.entries(RECON_FIELD).map(([k, label]): [string, string | null] => {
            const r = spec.mapping[k as keyof typeof spec.mapping] as ValueRef | undefined;
            if (k === "currency" && !r) return [label, spec.currency ? `${spec.currency} for every row` : "Not used: amounts read as written"];
            return [label, r ? `${refText(r)}${k === "amount_minor" && amount?.unit ? ` · ${UNIT_LABEL[amount.unit].toLowerCase()}` : ""}` : "Not used"];
          }),
          ...Object.entries(spec.derive).map(([name, expr]): [string, string] => {
            const b = computeSteps(expr);
            return [`Computed: ${name}`, b ? `${b.source}${b.steps.length ? ` → ${b.steps.map(stepText).join(" → ")}` : ""}` : `expression ${expr}`];
          }),
          ["Rows to load", spec.keep?.length ? spec.keep.map((c) => conditionText(c, spec)).join("; ") : "Every row"],
          ["When a row changes", spec.mutable ? `The newest row per ${spec.key_fields.join(" + ")} replaces the earlier one` : "Rows never change once they arrive"],
        ]} />
      </Panel>

      <Panel icon={ShareIcon} title="Shared with" count={s.shares.length} description="Spaces that read this source and its published versions; they change nothing">
        {s.shares.length
          ? <ul className="flex flex-wrap gap-2">{s.shares.map((x) => <li key={x.spaceId}><CategoryChip slot="neutral" label={x.name} /></li>)}</ul>
          : <p className="text-body-sm text-fg-3">Only this space reads it.</p>}
      </Panel>

      <Panel flush icon={BranchIcon} title="Used by recons" count={s.usedBy.length}
        description="Recons that read this source; a column they read can't be dropped or retyped until they change">
        {s.usedBy.length ? (
          <Table aria-label="Recons that read this source">
            <TableHeader><TableRow>
              <TableHead>Recon</TableHead>
              <TableHead>Fields it reads<InfoTip label="Fields it reads">The recon fields and stored columns its passes and filters read from this source.</InfoTip></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {s.usedBy.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.spaceId === spaceId
                    ? <Link className="text-fg underline-offset-4 hover:underline" href={`/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(r.id)}`}>{r.name}</Link>
                    : <span className="text-fg">{r.name} <span className="text-fg-3">· another space</span></span>}</TableCell>
                  <TableCell className="font-mono text-mono text-fg-2">{r.fields.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className="px-4 py-6 text-body-sm text-fg-3">No published recon reads this source yet. Recons list here once one that reads it is approved.</p>}
      </Panel>
    </div>
  );
}
