// A recon's Operation result columns (docs/superpowers/specs/2026-11-24-operation-result-design.md "Column setup"):
// outside the versioned spec, so a save needs no version and no approval; each change is one `recon.result_columns`
// activity entry on the recon (its History). No row = the default columns. A side column names a field of the records
// that side's source writes (recordFields of the source's published version); one the source no longer has stays,
// listed in `missing`.
import type { ResultColumn, ResultColumnsBody, ResultColumnsDto } from "@starterkit/shared/contracts/results";
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { FIELD_LABEL, recordFields } from "@starterkit/shared/recon";
import { and, eq } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { readableSources } from "../sources";
import { withSpace } from "../spaces";
import { reconConfigVersions, reconResultColumns } from "./schema";
import { configOf } from "./service";

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/** The default columns: each side's reference and amount, then the business date; headed by the sides' labels. */
const defaults = (labels: [string, string]): ResultColumn[] => [
  { kind: "a", field: "ext_ref", label: `${labels[0]} ${FIELD_LABEL.ext_ref.toLowerCase()}` },
  { kind: "a", field: "amount_minor", label: `${labels[0]} ${FIELD_LABEL.amount_minor.toLowerCase()}` },
  { kind: "b", field: "ext_ref", label: `${labels[1]} ${FIELD_LABEL.ext_ref.toLowerCase()}` },
  { kind: "b", field: "amount_minor", label: `${labels[1]} ${FIELD_LABEL.amount_minor.toLowerCase()}` },
  { kind: "recon", field: "businessDate", label: "Business date" },
];

export type ResultColumnsOf = {
  columns: ResultColumn[]; isDefault: boolean; updatedAt: Date | null;
  /** The published version's spec (null: none, so the recon has no results), and the fields each side's source writes. */
  spec: ReconSpec | null; fields: { a: Set<string>; b: Set<string> } | null;
};

/** The columns of recon `configId` (the default when unset) and what its published version's sides read; 404 for another space's. */
export async function resultColumnsOf(tx: InTx, spaceId: string, configId: string): Promise<ResultColumnsOf> {
  await configOf(tx, spaceId, configId);
  const [[row], [pub]] = await Promise.all([
    tx.select().from(reconResultColumns).where(and(eq(reconResultColumns.spaceId, spaceId), eq(reconResultColumns.configId, configId))),
    tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published"))),
  ]);
  const spec = pub ? ReconSpec.parse(pub.spec) : null;
  let fields: ResultColumnsOf["fields"] = null;
  if (spec) {
    const found = await readableSources(tx, spaceId, [...new Set(spec.sides.map((s) => s.source_id))]);
    const of = (i: 0 | 1) => { const s = found.get(spec.sides[i].source_id)?.spec; return new Set(s ? recordFields(s).keys() : []); };
    fields = { a: of(0), b: of(1) };
  }
  const labels: [string, string] = spec ? [spec.sides[0].label, spec.sides[1].label] : ["Side A", "Side B"];
  return row
    ? { columns: row.columns as ResultColumn[], isDefault: false, updatedAt: row.updatedAt, spec, fields }
    : { columns: defaults(labels), isDefault: true, updatedAt: null, spec, fields };
}

const dto = (r: ResultColumnsOf): ResultColumnsDto => ({
  columns: r.columns, isDefault: r.isDefault, updatedAt: r.updatedAt?.toISOString() ?? null,
  missing: r.fields ? r.columns.flatMap((c) => (c.kind !== "recon" && !r.fields![c.kind].has(c.field) ? [{ kind: c.kind, field: c.field }] : [])) : [],
});

/** GET …/recons/{configId}/result-columns. */
export function resultColumns(ctx: Ctx, configId: string): Promise<ResultColumnsDto> {
  return inSpace(ctx, async (tx, spaceId) => dto(await resultColumnsOf(tx, spaceId, configId)));
}

/**
 * PUT …/recons/{configId}/result-columns: the columns in order; none = back to the default (the row goes). 409 while
 * the recon has no published version (the fields come from it). The config row is locked, so two saves run in turn.
 */
export function setResultColumns(ctx: Ctx, configId: string, b: ResultColumnsBody): Promise<ResultColumnsDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, configId, true);
    const now = await resultColumnsOf(tx, spaceId, configId);
    if (!now.spec) throw new ApiError("invalid_state", "Publish a version first: the columns come from the sources it reads.");
    const before = now.isDefault ? null : now.columns, after = b.columns.length ? b.columns : null;
    if (JSON.stringify(before) === JSON.stringify(after)) return dto(now);
    const key = and(eq(reconResultColumns.spaceId, spaceId), eq(reconResultColumns.configId, configId));
    if (after) {
      await tx.insert(reconResultColumns).values({ spaceId, configId, columns: after, updatedBy: ctx.user.id })
        .onConflictDoUpdate({ target: [reconResultColumns.spaceId, reconResultColumns.configId], set: { columns: after, updatedBy: ctx.user.id, updatedAt: new Date() } });
    } else await tx.delete(reconResultColumns).where(key);
    await recordActivity(tx, ctx, { action: "recon.result_columns", target: { type: "recon", id: c.id, label: c.name }, before: { columns: before }, after: { columns: after } });
    return dto(await resultColumnsOf(tx, spaceId, configId));
  });
}
