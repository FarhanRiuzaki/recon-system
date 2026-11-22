// Dev only: the two sources and the recon that read scripts/dev-live-feed.ts's tables, made through the API as a person
// would (a maker drafts and submits, a checker approves), so the app's own rules check them. Run inside the dev API's
// container (it calls the API on 127.0.0.1 with the internal token):
//   SPACE_ID=… MAKER=maker CHECKER=approver PASSWORD=… LIVE_RO_PASSWORD=… bun scripts/dev-live-setup.ts
if (process.env.NODE_ENV === "production") throw new Error("dev-live-setup is for development only");
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const API = process.env.API_BASE_URL ?? "http://127.0.0.1:4000", INTERNAL = env("INTERNAL_API_TOKEN"), SPACE = env("SPACE_ID");

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const r = await fetch(API + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "x-internal-token": INTERNAL, "content-type": "application/json", "x-client-ip": "127.0.0.1", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j as T;
}
const login = async (who: string) => (await call<{ token?: string }>("POST", "/v1/auth/login", null, { login: who, password: env("PASSWORD") })).token
  ?? (() => { throw new Error(`${who}: no session token (a second factor?)`); })();
const maker = await login(env("MAKER")), checker = await login(env("CHECKER"));
const sp = `/v1/spaces/${SPACE}`;

const connection = { engine: "postgres", host: "postgres", port: 5432, database: "recon_live", user: "recon_live_ro", password: env("LIVE_RO_PASSWORD"), options: { tls: false } };
const f = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: false, trim: true, ...extra });
const pull = (table: string) => ({ kind: "db_watermark", table, watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 0, chunk: 500, when: { every_minutes: 1 } });

const SOURCES = [
  {
    code: "core-bifast-out", name: "Core banking · BI-FAST outgoing",
    spec: {
      fields: [f("id", "integer"), f("end_to_end_id", "string"), f("trx_time", "datetime"), f("value_date", "date"), f("debtor_account", "string"), f("debtor_name", "string"),
        f("creditor_bank", "string"), f("creditor_account", "string"), f("creditor_name", "string"), f("amount", "decimal", { format: { scale: 2 } }), f("currency", "string"),
        f("channel", "string"), f("status", "string"), f("updated_at", "datetime")],
      mapping: {
        ext_ref: { field: "end_to_end_id" }, business_date: { field: "value_date" }, amount_minor: { field: "amount", unit: "major" }, currency: { field: "currency" },
        event_time: { field: "trx_time" }, account_ref: { field: "debtor_account" },
        attrs: { creditor_bank: { field: "creditor_bank" }, channel: { field: "channel" }, status: { field: "status" } },
      },
      derive: {}, key_fields: [], mutable: false, calendar: "id-default",
      keep: [{ field: "status", op: "eq", value: "SUCCESS" }],
      input: pull("core.bifast_outgoing"),
    },
  },
  {
    code: "switch-bifast-settle", name: "BI-FAST switch · settlement",
    spec: {
      fields: [f("id", "integer"), f("end_to_end_id", "string"), f("settlement_time", "datetime"), f("value_date", "date"), f("sender_bank", "string"), f("receiver_bank", "string"),
        f("amount", "decimal", { format: { scale: 2 } }), f("currency", "string"), f("response_code", "string"), f("updated_at", "datetime")],
      mapping: {
        ext_ref: { field: "end_to_end_id" }, business_date: { field: "value_date" }, amount_minor: { field: "amount", unit: "major" }, currency: { field: "currency" },
        event_time: { field: "settlement_time" }, attrs: { receiver_bank: { field: "receiver_bank" }, response_code: { field: "response_code" } },
      },
      derive: {}, key_fields: [], mutable: false, calendar: "id-default",
      keep: [{ field: "response_code", op: "eq", value: "ACTC" }],
      input: pull("switch.bifast_settlement"),
    },
  },
];

type Version = { id: string; status: string };
const resume = process.env.RESUME_RECON?.split(":");
if (resume) { await simulateAndPublish(resume[0]!, resume[1]!); console.log("recon: published"); process.exit(0); }
const ids: string[] = [];
for (const s of SOURCES) {
  const src = await call<{ id: string; draft: Version | null }>("POST", `${sp}/sources`, maker, { code: s.code, name: s.name, kind: "db_watermark", connection, draft: true });
  const v = src.draft!;
  await call("PATCH", `${sp}/sources/${src.id}/versions/${v.id}`, maker, { spec: s.spec });
  await call("POST", `${sp}/sources/${src.id}/versions/${v.id}/submit`, maker);
  await call("POST", `${sp}/sources/${src.id}/versions/${v.id}/approve`, checker);
  ids.push(src.id);
  console.log(`source ${s.name}: published (${src.id})`);
}

const ccy = { op: "eq", field: "currency" };
const recon = await call<{ id: string; draft: Version }>("POST", `${sp}/recons`, maker, {
  code: "bifast-outgoing", name: "BI-FAST outgoing vs settlement",
  spec: {
    sides: [{ key: "a", label: "Core banking", source_id: ids[0], filter: [] }, { key: "b", label: "BI-FAST switch", source_id: ids[1], filter: [] }],
    passes: [
      { no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break",
        predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, { op: "eq", field: "business_date" }, ccy] },
      { no: 2, name: "Fee in the amount", cardinality: "1:1", blocking: ["ext_ref", "business_date"], accept: "suggest", on_ambiguous: "suggest",
        predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "2500.00" } }, ccy] },
      { no: 3, name: "Settled next day", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest",
        predicates: [{ op: "eq", field: "amount_minor" }, { op: "date_window", field: "business_date", days: 1 }, ccy] },
    ],
    grace_minutes: 10, carry_over_days: 1, close_at: "23:30", schedule: { kind: "interval", every_minutes: 2 },
  },
});
await simulateAndPublish(recon.id, recon.draft.id);
console.log(`recon BI-FAST outgoing vs settlement: published (${recon.id})`);

/** The app asks for a simulation of a draft before its submit: one over today, waited for, then submit and approve. */
async function simulateAndPublish(configId: string, versionId: string) {
  const run = await call<{ id: string }>("POST", `${sp}/recons/${configId}/versions/${versionId}/simulate`, maker, {});
  for (let i = 0; i < 120; i++) {
    const r = await call<{ status: string; error: string | null }>("GET", `${sp}/recons/${configId}/runs/${run.id}`, maker);
    if (r.status === "succeeded") break;
    if (r.status === "failed") throw new Error(`simulation failed: ${r.error}`);
    await Bun.sleep(1000);
  }
  await call("POST", `${sp}/recons/${configId}/versions/${versionId}/submit`, maker);
  await call("POST", `${sp}/recons/${configId}/versions/${versionId}/approve`, checker);
}
