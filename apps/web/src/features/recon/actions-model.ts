import type { OpField } from "@starterkit/shared/integrations";
import { type CatalogField, type Condition, conditionText, groupFields } from "@starterkit/shared/conditions";
import type { ConnectorOperationsDto } from "@starterkit/shared/contracts/integrations";
import type { ActionSpec, VariantSpec } from "@starterkit/shared/contracts/recon";
import { isTransform, type Source } from "@starterkit/shared/mapping";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { condDone } from "./approval-model";
import { changeText } from "./changes-model";

// The Approval step's actions editor (stage 4), pure: an action as a sentence, a request's leaf fields with what fills
// them, the required ones a variant leaves empty, and typed changes (transforms) read back.

type ActionLike = { name: string; kind: "posting" | "notify"; on: { event: "level_approved"; level: number } | { event: "approved" } | { event: "rejected" } };
/** "When level 2 approves, send Status" / "When the change is approved, post Post to GL". */
export function actionSentence(a: ActionLike): string {
  const when = a.on.event === "level_approved" ? `When level ${a.on.level} approves` : a.on.event === "approved" ? "When the change is approved" : "When the change is rejected";
  return `${when}, ${a.kind === "posting" ? "post" : "send"} ${a.name}`;
}

type OpLike = { request: readonly OpField[]; fixed: readonly string[]; auto: readonly string[] };
export type Leaf = { path: string; required: boolean; filledBy: "fixed" | "auto" | null };
/** The request's leaf fields, in order, and whether the operation fills them itself (a fixed or auto value). */
export function requestLeaves(op: OpLike, fields: readonly OpField[] = op.request, prefix = ""): Leaf[] {
  return fields.flatMap((f) => {
    const path = `${prefix}${f.name}`;
    if (f.children?.length) return requestLeaves(op, f.children, `${path}.`);
    return [{ path, required: f.required, filledBy: op.fixed.includes(path) ? "fixed" as const : op.auto.includes(path) ? "auto" as const : null }];
  });
}

/** The required fields a variant's mapping leaves empty (the operation's fixed and auto ones fill themselves). */
export function mappingGaps(mapping: Readonly<Record<string, Source>>, op: OpLike): string[] {
  return requestLeaves(op).filter((l) => l.required && !l.filledBy && !(l.path in mapping)).map((l) => l.path);
}

/** Changes typed as "amount:minor, pad_left:16:0": the ones known, in order, and the ones not. */
export function parseTransforms(text: string): { list: string[]; bad: string[] } {
  const parts = text.split(",").map((t) => t.trim()).filter(Boolean);
  return { list: parts.filter(isTransform), bad: parts.filter((t) => !isTransform(t)) };
}

const sourceGap = (path: string, s: Source): string | null =>
  s.kind === "template" && !s.text.trim() ? `${path}: write its template or remove the mapping.`
    : s.kind === "lookup" && !s.table ? `${path}: pick its lookup table or remove the mapping.`
      : s.kind === "account" && !s.account ? `${path}: pick its account or remove the mapping.`
        : s.kind === "field" && !s.key ? `${path}: pick its recon field or remove the mapping.` : null;

/** Whether an action's variants may send grouped (stage 5): a posting fired on an approval, never a reject or a notify. */
export const groupable = (a: Pick<ActionLike, "kind" | "on">) => a.kind === "posting" && a.on.event !== "rejected";

/**
 * Why the action editor's Done is refused (or the live preview sends the saved action instead), or null: what the
 * contract would refuse on save — a name, each variant's name, operation and finished conditions, each mapped source
 * complete. The client can't run the zod contract (types only, AGENTS.md §9), so this mirrors it.
 */
export function unfinishedReason(a: ActionSpec): string | null {
  if (!a.name.trim()) return "Name the action first.";
  for (const [i, x] of a.variants.entries()) {
    if (!x.name.trim()) return `Name variant ${i + 1}.`;
    if (!x.operation.key || !x.operation.connectorId) return `Pick where ${x.name} sends to.`;
    if (x.when && !condDone(x.when as Condition)) return `Finish the conditions of ${x.name}.`;
    if (x.per === "group" && !groupable(a)) return `${x.name} sends grouped, which only a posting on an approval does. Send it one per item.`;
    if (x.per === "group" && x.group?.at === "cutoff" && !x.group.cutoff) return `Give ${x.name} its cutoff time.`;
    for (const [path, s] of Object.entries(x.mapping)) { const gap = sourceGap(path, s as Source); if (gap) return gap; }
  }
  return null;
}

