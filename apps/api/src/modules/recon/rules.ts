// Pure rules of a recon spec (spec §10) beyond its contract: what checkReconSpec finds against the sides' published
// source versions, where in the builder a problem is (in the builder's words, never a spec path), and the fields a
// published recon holds its sources to (Plan 3 A4). Sentences name fields as people do (fieldLabel), never by code.
import { APPROVAL_FIELDS, type CatalogField, type Condition, conditionFields, fieldName, groupFields, isKeyField, OP_TEXT, OPS_BY_KIND } from "@starterkit/shared/conditions";
import { fieldPaths, type OpField } from "@starterkit/shared/integrations";
import { arrayPaths, type Source, templateParts } from "@starterkit/shared/mapping";
import type { ReconApprovalSpec, ReconSpec } from "@starterkit/shared/contracts/recon";
import { TRIGGER_LABEL, TRIGGERS } from "@starterkit/shared/workflows";
import { type FieldKind, fieldLabel, type FieldPair, type Operator, recordFields, sideRef, type SourceSpecLike } from "@starterkit/shared/recon";
import { specIssue } from "../../kernel/versions";

/**
 * A side's source as the check reads it: its published spec (null = none yet), the currencies seen in its records and
 * its name (for "<name> has no published version yet.").
 */
export type SideSource = { spec: SourceSpecLike | null; currencies: readonly string[]; name?: string };
/**
 * `errors` refuse a save and a submit (each "<place>: …"); `gates` refuse a submit and come back as warnings on a save
 * (carry over shorter than a date window); `warnings` never block (a currency without tolerance). `where` = the setup
 * step (and pass) of each message, set where the message is made, so a warning reaches the screen with its step.
 */
export type Where = { step: "sources" | "matching" | "schedule"; pass: number | null };
export type ReconCheck = { errors: string[]; gates: string[]; warnings: string[]; where: Map<string, Where> };

const SPOT: Record<string, string> = { measure: "Measure", grace_minutes: "Grace", carry_over_days: "Carry over", close_at: "Close time", schedule: "Schedule" };
/**
 * A spot of the spec in the builder's words: `passes.1.predicates.0…` → "Pass 2, condition 1", `passes.1.blocking.0` →
 * "Pass 2, matching key 1", `sides.1…` → "Side B, filter 1"; a tolerance names its currency.
 */
export function placeOf(path: readonly PropertyKey[]): string {
  const [top, i, part, j, , ccy] = path;
  const n = (x: PropertyKey | undefined) => Number(x) + 1;
  if (top === "passes" && i !== undefined) {
    const pass = `Pass ${n(i)}`;
    if (part === "predicates" && j !== undefined) return `${pass}, condition ${n(j)}${path[4] === "tolerance" && ccy !== undefined ? `, ${String(ccy)} tolerance` : ""}`;
    if (part === "blocking" && j !== undefined) return `${pass}, matching key ${n(j)}`;
    return pass;
  }
  if (top === "sides" && i !== undefined) return `Side ${Number(i) === 0 ? "A" : "B"}${part === "filter" && j !== undefined ? `, filter ${n(j)}` : ""}`;
  return SPOT[String(top)] ?? "The recon";
}
/** Why the contract refused a recon body, at its spot in words ("Pass 2, condition 1, JPY tolerance: …"); null otherwise. */
export const reconIssue = (e: unknown): string | null => specIssue(e, "spec", placeOf);

/** What an operator compares, as the sentence opens it; eq takes any kind, the same on both sides. */
const NEEDS: Partial<Record<Operator, [FieldKind, string]>> = {
  eq_normalized: ["text", "Text matching compares text"], contains: ["text", "Text matching compares text"], similarity: ["text", "Text matching compares text"],
  amount_abs_tol: ["decimal", "Amount is decimal"], amount_pct_tol: ["decimal", "Amount is decimal"], eq_sum: ["decimal", "Amount is decimal"],
  date_window: ["date", "A date window compares dates"],
};
const AMOUNT_OPS: ReadonlySet<Operator> = new Set(["amount_abs_tol", "amount_pct_tol", "eq_sum"]);
const VALUE: Record<FieldKind, [RegExp, string]> = {
  text: [/^/, ""], decimal: [/^-?\d+(\.\d+)?$/, "is not a number"], date: [/^\d{4}-\d{2}-\d{2}/, "is not a date (yyyy-mm-dd)"], boolean: [/^(true|false)$/, "is not true or false"],
};
/** Records store a mapped direction as debit or credit (ingest map.ts), so a filter on it names one of those. */
const DIRECTION_VALUE: [RegExp, string] = [/^(debit|credit)$/, "is not a direction. Use debit or credit"];
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * The checks of a recon spec against its sides' sources (Plan 3 Task 1): every field it names exists on the side (the
 * FieldRef whitelist, recordFields) and is of the kind its operator takes; passes are numbered 1, 2, 3 …; a group sum
 * only in a 1:N / N:1 pass, which groups by a matching key (A3); an amount compared on sides that can hold more than
 * one currency needs a currency condition (A2); a daily recon's carry over covers every date window (Captain's guardrail).
 */
