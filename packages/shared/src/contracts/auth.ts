import { z } from "zod";
import { Password } from "./password";
import { UserDto } from "./users";

export type AuthMethod = "password" | "ldap" | "google" | "apple" | "device";

export const LoginBody = z.object({
  login: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
  /** Auto selects the registered account provider; explicit methods remain supported for API clients. */
  method: z.enum(["auto", "password", "ldap"]).default("auto"),
  /** Deep link to return to; the server keeps it only when internal (afterSignIn). */
  next: z.string().max(2048).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

/** Where the browser goes next: `/login/2fa[?next=…]` when a second factor is due, else the signed-in landing page. */
export const LoginResult = z.object({ next: z.string() });
export type LoginResult = z.infer<typeof LoginResult>;

/**
 * `code` is a 6-digit one-time code or a recovery code. `trust`: after a password, trust this browser (DEC-065); the
 * answer then carries the device token, which the web keeps in its `sk_device` cookie. Ignored on a device sign-in.
 */
export const TwoFactorBody = z.object({ code: z.string().trim().min(6).max(32), next: z.string().max(2048).optional(), trust: z.boolean().optional() });
export type TwoFactorBody = z.infer<typeof TwoFactorBody>;

/** A trusted-device token as the web's `sk_device` cookie holds it (32 random bytes, base64url). */
const DeviceToken = z.string().min(1).max(64);
/** Every token one browser holds: at most 5 trusted accounts. */
const DeviceTokens = z.array(DeviceToken).max(5);

/** POST /v1/auth/devices (API-internal, the web's sign-in page): the tokens of this browser. */
export const TrustedAccountsBody = z.object({ tokens: DeviceTokens });
export type TrustedAccountsBody = z.infer<typeof TrustedAccountsBody>;

/** An account this browser may continue as: `slot` is the token's index in the body, `login` its username (NIP). */
export const TrustedAccountDto = z.object({ slot: z.number().int(), name: z.string(), login: z.string() });
export type TrustedAccountDto = z.infer<typeof TrustedAccountDto>;
export const TrustedAccountsDto = z.object({ accounts: z.array(TrustedAccountDto) });
export type TrustedAccountsDto = z.infer<typeof TrustedAccountsDto>;

/** POST /v1/auth/device: sign in as `login` with this browser's trust instead of a password. */
export const DeviceLoginBody = z.object({ login: z.string().min(1).max(254), tokens: DeviceTokens, next: z.string().max(2048).optional() });
export type DeviceLoginBody = z.infer<typeof DeviceLoginBody>;

/** POST /v1/auth/device/forget: this browser stops trusting `login`'s account. */
export const ForgetDeviceBody = z.object({ token: DeviceToken, login: z.string().min(1).max(254) });
export type ForgetDeviceBody = z.infer<typeof ForgetDeviceBody>;

export const ForgotPasswordBody = z.object({ email: z.string().email().max(254) });
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export { Password };

export const ResetPasswordBody = z.object({ token: z.string().min(1).max(256), password: Password });
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

/** GET /v1/auth/context (API-internal, for the web's page guards): the signed-in user and their permissions in catalog order. */
/** `permissions`: every catalog name the user holds (the app's in catalog order, then added ones A–Z). */
export const AuthContextDto = z.object({ user: UserDto, permissions: z.array(z.string()) });
export type AuthContextDto = z.infer<typeof AuthContextDto>;
