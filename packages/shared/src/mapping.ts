// Mapping a recon's data onto a bank operation's request (design 2026-11-22-recon-approval-and-posting §4.5), zod-free
// and pure: the sources a request field takes, the changes (transforms) applied to a value, and the references a
// template makes, so the contract and the editor check the same way.

export type Transform = string;
export type Source =
  | { kind: "field"; key: string; transforms: Transform[] }
  | { kind: "const"; value: string }
  | { kind: "template"; text: string }
  | { kind: "lookup"; table: string; key: Source; fallback?: string }
  | { kind: "account"; account: string; part: "number" | "label" | "currency" };

/** The changes a value may go through, in order, as people read them. */
export const TRANSFORMS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /^date:[yMdHms\-/.: T]{2,30}$/, label: "date as a pattern (yyyy yy MM dd HH mm ss)" },
  { pattern: /^amount:minor$/, label: "amount in minor units (whole number, by the currency)" },
  { pattern: /^amount:major:[0-4]$/, label: "amount with N decimals" },
  { pattern: /^pad_left:\d{1,3}:.$/, label: "pad on the left to N with a character" },
  { pattern: /^pad_right:\d{1,3}:.$/, label: "pad on the right to N with a character" },
  { pattern: /^(trim|upper|lower|abs)$/, label: "trim, upper case, lower case, or without sign" },
  { pattern: /^truncate_left:\d{1,3}$/, label: "keep the last N characters" },
  { pattern: /^truncate_right:\d{1,3}$/, label: "keep the first N characters" },
  { pattern: /^default:.{0,100}$/, label: "a value when empty" },
];
export const isTransform = (t: string) => TRANSFORMS.some((x) => x.pattern.test(t));

/** `{…}` parts of a template: a field with changes (`{break.amount|amount:minor}`) or an account (`{accounts.key.part}`). */
export function templateParts(text: string): { field?: { key: string; transforms: string[] }; account?: { key: string; part: string } }[] {
  return [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => {
    const [ref, ...transforms] = m[1]!.split("|").map((s) => s.trim());
    const acc = /^accounts\.([a-z0-9_]+)\.(number|label|currency)$/.exec(ref!);
    return acc ? { account: { key: acc[1]!, part: acc[2]! } } : { field: { key: ref!, transforms } };
  });
}

export const ACTIONS_MAX = 10, VARIANTS_MAX = 20, MAPPED_MAX = 300, ACCOUNTS_MAX = 50, LOOKUPS_MAX = 20, LOOKUP_ROWS_MAX = 500;
