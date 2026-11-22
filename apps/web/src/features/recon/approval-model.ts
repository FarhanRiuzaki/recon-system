import { type Clause, type Condition, NO_VALUE_OPS } from "@starterkit/shared/conditions";
import type { ReconApprovalSpec } from "@starterkit/shared/contracts/recon";
import { TRIGGERS } from "@starterkit/shared/workflows";

// The Approval step's draft (DEC-052 rev 2): what of it the recon draft can hold now, and the copy of an unfinished
// rule this browser keeps meanwhile. Pure.

type Rule = NonNullable<ReconApprovalSpec["changes"]["unmatch"]>["workflow"]["rules"][number];
const clauseDone = (c: Clause) => !!c.field && (NO_VALUE_OPS.includes(c.op) || (Array.isArray(c.value) ? c.value.some((v) => v.trim()) : !!c.value?.trim()));
/** Every clause has a field and, where its comparison takes one, a value. */
export const condDone = (c: Condition): boolean => { const p = "all" in c ? c.all : c.any; return p.length > 0 && p.every((x) => ("field" in x ? clauseDone(x) : condDone(x))); };
export const ruleDone = (r: Rule) => !!r.name.trim() && condDone(r.when as Condition) && !!r.workflow.id;

/**
 * The setup as the contract takes it: finished rules (names trimmed), each change's default; a change left on the
 * default chain with no rules goes, and no change at all is undefined. `unfinished` = a rule was left out.
 */
export function savable(a: ReconApprovalSpec): { approvals: ReconApprovalSpec | undefined; unfinished: boolean } {
  const changes: ReconApprovalSpec["changes"] = {};
  let unfinished = false;
  for (const k of TRIGGERS) {
    const s = a.changes[k];
    if (!s) continue;
    const rules = s.workflow.rules.filter((r) => { const ok = ruleDone(r); if (!ok) unfinished = true; return ok; }).map((r) => ({ ...r, name: r.name.trim() }));
    if (!s.workflow.default && !rules.length) continue;
    changes[k] = { workflow: { default: s.workflow.default, rules } };
  }
  return { approvals: Object.keys(changes).length ? { changes } : undefined, unfinished };
}

/** The kept copy (`{ base, approvals }`), when the saved draft still holds what it was based on; else null. */
export function keptCopy(stored: string | null, saved: ReconApprovalSpec | undefined): ReconApprovalSpec | null {
  if (!stored) return null;
  try {
    const k = JSON.parse(stored) as { base?: string; approvals?: ReconApprovalSpec };
    return k.approvals && k.base === JSON.stringify(saved ?? null) ? k.approvals : null;
  } catch { return null; }
}

/** The changes whose approval setup differs between the live version and this one (none without a live version). */
export function approvalChanges(live: ReconApprovalSpec | undefined, next: ReconApprovalSpec | undefined, hasLive: boolean): (typeof TRIGGERS)[number][] {
  if (!hasLive) return [];
  return TRIGGERS.filter((k) => JSON.stringify(live?.changes[k] ?? null) !== JSON.stringify(next?.changes[k] ?? null));
}
