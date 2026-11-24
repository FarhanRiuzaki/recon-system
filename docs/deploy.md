# Deploy on your own Docker server

The production stack (`docker-compose.yml`): PostgreSQL 18, `migrate` (migrations, then the system seed, then the demo
seed when asked), the API (no published port), the job worker and the web. Only the web is published.

## Prerequisites

- Docker Engine with Compose v2 (`docker compose version`). The images build on the server: the three images took
  about 2 GB here (api 805 MB, web 454 MB, postgres 701 MB), plus build cache and the database.
- A copy of the repository on the server (`git clone`, or copy the folder; `node_modules` and `.env*` files are not
  needed).

## First start

```sh
cd recon-system
cp .env.compose.example .env.compose
chmod 600 .env.compose
```

Fill `.env.compose` (never commit it). Secrets:

```sh
openssl rand -hex 32       # POSTGRES_PASSWORD, APP_DB_PASSWORD, INTERNAL_API_TOKEN, SESSION_SECRET (one each)
openssl rand -base64 32    # DATA_ENCRYPTION_KEY
```

| Key | Value |
| --- | --- |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | two different hex values; repeat each in `MIGRATION_DATABASE_URL` and `DATABASE_URL` |
| `INTERNAL_API_TOKEN`, `SESSION_SECRET` | hex values |
| `DATA_ENCRYPTION_KEY` | the base64 value; keep a copy outside the server: without it encrypted 2FA secrets and source connections can't be read |
| `WEB_PORT`, `APP_URL` | the host port and the address users open, e.g. `3001` and `http://recon.internal:3001` (or the HTTPS address of the proxy) |
| `SEED_SUPERADMIN_*` | your first Superadmin (password 12 to 128 characters); not a demo username (`superadmin`, `admin`, `viewer`, ...) |
| `MAIL_TRANSPORT`, `SMTP_URL`, `MAIL_FROM` | SMTP over TLS (`smtps://...:465` or `smtp://...:587?requireTLS=true`) |
| `COMPOSE_PROJECT_NAME` | a name for this stack's containers, volume and images |

```sh
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps          # migrate exited 0; postgres, api, worker, web healthy
docker compose --env-file .env.compose logs migrate
```

Open `APP_URL`, sign in with the `SEED_SUPERADMIN_*` account. Every compose command takes `--env-file .env.compose`.

## Trial switches

Both off by default; without them production refuses log mail and demo data as before.

| Switch | What it does | Risk |
| --- | --- | --- |
| `MAIL_TRANSPORT=log` + `ALLOW_MAIL_LOG=true` | runs without SMTP; `SMTP_URL`/`MAIL_FROM` may stay empty. The API warns at boot. | No mail leaves the server: password reset and invitations reach nobody (the log has the subject only). An admin sets passwords on the user's page instead. |
| `SEED_DEMO=true` + `ALLOW_DEMO_SEED=true` | `migrate` runs `db:seed:demo` after `db:seed`, once (skipped when its accounts exist): 50 users, three spaces, Treasury's sources, two BI-FAST demo recons run over the last five business days, unmatch items, a pending write-off | The demo accounts share one known password (`SEED_PASSWORD` in `apps/api/src/db/seed/demo.ts`). All data is generated, none is real. |

Demo accounts (username): `superadmin` (Superadmin), `admin`, `twofa` (Admin; `twofa` has TOTP), `viewer` (Viewer; in
Treasury operator and config maker), `inactive`, `ldap`, `google`, `apple`, and 42 generated users; Treasury's reviewer
(who approves the demo write-off) is a generated user, shown in Treasury's members.

Before any real use: deactivate or delete the demo accounts (or start over on a new volume without `SEED_DEMO`), set
SMTP and remove `ALLOW_MAIL_LOG`, `SEED_DEMO`, `ALLOW_DEMO_SEED` and the `SEED_SUPERADMIN_PASSWORD` from `.env.compose`.

## Upgrade

```sh
git pull
docker compose --env-file .env.compose up -d --build
```

`migrate` applies new migrations before the API and worker start (they wait for it). Back up first (below).

## Backup

The database lives in the volume `<COMPOSE_PROJECT_NAME>_pgdata`. A dump while running:

```sh
docker compose --env-file .env.compose exec -T postgres pg_dump -U postgres -Fc starterkit > recon-$(date +%F).dump
```

Restore into a new stack's database with `pg_restore -U postgres -d starterkit --clean`. Keep `.env.compose` (above
all `DATA_ENCRYPTION_KEY`) with the dumps. `docker compose down` keeps the volume; `down -v` deletes it.

## Ports, reverse proxy, cookies

- Only the web is published (`WEB_PORT`, default 3001); the API, worker and database stay on the compose network.
- Behind an HTTPS proxy: `APP_URL=https://...`, `COOKIE_SECURE=true` (required with an HTTPS `APP_URL`), and
  `TRUSTED_PROXY=true` only when the proxy overwrites `X-Forwarded-For`/`-Host`/`-Proto`. Bind the published port to
  the proxy only (e.g. a firewall rule, or `127.0.0.1:${WEB_PORT}:3000` in an override file).
- Plain HTTP (`COOKIE_SECURE=false`) is for a closed network trial only.
- Sign-in POSTs are checked against `APP_URL`'s origin: open the site at exactly that address.

## Production notes

- DEC-054 (`docs/decisions.md`): a database watermark source whose watermark is a date (no time) and whose look back is
  under one day pauses on its next pull, with the reason on the source. Make a new source version with a look back of
  at least one day.
- DEC-055: migration 0069 builds an index and validates a check on `recon_items` inside one transaction (no
  `CONCURRENTLY`): it blocks writes to that table for a full scan. On a large `recon_items`, run that upgrade in a
  maintenance window. A fresh install is not affected.
