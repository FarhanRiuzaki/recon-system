# Connector call log — plan

Spec: `docs/superpowers/specs/2026-11-24-connector-call-log-design.md` (owner-approved). TDD per task: failing test
first, then code, then the related tests; one commit per task.

## Task 1 — permission, table, transport writes the log

Files: `packages/shared/src/permissions.ts` (`debug` action, `integration.debug`), `apps/api/src/kernel/config.ts`
(`CALL_LOG_RETENTION_DAYS` 90, `CALL_LOG_FULL_RETENTION_DAYS` 30), `apps/api/.env.example`,
`apps/api/src/modules/integrations/schema.ts` (`connectorCalls`), `drizzle/0062_connector_calls.sql`,
`apps/api/src/modules/integrations/call-log.ts` (new: row building, `recordCall`, `callsLogged`),
`transport.ts`, `service.ts` (Try, Check token), `worker.ts` (origin, attempt, on behalf of), `index.ts`.

Interfaces:
- `type CallOrigin = { module; kind; refId: string | null; label; href: string | null }`
- `type CallMeta = { origin: CallOrigin; actorId: string | null; onBehalfOf?: string | null; attempt?: number; connectorVersion: number | null }`
- `accessToken(connectorId, env, settings, secrets, call: CallMeta, fresh?)`, `sendOperation({ …, call })`.
- `recordCall(row)`: insert after the call, outside any send transaction, never awaited by the send; a failure is a
  `log.warn`. `callsLogged()` resolves once every pending write has ended (tests).
- Full call (encrypted with `encryptSecret`): `{ request: { method, url, headers, json, body }, response: { status,
  headers, raw, json } | null }`; Authorization keeps `Bearer …<last 8>` (Basic: hidden), a token answer's
  `access_token` its last 8; the client secret, the Basic credential and the whole token are scrubbed from every stored
  text (masked bodies too).

Tests (`tests/integration/call-log.test.ts`): a Try writes one row (origin integrations/try, actor = the user), Check
token one token row (origin token_check), a worker send one token row + one operation row with origin
approvals/action, refId = run id, attempt, on behalf of = the approver; a call with no address writes a not-sent row;
refused credentials write the token row (rejected) and the operation's not-sent row; no stored row (JSON) nor the
decrypted full call contains the client secret, the Basic credential or the whole token.

## Task 2 — list, facets, detail, reveal, retention

Files: `packages/shared/src/contracts/integrations.ts` (`CallListQuery`, `ConnectorCallRowDto`, `ConnectorCallDto`,
`ConnectorCallFullDto`), `packages/shared/src/integrations.ts` (`CALL_OUTCOMES`), `packages/shared/src/paging.ts`
(`CALL_SORTS`), `packages/shared/src/audit.ts` (`integration.call_reveal`), `call-log.ts` (`callPage`, `callFacets`,
`callDetail`, `revealCall`, `purgeCalls`), `controller.ts`, `apps/api/src/db/janitor.ts`,
`apps/web/scripts/emit-api-schemas.ts`, `docs/api/README.md`, `AGENTS.md` (ownership).

Routes: `GET /v1/integrations/calls` (integration.view, pageQuery, default 15, sort `startedAt`|`durationMs`),
`GET /v1/integrations/calls/facets` (outcome, environment, origin `module.kind`), `GET /v1/integrations/calls/:id`
(masked), `POST /v1/integrations/calls/:id/reveal` (integration.debug; activity `integration.call_reveal` in its
transaction; 409 when the full call was cleared).

Tests: list pages (15 default, page 2), filters (range, connector, environment, outcome, origin, q on external id /
path / label), facets; detail masked; reveal 403 without `integration.debug`, 200 + one activity entry with it, the
entry holds no secret; janitor clears `full_enc` past 30 days and deletes rows past 90 (`test/db/janitor.test.ts`).

## Task 3 — web: Call log view

Files: `apps/web/src/lib/shared/queries.ts` (`CONNECTOR_CALLS`, `connectorCall`, `connectorOptions`),
`lib/server/prefetch.tsx` (reads), `lib/shared/prefs.ts` (`VIEW_PAGES`), `lib/shared/nav.ts` (Open API children),
`lib/shared/time-controls.ts` (refresh scope, 1-day window, "Today" label), `lib/shared/categories.ts` (call outcome
chip), `components/route-shapes.ts`, `features/integrations/{calls-page,call-dialog,open-api-tabs,shapes}.tsx`,
`connectors-page.tsx` and `connector-editor.tsx` (tabs, link to the log filtered by the connector),
`app/(main)/integrations/calls/{page,loading}.tsx`, copy guide navigation label.

Tests: column and chip unit tests beside the feature (`calls-columns.test.ts`), the existing architecture, nav, prefs,
prefetch and page-anatomy tests.

## Task 4 — verification

`bun run api:schemas`, `bun run check` (own `TEST_DATABASE_URL`), `cd apps/web && bun run build`, `bun run budget`.
No Playwright.