export function checkReconSpec(spec: ReconSpec, sources: readonly [SideSource, SideSource]): ReconCheck {
  const errors: string[] = [], gates: string[] = [], warnings: string[] = [];
  const where = new Map<string, Where>();
  /** Adds `text` to `list` with its step: a side's problem is the Sources step's, the rest (passes, measure) Matching's. */
  const add = (list: string[], text: string, step: Where["step"], pass: number | null = null) => { list.push(text); where.set(text, { step, pass }); };
  const stepOf = (place: string): Where["step"] => (place.startsWith("Side") ? "sources" : "matching");
  const passOf = (place: string) => { const m = /^Pass (\d+)/.exec(place); return m ? Number(m[1]) : null; };
  const at = (place: string, why: string) => add(errors, `${place}: ${why}`, stepOf(place), passOf(place));
  const fields = sources.map((s) => (s.spec ? recordFields(s.spec) : null));
  const label = (i: number) => spec.sides[i]!.label;

  spec.sides.forEach((side, i) => {
    const place = placeOf(["sides", i]);
    if (!fields[i]) return at(place, `${sources[i]!.name ?? side.label} has no published version yet.`);
    if (side.amount_sign === "negate" && !fields[i]!.has("amount_minor")) at(place, `${side.label} has no amount to negate. Map an amount in its source or read the sign as it is.`);
    side.filter.forEach((f, j) => {
      const r = fields[i]!.get(f.field);
      if (!r) return at(placeOf(["sides", i, "filter", j]), `${side.label} has no field ${fieldLabel(f.field)}.`);
      const [ok, not] = f.field === "direction" ? DIRECTION_VALUE : VALUE[r.kind];
      const bad = ("value" in f ? [f.value] : "values" in f ? f.values : []).find((v) => !ok.test(v));
      if (bad !== undefined) at(placeOf(["sides", i, "filter", j]), `${JSON.stringify(bad)} ${not}.`);
    });
  });

  /** The field's kind on each side (null: no source, or no such field, reported); `need` = what the operator takes. */
  const onBoth = (place: string, pair: FieldPair, need?: [FieldKind, string]) => fields.map((fs, i) => {
    if (!fs) return null;
    const ref = sideRef(pair, i as 0 | 1);
    const r = fs.get(ref);
    if (!r) { at(place, `${label(i)} has no field ${fieldLabel(ref)}.`); return null; }
    if (need && r.kind !== need[0]) at(`${place}, ${label(i)}`, `${need[1]}; this side's field is ${r.kind}.`);
    return r.kind;
  });
  /** "<A>'s <field> is <kind>; <B>'s <field> is <kind>.": a matching key or an equality compares fields of one kind. */
  const kindsDiffer = (f: FieldPair, ka: FieldKind, kb: FieldKind) =>
    `${label(0)}'s ${fieldLabel(sideRef(f, 0))} is ${ka}; ${label(1)}'s ${fieldLabel(sideRef(f, 1))} is ${kb}.`;
  if (spec.measure) onBoth("Measure", spec.measure.field, ["decimal", "A measure is decimal"]);

  const sideCurrency = sources.map((s) => (s.spec ? { column: !!s.spec.mapping.currency, fixed: s.spec.currency ?? null } : null));
  const [ca, cb] = sideCurrency;
  const manyCurrencies = sideCurrency.some((c) => c?.column) || (!!ca?.fixed && !!cb?.fixed && ca.fixed !== cb.fixed);
  const seen = [...new Set(sources.flatMap((s, i) => [...s.currencies, ...(sideCurrency[i]?.fixed ? [sideCurrency[i]!.fixed!] : [])]))].sort();

  if (spec.passes.some((p, i) => p.no !== i + 1)) add(errors, "Number the passes 1, 2, 3 … in order, with no gaps.", "matching");
  spec.passes.forEach((p, i) => {
    const pass = placeOf(["passes", i]);
    p.blocking.forEach((f, j) => {
      const place = placeOf(["passes", i, "blocking", j]);
      const [ka, kb] = onBoth(place, f);
      if (ka && kb && ka !== kb) at(place, kindsDiffer(f, ka, kb));
    });
    p.predicates.forEach((q, j) => {
      const place = placeOf(["passes", i, "predicates", j]);
      if (q.op === "bday_window" && ([0, 1] as const).some((i) => sideRef(q.field, i) !== "business_date")) return at(place, "Business days are counted on the business date. Compare the business date.");
      const [ka, kb] = onBoth(place, q.field, NEEDS[q.op]);
      if (!NEEDS[q.op] && ka && kb && ka !== kb) at(place, kindsDiffer(q.field, ka, kb));
      if (q.op === "eq_sum" && p.cardinality === "1:1") at(place, "A group sum needs a 1:N or N:1 pass.");
    });
    if (p.cardinality !== "1:1") {
      if (p.accept === "suggest" || p.on_ambiguous === "suggest") add(errors, `Pass ${p.no} groups several items; it can only match automatically or leave them unmatched in this release.`, "matching", p.no);
      if (!p.blocking.length) at(pass, "A 1:N or N:1 pass groups records by a matching key. Add one, such as a settlement reference.");
      if (p.predicates.filter((q) => q.op === "eq_sum").length !== 1) at(pass, "A 1:N or N:1 pass needs one group sum condition.");
    }

    const isAmount = (f: FieldPair) => ([0, 1] as const).some((i) => sideRef(f, i) === "amount_minor" || sideRef(f, i) === spec.measure?.field);
    const isCurrency = (f: FieldPair) => ([0, 1] as const).every((i) => sideRef(f, i) === "currency");
    const amounts = p.predicates.some((q) => AMOUNT_OPS.has(q.op) || isAmount(q.field)) || p.blocking.some(isAmount);
    const currencyEq = p.blocking.some(isCurrency) || p.predicates.some((q) => q.op === "eq" && isCurrency(q.field));
    if (manyCurrencies && amounts && !currencyEq) add(errors, `Pass ${p.no} compares amounts but has no currency condition. Add one so amounts in different currencies never match.`, "matching", p.no);

    const untolerated = new Set<string>();
    for (const q of p.predicates) {
      if (q.op === "amount_abs_tol" || (q.op === "eq_sum" && Object.keys(q.tolerance).length)) for (const c of seen) if (!Object.hasOwn(q.tolerance, c)) untolerated.add(c);
    }
    for (const c of untolerated) add(warnings, `${c} has no tolerance in pass ${p.no}; ${c} pairs must match exactly.`, "matching", p.no);

    const window = Math.max(0, ...p.predicates.map((q) => (q.op === "date_window" || q.op === "bday_window" ? q.days : 0)));
    // carry over always (null) checks unmatch on every run: no window is too wide for it
    if (spec.schedule.kind === "daily" && spec.carry_over_days !== null && window > spec.carry_over_days) {
      add(gates, `Pass ${p.no} allows dates ${days(window)} apart, but carry over is ${days(spec.carry_over_days)}: ${p.cardinality === "1:1" ? "pairs" : "groups"} across days never meet in a daily run. Set carry over to ${days(window)}.`, "schedule", p.no);
    }
  });
  return { errors, gates, warnings, where };
}

