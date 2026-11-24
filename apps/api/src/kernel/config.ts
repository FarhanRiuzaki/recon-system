import { isAbsolute } from "node:path";
import { z } from "zod";

const int = (min: number, max: number, dflt: number) => z.coerce.number().int().min(min).max(max).default(dflt);
const flag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
/** Standard base64 that decodes to exactly 32 bytes. */
const key32 = z.string().refine((v) => /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, "base64").length === 32, {
  message: "must be base64 of exactly 32 bytes",
});

const Fields = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: int(1, 65535, 4000),
  DATABASE_URL: z.string(),
  MIGRATION_DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: int(1, 100, 10),
  // The worker process (src/worker.ts): its job pool (kernel/worker-db.ts) and its probe port on API_HOST.
  WORKER_DB_POOL_MAX: int(1, 100, 10),
  JOB_STATEMENT_TIMEOUT_MS: int(1000, 3_600_000, 120_000),
  WORKER_HEALTH_PORT: int(1, 65535, 4100),
  /** pg-boss's own pool (kernel/jobs.ts), in the API and the worker: its statements are short, so it stays small. */
  JOBS_POOL_MAX: int(1, 20, 3),
  /** The role of DATABASE_URL; db:migrate grants it DML on pg-boss's schema (it never runs DDL there). */
  APP_DB_ROLE: z.string().optional(),
  INTERNAL_API_TOKEN: z.string().min(32),
  DATA_ENCRYPTION_KEY: key32,
  SESSION_TTL_HOURS: int(1, 24, 12),
  SESSION_IDLE_MINUTES: int(5, 1440, 120),
  APP_URL: z.url().default("http://localhost:3000"),
  MAIL_TRANSPORT: z.enum(["log", "smtp"]).default("log"),
  /** A trial only: production may keep MAIL_TRANSPORT=log (no mail is sent; index.ts warns at boot). */
  ALLOW_MAIL_LOG: flag,
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  AUDIT_RETENTION_DAYS: int(30, 3650, 365),
  /** The connector call log (integrations): rows kept this many days, their full request and response this many. */
  CALL_LOG_RETENTION_DAYS: int(1, 3650, 90),
  CALL_LOG_FULL_RETENTION_DAYS: int(1, 3650, 30),
  /** Folders a file inbox source may read from (and below): absolute paths, comma-separated; none = no file inbox. */
  INBOX_ROOTS: z.string().default("").transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean))
    .refine((roots) => roots.every((r) => isAbsolute(r)), { message: "must be absolute paths, comma-separated" }),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  OAUTH_MOCK: flag,
  LDAP_MOCK: flag,
  LDAP_URL: z.string().regex(/^ldaps?:\/\/\S+$/i, { message: "must start with ldap:// or ldaps://" }).optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_BASE_DN: z.string().optional(),
  // Without {username} every sign-in would search the same entry.
  LDAP_USER_FILTER: z.string().refine((v) => v.includes("{username}"), { message: "must contain {username}" }).default("(uid={username})"),
  LDAP_STARTTLS: flag,
  // LDAP through the Bank Mega Open API gateway (modules/auth/ldap-gateway.ts), instead of LDAP_URL: Keycloak token
  // (realm LDAP_GATEWAY_REALM, password grant as the service account) then GET /openapi/v1.0/ldap/verifypassword/….
  LDAP_GATEWAY_URL: z.string().regex(/^https?:\/\/\S+$/i, { message: "must start with http:// or https://" }).optional(),
  /** The Host header the gateway routes on, when LDAP_GATEWAY_URL is an address rather than that name. */
  LDAP_GATEWAY_HOST: z.string().optional(),
  LDAP_GATEWAY_REALM: z.string().regex(/^[\w.-]+$/, { message: "must be a realm name" }).default("quarkus"),
  LDAP_GATEWAY_USERNAME: z.string().optional(),
  LDAP_GATEWAY_PASSWORD: z.string().optional(),
  LDAP_GATEWAY_CLIENT_ID: z.string().optional(),
  /** Keycloak client secret, also the HMAC-SHA512 key of X-SIGNATURE. */
  LDAP_GATEWAY_CLIENT_SECRET: z.string().optional(),
  /** AES-256-CBC key of the password in the verify path. */
  LDAP_GATEWAY_SECRET_KEY: z.string().optional(),
  LDAP_GATEWAY_PARTNER_ID: z.string().optional(),
  LDAP_GATEWAY_CHANNEL_ID: z.string().optional(),
  /** true skips the gateway's certificate check (the Laravel app did); prefer a trusted certificate. */
  LDAP_GATEWAY_INSECURE_TLS: flag,
  // Google and Apple sign-in: each provider is on when all of its keys are set (redirect: APP_URL/api/auth/oauth/<provider>/callback).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  /** The Sign in with Apple key (.p8): PKCS#8 PEM; line breaks may be written as \n. */
  APPLE_PRIVATE_KEY: z.string().refine((v) => v.includes("-----BEGIN PRIVATE KEY-----"), { message: "must be a PKCS#8 PEM (BEGIN PRIVATE KEY)" }).optional(),
});
const Schema = Fields.transform((c) => ({ ...c, MIGRATION_DATABASE_URL: c.MIGRATION_DATABASE_URL ?? c.DATABASE_URL }));
/** What the pool needs (kernel/db.ts builds it when it loads). */
const DbFields = Fields.pick({ DATABASE_URL: true, DB_POOL_MAX: true });
/** What pg-boss's pool needs (kernel/jobs.ts opens it on first use). */
const JobsFields = Fields.pick({ DATABASE_URL: true, JOBS_POOL_MAX: true });
/** What the worker process reads (src/worker.ts, kernel/worker-db.ts); it needs none of the API's secrets. */
const WorkerFields = Fields.pick({
  DATABASE_URL: true, JOBS_POOL_MAX: true, API_HOST: true, WORKER_DB_POOL_MAX: true, JOB_STATEMENT_TIMEOUT_MS: true, WORKER_HEALTH_PORT: true,
  DATA_ENCRYPTION_KEY: true, INBOX_ROOTS: true,
});
/** The key of encryptSecret/decryptSecret (kernel/crypto.ts), read alone so the worker decrypts without the API's secrets. */
const KeyFields = Fields.pick({ DATA_ENCRYPTION_KEY: true });

