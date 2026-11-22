import type { ConnectorSpec, OperationSpec } from "@starterkit/shared/contracts/integrations";
import { fieldPaths, OPERATIONS_MAX, type SpecOperation, TIMEOUT_DEFAULT_MS } from "@starterkit/shared/integrations";

// A connector draft's operations as the editor changes them (DEC-053), pure: a field renamed carries what points to it,
// what points to a field that is gone is dropped before saving, and an operation is changed by its place in the list.

const moved = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(`${from}.`) ? `${to}${p.slice(from.length)}` : p);

/** `op` with every path at or under `from` (fixed values, masks, success rule, reference) moved to `to`. */
export function renamePath(op: OperationSpec, from: string, to: string): OperationSpec {
  if (!from || from === to) return op;
  return {
    ...op,
    presets: Object.fromEntries(Object.entries(op.presets).map(([k, v]) => [moved(k, from, to), v])),
    auto: Object.fromEntries(Object.entries(op.auto ?? {}).map(([k, v]) => [moved(k, from, to), v])),
    masked: op.masked.map((p) => moved(p, from, to)),
    success: op.success ? { ...op.success, field: moved(op.success.field, from, to) } : null,
    reference: op.reference ? moved(op.reference, from, to) : null,
  };
}

/** `op` without fixed values, masks, a success rule or a reference that point to a field it no longer has. */
export function prune(op: OperationSpec): OperationSpec {
  const req = new Set(fieldPaths(op.request)), res = new Set(fieldPaths(op.response));
  return {
    ...op,
    presets: Object.fromEntries(Object.entries(op.presets).filter(([k]) => req.has(k))),
    auto: Object.fromEntries(Object.entries(op.auto ?? {}).filter(([k]) => req.has(k) && !(k in op.presets))),
    masked: op.masked.filter((p) => req.has(p) || res.has(p)),
    success: op.success && res.has(op.success.field) ? op.success : null,
    reference: op.reference && res.has(op.reference) ? op.reference : null,
  };
}

/** `list` with the item at `i` replaced. */
export const replaceAt = <T>(list: readonly T[], i: number, v: T): T[] => list.map((x, j) => (j === i ? v : x));

/**
 * `spec` with the operations read from a whole spec: one with the same key is updated (name, method, path, fields;
 * its time limit, success rule, masks and fixed values stay where they still apply), the others are added up to the
 * limit. `fillAddress`: the development address and Host take the spec's while they are empty.
 */
export function mergeSpecOperations(spec: ConnectorSpec, pasted: { operations: readonly SpecOperation[]; baseUrl: string | null }, fillAddress: boolean) {
  let added = 0, updated = 0, skipped = 0;
  const operations = [...spec.operations];
  for (const p of pasted.operations) {
    const i = operations.findIndex((o) => o.key === p.key);
    if (i >= 0) {
      const o = operations[i]!;
      // what the operation set stays; the spec's suggestions fill only fields it has no fixed or auto value for
      const suggested = Object.fromEntries(Object.entries(p.auto).filter(([k]) => !(k in o.presets)));
      operations[i] = prune({ ...o, name: p.name, method: p.method, path: p.path, request: p.request, response: p.response, success: o.success ?? p.success, auto: { ...suggested, ...o.auto } });
      updated++;
    } else if (operations.length < OPERATIONS_MAX) {
      operations.push({ ...p, timeoutMs: TIMEOUT_DEFAULT_MS, reference: null, masked: [], presets: {} });
      added++;
    } else skipped++;
  }
  const dev = spec.environments.dev;
  const host = pasted.baseUrl ? new URL(pasted.baseUrl).hostname : "";
  const environments = fillAddress && pasted.baseUrl && !dev.baseUrl
    ? { ...spec.environments, dev: { ...dev, baseUrl: pasted.baseUrl, host: dev.host || host } }
    : spec.environments;
  return { spec: { ...spec, operations, environments }, added, updated, skipped };
}