/**
 * The fields each side's records must keep while the recon is published (Plan 3 A4), per side, sorted: the side's own
 * filters, its field of every matching key and condition, the measure, direction when the side's source maps it
 * (the amount's sign comes from it), and the amount when the side negates it.
 */
export function usedFields(spec: ReconSpec, directionMapped: readonly [boolean, boolean] = [false, false]): [string[], string[]] {
  const pairs = spec.passes.flatMap((p) => [...p.blocking, ...p.predicates.map((q) => q.field)]);
  // an approval rule's side fields (side_a.attrs.channel) bind the source too (DEC-052 rev 2 §4.3)
  const ruled = Object.values(spec.approvals?.changes ?? {}).flatMap((c) => [
    ...(c?.workflow.rules.flatMap((r) => conditionFields(r.when as Condition)) ?? []),
    // what the actions' variants check and map read (stage 4)
    ...(c?.actions.flatMap((a) => a.variants.flatMap((v) => [...(v.when ? conditionFields(v.when as Condition) : []), ...v.group?.key ?? [],
      ...Object.values(v.mapping).flatMap(sourceFields).map((k) => (k.startsWith("group.key.") ? k.slice(10) : k))])) ?? []),
  ]);
  const sideOf = (i: 0 | 1) => ruled.filter((k) => k.startsWith(`side_${i ? "b" : "a"}.`)).map((k) => k.slice(7));
  const of = (i: 0 | 1) => [...new Set([...sideOf(i),
    ...spec.sides[i].filter.map((f) => f.field), ...pairs.map((f) => sideRef(f, i)),
    ...(spec.measure ? [spec.measure.field] : []), ...(directionMapped[i] ? ["direction"] : []),
    ...(spec.sides[i].amount_sign === "negate" ? ["amount_minor"] : []),
  ])].sort();
  return [of(0), of(1)];
}

