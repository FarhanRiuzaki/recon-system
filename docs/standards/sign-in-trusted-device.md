# Sign-in standard: trusted device (NIP → OTP)

Status: standard, owner decision 2026-11-26. Applies to every app built on this starter kit (recon-system, the
MEGA-SDD Console and the next ones). Reference implementation: MEGA-SDD Console, branch `feat/trusted-device`
(Jumpserver-POC, apps/ws-console), deployed there first.

## Why

People sign in many times a day and switch between accounts (an admin account and a developer account for testing).
Typing the directory password every time is friction that buys nothing on a browser that has already proven itself.
The owner wants: after the first full sign-in, the next ones on the same browser are **NIP → OTP**, with a clear way to
change account. A bank app keeps **two factors**, so the password is skipped only where the device itself is the second
factor.

## The flow

| Case | Steps |
|---|---|
| First sign-in, registration, MFA enrolment | NIP → directory (LDAP) password → TOTP (enrol if needed) → "Trust this device" (on by default) |
| Trusted browser, remembered account | Pick the account (or type its NIP) → TOTP |
| Trusted browser, **another account** ("Use another account") | NIP → password → TOTP → may be trusted too |
| New browser, expired or revoked trust, cleared cookies | Full flow: NIP → password → TOTP |
| Account disabled in the directory, password expired, MFA not enrolled, any existing guard | Full flow, or refused exactly as today; no guard is skipped |

The NIP step answers the same way for an unknown NIP, a known NIP without trust on this browser and a disabled
account: no user enumeration.

## Sign-in page

- When the browser holds trust for one or more accounts (at most 5), the first screen lists them (name and NIP as the
  app already shows identity) with one click to continue to the OTP.
- **Use another account**: always visible; goes to an empty NIP field and the normal flow.
- **Forget on this device**: per remembered account; revokes that device's trust (audited).
- Keyboard and screen-reader friendly; the sign-in look stays the app's own.

## Security model

- Factor 1: possession of the trusted device (its token). Factor 2: the TOTP code. The password is the first factor on
  any device that is not trusted.
- Device token: random, at least 256 bits; the browser gets it in a cookie `HttpOnly`, `Secure` (when served over TLS),
  `SameSite=Strict`, `Path=/`. The database keeps only its hash, with user, created, last used, expiry, user-agent
  label and created IP.
- Lifetime: 30 days sliding, absolute cap 90 days; at most 5 trusted devices per user (oldest evicted).
- A token is bound to one user: a cookie for another account gives the full flow.
- OTP attempts on the NIP → OTP path count toward the same rate limits and lockout as the full flow.
- Revoked automatically on password change, MFA reset or re-enrolment, and account disable. The user revokes their own
  devices from their account security page; an admin revokes a person's devices from the user page.
- Every trust created, used and revoked is written to the audit log (actor, device label, IP).
- Admin and superadmin accounts follow the same rules unless the app has a stricter policy for them, which then wins.

## Tests every implementation carries

Full sign-in with trust → sign out → NIP → OTP only; another NIP on the same browser → full flow; revoked or expired
trust → full flow; forget on this device; password change revokes all; OTP lockout still applies on the short path; no
enumeration on the NIP step.
