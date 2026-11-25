// A column's format controls (a date's pattern, a datetime's pattern and zone, a decimal's places and separator), shared
// by step 2's list and the source mapper's column inspector.
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { FieldSpec } from "@starterkit/shared/contracts/sources";
import { ctl } from "./model";

/** The format a type is read with: a date's pattern, a datetime's pattern and zone, a decimal's places and separators. */
export function FormatCell({ f, i, setFormat, err, idOf }: {
  f: FieldSpec; i: number; setFormat: (i: number, p: NonNullable<FieldSpec["format"]>) => void; err: (id: string) => string | undefined;
  /** The controls' ids (the mapper's own, so they never repeat the list's). */
  idOf?: (k: string) => string;
}) {
  const at = idOf ?? ((k: string) => ctl(`fields.${i}.format.${k}`));
  if (f.type === "date" || f.type === "datetime") {
    return (
      <span className={f.type === "datetime" ? "grid min-w-52 gap-1" : "grid min-w-36 gap-1"}>
        <Input id={at("date")} aria-label={`Date format of ${f.name}`} placeholder={f.type === "date" ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss"} className="font-mono" value={f.format?.date ?? ""}
          aria-invalid={!!err(at("date")) || undefined} onChange={(e) => setFormat(i, { date: e.target.value || undefined })} />
        {err(at("date")) && <span role="alert" className="max-w-48 whitespace-normal text-caption text-down-ink">{err(at("date"))}</span>}
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
