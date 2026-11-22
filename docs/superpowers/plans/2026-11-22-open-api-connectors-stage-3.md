# Open API connectors (stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin registers a Bank Mega Open API connector and its operations without code (Access → Open API), keeps
its credentials encrypted, and proves it works with "Get token" and "Try it" against the dev environment.

**Architecture:** A new global module `integrations` (no space, no RLS) owns connectors, their maker-checker versions
(the spec: environments' settings + operations with field trees), per-environment secrets (encrypted, never answered),
a token cache and a per-day external-id counter. The security profile `bank_mega_openapi_2_1` is pure code
(`node:crypto`), proven by round-trip tests against a fake bank that holds the RSA private key. Actions and posting
(stage 4) consume `sendOperation`.

**Scope cuts (spec §4.2, decided here):** the whole connector (settings + operations) is one reviewed version, so a recon
(stage 4) pins `{ connectorId, version, operation key }` instead of an operation's own version — same guarantee, one
review per change. The circuit breaker and the `password` (LDAP) grant belong to stage 4's runtime (no operation needs
LDAP yet); Try it is a person's single call and needs neither.

**Tech Stack:** Bun, Elysia, Drizzle, PG18, `node:crypto`, Next 16, React Query.

**Spec:** `docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md` (§4.2, §4.8 Manage Open API, §4.9,
§5 rows on tokens/TLS/PII, §7 stage 3, §8). Reference implementation read for the wire format: Recon-QR
`app/Services/Encryption/EncryptionService.php`, `app/Services/Api/ApiManagementService.php`,
`app/Http/Controllers/ApiManagement/ApiManagementController.php` (not copied: `SSL_VERIFYPEER false`, secrets in env,
no timeouts, random external ids).

## Global Constraints

