// An amount as the screens print it, pure (lib/shared): the recon results and the breaks queue share it.
import { formatMinor } from "@starterkit/ui/lib/format";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";

/** "181,000.00" from minor units of `ccy`; the minor units as they are for a currency the product doesn't know; "—" for none. */
export function amountText(minor: string | null, ccy: string | null): string {
  if (minor === null) return "—";
  const exp = ccy ? CURRENCY_EXPONENT[ccy] : undefined;
  return exp === undefined ? minor : formatMinor(BigInt(minor), exp);
}
