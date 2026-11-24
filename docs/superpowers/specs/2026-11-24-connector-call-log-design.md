# Connector call log — design

Status: owner asked 2026-11-24 ("di menu openapi, ada log activity hit api nya juga lengkap dari mana, bagaimana,
siapa, dst"; "bikin standar saja, karena kedepan mungkin ga hanya untuk recon"). Owner said to take my
recommendations; this is the short design.

## Intent

Whoever runs the Open API connectors sees every outbound HTTP call the app made to a bank: when, to which connector and
operation, what triggered it and on whose behalf, how it went, and the masked request and response. The connector and
the workflow will ship as default starterkit modules, so the log is generic: any module that calls a connector tells
the log where the call came from; the log has no recon columns.

## Goals

- Every outbound call is one row, written by the transport (`apps/api/src/modules/integrations/transport.ts`), the one
  place that calls `fetch`: token requests (`accessToken`) and operation calls (`sendOperation`), from the worker's
  sends, the Try panel and Check token. A call that never left (no address, no credentials, certificate, network,
  token refused) is a row too, with outcome Not sent.
- Columns: started at, duration, connector + version, environment, operation (or "Access token"), method, host + path
  (no query string), outcome (OK, Rejected, Timeout, Not sent), HTTP status, bank code and message, attempt, origin,
  actor.
- **Origin** (generic, caller-supplied): `{ module, kind, refId, label, href }`, e.g. integrations' worker for an
  approval action: `{ module: "approvals", kind: "action", refId: <action run id>, label: "Post to GL · P1-2", href:
  <the page of the subject> }`; the Try panel `{ module: "integrations", kind: "try", … }`; Check token
  `{ … kind: "token_check" }`. A token request made inside a send carries the send's origin.
- **Actor**: the user who clicked (Try, Check token), else "System" plus `onBehalfOf` (the user whose approval fired the
  send) when the caller knows it.
- Detail: masked request and response (the connector's masking, as `action_runs.payload_masked` today). Never stored:
  secrets, tokens, signatures, the Authorization header, the sealed body.
- Screen: Open API menu gets a "Call log" view (tab beside the connector list), and each connector's page links to it
  filtered by that connector. Server paging, default 15; filters: time range (default today, `DateRangeControl`),
  connector, environment, outcome, origin module/kind, search (external id, path, origin label). Detail in a dialog.
  `SavedViewsMenu` + `ColumnsMenu`; five states; outcome chips by meaning (OK green, Rejected/Timeout/Not sent red).
- Access: `integration.view` reads the log and its masked bodies (the same people who read connector settings and
  Try results today).
- Retention: the janitor deletes rows older than `CALL_LOG_RETENTION_DAYS` (default 90), 10,000 per run, like audit.

## Non-goals

- Inbound calls (nothing outside calls this app's API today).
- Replaying a call from the log.
- Alerts on failure rates (Today already counts failed postings).

## Anti-goals

- A log write that can fail or slow the send: it runs after the call, outside the send's transaction; a failure to log
  is a warning line, the send's result stands.
- Any secret in a row or in the activity log.
- Recon-specific fields in the integrations module.

## Approaches

1. **Write in the transport, caller passes origin** — picked. One choke point covers every call type, including
   failures before the bank; callers only add `origin`/`actor` to the call.
2. Derive from `action_runs` + activity entries. No new table, but misses token calls, Try calls and retries, and
   can't show per-attempt timing.
3. A generic HTTP middleware around `fetch`. Wider than needed; the transport already is the only caller.

## Data

Table `connector_calls` (owned by `integrations`, global like `connectors`: no `space_id`; an origin's space, when
there is one, sits inside `origin`, and the log is read only with the global `integration.view`): id (uuid v7),
connector_id, connector_version, environment, operation_key (null for a token call), method, host, path, started_at,
duration_ms, attempt, outcome, http_status, code, message, external_id, request_masked jsonb, response_masked jsonb,
origin jsonb, actor_id uuid null, on_behalf_of uuid null. Indexes: (started_at desc, id), (connector_id, started_at).
Monthly partitions are not needed at this size (my call; revisit past ~10M rows).

## API

- `GET /v1/integrations/calls` (list, `integration.view`), `GET /v1/integrations/calls/facets`,
  `GET /v1/integrations/calls/:id` (detail with bodies).

## My calls

- Global table without `space_id` (connectors are global; RLS rule applies to space-owned tables only).
- 90-day retention default, env-configurable.
- Attempt number = the worker's retry count for that action run (1 for Try and token checks).
- The connector page links to the log rather than embedding it.