- No new dependency: crypto through `node:crypto` (AES-256-CBC PKCS7, RSA PKCS#1 v1.5, HMAC-SHA512, PBKDF2-SHA256, SHA-256).
- Profile constants: PBKDF2 phrase `itec-cds-is-the-beast`, salt 16 random bytes, 1000 iterations, 32-byte key; IV 16 random bytes; token path `/realms/bpsecurity/protocol/openid-connect/token`; token life 300 s, refreshed 30 s before expiry.
- Wire format (Recon-QR, proven against the bank): `X-CREDENTIAL-KEY = Base64(RSA_PKCS1v15(publicKey, base64(key) + ":" + base64(iv)))`; body = `Base64(AES-256-CBC(json))`; `X-SIGNATURE = Base64(HMAC-SHA512(clientSecret, method + ":" + path(+ "?" + sorted query) + ":" + accessToken + ":" + hex(sha256(json)) + ":" + timestamp))`; `X-TIMESTAMP` = UTC `yyyy-MM-ddTHH:mm:ss+00:00`; headers `Authorization: Bearer`, `Content-Type: application/json`, `X-PARTNER-ID`, `CHANNEL-ID`, `Host`, `X-EXTERNAL-ID`; response text = `Base64(AES-256-CBC(json))` with the same key and IV.
- `X-EXTERNAL-ID` = `yyyyMMdd` (Asia/Jakarta) + 12-digit counter per connector and day, never reused (spec §4.6).
- TLS always verified; an environment's CA bundle (PEM) is added to the trust store; base URL must be `https://`.
- Timeouts: connect 5 s, total 30 s (per operation `timeoutMs`, 1000–60000).
- Secrets (client id, client secret, bank public key PEM, CA bundle PEM) only as `encryptSecret`; answers say `set: true|false`; never in activity, logs, errors.
- "Try it" goes to the `dev` environment only; 20 calls a minute per user (same limit as source connection tests).
- Permissions: `integration.view` reads, `integration.manage` edits; another `integration.manage` holder publishes (a Superadmin their own only by override, with a reason) — the workflow pattern (`approvals/versions.ts reviewRule`).
- UI copy: English, sentence case, verb + object; field names of operations are bank terms and may show in the field tree (spec §2 UX); secrets show "Set" / "Not set" and "Replace".
- Wizard rule: autosave + draft URL; reload never loses entered data.

## Review Focus

- A response that is not encrypted (an HTML 502, a plain JSON 401) → Try it shows the HTTP status and the text (masked, cut at 2,000 characters) and says it could not be decrypted, never a 500. Test in Task 4.
- A public key pasted as bare base64 (no PEM lines, as Recon-QR wraps it) or with Windows line ends → accepted; garbage → 400 "This isn't a public key. Paste the bank's public key (PEM)." Test in Task 3.
- Two Try it calls at the same moment with no token cached → one token request to the bank. Test in Task 4.
- An operation path with a query (`/x?b=2&a=1`) → signed as `/x?a=1&b=2`. Test in Task 2.
- A secret never appears in any answer, activity entry or error message, including a failed token call whose body echoes it. Test in Task 3 and Task 4.

---

### Task 1: Shared contracts, field trees and the permission

**Files:**
- Create: `packages/shared/src/integrations.ts` (zod-free: `FieldType`, `OpField`, `fieldsFromSample(json: unknown): OpField[]`, `fieldsFromOpenApi(doc: unknown, path: string, method: string): { request: OpField[]; response: OpField[] } | string`, `maskValue(v: string): string`, `maskTree(json: unknown, masked: readonly string[]): unknown`, `ENVIRONMENTS = ["dev", "prod"] as const`, `PROFILES = ["bank_mega_openapi_2_1"] as const`, `PROFILE_LABEL`)
- Create: `packages/shared/src/contracts/integrations.ts` (zod: `ConnectorSpec`, `OperationSpec`, `EnvironmentSettings`, DTOs, bodies)
- Modify: `packages/shared/src/permissions.ts` (`integration`: view, manage), `packages/shared/src/audit.ts` (`ACTION_LABEL` for `integration.*`), `packages/shared/src/paging.ts` (`CONNECTOR_SORTS = ["name", "createdAt"]`)
- Test: `packages/shared/src/integrations.test.ts`

**Interfaces (produced):**
- `type OpField = { name: string; type: "string" | "numeric" | "boolean" | "object" | "array"; maxLength?: number; required: boolean; children?: OpField[] }` (array of objects: `children` describe one element).
- `OperationSpec = { key: string /* a-z0-9_, unique in the connector */; name: string; method: "POST" | "GET" | "PUT"; path: string /* starts with "/" */; timeoutMs: number; request: OpField[]; response: OpField[]; success: { field: string /* dot path */; equals: string } | null; reference: string | null /* dot path */; masked: string[] /* dot paths */; presets: Record<string, string> /* dot path → fixed value */ }`.
- `EnvironmentSettings = { baseUrl: string /* https:// */; host: string; partnerId: string; channelId: string }`.
- `ConnectorSpec = { name: string; profile: "bank_mega_openapi_2_1"; active: "dev" | "prod"; environments: { dev: EnvironmentSettings; prod: EnvironmentSettings }; operations: OperationSpec[] /* ≤ 50 */ }`.
- Secrets body: `ReplaceSecretsBody = { environment: "dev" | "prod"; clientId?: string; clientSecret?: string; publicKey?: string; caBundle?: string }` (at least one).
- DTOs: `ConnectorRowDto`, `ConnectorDetailDto` (live + open version as `versionDto`, `secrets: Record<"dev"|"prod", { clientId: boolean; clientSecret: boolean; publicKey: boolean; caBundle: boolean }>`, `disabled: { at, reason } | null`, `canEdit`, `reviewBlocked`, `overrideOnly`), `TokenCheckDto = { ok: boolean; expiresIn: number | null; message: string }`, `TryBody = { operation: string; body: unknown }`, `TryDto = { ok: boolean; status: number | null; ms: number; externalId: string | null; success: boolean | null; reference: string | null; response: unknown | null; raw: string | null; message: string }`.

- [ ] **Step 1: Failing tests** in `integrations.test.ts`:
  - `fieldsFromSample({ ResponseCode: "00", Amount: 1500, DE48: { TraceID: "1" }, Items: [{ a: "x" }] })` → `[{ name: "ResponseCode", type: "string", required: false }, { name: "Amount", type: "numeric", required: false }, { name: "DE48", type: "object", required: false, children: [{ name: "TraceID", type: "string", required: false }] }, { name: "Items", type: "array", required: false, children: [{ name: "a", type: "string", required: false }] }]`.
  - `fieldsFromOpenApi` on a minimal OpenAPI 3 doc with `requestBody.content["application/json"].schema` using a `$ref` to `components.schemas.Req` (`required: ["A"]`, `A: { type: "string", maxLength: 10 }`) → request `[{ name: "A", type: "string", maxLength: 10, required: true }]`; unknown path → the string `"This file has no POST /x."`.
  - `maskValue("1234567890")` → `"12******90"`; `maskValue("abc")` → `"***"`; `maskTree({ a: { b: "1234567890" }, c: "x" }, ["a.b"])` → `{ a: { b: "12******90" }, c: "x" }`.
  - `ConnectorSpec.safeParse` refuses `baseUrl: "http://x"` ("Use an https:// address."), two operations with the same `key`, a `success.field` not in the response tree ("Pick a response field for success.").
- [ ] **Step 2:** `bun run --filter @starterkit/shared test` → FAIL.
- [ ] **Step 3:** Implement. `$ref` resolution only `#/components/schemas/<name>`, depth ≤ 8 (deeper refs become `object` without children).
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(shared): Open API connector contracts, field trees and integration permissions`.

### Task 2: The security profile `bank_mega_openapi_2_1`

**Files:**
- Create: `apps/api/src/modules/integrations/profile.ts`
- Test: `apps/api/src/modules/integrations/tests/unit/profile.test.ts`

**Interfaces (produced):**
- `publicKeyPem(text: string): string` — accepts PEM or bare base64 (wraps at 64, adds `-----BEGIN PUBLIC KEY-----` lines), normalizes `\r\n`; throws `ApiError("bad_request", "This isn't a public key. Paste the bank's public key (PEM).")` when `createPublicKey` refuses it.
- `signedPath(path: string): string` — path plus `?` + query parts sorted (as Recon-QR `sort()`), none when no query.
- `timestamp(now: Date): string` — UTC `yyyy-MM-ddTHH:mm:ss+00:00`.
- `sealRequest(i: { method: string; path: string; json: string; accessToken: string; clientSecret: string; publicKey: string; now: Date }): { headers: Record<"X-CREDENTIAL-KEY" | "X-SIGNATURE" | "X-TIMESTAMP", string>; body: string; key: Buffer; iv: Buffer }`.
- `openResponse(text: string, key: Buffer, iv: Buffer): { json: unknown } | { error: "not_encrypted" | "bad_json" }` — `not_encrypted` when the text isn't base64 AES with this key (decipher throws), `bad_json` when it decrypts but isn't JSON; the caller shows the raw text (masked) in both.
- `signature(i: { method: string; path: string; accessToken: string; json: string; timestamp: string; clientSecret: string }): string`.

- [ ] **Step 1: Failing tests** (`profile.test.ts`):
  - signature oracle: for `method "POST", path "/openapi/v2.0/misc/debit-credit", accessToken "tok", json '{"a":1}', timestamp "2026-11-22T03:04:05+00:00", clientSecret "s3cret"` the result equals `createHmac("sha512", "s3cret").update("POST:/openapi/v2.0/misc/debit-credit:tok:" + sha256hex('{"a":1}') + ":2026-11-22T03:04:05+00:00").digest("base64")` AND equals the output of `printf '%s' "<stringToSign>" | openssl dgst -sha512 -hmac s3cret -binary | base64` run through `Bun.spawnSync` (the independent oracle; skip that half when `openssl` is missing).
  - `signedPath("/x?b=2&a=1")` → `"/x?a=1&b=2"`; `signedPath("/x")` → `"/x"`.
  - `timestamp(new Date("2026-11-22T03:04:05.678Z"))` → `"2026-11-22T03:04:05+00:00"`.
  - round trip as the bank: generate an RSA 2048 pair (`generateKeyPairSync`); `sealRequest` → the "bank" decrypts `X-CREDENTIAL-KEY` with `privateDecrypt({ key, padding: RSA_PKCS1_PADDING })`, splits on `:`, base64-decodes key (32 bytes) and iv (16 bytes), decrypts the body to the same JSON, recomputes the signature from that JSON and gets `X-SIGNATURE`.
  - `openResponse` of the bank's encrypted reply → `{ json }`; of `"<html>502</html>"` → `{ error: "not_encrypted" }`.
  - `publicKeyPem`: the PEM, the same base64 without header lines, with `\r\n` → the same key; `"hello"` → the error above.
- [ ] **Step 2:** `cd apps/api && bun test src/modules/integrations/tests/unit/profile.test.ts` → FAIL.
- [ ] **Step 3:** Implement with `pbkdf2Sync`, `randomBytes`, `createCipheriv("aes-256-cbc")`, `publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING })`, `createHmac("sha512")`.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(integrations): Bank Mega Open API security profile 2.1`.

