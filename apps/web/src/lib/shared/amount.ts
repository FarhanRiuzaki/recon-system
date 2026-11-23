// An amount as the screens print it, pure (lib/shared): the recon results and the breaks queue share it.
import { formatMinor } from "@starterkit/ui/lib/format";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";

/** "181,000.00" from minor units of `ccy`; the minor units as they are for a currency the product doesn't know; "—" for none. */
export function amountText(minor: string | null, ccy: string | null): string {
  if (minor === null) return "—";
  const exp = ccy ? CURRENCY_EXPONENT[ccy] : undefined;
  return exp === undefined ? minor : formatMinor(BigInt(minor), exp);
}

/**
 * The open amount as one tile: the first currency (the API puts the one with the most items first) as the value, the
 * others in the caption ("Also 5.00 EUR"); none open is 0 without a unit.
 */
export function amountTile(amounts: readonly { currency: string; amountMinor: string }[]): { value: string; unit?: string; caption?: string } {
  const [first, ...rest] = amounts;
  if (!first) return { value: "0" };
  return {
    value: amountText(first.amountMinor, first.currency), unit: first.currency,
    caption: rest.length ? `Also ${rest.map((a) => `${amountText(a.amountMinor, a.currency)} ${a.currency}`).join(", ")}` : undefined,
  };
}

/**
 * Text typed as an amount in major units, as the unmatch queue's amount filter sends it (contracts/breaks BreakListQuery
 * `amountMin`): digits and one point ("1,000.50" → "1000.50", ".5" → "0.5"), at most 15 digits before it and 6 after;
 * "" without a digit. A sign is dropped: the filter is on the absolute amount. A second point is refused: `prev` stays.
 */
export function majorAmount(text: string, prev = ""): string {
  const [whole = "", ...rest] = text.replace(/[^\d.]/g, "").split(".");
  if (rest.length > 1) return prev;
  const out = `${rest.length && !whole ? "0" : whole.slice(0, 15)}${rest.length ? `.${rest[0]!.slice(0, 6)}` : ""}`;
  return /\d/.test(out) ? out : "";
}
