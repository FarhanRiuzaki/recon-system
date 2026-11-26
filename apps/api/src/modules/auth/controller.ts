// /v1/auth/{login,device,device/forget,devices,2fa,logout,forgot,reset,context}. The web keeps the cookie, CSRF and
// same-origin checks; here a full sign-in answers `token` and a pending second factor answers `challenge`. These routes
// answer before a session exists, so only `context` is guarded; the others read their body first.
import { Elysia } from "elysia";
import {
  AuthContextDto, DeviceLoginBody, ForgetDeviceBody, ForgotPasswordBody, LoginBody, ResetPasswordBody, TrustedAccountsBody, TwoFactorBody,
} from "@starterkit/shared/contracts/auth";
import { PERMISSIONS } from "@starterkit/shared/permissions";
import { body } from "../../kernel/parse";
import { bearer, guard } from "./guard";
import { forgetDevice, trustedAccounts } from "./devices";
import { deviceLogin, forgot, login, logout, reset, secondFactor } from "./service";

/** The routes of /v1/auth (the Google/Apple round trip and `/v1/auth/providers` are the oauth module's). */
export const authController = () =>
  new Elysia()
    .use(guard)
    .post("/v1/auth/login", async (c) => login(await body(c, LoginBody), c.client))
    /** Sign-in step 1 with this browser's trust instead of a password (DEC-065): a challenge, or `{ password: true }`. */
    .post("/v1/auth/device", async (c) => deviceLogin(await body(c, DeviceLoginBody), c.client))
    /** The accounts this browser's device tokens may continue as (API-internal: the web's sign-in page). */
    .post("/v1/auth/devices", async (c) => ({ accounts: await trustedAccounts((await body(c, TrustedAccountsBody)).tokens) }))
    /** "Forget on this device": ends the token's trust when it is that login's. `{ forgotten }`. */
    .post("/v1/auth/device/forget", async (c) => {
      const b = await body(c, ForgetDeviceBody);
      return { forgotten: await forgetDevice(b.token, b.login, c.client) };
    })
    .post("/v1/auth/2fa", async (c) => {
      const b = await body(c, TwoFactorBody);
      return secondFactor(c.request.headers.get("x-auth-challenge"), b, c.client);
    })
    /** Ends the bearer's session and/or deletes the `X-Auth-Challenge` challenge. Always `{ ok: true }`. */
    .post("/v1/auth/logout", async ({ request, client }) => {
      await logout(bearer(request.headers.get("authorization")), request.headers.get("x-auth-challenge"), client);
      return { ok: true };
    })
    .post("/v1/auth/forgot", async (c) => {
      await forgot((await body(c, ForgotPasswordBody)).email, c.client);
      return { ok: true };
    })
    .post("/v1/auth/reset", async (c) => {
      await reset(await body(c, ResetPasswordBody), c.client);
      return { ok: true };
    })
    /** The signed-in user and their permissions in catalog order (API-internal: the web's page guards). */
    .get("/v1/auth/context", ({ ctx }) => AuthContextDto.parse({ user: ctx.user, permissions: [...PERMISSIONS.filter((p) => ctx.perms.has(p)), ...[...ctx.perms].filter((p) => !(PERMISSIONS as readonly string[]).includes(p)).sort()] }), { guard: null });