### Task 3: Connectors, versions and secrets (API + migration)

**Files:**
- Create: `apps/api/src/modules/integrations/{schema,service,controller,index}.ts`, migration `0052_integrations.sql` (`bun run db:generate -- --name=integrations`)
- Modify: `apps/api/src/modules/index.ts`, `apps/api/src/db/seed/*` (catalog picks up `integration.*` from `MODULES`; Superadmin gets them), `packages/shared/src/body-limit.ts` (`PATCH …/integrations/connectors/:id/draft` up to 512 KB), `docs/api/README.md`, `apps/web/scripts/emit-api-schemas.ts` (`ConnectorPage`), AGENTS.md ownership line
- Test: `apps/api/src/modules/integrations/tests/integration/connectors.test.ts`

**Interfaces (produced):**
- Tables: `connectors (id, name unique lower, disabled_at, disabled_reason, created_at)`; `connector_versions (id, connector_id, version, status draft|in_review|published|retired, spec jsonb, maker_id, submitted_by, submitted_at, decided_by, decided_at, review_comment, override_reason, created_at, updated_at; unique (connector_id, version); one open per connector)` — the `workflow_versions` shape; `connector_secrets (connector_id, environment, secret_enc text, updated_by, updated_at; pk (connector_id, environment))` holding `encryptSecret(JSON {clientId, clientSecret, publicKey, caBundle})`; `connector_tokens (connector_id, environment, token_enc, expires_at; pk)`; `connector_external_ids (connector_id, day date, n bigint; pk)`.
- Routes (guard `"integration.view"` reads, `"integration.manage"` writes): `GET /v1/integrations/connectors` (page, `q`, sort), `POST /v1/integrations/connectors` (`{ spec }`, a draft v1), `GET …/connectors/:id`, `POST …/:id/draft`, `PATCH …/:id/draft` (autosave, maker only), `POST …/:id/draft/submit|discard`, `POST …/:id/review/approve|reject`, `PUT …/:id/secrets` (`ReplaceSecretsBody`), `POST …/:id/disable` (`{ reason }`) and `POST …/:id/enable`.
- `export async function liveOperation(tx: InTx, connectorId: string, key: string): Promise<{ connector: ConnectorSpec; version: number; op: OperationSpec; disabled: boolean } | null>` and `export async function secretsOf(tx: InTx, connectorId: string, env: "dev" | "prod"): Promise<{ clientId; clientSecret; publicKey; caBundle } | null>` (index exports, for Task 4 and stage 4).
- Activity: `integration.create|save|submit|publish|reject|discard|secrets|disable|enable` with `after` holding names, versions and which secret fields changed (`["clientSecret"]`), never values.

