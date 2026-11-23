import { type Clause, type Condition, NO_VALUE_OPS } from "@starterkit/shared/conditions";
import type { ReconApprovalInput, ReconApprovalSpec, ReconWarning } from "@starterkit/shared/contracts/recon";
import { TRIGGERS } from "@starterkit/shared/workflows";

// The Approval step's draft (DEC-052 rev 2): what of it the recon draft can hold now, and the copy of an unfinished
// rule this browser keeps meanwhile. Pure.

type Rule = NonNullable<ReconApprovalSpec["changes"]["unmatch"]>["workflow"]["rules"][number];
const clauseDone = (c: Clause) => !!c.field && (NO_VALUE_OPS.includes(c.op) || (Array.isArray(c.value) ? c.value.some((v) => v.trim()) : !!c.value?.trim()));
/** Every clause has a field and, where its comparison takes one, a value. */
export const condDone = (c: Condition): boolean => { const p = "all" in c ? c.all : c.any; return p.length > 0 && p.every((x) => ("field" in x ? clauseDone(x) : condDone(x))); };
export const ruleDone = (r: Rule) => !!r.name.trim() && condDone(r.when as Condition) && !!r.workflow.id;

/**
 * The setup as the contract takes it: finished rules (names trimmed), each change's default and actions, the accounts
 * and lookups; a change with no default, rules or actions goes, and an empty setup is undefined. `unfinished` = a rule was left out.
 */
export function savable(a: ReconApprovalInput): { approvals: ReconApprovalSpec | undefined; unfinished: boolean } {
  const changes: ReconApprovalSpec["changes"] = {};
  let unfinished = false;
  for (const k of TRIGGERS) {
    const s = a.changes[k];
    if (!s) continue;
    const rules = s.workflow.rules.filter((r) => { const ok = ruleDone(r); if (!ok) unfinished = true; return ok; }).map((r) => ({ ...r, name: r.name.trim() }));
    // the actions as the parsed spec holds them (the step edits only the workflow part)
    const actions = (s.actions ?? []) as NonNullable<ReconApprovalSpec["changes"]["unmatch"]>["actions"];
    if (!s.workflow.default && !rules.length && !actions.length) continue;
    changes[k] = { workflow: { default: s.workflow.default, rules }, actions };
  }
  const accounts = a.accounts ?? [], lookups = a.lookups ?? [];
  const any = Object.keys(changes).length || accounts.length || lookups.length;
  return { approvals: any ? { accounts, lookups, changes } : undefined, unfinished };
}

export const DEFAULT_CHAIN_TEXT = "Default · 1 of Reviewer or Space admin";

type ChangeSetup = ReconApprovalInput["changes"][(typeof TRIGGERS)[number]];
/**
 * One row of the Approval step's table: who approves (the picked workflow, else the default chain, and how many rules
 * pick another in some cases) and what is sent to the bank (the actions by name, or Nothing). `nameOf` = a live
 * workflow's name, null when it is gone.
 */
export function approvalRow(s: ChangeSetup | undefined, nameOf: (id: string) => string | null): { who: string; bank: string } {
  const w = s?.workflow;
  const base = w?.default ? (nameOf(w.default.id) ?? "A workflow no longer available") : DEFAULT_CHAIN_TEXT;
  const n = w?.rules.length ?? 0;
  const actions = s?.actions ?? [];
  return {
    who: n ? `${base} · ${n} ${n === 1 ? "rule" : "rules"} for some cases` : base,
    bank: actions.length ? actions.map((a) => a.name.trim() || "An action without a name").join(", ") : "Nothing",
  };
}

/** The kept copy (`{ base, approvals }`), when the saved draft still holds what it was based on; else null. */
export function keptCopy(stored: string | null, saved: ReconApprovalInput | undefined): ReconApprovalInput | null {
  if (!stored) return null;
  try {
    const k = JSON.parse(stored) as { base?: string; approvals?: ReconApprovalInput };
    return k.approvals && k.base === JSON.stringify(saved ?? null) ? k.approvals : null;
  } catch { return null; }
}

/** The changes whose approval setup differs between the live version and this one (none without a live version). */
export function approvalChanges(live: ReconApprovalInput | undefined, next: ReconApprovalInput | undefined, hasLive: boolean): (typeof TRIGGERS)[number][] {
  if (!hasLive) return [];
  return TRIGGERS.filter((k) => JSON.stringify(live?.changes[k] ?? null) !== JSON.stringify(next?.changes[k] ?? null));
}

/**
 * The draft's warnings by the step the API gives each (review 24 Nov; never read from the words): `approval` = how many
 * the Approval step holds (its rules, picked workflows and actions, Undo match's included), shown on Matching as one
 * notice; `pass(no)` = a pass's own (a tolerance), under that pass; `page` = the rest of Sources and Matching. A
 * schedule warning (carry over) is shown live on the Schedule step.
 */
export function stepWarnings(ws: readonly ReconWarning[]): { approval: number; pass: (no: number) => string[]; page: string[] } {
  return {
    approval: ws.filter((w) => w.step === "approval").length,
    pass: (no) => ws.filter((w) => w.step === "matching" && w.pass === no).map((w) => w.text),
    page: ws.filter((w) => (w.step === "sources" || w.step === "matching") && w.pass === null).map((w) => w.text),
  };
}
/** The Matching step's one line about the Approval step. */
export const approvalNotice = (n: number) => `Approval and posting has ${n} ${n === 1 ? "thing" : "things"} to finish.`;