/** The live preview's body: the action as edited once it is finished (else the saved one answers), the accounts as edited. */
export function previewBody(change: string, action: number, itemId: string, draft: ActionSpec, accounts: readonly { key: string; label: string; number: string; currency: string }[]) {
  return { change, action, itemId, ...(unfinishedReason(draft) ? {} : { draft }), accounts };
}

export type Ops = ConnectorOperationsDto["items"];
/** The connector, its version and the operation a variant sends to (each undefined once gone). */
export const opOf = (ops: Ops, ref: VariantSpec["operation"]) => {
  const c = ops.find((x) => x.id === ref.connectorId);
  const v = c?.versions.find((x) => x.version === ref.version);
  return { connector: c, version: v, op: v?.operations.find((o) => o.key === ref.key) };
};

/** An amount of 0 or below (the contract's `zeroOrNegative`): no call, or the amount without its sign with the sides swapped by the mapping. */
export const ZERO_OR_NEGATIVE = {
  label: "An amount of 0 or below",
  options: { skip: "Skip it", absolute_swap: "Post it without the sign, sides swapped" },
} as const satisfies { label: string; options: Record<VariantSpec["zeroOrNegative"], string> };
export const PER_TEXT: Record<VariantSpec["per"], string> = { item: "One call per item", request: "One call per request", group: "Grouped, one call per group" };

type SetupLike = { accounts: readonly { key: string; label: string }[] };
/** Where a mapped value comes from, in words. */
export function sourceText(s: Source, fields: readonly CatalogField[], setup: SetupLike): string {
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? "A field no longer read";
  switch (s.kind) {
    case "field": return [label(s.key), ...s.transforms.map(changeText)].join(" · ");
    case "const": return `Fixed value “${s.value}”`;
    case "template": return `Template “${s.text}”`;
    case "lookup": return `${sourceText(s.key, fields, setup)} looked up in ${s.table}${s.fallback !== undefined ? `, else “${s.fallback}”` : ""}`;
    case "account": { const a = setup.accounts.find((x) => x.key === s.account); return `${a ? a.label || a.key : "An account no longer set up"}'s ${s.part === "label" ? "name" : s.part}`; }
  }
}

/**
 * A variant as the checker reads it: its condition, where it sends, its mapping (in the request's order, masked ones
 * marked), how and when it sends, and what an amount of 0 or below does.
 */
export function variantFacts(v: VariantSpec, ops: Ops, catalog: readonly CatalogField[], setup: SetupLike) {
  const { connector, version, op } = opOf(ops, v.operation);
  const fields = v.per === "group" && v.group ? [...groupFields(v.group.key, catalog), ...catalog] : catalog;
  const order = op ? requestLeaves(op).map((l) => l.path) : [];
  const paths = [...order.filter((p) => p in v.mapping), ...Object.keys(v.mapping).filter((p) => !order.includes(p))];
  const label = (k: string) => catalog.find((f) => f.key === k)?.label ?? "A field no longer read";
  const g = v.group;
  const sent = g?.at === "cutoff" ? `sent at ${g.cutoff ?? "a cutoff not set"} ${APP_TIME_ZONE_LABEL}` : "sent at day close";
  return {
    name: v.name,
    when: v.when ? conditionText(v.when as Condition, catalog) : "Every item",
    sends: connector && version && op ? `${connector.name} · version ${version.version} · ${op.name}` : "An operation no longer available",
    mapping: paths.map((p) => ({ field: p, from: sourceText(v.mapping[p] as Source, fields, setup), masked: !!op?.masked.includes(p) })),
    per: v.per === "group" && g
      ? (g.key.length ? `Grouped: items with the same ${g.key.map(label).join(", ")} and currency, ${sent}` : `Grouped: every approved item of one currency, ${sent}`)
      : PER_TEXT[v.per],
    zero: ZERO_OR_NEGATIVE.options[v.zeroOrNegative],
  };
}

/** The variants of `a` new or different from the live version's action of the same name (none without a live version). */
export function changedVariants(live: readonly ActionSpec[] | undefined, a: ActionSpec, hasLive: boolean): Set<number> {
  if (!hasLive) return new Set();
  const was = live?.find((x) => x.name === a.name);
  return new Set(a.variants.flatMap((v, i) => {
    const old = was?.variants.find((x) => x.name === v.name);
    return old && JSON.stringify(old) === JSON.stringify(v) ? [] : [i];
  }));
}