- [ ] **Step 1: Failing tests** (`connectors.test.ts`):
  - maker-checker as `workflows.test.ts`: create → draft v1; self approve → `self_approval`; another manager publishes; Superadmin own only by override with reason; only the maker saves the draft.
  - `integration.view` holder reads, gets 403 on create; a user without it gets 403 on list.
  - secrets: `PUT …/secrets { environment: "dev", clientSecret: "s3cret-value" }` → detail `secrets.dev.clientSecret === true`, `clientId === false`; the response text, the activity rows (`JSON.stringify` of before/after) and the detail never contain `"s3cret-value"`; `{ environment: "dev" }` → 400 "Enter at least one value to replace."; `publicKey: "hello"` → 400 with the profile message; a bare-base64 key is stored as PEM.
  - disable with reason → `detail.disabled.reason`; disable without reason → 400.
  - a version spec of 300 KB (50 operations with large trees) saves (body limit raised for this route only).
- [ ] **Step 2:** `bun test src/modules/integrations` → FAIL.
- [ ] **Step 3:** Implement; reuse `reviewRule`/`versionDto`/`userNames` from the approvals index (export them there if not yet); `canEdit = perms.has("integration.manage")`.
- [ ] **Step 4:** → PASS; `bun run api:schemas`; `bun test test/architecture test/db` → PASS (conformance rows, ownership, schema drift).
- [ ] **Step 5:** Commit `feat(integrations): connectors with reviewed versions and encrypted secrets`.

