/** contracts/password.ts `Password` minimum (zod stays out of client code; password.test.ts checks they agree). */
export const PASSWORD_MIN = 12;

/**
 * The new-password requirements, ticked off while the user types (`PasswordChecks`): the length with how many are
 * left, and with a repeat field (`again`) that both match.
 */
export function passwordChecks(password: string, again?: string): { label: string; met: boolean }[] {
  const left = PASSWORD_MIN - password.length;
  return [
    { label: `At least ${PASSWORD_MIN} characters${left > 0 && password ? ` (${left} more)` : ""}`, met: left <= 0 },
    ...(again === undefined ? [] : [{ label: "The two passwords match", met: password !== "" && password === again }]),
  ];
}

const LOWER = "abcdefghijkmnpqrstuvwxyz", UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ", DIGITS = "23456789", MARKS = "-_!#";
/** An unbiased index below `n` from Web Crypto (rejection sampling). */
function randomBelow(n: number): number {
  const buf = new Uint32Array(1), limit = Math.floor(0x100000000 / n) * n;
  for (;;) { crypto.getRandomValues(buf); if (buf[0]! < limit) return buf[0]! % n; }
}
/**
 * A password to hand over (Create user: Generate password), as the API's temporaryPassword makes one: 18 characters
 * without look-alikes, one of each class, shuffled; from Web Crypto, never Math.random.
 */
export function generatePassword(): string {
  const pick = (set: string) => set[randomBelow(set.length)]!;
  const all = LOWER + UPPER + DIGITS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(MARKS), ...Array.from({ length: 14 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join("");
}
