// Customer data in a report (spec "Masking"): a masked value keeps its last four characters.
/** `"1234567890"` → `"······7890"`; four characters or fewer are all dots. */
export function maskValue(v: string): string {
  if (v.length <= 4) return "·".repeat(v.length);
  return "·".repeat(v.length - 4) + v.slice(-4);
}