### Task 4: Token, send and Try it

**Files:**
- Create: `apps/api/src/modules/integrations/transport.ts`
- Modify: `service.ts`, `controller.ts` (`POST …/:id/token-check`, `POST …/:id/try`), `index.ts` (export `sendOperation`)
- Test: `apps/api/src/modules/integrations/tests/integration/transport.test.ts`, helper `apps/api/test/helpers/fake-bank.ts`

**Interfaces (produced):**
- `sendOperation(i: { connectorId: string; env: "dev" | "prod"; op: OperationSpec; settings: EnvironmentSettings; secrets: Secrets; body: unknown }): Promise<SendResult>` where `SendResult = { outcome: "ok" | "rejected" | "not_sent" | "timeout"; status: number | null; externalId: string | null; ms: number; json: unknown | null; raw: string | null; message: string }` — `not_sent` = failed before the request left (DNS, refused, TLS, token); `timeout` = sent, no answer in time, or the answer could not be decrypted; `rejected` = HTTP status outside 2xx with a readable body; `ok` = 2xx decrypted. Success rule and reference are read by the caller (`readPath(json, dotPath)` exported).
- `accessToken(connectorId, env, settings, secrets): Promise<string>` — cached in `connector_tokens` (`encryptSecret`), refreshed when `expires_at - 30 s` passed, under `pg_advisory_xact_lock(hashtext('connector-token:' || id || env))` (add `connectorToken` to `LOCKS`).
- `nextExternalId(connectorId, now): Promise<string>` — upsert-increment on `connector_external_ids` (today Asia/Jakarta) returning `yyyyMMdd` + 12-digit zero-padded n.
- `fetch` with `tls: { ca: [caBundle] }` when set, `signal: AbortSignal.timeout(op.timeoutMs)`; connect timeout through a 5 s race on the token call and on the first byte.
- Try it: dev only (`settings = spec.environments.dev`, secrets of dev), body = the typed JSON with presets applied (preset wins only where the body leaves the field out), answer `TryDto` with `response = maskTree(json, op.masked)`, `raw` cut at 2,000 characters and masked when it is the not-decrypted text; 429 past 20 a minute per user (`limited(connectionTests, ctx)` from sources, or a new `RateLimiter("integration-try", 20, 60_000)`); activity `integration.try` with operation key, outcome, status and external id only.
- Token check: `TokenCheckDto`, the bank's error text never echoed (fixed sentence + HTTP status).

