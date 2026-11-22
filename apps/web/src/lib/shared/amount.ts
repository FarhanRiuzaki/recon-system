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
 * The open amount as one tile: the largest currency as the value, the others in the caption ("Also 5.00 EUR"); none
 * open is 0 without a unit.
 */
export function amountTile(amounts: readonly { currency: string; amountMinor: string }[]): { value: string; unit?: string; caption?: string } {
  const [first, ...rest] = amounts;
  if (!first) return { value: "0" };
  return {
    value: amountText(first.amountMinor, first.currency), unit: first.currency,
    caption: rest.length ? `Also ${rest.map((a) => `${amountText(a.amountMinor, a.currency)} ${a.currency}`).join(", ")}` : undefined,
  };
}