export type Config = z.output<typeof Schema>;

/** Every key the schema reads (apps/api/.env.example must name each; its test checks). */
export const CONFIG_KEYS = Object.keys(Fields.shape);

export const GOOGLE_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
export const APPLE_KEYS = ["APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"] as const;
/** What LDAP_GATEWAY_URL needs besides itself (LDAP_GATEWAY_HOST and _REALM are optional). */
export const LDAP_GATEWAY_KEYS = [
  "LDAP_GATEWAY_USERNAME", "LDAP_GATEWAY_PASSWORD", "LDAP_GATEWAY_CLIENT_ID", "LDAP_GATEWAY_CLIENT_SECRET",
  "LDAP_GATEWAY_SECRET_KEY", "LDAP_GATEWAY_PARTNER_ID", "LDAP_GATEWAY_CHANNEL_ID",
] as const;

/**
 * Rules across keys, on the raw env so they're reported even when a field is invalid (zod skips refinements of an
 * object with field issues). Raw values are the enum strings; anything else is a field issue already.
 */
function crossKeyProblems(e: Record<string, string>): string[] {
  const out: string[] = [];
  if (e.MAIL_TRANSPORT === "smtp") {
    if (!e.SMTP_URL) out.push("SMTP_URL (required when MAIL_TRANSPORT=smtp)");
    if (!e.MAIL_FROM) out.push("MAIL_FROM (required when MAIL_TRANSPORT=smtp)");
  }
  if (e.LDAP_URL && !e.LDAP_BASE_DN) out.push("LDAP_BASE_DN (required when LDAP_URL is set)");
  if (e.LDAP_GATEWAY_URL) {
    out.push(...LDAP_GATEWAY_KEYS.filter((k) => !e[k]).map((k) => `${k} (required when LDAP_GATEWAY_URL is set)`));
    // One directory: a sign-in must not depend on which of the two the code happens to try first.
    if (e.LDAP_URL) out.push("LDAP_GATEWAY_URL (set LDAP_URL or LDAP_GATEWAY_URL, not both)");
  }
  // A provider's keys come all together or not at all: half a provider would show a button that can't work.
  for (const keys of [GOOGLE_KEYS, APPLE_KEYS]) {
    if (keys.some((k) => e[k])) out.push(...keys.filter((k) => !e[k]).map((k) => `${k} (required with ${keys.filter((x) => e[x]).join(", ")})`));
  }
  if (e.NODE_ENV === "production") {
    if (e.MAIL_TRANSPORT !== "smtp" && e.ALLOW_MAIL_LOG !== "true") out.push("MAIL_TRANSPORT (must be smtp in production, or ALLOW_MAIL_LOG=true for a trial)");
    if (!e.APP_URL) out.push("APP_URL (required in production: the public origin the reset and invitation links point to)");
    if (e.OAUTH_MOCK === "true") out.push("OAUTH_MOCK (must be false in production)");
    if (e.LDAP_MOCK === "true") out.push("LDAP_MOCK (must be false in production)");
    if (/^ldap:\/\//i.test(e.LDAP_URL ?? "") && e.LDAP_STARTTLS !== "true") out.push("LDAP_URL (production needs ldaps:// or LDAP_STARTTLS=true)");
    // smtp:// alone sends the password and the reset links in clear text whenever the server offers no STARTTLS.
    if (e.MAIL_TRANSPORT === "smtp" && e.SMTP_URL && !/^smtps:\/\//i.test(e.SMTP_URL) && !/[?&]requireTLS=true(&|$)/.test(e.SMTP_URL)) {
      out.push("SMTP_URL (production needs smtps:// or ?requireTLS=true)");
    }
  }
  return out;
}

const nonEmpty = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
const issues = (e: z.ZodError | undefined) => e?.issues.map((i) => `${i.path.join(".")} (${i.code === "custom" ? i.message : i.code})`) ?? [];
const invalid = (why: string[]) => new Error(`Invalid API configuration: ${[...new Set(why)].join(", ")}. See apps/api/.env.example.`);

/**
 * Validated API settings from `env` (empty strings count as unset). A missing or invalid value throws one error that
 * names every bad key and why, never a value.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const set = nonEmpty(env);
  const r = Schema.safeParse(set);
  const why = [...issues(r.error), ...crossKeyProblems(set)];
  if (r.success && !why.length) return r.data;
  throw invalid(why);
}

/**
 * Only DATABASE_URL and DB_POOL_MAX, validated the same way: the pool is built when kernel/db.ts loads, so the one-shot
 * scripts (db:seed) that import the modules run without the server's secrets. The server checks everything at boot
 * (`config()` in index.ts).
 */
export function loadDbConfig(env: Record<string, string | undefined>): z.output<typeof DbFields> {
  return loadPicked(DbFields, env);
}

/** Only DATABASE_URL and JOBS_POOL_MAX (pg-boss's pool), validated the same way. */
export function loadJobsConfig(env: Record<string, string | undefined>): z.output<typeof JobsFields> {
  return loadPicked(JobsFields, env);
}

/** Only the keys the worker process reads (WorkerFields), validated the same way. */
export function loadWorkerConfig(env: Record<string, string | undefined>): z.output<typeof WorkerFields> {
  return loadPicked(WorkerFields, env);
}

function loadPicked<S extends z.ZodType>(fields: S, env: Record<string, string | undefined>): z.output<S> {
  const r = fields.safeParse(nonEmpty(env));
  if (r.success) return r.data;
  throw invalid(issues(r.error));
}

let key: string | undefined;
/** DATA_ENCRYPTION_KEY from process.env, validated, read once. */
export const encryptionKey = (): string => (key ??= loadPicked(KeyFields, process.env).DATA_ENCRYPTION_KEY);

let cached: Config | undefined;
/** `loadConfig(process.env)`, read once. */
export const config = (): Config => (cached ??= loadConfig(process.env));