- [ ] **Step 1: Failing tests** with `fake-bank.ts` (Bun.serve over TLS using a self-signed cert generated once per run with `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -days 1`; it holds the RSA private key whose public key the test stores as the connector's `publicKey`; it checks Basic auth on the token path, the Bearer, decrypts `X-CREDENTIAL-KEY` and the body, verifies `X-SIGNATURE`, and answers per path: `/ok` encrypted `{ ResponseCode: "00", Ref: "R1", Account: "1234567890" }`, `/html` 502 `<html>bad gateway</html>`, `/slow` waits 3 s):
  - Try `/ok` → `ok: true, success: true` (success rule `ResponseCode = "00"`), `reference: "R1"`, `response.Account === "12******90"` (masked), `externalId` matches `/^\d{8}\d{12}$/`; a second try → external id n + 1.
  - Try `/html` → `ok: false, status: 502`, `message` "The bank answered 502 and the answer could not be read.", `raw` contains `bad gateway`; no 500.
  - Try `/slow` with `timeoutMs: 1000` → `outcome` timeout, message "No answer from the bank within 1 s."
  - Two parallel tries with no token cached → the fake bank counts exactly 1 token request.
  - Token check with a wrong client secret → `ok: false`, message "The bank refused the credentials (HTTP 401).", and the answer text does not contain the secret even though the fake bank echoes it in its 401 body.
  - The CA bundle not set → `not_sent`, message "The bank's certificate isn't trusted. Add the environment's CA bundle." (self-signed cert refused).
  - `prod` is never called by Try it (a connector whose dev base URL points to an unreachable port and prod to the fake bank → `not_sent`, fake bank counts 0).
- [ ] **Step 2:** `bun test src/modules/integrations` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; architecture tests → PASS (conformance: `POST …/try` and `…/token-check` record activity; token-check is in `NO_ACTIVITY` with its reason).
- [ ] **Step 5:** Commit `feat(integrations): access token cache, signed calls and Try it against dev`.

### Task 5: Web — Access → Open API

**Files:**
- Create: `apps/web/src/features/integrations/{connectors-page,connector-editor,operation-editor,field-tree,secrets-panel,try-panel,shapes}.tsx|ts`, `use-integrations.ts`
- Create: routes `app/(main)/integrations/{page,loading}.tsx`, `app/(main)/integrations/[id]/{page,loading}.tsx`
- Modify: `lib/shared/nav.ts` (Access → "Open API" `/integrations`, perm `integration.view`, shortcut "G I", icon `integrations`), `components/shell/nav-icon.tsx`, `lib/shared/queries-recon.ts` (keys under `integrations`), `lib/server/prefetch.tsx`, `prefs.ts` `VIEW_PAGES`, `route-shapes.ts`, `docs/standards/copy-guide.md` nav labels, `nav.test.ts`
- Look (Figma 07, Task 6; direction A calm): list of connectors (name, profile, active environment, live version, operations count, Disabled chip). Detail: header (name, status chip, Send for approval), tabs **Environments** (dev and prod cards: address, host, partner, channel; Credentials rows Set / Not set with Replace (a dialog, password fields), "Get token" with the result inline), **Operations** (list; an operation opens its editor: name, method, path, timeout; Request and Response field trees with Import (paste a sample JSON or an OpenAPI file); success rule as a sentence "Success when [field] is [00]"; reference field; masked fields as toggles on the tree; presets as values on the tree), **Try it** (operation picker, JSON body prefilled from the request tree with presets, Send to dev, result: outcome chip, HTTP status, external id, time, success, reference, masked response tree).
- Micro-interactions from board 06: tree expand/collapse, token added, Saved check, result reveal; tokens only.

- [ ] **Step 1:** `nav.test.ts`: all permissions → "Open API" after "Permissions" in Access; `integration.view` alone shows it → FAIL.
- [ ] **Step 2:** Implement; `bunx vitest run src` in `apps/web`, typecheck, lint → PASS; `NEXT_DIST_DIR=.next-e2e bun run build && bun run budget` → every route ≤ 300 kB.
- [ ] **Step 3:** Browser check on :3000 (the preview moves after the commit): create a connector, fill dev settings, add an operation by pasting a sample, autosave survives reload, secrets show Not set; Get token without secrets says what is missing. Restore dev data (discard the test connector).
- [ ] **Step 4:** Commit `feat(web): Access → Open API: connectors, operations, credentials and Try it`.

### Task 6: Design, docs, final

**Files:** Figma file `fbGv05DvfJnw6XU0fwZebO` page "07 Open API · v1.0.0" (list, Environments tab, Operations editor with field tree, Try it result; Read me; release index entry); `docs/decisions.md` (DEC-053: connectors are global, versioned with maker-checker, secrets per environment outside the version, Try it dev only, external id per connector and day); `docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md` status line (stage 3 shipped).

- [ ] **Step 1:** Figma page built from the design system, screenshots checked.
- [ ] **Step 2:** Docs; `bun run check` green; commit `docs(integrations): DEC-053, Figma 07 v1.0.0`; push to `recon feat/recon-phase1`.