export type WorkflowFact = { spaceId: string; name: string; archived: boolean; versions: ReadonlySet<number> };
const clausesOf = (c: Condition): { field: string; op: keyof typeof OP_TEXT }[] =>
  ("all" in c ? c.all : c.any).flatMap((p) => ("all" in p || "any" in p ? clausesOf(p as Condition) : [p as { field: string; op: keyof typeof OP_TEXT }]));

/**
 * What is wrong with a recon version's approval setup (DEC-052 rev 2): a workflow that is gone, of another space,
 * archived or pinned at a version never published; a rule checking a field its sides no longer read, or comparing a
 * field in a way its kind doesn't offer. A save keeps these as warnings; submit and approve refuse on the first.
 */
export function checkApprovals(approvals: ReconApprovalSpec | undefined, catalog: readonly CatalogField[], workflows: ReadonlyMap<string, WorkflowFact>, spaceId: string): string[] {
  const out: string[] = [];
  for (const change of TRIGGERS) {
    const w = approvals?.changes[change]?.workflow;
    if (!w) continue;
    const label = TRIGGER_LABEL[change];
    for (const ref of [...(w.default ? [w.default] : []), ...w.rules.map((r) => r.workflow)]) {
      const f = workflows.get(ref.id);
      const msg = !f || f.spaceId !== spaceId ? `${label}: a picked workflow no longer exists. Pick another one.`
        : f.archived ? `${label}: workflow “${f.name}” is archived. Pick another one.`
          : !f.versions.has(ref.version) ? `${label}: version ${ref.version} of “${f.name}” was never published. Pick a published version.` : null;
      if (msg && !out.includes(msg)) out.push(msg);
    }
    for (const r of w.rules) {
      const where = `${label} · rule “${r.name}”`;
      const lost = conditionFields(r.when).filter((k) => !catalog.some((c) => c.key === k));
      if (lost.length) out.push(`${where}: a field it checks is no longer read from the sources (${[...new Set(lost)].join(", ")}).`);
      for (const c of clausesOf(r.when)) {
        const f = catalog.find((x) => x.key === c.field);
        if (f && !OPS_BY_KIND[f.kind].includes(c.op)) out.push(`${where}: ${f.label} can't be compared with “${OP_TEXT[c.op]}”.`);
      }
    }
  }
  return out;
}

/** A connector as the recon check needs it: its reviewed versions (published once) and their operations. */
export type ConnectorFact = {
  name: string; disabled: boolean;
  versions: ReadonlyMap<number, { operations: ReadonlyMap<string, { name: string; request: readonly OpField[]; presets: ReadonlySet<string>; auto: ReadonlySet<string> }> }>;
};
/** The catalog keys a source reads (a field, a template's fields, a lookup's key). */
export function sourceFields(src: Source): string[] {
  if (src.kind === "field") return [src.key];
  if (src.kind === "template") return templateParts(src.text).flatMap((p) => (p.field ? [p.field.key] : []));
  if (src.kind === "lookup") return sourceFields(src.key);
  return [];
}

/**
 * What is wrong with a recon version's actions (stage 4): a connector gone, a version never published, an operation
 * the version doesn't have, a mapped path that isn't a request field, a required field neither mapped nor fixed nor
 * auto, a field the sides no longer read. Each names the change, action and variant. A save keeps these as warnings;
 * submit and approve refuse on the first.
 */
