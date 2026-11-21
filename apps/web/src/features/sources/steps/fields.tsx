"use client";

import { type ChangeEvent, Fragment, useRef } from "react";
import { Checkbox, Combobox, type ComboOption, Field, focusNew, InfoTip, Notice, Panel, Segmented, Switch, useFirstUse } from "@starterkit/ui/ds";
import { formatMinor, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CheckIcon, CloseIcon, SpinnerIcon, SuggestedIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { FieldSpec, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import { AMOUNT_UNITS, type AmountUnit, CURRENCY_EXPONENT, type DbEngine, FIELD_TYPES } from "@starterkit/shared/sources";
import { ARRIVED_DATE, attrNameOf, FILE_DATE, fieldTypeOf, storeAs, storedName, storedNameProblem, TYPE_LABEL, UNIT_LABEL } from "../spec-draft";
import { type SuggestedCore, UNIT_HINT, unitExamples, withUnit } from "./core-suggest";
import { goneRowNote, idNote, type Suggestion, watermarkNote } from "./catalog";
import { type Column, ctl, type Draft, mappingProblem, NULLABLE_REASON, type Preview } from "./model";
import { ComputedColumns } from "./computed";
import { computeCel, computeSteps, jsonPaths } from "@starterkit/shared/compute";

/** Every currency the amount unit knows, for the searchable "Currency for every row" field. */
const CURRENCIES: ComboOption[] = Object.keys(CURRENCY_EXPONENT).map((c) => ({ value: c, label: c }));

type Core = Exclude<keyof SourceSpec["mapping"], "attrs">;
/**
 * The core fields with what each means, behind an ⓘ (owner, 21 Nov: watermark, id column and the like are not
 * self-explaining). Plain words and one example; the note under a field stays for what to pick.
 */
const CORE: { key: Core; group: "date" | "money" | "match"; label: string; note?: string; help: string }[] = [
  { key: "business_date", group: "date", label: "Business date", help: "The day a row belongs to. Recons match, close and sign off per business date, so rows of 20 Nov are compared with the other side's 20 Nov. Usually a value or booking date column, or the date in the file name." },
  { key: "amount_minor", group: "money", label: "Amount", help: "The money value both sides compare. Leave it out when a recon only matches by keys, such as an account list." },
  { key: "currency", group: "money", label: "Currency", note: "ISO code or number, such as IDR or 360.", help: "The currency of each row's amount. A source in one currency leaves this as Not used and picks the currency for every row below." },
  { key: "direction", group: "money", label: "Direction", help: "Whether a row is a debit or a credit (D/C, DR/CR, DEBIT/CREDIT). A debit counts as negative, so both sides compare amounts with the same sign." },
  { key: "event_time", group: "match", label: "Event time", help: "When the transaction happened, with its time. Matching rules can allow a time window with it, such as within 10 minutes." },
  { key: "ext_ref", group: "match", label: "Reference", help: "The id both sides share for the same transaction, such as an end-to-end or transfer reference. The strongest thing to match on." },
  { key: "account_ref", group: "match", label: "Account", help: "The account the row is posted to. Matching on it as well keeps two equal amounts on different accounts apart." },
];
/** The types a core field reads well from; another type gets a red cross with what to change (Combobox tone). */
const FITS: Partial<Record<Core, readonly FieldSpec["type"][]>> = {
  business_date: ["date", "datetime"], amount_minor: ["integer", "decimal"], event_time: ["datetime"],
};


export type FieldsStepProps = {
  d: Draft;
  set: (fn: (d: Draft) => Draft) => void;
  err: (id: string) => string | undefined;
  /** The database engine (its float hint), null for a file source. */
  engine: DbEngine | null;
  /** Native types of the columns read from the source database, by name. */
  native: Map<string, string>;
  /** A source admin may read the columns again (a maker works from the version's fields). */
  canRead: boolean;
  reading: boolean;
  onReadColumns: () => void;
  sample: string;
  fileName: string;
  sampleCut: boolean;
  onSample: (text: string, fileName?: string) => void;
  onFileName: (name: string) => void;
  onReadSample: () => void;
  businessDate: string;
  onBusinessDate: (d: string) => void;
  preview: Preview;
  /** A database source previews on demand (each preview pulls from the source database); a file source live. */
  onPreview: (() => void) | null;
  /** The source's columns as read (nullability for the watermark pickers); null when not read here. */
  columns: Column[] | null;
  /** A source admin changes how the source is read (watermark, header); anyone else sees it. */
  canChangeReading: boolean;
  /** The sample's first line looks like column names while "First row is a header" is off. */
  headerHint: boolean;
  onUseHeader: () => void;
  /** Stored names as typed, by field, while they aren't valid yet (the spec keeps the last valid one). */
  typedNames: Record<string, string>;
  /** A stored name as typed (undefined = none typed); `clear` = the controls whose earlier error the change ends. */
  onTypedName: (field: string, name: string | undefined, clear: string[]) => void;
  /** Fields whose column the table read last lacks (kept, marked), and those of them still used (they block Next). */
  gone: { gone: string[]; used: string[] };
  /** The watermark and id the table's columns suggested, null before a table is read. */
  suggested: Suggestion | null;
  /** Core fields filled from the column names; the note shows while the value is still it. */
  coreHint: Partial<Record<SuggestedCore, string>>;
};

/**
 * Step 2, Fields & mapping (Figma 23:6254, 25:6736, phone 29:7871): the columns as detected (a sample of the file, or
 * the source table), each typed by the user from that guess; the core record's values; derived values; and the
 * preview of what a sample becomes, updated as things change. Nothing here is saved until Next.
 */
export function FieldsStep(p: FieldsStepProps) {
  const { d, set, err } = p;
  const s = d.spec;
  const file = s.input.kind === "file_inbox";
  // every change re-reads the amount unit's suggestion (a column or its type changed); a unit the user chose stays
  const setSpec = (fn: (s: SourceSpec) => SourceSpec) => set((x) => withUnit({ ...x, spec: fn(x.spec) }));
  const setField = (i: number, patch: Partial<FieldSpec>) => setSpec((x) => ({ ...x, fields: x.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  /** A new type with the format it starts with: a date as yyyy-MM-dd, a decimal at 2 places. */
  const setType = (i: number, type: FieldSpec["type"]) => setField(i, { type, format: type === "decimal" ? { scale: 2 } : type === "date" ? { date: "yyyy-MM-dd" } : undefined });
  const setFormat = (i: number, patch: NonNullable<FieldSpec["format"]>) => setSpec((x) => ({
    ...x, fields: x.fields.map((f, j) => (j === i ? { ...f, format: Object.fromEntries(Object.entries({ ...f.format, ...patch }).filter(([, v]) => v !== undefined && v !== "")) } : f)),
  }));
  const setCore = (k: Core, r: ValueRef | undefined) => setSpec((x) => {
    const unit = k === "amount_minor" && r ? x.mapping.amount_minor?.unit : undefined;
    return { ...x, mapping: { ...x.mapping, [k]: k === "business_date" ? (r ?? { field: "" }) : unit ? { ...r, unit } : r } };
  });
  const setUnit = (unit: AmountUnit) => set((x) => {
    const a = x.spec.mapping.amount_minor;
    return a ? { ...x, unitHint: undefined, spec: { ...x.spec, mapping: { ...x.spec.mapping, amount_minor: { ...a, unit } } } } : x;
  });
  const examples = new Map((p.preview.result?.columns ?? []).map((c) => [c.name, c.examples]));

  // Add computed column shimmers until first used, and the card it adds takes the focus (design-system §7.9)
  const [computedNew, computedUsed] = useFirstUse("source.computed-column");
  const addComputed = () => {
    computedUsed();
    const taken = new Set([...s.fields.map((f) => f.name), ...Object.keys(s.derive)]);
    let n = 1;
    while (taken.has(`computed_${n}`)) n++;
    const name = `computed_${n}`;
    // it starts from the first text column (a remark, a reference), the usual source of a computed key
    const from = (s.fields.find((f) => f.type === "string") ?? s.fields[0]!).name;
    setSpec((x) => ({ ...x, derive: { ...x.derive, [name]: computeCel(from, []) } }));
    focusNew(`${ctl(`derive.${name}`)}-name`);
  };

  // what Read the columns reads: the table or the SELECT typed in step 1 (none yet: nothing to read, said instead of a 400)
  const hasSource = s.input.kind === "db_snapshot" ? !!s.input.query.trim()
    : s.input.kind === "db_watermark" ? (d.from === "table" ? !!(s.input.table ?? "").trim() : !!(s.input.query ?? "").trim()) : true;
  const byName = new Map(s.fields.map((f) => [f.name, f]));
  /** Where a recon field's value comes from, in words: a column, a JSON value (column › path), the file name, an expression. */
  const refLabel = (r: ValueRef) => {
    if ("field" in r) return r.field;
    if (r.cel === FILE_DATE.cel) return "the file name";
    if (r.cel === ARRIVED_DATE.cel) return s.input.kind === "db_snapshot" ? "the snapshot's date" : "the day it arrives";
    const b = computeSteps(r.cel);
    return b?.steps.length === 1 && b.steps[0]!.type === "json" ? `${b.source} › ${b.steps[0]!.args[0]}` : `expression ${r.cel}`;
  };
  const jsonRef = (col: string, path: string): ValueRef => ({ cel: computeCel(col, [{ type: "json", args: [path] }]) });
  /**
   * "Use as" of one column or computed column (owner, 21 Nov: the mapping joins Columns): the recon fields it fills,
   * picked beside its type and example. A recon field takes one value, so picking it here moves it from where it was
   * ("Now from …"); a JSON column offers each value inside it (Reference ← data.code.rc) instead of the whole text.
   */
  const fieldPicker = (col: string, idx: string) => {
    const t = byName.get(col)?.type ?? "string";
    const paths = jsonPaths(examples.get(col) ?? []);
    const mine = (k: Core): string | null => {
      const r = s.mapping[k];
      if (!r) return null;
      if ("field" in r) return r.field === col ? k : null;
      const cel = r.cel;
      const p = paths.find((x) => "cel" in jsonRef(col, x.path) && computeCel(col, [{ type: "json", args: [x.path] }]) === cel);
      if (p) return `${k}@${p.path}`;
      const b = computeSteps(cel);
      return b?.source === col && b.steps.length === 1 && b.steps[0]!.type === "json" ? `${k}@${b.steps[0]!.args[0]}` : null;
    };
    const opts: ComboOption[] = CORE.flatMap((c) => {
      const now = s.mapping[c.key];
      const from = now && ("field" in now ? now.field : true) ? refLabel(now) : null;
      const elsewhere = from && !mine(c.key) ? `Now from ${from}` : null;
      if (paths.length) return paths.map((x) => ({ value: `${c.key}@${x.path}`, label: `${c.label} ← ${x.path}`, description: [`e.g. ${x.example}`, elsewhere].filter(Boolean).join(" · ") }));
      const fits = FITS[c.key];
      const bad = !!fits && !fits.includes(t);
      // only text can hold a date or a number to retype; another type just isn't one
      const why = !bad ? null : t === "string" ? `if it holds ${fits[0] === "integer" ? "numbers" : "dates"}, set its type` : `not ${fits[0] === "integer" ? "a number" : "a date"}`;
      return [{ value: c.key, label: c.label, tone: fits ? (bad ? "bad" : "ok") : undefined, description: [why, elsewhere].filter(Boolean).join(" · ") || undefined } as ComboOption];
    });
    const value = CORE.map((c) => mine(c.key)).filter((v): v is string => !!v).map((v) => opts.find((o) => o.value === v) ?? { value: v, label: v });
    return (
      <Combobox multiple id={`src-useas-${idx}`} label={`${col} is used as`} className="w-full min-w-72" options={opts} value={value} placeholder="Not used"
        emptyText="No recon field has that name." onChange={(next) => {
          const want = new Map(next.map((o) => { const [k, path] = o.value.split("@") as [Core, string | undefined]; return [k, path] as const; }));
          for (const c of CORE) {
            const had = mine(c.key), path = want.get(c.key);
            const now = want.has(c.key) ? (path === undefined ? c.key : `${c.key}@${path}`) : null;
            if (now === had) continue;
            setCore(c.key, now === null ? undefined : path === undefined ? { field: col } : jsonRef(col, path));
          }
        }} />
    );
  };
  return (
    <div className="grid gap-section">
      {file ? (
        <Panel title="Sample of the file" description="Read in the browser and sent only to preview; nothing is stored" bodyClassName="grid gap-4">
          <SampleInput {...p} />
          {p.headerHint && (
            <Notice live>
              The first line looks like column names, but &quot;First row is a header&quot; is off, so it is read as data and every column comes out as text.{" "}
              {p.canChangeReading
                ? <Button type="button" variant="link" size="sm" onClick={p.onUseHeader}>Use the first line as the header</Button>
                : "A source admin turns it on in step 1."}
            </Notice>
          )}
        </Panel>
      ) : null}

      {/* a database's examples come from Preview rows (each pulls from the bank's database: on demand only), offered
          here where the examples are read, before the mapping that needs them */}
      <Panel flush title="Columns" description={`${s.fields.length} columns${!file ? ` from ${s.input.kind === "db_watermark" && s.input.table?.trim() ? s.input.table.trim() : "the query"}` : ""} · check each type and what the recons use it as`}
        actions={(s.fields.length > 0 || (!file && p.canRead && hasSource)) && (
          <span className="flex flex-wrap gap-2">
            {!file && p.canRead && hasSource && (
              <Button id="src-columns" type="button" variant="secondary" size="sm" onClick={p.onReadColumns} disabled={p.reading} aria-busy={p.reading || undefined}>
                {p.reading && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Read the columns again</Button>
            )}
            {p.onPreview && !p.preview.result && (
              <Button type="button" variant="secondary" size="sm" onClick={p.onPreview} disabled={p.preview.pending} aria-busy={p.preview.pending || undefined}>
                {p.preview.pending && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Show examples</Button>
            )}
            {/* a value made from another column (the remark's first word as the reference): set with the columns */}
            <Button type="button" variant="secondary" size="sm" onClick={addComputed}><span className={computedNew ? "text-shimmer" : undefined}>Add computed column</span></Button>
          </span>
        )}>
        {/* where the columns come from, when they can't be read here (the panel "Columns of the source" folded in) */}
        {!file && p.canRead && !hasSource && <p id="src-columns" tabIndex={-1} className="px-4 pt-3 text-body-sm text-fg-2">{s.input.kind === "db_watermark" && d.from === "table" ? "No table chosen yet." : "No SELECT written yet."} Go back to Connection to {s.input.kind === "db_watermark" && d.from === "table" ? "choose it" : "write it"}, then read its columns here.</p>}
        {!file && !p.canRead && <p id="src-columns" tabIndex={-1} className="px-4 pt-3 text-body-sm text-fg-2">These are the fields of the version this draft started from. A source admin reads the columns the table has now.</p>}
        {!file && err("src-columns") && <p role="alert" className="px-4 pt-3 text-body-sm text-down-ink">{err("src-columns")}</p>}
        {s.fields.length === 0 ? (
          <p className="px-4 py-6 text-body-sm text-fg-3">{file ? "Columns appear here once a sample is read." : "Columns appear here once the source's columns are read."}</p>
        ) : (
          <div className="scroll-quiet overflow-x-auto max-xl:overflow-visible">
            {/* below 1280 px each column is a card: the header row hides, each cell shows its own label (one DOM); from
                1280 every control keeps its width and the table scrolls inside its card (fix round 2) */}
            <Table aria-label="Columns" className={CARDS}>
              <TableHeader className="max-xl:hidden"><TableRow>
                {COLUMN_HEADS.map(([head, help], k) => <TableHead key={head} className={k === 0 ? STICK_HEAD : undefined}>{head}<InfoTip label={head}>{help}</InfoTip></TableHead>)}
              </TableRow></TableHeader>
              <TableBody>
                {s.fields.map((f, i) => {
                  const id = ctl(`fields.${i}`);
                  const hint = p.engine ? fieldTypeOf(p.engine, p.native.get(f.name) ?? "").note : undefined;
                  const why = err(id) ?? err(ctl(`fields.${i}.format`)) ?? err(ctl(`fields.${i}.name`));
                  const stored = storedName(s, f.name);
                  const nameId = `src-attr-${i}`;
                  const typedName = p.typedNames[f.name];
                  const nameWhy = (typedName !== undefined ? storedNameProblem(typedName, f.name, s) : null) ?? err(nameId) ?? (stored ? err(ctl(`mapping.attrs.${stored}`)) : undefined);
                  const shown = [nameId, ...(stored ? [ctl(`mapping.attrs.${stored}`)] : [])]; // an error from Next or the API, until the value changes
                  const setName = (v: string) => {
                    p.onTypedName(f.name, v, shown);
                    if (!storedNameProblem(v, f.name, s)) setSpec((x) => storeAs(x, f.name, v));
                  };
                  return (
                    <TableRow key={f.name}>
                      <TableCell className={`font-mono text-mono text-fg max-xl:col-span-2 max-xl:text-label ${STICK_CELL}`}>
                        {f.name}
                        {p.gone.gone.includes(f.name) && s.input.kind === "db_watermark" && (
                          <span className={`block max-w-56 whitespace-normal font-sans text-caption ${p.gone.used.includes(f.name) ? "text-down-ink" : "text-fg-3"}`}>{goneRowNote(s.input.table ?? "")}</span>
                        )}
                      </TableCell>
                      <TableCell className="max-xl:order-last max-xl:col-span-2">
                        <Cap>Stored as</Cap>
                        <span className="grid gap-1">
                          <span className="flex items-center gap-2">
                            <Checkbox label={`${f.name} is stored`} checked={stored !== null} onToggle={() => {
                              p.onTypedName(f.name, undefined, shown);
                              setSpec((x) => {
                                if (storedName(x, f.name) !== null) return storeAs(x, f.name, null);
                                const want = attrNameOf(f.name);
                                return storeAs(x, f.name, storedNameProblem(want, f.name, x) ? `${want.slice(0, 58)}_${i + 1}` : want);
                              });
                            }} />
                                            <Input id={nameId} aria-label={`Stored name of ${f.name}`} className="min-w-40 font-mono" disabled={stored === null && typedName === undefined}
                              placeholder="Not stored" value={typedName ?? stored ?? ""} aria-invalid={!!nameWhy || undefined} aria-describedby={nameWhy ? `${nameId}-why` : undefined}
                              onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
                          </span>
                          {nameWhy && <span id={`${nameId}-why`} role="alert" className="max-w-72 whitespace-normal text-caption text-down-ink">{nameWhy}</span>}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-mono text-fg-3 max-xl:col-span-2 max-xl:max-w-none"><Cap>Example</Cap>{examples.get(f.name)?.[0] ?? "—"}</TableCell>
                      <TableCell className="max-xl:col-span-2"><Cap>Use as</Cap>{fieldPicker(f.name, String(i))}</TableCell>
                      <TableCell className="max-xl:col-span-2">
                        <Cap>Type</Cap>
                        <span className="grid gap-1">
                          <Select id={id} aria-label={`Type of ${f.name}`} value={f.type} aria-invalid={!!why || undefined} aria-describedby={why ? `${id}-why` : hint ? `${id}-hint` : undefined}
                            className="w-full min-w-36" onChange={(e) => setType(i, e.target.value as FieldSpec["type"])}>
                            {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                          </Select>
                          {why && <span id={`${id}-why`} role="alert" className="max-w-64 whitespace-normal text-caption text-down-ink">{why}</span>}
                          {!why && hint && <span id={`${id}-hint`} className="max-w-64 whitespace-normal text-caption text-fg-3">{hint}</span>}
                        </span>
                      </TableCell>
                      <TableCell className="max-xl:col-span-2"><Cap>Format</Cap><FormatCell f={f} i={i} setFormat={setFormat} err={err} /></TableCell>
                      <TableCell><span className="inline-flex items-center gap-2"><Checkbox label={`${f.name} may be empty`} checked={f.nullable} onToggle={() => setField(i, { nullable: !f.nullable })} /><Cap inline>Empty ok</Cap></span></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <ComputedColumns spec={s} setSpec={setSpec} err={err} examples={examples} renderUseAs={(name, i) => fieldPicker(name, `derive-${i}`)} />
        <ReconFields d={d} p={p} err={err} refLabel={refLabel} setSpec={setSpec} setCore={setCore} setUnit={setUnit} />
      </Panel>



      {s.input.kind === "db_watermark" && <WatermarkPanel {...p} />}
      {s.input.kind !== "db_snapshot" && (
        <Panel title="When a row changes" bodyClassName="grid gap-4">
          <span className="inline-flex items-center gap-2 md:col-span-2">
            <Switch id={ctl("mutable")} checked={s.mutable} onChange={(e) => setSpec((x) => ({ ...x, mutable: e.target.checked }))} aria-label="Rows can change after they arrive" />
            <label htmlFor={ctl("mutable")} className="text-body text-fg">Rows can change after they arrive</label>
            <InfoTip label="Rows can change after they arrive">
              Turn on when the source can send the same transaction again with new values, such as a status or amount
              corrected later. The newest version of each row counts and replaces the earlier one. Leave off when a row,
              once sent, never changes.
            </InfoTip>
          </span>
          {s.mutable && (
            <Field id={ctl("key_fields")} label="Match key" required error={err(ctl("key_fields"))}
              note="The columns that together name one row, such as its reference. A newer row with the same match key replaces the earlier one.">
              <Combobox multiple id={ctl("key_fields")} label="Match key" placeholder="Pick the columns" options={s.fields.map((f) => ({ value: f.name, label: f.name }))}
                value={s.key_fields.map((k) => ({ value: k, label: k }))} onChange={(v) => setSpec((x) => ({ ...x, key_fields: v.map((o) => o.value) }))} />
            </Field>
          )}
        </Panel>
      )}
      <PreviewPanel {...p} />
      <Left d={d} />
    </div>
  );
}
/**
 * The Columns table's headers with what each means, behind an ⓘ (owner, 21 Nov: every column header says in one or two
 * plain sentences what it is and what changing it does; design-system §5.7).
 */
const COLUMN_HEADS: readonly [string, string][] = [
  ["Column", "The column's name in the source, as read from the table, the query or the file."],
  ["Stored as", "The name the value is kept under with each record, so recons can match and filter on it. Untick to leave the column out."],
  ["Example", "A value read from the source, to check the type and format at a glance."],
  ["Use as", "The recon field this column fills, such as Business date or Amount. Each recon field takes one column. Leave it empty when the column is only stored."],
  ["Type", "How the value is read: text, number, date, or date and time. A row whose value doesn't fit goes to quarantine with the reason."],
  ["Format", "How a date or number is written in the source, such as yyyy-MM-dd or 2 decimal places, and the time zone of a date and time."],
  ["Empty ok", "Allows rows where this column is empty. When off, such a row goes to quarantine."],
];
/**
 * The column's name stays at the left while the Columns table scrolls sideways (owner, 21 Nov: which column is being
 * set stays in view), with a line on its right; a table (1280 px and up) only, as DataTable's title column.
 */
const STICK_ON = "xl:group-data-[scrolls=true]/scroll:sticky xl:group-data-[scrolls=true]/scroll:left-0 xl:group-data-[scrolls=true]/scroll:border-r xl:group-data-[scrolls=true]/scroll:border-r-line";
const STICK_HEAD = `${STICK_ON} xl:group-data-[scrolls=true]/scroll:z-20 bg-tray`;
const STICK_CELL = `${STICK_ON} xl:group-data-[scrolls=true]/scroll:z-1 xl:group-data-[scrolls=true]/scroll:bg-card xl:group-data-[scrolls=true]/scroll:group-hover/row:bg-tray`;
/** The Columns table as cards below 1280 px (a cell's height stays its content's: no fixed row height). */
const CARDS = "max-xl:block max-xl:[&_tbody]:block max-xl:[&_tr]:grid max-xl:[&_tr]:grid-cols-2 max-xl:[&_tr]:gap-x-3 max-xl:[&_tr]:gap-y-3 max-xl:[&_tr]:border-b max-xl:[&_tr]:border-line max-xl:[&_tr]:px-4 max-xl:[&_tr]:py-3 max-xl:[&_td]:block max-xl:[&_td]:h-auto max-xl:[&_td]:border-0 max-xl:[&_td]:p-0 max-xl:[&_td]:whitespace-normal";

/** A cell's label, shown only on the card (the table's header row names the columns from 768 px). */
function Cap({ children, inline }: { children: string; inline?: boolean }) {
  return <span aria-hidden="true" className={inline ? "font-sans text-caption text-fg-3 xl:hidden" : "mb-1 block font-sans text-caption text-fg-3 xl:hidden"}>{children}</span>;
}

/**
 * How new rows are found (ruling 4): the watermark and id columns, from the columns read. A column that can be empty is
 * offered disabled with the reason; a SELECT can't say, so a warning says it. A source admin's: anyone else sees it.
 */
function WatermarkPanel({ d, set, err, columns, canChangeReading, suggested }: FieldsStepProps) {
  const i = d.spec.input;
  if (i.kind !== "db_watermark") return null;
  const options = columns ?? d.spec.fields.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable }));
  /** A suggestion said under its picker while the pick is still it;. */
  const said = (key: "column" | "id_column"): string | null => {
    if (!suggested || d.from !== "table") return null;
    const s = key === "column" ? suggested.column : suggested.id;
    if (s && i.watermark[key] === s) return key === "column" ? watermarkNote(s) : idNote(s);
    return key === "id_column" && !s && !i.watermark.id_column ? suggested.idWhy : null;
  };
  const cols: ComboOption[] = options.map((c) => {
    const empty = d.from === "table" && c.nullable === true;
    // read from the table, a column is known usable (never empty: green check) or not (can be empty: red cross)
    const tone = d.from !== "table" || c.nullable === undefined ? undefined : empty ? "bad" as const : "ok" as const;
    return { value: c.name, label: c.name, description: empty ? NULLABLE_REASON : undefined, disabled: empty, tone };
  });
  const pick = (key: "column" | "id_column", label: string, plain: string, help: string) => {
    // "Suggested" is shown beside the label; any other sentence (why no id was suggested) stays the note
    const hint = said(key);
    const suggested = hint === watermarkNote("") || hint === idNote("");
    const note = (!suggested && hint) || plain;
    return (
    <Field id={ctl(`input.watermark.${key}`)} label={label} note={canChangeReading ? note : `${note} Set by a source admin.`} suggested={suggested} error={err(ctl(`input.watermark.${key}`))} help={help}>
      <Combobox id={ctl(`input.watermark.${key}`)} className="w-full min-w-0" label={label} placeholder="Pick a column" disabled={!canChangeReading}
        options={cols} value={cols.find((o) => o.value === i.watermark[key]) ?? null}
        onChange={(o) => set((x) => (x.spec.input.kind === "db_watermark"
          ? { ...x, spec: { ...x.spec, input: { ...x.spec.input, watermark: { ...x.spec.input.watermark, [key]: o?.value ?? "" } } } } : x))} />
    </Field>
    );
  };
  return (
    <Panel title="How new rows are found" description={d.from === "table" ? `From ${i.table?.trim() || "the table"}, after the last watermark and id` : "From the SELECT, after the last watermark and id"} bodyClassName="grid gap-4">
      {d.from === "query" && <Notice tone="warn">A SELECT can&apos;t say whether its columns can be empty. Pick a watermark and an id column that always have a value: rows with no value would never be pulled.</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        {pick("column", "Watermark column", "Grows whenever a row is added or changed, such as updated_at.",
          "How each pull finds what is new. Every pull reads only the rows whose value in this column is past the last one it read, so the source is never read whole again. It must grow whenever a row is added or changed, and never be empty: a row without a value is never pulled.")}
        {pick("id_column", "Id column", "Tells apart rows with the same watermark, such as the primary key.",
          "Puts rows with the same watermark value in a fixed order, such as many rows written in the same second. With it, a pull that stops between them goes on at the right row: none is skipped or read twice. Usually the primary key.")}
      </div>
    </Panel>
  );
}

/** The format a type is read with: a date's pattern, a datetime's pattern and zone, a decimal's places and separators. */
function FormatCell({ f, i, setFormat, err }: { f: FieldSpec; i: number; setFormat: (i: number, p: NonNullable<FieldSpec["format"]>) => void; err: (id: string) => string | undefined }) {
  const at = (k: string) => ctl(`fields.${i}.format.${k}`);
  if (f.type === "date" || f.type === "datetime") {
    return (
      <span className={f.type === "datetime" ? "grid min-w-52 gap-1" : "grid min-w-36 gap-1"}>
        <Input id={at("date")} aria-label={`Date format of ${f.name}`} placeholder={f.type === "date" ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss"} className="font-mono" value={f.format?.date ?? ""}
          onChange={(e) => setFormat(i, { date: e.target.value || undefined })} />
        {f.type === "datetime" && (
          <Input id={at("timezone")} aria-label={`Time zone of ${f.name}`} placeholder="Asia/Jakarta" value={f.format?.timezone ?? ""} aria-invalid={!!err(at("timezone")) || undefined}
            onChange={(e) => setFormat(i, { timezone: e.target.value || undefined })} />
        )}
        {err(at("timezone")) && <span role="alert" className="max-w-48 whitespace-normal text-caption text-down-ink">{err(at("timezone"))}</span>}
      </span>
    );
  }
  if (f.type === "decimal") {
    return (
      <span className="grid min-w-36 gap-1">
        <Select id={at("scale")} className="w-full" aria-label={`Places of ${f.name}`} value={String(f.format?.scale ?? 2)} onChange={(e) => setFormat(i, { scale: Number(e.target.value) })}>
          {[0, 1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} places</option>)}
        </Select>
        <Select id={at("decimalSeparator")} className="w-full" aria-label={`Decimal separator of ${f.name}`} value={f.format?.decimalSeparator ?? "."}
          onChange={(e) => setFormat(i, { decimalSeparator: e.target.value as "." | "," })}>
          <option value=".">1,234.50</option><option value=",">1.234,50</option>
        </Select>
      </span>
    );
  }
  return <span className="text-fg-3">—</span>;
}

/** The sample: pasted or chosen from a file (its first 32 KB), and the file name its business date comes from. */
function SampleInput(p: FieldsStepProps) {
  const pick = useRef<HTMLInputElement>(null);
  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) p.onSample(await f.slice(0, 64 * 1024).text(), f.name);
    e.target.value = "";
  };
  return (
    <>
      <Field id="src-sample" label="Sample" note="Up to 32 KB is read." error={p.err("src-sample")}>
        <Textarea id="src-sample" value={p.sample} rows={6} className="font-mono" spellCheck={false} onChange={(e) => p.onSample(e.target.value)} />
      </Field>
      {p.sampleCut && <Notice>Only the first 32 KB of the file is previewed.</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="src-file-name" label="File name" note="Its date (yyyyMMdd) is the business date, as when the inbox picks the file up: act20261102.txt is 2 Nov 2026.">
          <Input id="src-file-name" value={p.fileName} className="font-mono" onChange={(e) => p.onFileName(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <span className="flex flex-wrap gap-3">
        <Button id="src-columns" type="button" onClick={p.onReadSample} disabled={!p.sample.trim()}>Read the sample</Button>
        <Button type="button" variant="secondary" onClick={() => pick.current?.click()}>Choose a file</Button>
        <input ref={pick} type="file" accept=".txt,.csv,.dat,text/plain,text/csv" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void choose(e)} />
      </span>
    </>
  );
}

/**
 * What is still missing before Next, each with a check or a cross and its words (goal gradient: the end is visible;
 * the same rules Next checks: mappingProblem, amountProblems, the watermark, the match key).
 */
function Left({ d }: { d: Draft }) {
  const s = d.spec, i = s.input;
  const items = [
    { ok: s.fields.length > 0, text: "Columns read" },
    { ok: s.fields.length > 0 && !mappingProblem(s), text: "Business date mapped" },
    ...(s.mapping.amount_minor ? [{ ok: !!s.mapping.amount_minor.unit, text: "Amount unit chosen" }, { ok: !!(s.mapping.currency || s.currency), text: "Currency set" }] : []),
    ...(i.kind === "db_watermark" ? [{ ok: !!i.watermark.column && !!i.watermark.id_column, text: "Watermark and id column picked" }] : []),
    ...(i.kind !== "db_snapshot" && s.mutable ? [{ ok: s.key_fields.length > 0, text: "Match key picked" }] : []),
  ];
  const left = items.filter((x) => !x.ok).length;
  return (
    <Panel title="Before you go on" description={left ? `${left} of ${items.length} left` : "Ready for review"}>
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((x) => (
          <li key={x.text} className="flex items-center gap-2 text-body-sm">
            <Icon icon={x.ok ? CheckIcon : CloseIcon} className={x.ok ? "size-4 shrink-0 text-healthy-mark" : "size-4 shrink-0 text-down-mark"} />
            <span className={x.ok ? "text-fg-2" : "text-fg"}>{x.text}</span><span className="sr-only">{x.ok ? " (done)" : " (to do)"}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** What the sample becomes under the spec on screen: records for the core table and the lines that would be quarantined. */
function PreviewPanel(p: FieldsStepProps) {
  const r = p.preview.result;
  const file = p.d.spec.input.kind === "file_inbox";
  return (
    <Panel flush title="Preview" description={file ? `${p.fileName || "the sample"} · updates as you change columns · not stored` : "Pulled from the source on demand · not stored"}>
      <div className="grid gap-3 p-4">
        {p.d.spec.input.kind === "db_snapshot" && (
          <div className="max-w-xs">
            <Field id="src-preview-date" label="Business date">
              <Input id="src-preview-date" type="date" value={p.businessDate} onChange={(e) => p.onBusinessDate(e.target.value)} />
            </Field>
          </div>
        )}
        {p.onPreview && (
          <span>
            <Button type="button" variant="secondary" onClick={p.onPreview} disabled={p.preview.pending} aria-busy={p.preview.pending || undefined}>
              {p.preview.pending && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{p.preview.result ? "Preview again" : "Preview rows"}
            </Button>
          </span>
        )}
        <PreviewResult preview={p.preview} file={file} />
        {!r && !p.preview.error && !p.preview.pending && (
          <p className="text-body-sm text-fg-3">{p.onPreview
            ? "Preview rows pulls up to 200 rows from the source."
            : "The preview appears once the columns are read and the business date is mapped."}</p>
        )}
      </div>
    </Panel>
  );
}

/** The preview's counts, its first records and its quarantined lines with a reason per column. Shared with the version page. */
export function PreviewResult({ preview, file }: { preview: Preview; file: boolean }) {
  const r = preview.result;
  return (
    <div aria-busy={preview.pending || undefined} className="grid gap-3">
      {/* while a new preview runs, the last one's failure goes: a failure never stands beside a spinner */}
      {preview.pending ? <Notice tone="progress" live>Updating the preview</Notice> : preview.error && <Notice tone="warn" live>{preview.error}</Notice>}
      {r && (
        <>
          <p role="status" className="text-body-sm text-fg">
            {formatNumber(r.lines)} rows read: {formatNumber(r.ok)} become records, {formatNumber(r.quarantined)} go to quarantine. Quarantined rows don&apos;t stop the {file ? "file" : "pull"}.
          </p>
          {r.records.length > 0 && (() => {
            // every recon field the records carry, so each mapping (a computed column's too) can be checked here;
            // a field no record has stays out (Match key only for a source whose rows change)
            const rows = r.records.slice(0, 10);
            const amount = (x: (typeof rows)[number]) => {
              if (x.amountMinor === null) return "—";
              const exp = x.currency ? CURRENCY_EXPONENT[x.currency] : undefined;
              return exp === undefined ? x.amountMinor : `${x.currency} ${formatMinor(BigInt(x.amountMinor), exp)}`;
            };
            const all: { head: string; help: string; cell: (x: (typeof rows)[number]) => string | null }[] = [
              { head: "Business date", help: "The day the record belongs to. Recons compare and close it on this day.", cell: (x) => x.businessDate },
              { head: "Amount", help: "The amount as the recons compare it, in the row's currency.", cell: (x) => (x.amountMinor === null ? null : amount(x)) },
              { head: "Currency", help: "The ISO code read for the row.", cell: (x) => x.currency },
              { head: "Direction", help: "Debit or credit as read. A debit counts as negative.", cell: (x) => x.direction },
              { head: "Event time", help: "When the transaction happened, stored in UTC.", cell: (x) => x.eventTime },
              { head: "Reference", help: "The reference both sides share for the same transaction.", cell: (x) => x.extRef },
              { head: "Account", help: "The account the row is posted to.", cell: (x) => x.accountRef },
              { head: "Match key", help: "The columns that name the row. A newer row with the same match key replaces it.", cell: (x) => x.naturalKey?.replaceAll("\u001f", " · ") ?? null },
            ];
            const cols = all.filter((c) => rows.some((x) => c.cell(x) !== null));
            return (
              <Table aria-label="Preview records">
                <TableHeader><TableRow>
                  <TableHead>Row<InfoTip label="Row">The row&apos;s position in the sample, so you can find it in the source.</InfoTip></TableHead>
                  {cols.map((c) => <TableHead key={c.head}>{c.head}<InfoTip label={c.head}>{c.help}</InfoTip></TableHead>)}
                  <TableHead>Stored columns<InfoTip label="Stored columns">Every column kept with the record, under its stored name. Recons can match on any of them.</InfoTip></TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {rows.map((x) => (
                    <TableRow key={x.line}>
                      <TableCell className="tabular">{x.line}</TableCell>
                      {cols.map((c) => <TableCell key={c.head} className="font-mono text-mono whitespace-nowrap">{c.cell(x) ?? "—"}</TableCell>)}
                      <TableCell className="max-w-72 truncate font-mono text-mono text-fg-2" title={Object.entries(x.attrs).map(([k, v]) => `${k}=${v === null ? "∅" : String(v)}`).join("\n")}>
                        {Object.entries(x.attrs).map(([k, v]) => `${k}=${v === null ? "∅" : String(v)}`).join(" · ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
          })()}
          {r.quarantine.length > 0 && (
            <div className="grid gap-1">
              <h3 className="text-label text-fg">Quarantined</h3>
              <ul className="grid gap-1 text-body-sm text-fg">
                {r.quarantine.slice(0, 20).map((q) => (
                  <li key={q.line}>Row {q.line} · {Object.entries(q.reasons).map(([k, v]) => (k === "_row" ? v : v.startsWith(k) ? v : `${k}: ${v}`)).join("; ")}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** "Amount is in": currency units or minor units, the suggestion while it is still the value, and what the sample's first row per currency is stored as. */
/**
 * The recon fields at a glance, under the columns that fill them (owner, 21 Nov: "Map to recon fields" joined Columns):
 * each one's source with a ✓, or Not used; what isn't a column is set here: the date in the file name, one currency
 * for every row, the amount's unit. The line is the field's error target (src-mapping-…).
 */
function ReconFields({ d, p, err, refLabel, setSpec, setCore, setUnit }: {
  d: Draft; p: FieldsStepProps; err: FieldsStepProps["err"]; refLabel: (r: ValueRef) => string;
  setSpec: (fn: (s: SourceSpec) => SourceSpec) => void; setCore: (k: Core, r: ValueRef | undefined) => void; setUnit: (u: AmountUnit) => void;
}) {
  const s = d.spec;
  const file = s.input.kind === "file_inbox";
  return (
    <div className="grid gap-4 border-t border-line p-4">
      <h3 className="eyebrow text-fg-3">Recon fields</h3>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        {CORE.map((c) => {
          const id = ctl(`mapping.${c.key}`);
          const r = s.mapping[c.key];
          const set = !!r && (!("field" in r) || !!r.field);
          const why = err(id);
          const hint = c.key in p.coreHint ? p.coreHint[c.key as SuggestedCore] : undefined;
          const typed = set && r && "cel" in r && r.cel !== FILE_DATE.cel && r.cel !== ARRIVED_DATE.cel;
          return (
            <div key={c.key} id={id} tabIndex={-1} className="grid min-w-0 content-start gap-1.5 rounded-md">
              <span className="flex min-w-0 items-center gap-1 text-label text-fg">
                {c.label}{c.key === "business_date" && <span aria-hidden="true" className="ml-0.5 text-destructive">*</span>}
                <InfoTip label={c.label}>{c.help}</InfoTip>
                {hint && r && "field" in r && r.field === hint && <span className="ml-1 inline-flex items-center gap-1 text-caption text-fg-2"><Icon icon={SuggestedIcon} className="size-3.5 text-chart-1" />Suggested</span>}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-body-sm">
                {set && r ? <>
                  <Icon icon={CheckIcon} className="size-4 shrink-0 text-healthy-mark" />
                  <span className="min-w-0 truncate font-mono text-mono text-fg">{refLabel(r)}</span>
                  {typed && <Button type="button" variant="link" size="sm" onClick={() => setCore(c.key, undefined)}>Stop using it</Button>}
                </> : <span className="text-fg-3">{c.key === "business_date" ? "Not set: pick a column in Use as" : "Not used"}</span>}
              </span>
              {/* rows that carry no date of their own (owner, 21 Nov): the file name's date, or the day they arrive */}
              {c.key === "business_date" && (
                <Segmented label="Business date comes from" value={r && "cel" in r && (r.cel === FILE_DATE.cel || r.cel === ARRIVED_DATE.cel) ? r.cel : "column"}
                  onChange={(v) => setCore(c.key, v === FILE_DATE.cel ? FILE_DATE : v === ARRIVED_DATE.cel ? ARRIVED_DATE : r && "field" in r ? r : undefined)}
                  options={[
                    { value: "column", label: "A column" },
                    ...(file ? [{ value: FILE_DATE.cel, label: "The file name" }] : []),
                    { value: ARRIVED_DATE.cel, label: s.input.kind === "db_snapshot" ? "The snapshot's date" : "The day it arrives" },
                  ]} />
              )}
              {c.key === "business_date" && r && "cel" in r && r.cel === ARRIVED_DATE.cel && (
                <span className="text-caption text-fg-3">{s.input.kind === "db_snapshot"
                  ? "Every row gets the business date the snapshot is taken for."
                  : "Every row gets the date it is read on (Jakarta time), so a row read after midnight belongs to the next day."}</span>
              )}
              {c.key === "currency" && !r && (
                <Combobox className="w-full min-w-0 md:max-w-64" id={ctl("currency")} label="Or one currency for every row" placeholder="Or one currency for every row" options={CURRENCIES}
                  invalid={!!err(ctl("currency"))} value={CURRENCIES.find((o) => o.value === s.currency) ?? null} onChange={(o) => setSpec((x) => ({ ...x, currency: o?.value || undefined }))} />
              )}
              {c.key === "currency" && !r && err(ctl("currency")) && <p role="alert" className="text-caption text-down-ink">{err(ctl("currency"))}</p>}
              {why && <p role="alert" className="text-caption text-down-ink">{why}</p>}
            </div>
          );
        })}
      </div>
      {s.mapping.amount_minor
        ? <AmountUnitField d={d} err={err} records={p.preview.result?.records ?? []} onUnit={setUnit} />
        : <p className="text-caption text-fg-3">Recons on a source without an amount match by keys only.</p>}
    </div>
  );
}

function AmountUnitField({ d, err, records, onUnit }: { d: Draft; err: FieldsStepProps["err"]; records: NonNullable<Preview["result"]>["records"]; onUnit: (u: AmountUnit) => void }) {
  const id = ctl("mapping.amount_minor.unit");
  const unit = d.spec.mapping.amount_minor?.unit;
  const why = err(id);
  const note = unit && d.unitHint?.unit === unit ? d.unitHint.note : null;
  const examples = unit ? unitExamples(records, unit) : [];
  return (
    <div className="grid min-w-0 content-start gap-2 md:col-span-2">
      <span className="text-label text-fg">Amount is in<span aria-hidden="true" className="ml-0.5 text-destructive">*</span></span>
      <div id={id} tabIndex={-1} className="w-fit rounded-ctl" aria-invalid={!!why || undefined} aria-describedby={why ? `${id}-error` : undefined}>
        <Segmented label="Amount is in" value={unit ?? ("" as AmountUnit)} onChange={onUnit} options={AMOUNT_UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u] }))} />
      </div>
      {why && <p id={`${id}-error`} role="alert" className="text-body-sm text-down-ink">{why}</p>}
      <span className="text-caption text-fg-3">{(unit ? [unit] : AMOUNT_UNITS).map((u) => `${UNIT_LABEL[u]}: ${UNIT_HINT[u]}`).join(". ")}.</span>
      {note && <span className="text-caption text-fg-3">{note}</span>}
      {examples.length > 0 && <p role="status" className="text-body-sm text-fg-2">{examples.join(" · ")}</p>}
    </div>
  );
}
