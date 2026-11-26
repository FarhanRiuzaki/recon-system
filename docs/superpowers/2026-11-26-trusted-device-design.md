# Trusted device sign-in: design

Brief: `docs/standards/sign-in-trusted-device.md` (owner standard, 2026-11-26). Decision: DEC-065.

## Where trust applies

Only an account with two-factor authentication on can trust a browser: the device then replaces the password as the
first factor and the one-time code stays the second. An account without 2FA (and a Google/Apple sign-in) always
gets the full flow; nothing here changes it.

## API (`auth` module)

Table `trusted_devices` (owned by `auth`): `id`, `token_hash` (SHA-256 of 32 random bytes, unique), `user_id` (cascade),
`label` ("Chrome on macOS"), `ip`, `created_at`, `last_used_at`, `expires_at` (30 days after the last use),
`cap_at` (90 days after creation), `bound_hash` (SHA-256 of the user's password hash and TOTP secret when trusted).
A trust is live while `expires_at` and `cap_at` are ahead and the user's current `bound_hash` is the same, the user is
active and has 2FA on. At most 5 per user: a sixth evicts the oldest.

- `POST /v1/auth/devices` `{ tokens }` (≤ 5): the accounts this browser may continue as, `{ slot, name, login }`,
  one per user (newest trust), dead ones left out.
- `POST /v1/auth/device` `{ login, tokens, next? }`: through the sign-in gate (step `login`, the same limits as a
  password). A live trust of that login among the tokens → a challenge bound to the trust (`auth_challenges.device_id`)
  and `{ next: /login/2fa…, challenge }`; anything else (unknown login, no trust here, other user's trust, inactive,
  no 2FA) → the same `{ password: true }`. The attempt's reservation is released either way: no credential was tried.
- `POST /v1/auth/2fa` takes `trust` (boolean). A password challenge with `trust` → a new trust, its token in the answer
  (`device`), sign-in log `device_trusted`. A device challenge re-checks the trust in the transaction (else 401),
  slides it and signs in with method `device`. The OTP gate and backoff are the same on both paths.
- `POST /v1/auth/devices/forget` `{ token, login }`: deletes that trust when it is that login's; sign-in log
  `device_revoked`.
- Revocation: `revokeTrustedDevices(tx, userId, client)` beside every `endUserSessions` of a credential change
  (password change, reset by link, admin reset, deactivation) and on 2FA enable/disable; each revoked device writes
  `device_revoked`. The `bound_hash` check is the backstop for any path that changes the password or secret.
- Me: `GET /v1/me/devices` (paged), `DELETE /v1/me/devices/:id` (`me.device_revoke`). Users: `GET
  /v1/users/:id/devices` (`user.view`), `DELETE /v1/users/:id/devices/:did` (`user.edit`, actor rank,
  `user.device_revoke`). Shapes copy the sessions routes.
- Vocabulary: `AUTH_METHODS` + `device`, `AUTH_EVENTS` + `device_trusted`, `device_revoked`.

## Web (BFF)

- Cookie `sk_device`: sealed (iron-session, `SESSION_SECRET`), `{ tokens: string[] }` ≤ 5, `httpOnly`,
  `sameSite: "strict"`, `secure` with `COOKIE_SECURE`, `path: "/"`, 90 days. Sign-out leaves it.
- `/login`: the server lists the remembered accounts (`POST /v1/auth/devices`). With any, the first screen is the
  account picker (continue, "Forget on this device") and "Use another account"; typing a remembered login in the
  form makes the password optional.
- `POST /api/auth/device` `{ login, next }` and `POST /api/auth/device/forget` `{ slot, login }`, same-origin.
- `/login/2fa`: "Trust this device for 30 days", on by default, only after a password; the session cookie carries
  `trusted: true` for a device challenge.
- Security page and the user page: a "Trusted devices" panel like Sessions, with Revoke.

## Not covered

The directory gateway only checks passwords, so an account disabled in the directory but still active here can use a
live trust until it ends (30 days idle, 90 days at most) or the account is deactivated here.