export function checkActions(approvals: ReconApprovalSpec | undefined, catalog: readonly CatalogField[], connectors: ReadonlyMap<string, ConnectorFact>): string[] {
  const out: string[] = [];
  const known = new Set([...catalog, ...APPROVAL_FIELDS].map((f) => f.key));
  for (const change of TRIGGERS) {
    for (const action of approvals?.changes[change]?.actions ?? []) {
      for (const v of action.variants) {
        const where = `${TRIGGER_LABEL[change]} · ${action.name} · ${v.name}`;
        const c = connectors.get(v.operation.connectorId);
        if (!c) { out.push(`${where}: the connector picked no longer exists. Pick another one.`); continue; }
        const ver = c.versions.get(v.operation.version);
        if (!ver) { out.push(`${where}: version ${v.operation.version} of “${c.name}” was never published. Pick a published version.`); continue; }
        const op = ver.operations.get(v.operation.key);
        if (!op) { out.push(`${where}: “${c.name}” version ${v.operation.version} has no operation ${v.operation.key}.`); continue; }
        const paths = new Set(fieldPaths(op.request));
        for (const p of Object.keys(v.mapping)) if (!paths.has(p)) out.push(`${where}: ${p} isn't a request field of ${op.name}.`);
        const required = (fs: readonly OpField[], prefix: string): string[] => fs.flatMap((f) => {
          const p = `${prefix}${f.name}`;
          return f.children?.length ? required(f.children, `${p}.`) : f.required && !(p in v.mapping) && !op.presets.has(p) && !op.auto.has(p) ? [p] : [];
        });
        for (const p of required(op.request, "")) out.push(`${where}: ${p} is required. Map it, or give it a fixed or auto value.`);
        const reads = [...(v.when ? conditionFields(v.when as Condition) : []), ...Object.values(v.mapping).flatMap(sourceFields)];
        const usedAccounts = new Set(Object.values(v.mapping).flatMap((src) => (src.kind === "account" ? [src.account] : src.kind === "template" ? templateParts(src.text).flatMap((p) => (p.account ? [p.account.key] : [])) : [])));
        for (const k of usedAccounts) if (!approvals!.accounts.find((a) => a.key === k)?.number) out.push(`${where}: account ${k} has no number. Enter it under Accounts.`);
        // grouped (stage 5, design §4.4 check 6): a posting on an approval, keyed by fields a group can share
        const grouped = v.per === "group" && v.group;
        if (grouped && action.kind !== "posting") out.push(`${where}: only a posting action is sent grouped. Make it a posting, or send one call per item.`);
        if (grouped && action.on.event === "rejected") out.push(`${where}: a rejected change posts nothing to group. Group it on an approval.`);
        const lostKeys: string[] = [];
        for (const k of grouped ? v.group!.key : []) {
          const f = catalog.find((x) => x.key === k);
          if (!f) lostKeys.push(k);
          else if (!isKeyField(f)) out.push(`${where}: ${fieldName(k)} can't be a group key. Pick a text, date, list or number field.`);
        }
        if (lostKeys.length) out.push(`${where}: a group key is no longer read from the sources (${lostKeys.map(fieldName).join(", ")}).`);
        const groupKnown = new Set(grouped ? groupFields(v.group!.key, catalog).map((f) => f.key) : []);
        if (!grouped && reads.some((k) => k.startsWith("group."))) out.push(`${where}: it reads the group's values (total, count, key), which only a grouped variant has.`);
        const lost = [...new Set(reads.filter((k) => k && !known.has(k) && !groupKnown.has(k) && !(k.startsWith("group.") && !grouped)))];
        if (lost.length) out.push(`${where}: a field it reads is no longer read from the sources (${lost.map(fieldName).join(", ")}).`);
      }
    }
  }
  return out;
}

/**
 * What a grouped variant reads from the first break of each group only (stage 5, review C1): outside an item list
 * (an array request field), a break or side field that is neither one of its keys nor money (money reads the group's
 * total). Warnings, never refusing: a field every break of a group shares by its data is right as it is.
 */
export function firstItemReads(approvals: ReconApprovalSpec | undefined, catalog: readonly CatalogField[], connectors: ReadonlyMap<string, ConnectorFact>): string[] {
  const out: string[] = [];
  for (const change of TRIGGERS) {
    for (const action of approvals?.changes[change]?.actions ?? []) {
      for (const v of action.variants) {
        if (v.per !== "group" || !v.group) continue;
        const op = connectors.get(v.operation.connectorId)?.versions.get(v.operation.version)?.operations.get(v.operation.key);
        const arrays = op ? arrayPaths(op.request) : [];
        const reads = Object.entries(v.mapping).filter(([p]) => !arrays.some((a) => p.startsWith(`${a}.`))).flatMap(([, src]) => sourceFields(src));
        const first = [...new Set(reads)].flatMap((k) => {
          const f = catalog.find((x) => x.key === k);
          return f && ["break", "side_a", "side_b"].includes(f.group) && f.kind !== "money" && !v.group!.key.includes(k) ? [f.label] : [];
        });
        if (!first.length) continue;
        const one = first.length === 1;
        out.push(`${TRIGGER_LABEL[change]} · ${action.name} · ${v.name}: ${first.length > 2 ? `${first.slice(0, -1).join(", ")} and ${first.at(-1)}` : first.join(" and ")} ${one ? "is" : "are"} read from the first item of each group only. ${one ? "Make it a group key, or map it" : "Make them group keys, or map them"} inside an item list.`);
      }
    }
  }
  return out;
}
