// The PostgreSQL connector's catalog (REC-F2a) against `<test database>_src`, read by a login that holds only what IT
// granted (`recon_catalog_probe`): the databases it can open, the tables and views it can SELECT (a table without the
// grant, and a table in a schema without USAGE, are not listed), column counts, search, paging, the server's line, and
// unique/indexed in a table's columns.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { sourceDb } from "../../../../../test/helpers/source-db";
import { type Connector, connectorFor, type Secret } from "../../connectors";

let src: SQL, secret: Secret;
const open: Connector[] = [];
const probe = (s: Partial<Secret> = {}) => {
  const c = connectorFor("postgres", { ...secret, user: "recon_catalog_probe", password: "probe", ...s }, { tls: false, connectTimeoutSeconds: 5, statementTimeoutMs: 8000 });
  open.push(c);
  return c;
};

beforeAll(async () => {
  ({ sql: src, secret } = await sourceDb());
  await src.unsafe(`
    drop schema if exists cat_a, cat_b, cat_hidden cascade;
    do $$ begin if not exists (select from pg_roles where rolname = 'recon_catalog_probe') then create role recon_catalog_probe login password 'probe'; end if; end $$;
    create schema cat_a; create schema cat_b; create schema cat_hidden;
    create table cat_a.bifast_tx (id bigint primary key, ref text not null unique, updated_at timestamptz not null, note text, amount numeric(18,2));
    create index on cat_a.bifast_tx (updated_at);
    create table cat_a.pairs (a int not null, b int not null, unique (a, b));
    create table cat_a.secret (id int);
    create view cat_a.tx_view as select id, ref from cat_a.bifast_tx;
    create table cat_b.ledger (id int);
    create table cat_hidden.visible_grant (id int);
    grant usage on schema cat_a, cat_b to recon_catalog_probe;
    grant select on cat_a.bifast_tx, cat_a.pairs, cat_a.tx_view, cat_b.ledger, cat_hidden.visible_grant to recon_catalog_probe;
  `);
  for (let i = 0; i < 55; i++) await src.unsafe(`create table cat_b.t${String(i).padStart(2, "0")} (id int, v text); grant select on cat_b.t${String(i).padStart(2, "0")} to recon_catalog_probe`);
});
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await src.unsafe("drop schema if exists cat_a, cat_b, cat_hidden cascade");
  await src.close();
});

describe("catalog over a read-only login", () => {
  it("server(): version, the login, the database", async () => {
    const s = await probe().server();
    expect(s.version).toMatch(/^\d+(\.\d+)?/);
    expect([s.user, s.database]).toEqual(["recon_catalog_probe", secret.database]);
  });

  it("databases(): the ones it may CONNECT to, no templates; the default database `postgres` opens", async () => {
    const d = await probe().databases();
    expect(d.names).toContain(secret.database);
    expect(d.names).toContain("postgres");
    expect(d.names.some((n) => n.startsWith("template"))).toBe(false);
    expect(d.truncated).toBe(false);
    await probe({ database: "postgres" }).test();
  });

  it("tables(): only what it can SELECT — not cat_a.secret (no grant), not cat_hidden (no USAGE) — with kind and column count", async () => {
    const r = await probe().tables({ schema: "cat_a" });
    expect(r.items).toEqual([
      { schema: "cat_a", name: "bifast_tx", kind: "table", columns: 5 },
      { schema: "cat_a", name: "pairs", kind: "table", columns: 2 },
      { schema: "cat_a", name: "tx_view", kind: "view", columns: 2 },
    ]);
    expect(r.next).toBeNull();
    const all = await probe().tables({ q: "visible" });
    expect(all.items).toEqual([]);
    const secretOnes = await probe().tables({ q: "secret" });
    expect(secretOnes.items).toEqual([]);
    // the owner of the tables sees cat_a.secret: the filter is the login's privilege, not a name list
    const owner = connectorFor("postgres", secret, { tls: false, connectTimeoutSeconds: 5, statementTimeoutMs: 8000 });
    open.push(owner);
    expect((await owner.tables({ q: "secret" })).items.map((t) => `${t.schema}.${t.name}`)).toContain("cat_a.secret");
  });

  it("search is contains, any case, on the name or the schema; LIKE wildcards are literal", async () => {
    expect((await probe().tables({ q: "BIFAST" })).items.map((t) => t.name)).toEqual(["bifast_tx"]);
    expect((await probe().tables({ q: "cat_a" })).items).toHaveLength(3);
    expect((await probe().tables({ q: "%" })).items).toEqual([]);
    expect((await probe().tables({ q: "_tx" })).items.map((t) => t.name)).toEqual(["bifast_tx"]);
  });

  it("pages of 50 after the last one; countTables stops at its cap", async () => {
    const c = probe();
    const first = await c.tables({ schema: "cat_b" });
    expect(first.items).toHaveLength(50);
    expect(first.next).toEqual({ schema: "cat_b", name: "t48" });
    const second = await c.tables({ schema: "cat_b", after: first.next! });
    expect(second.items.map((t) => t.name)).toEqual(["t49", "t50", "t51", "t52", "t53", "t54"]);
    expect(second.next).toBeNull();
    expect(await c.countTables({ schema: "cat_b" }, 1000)).toBe(56);
    expect(await c.countTables({ schema: "cat_b" }, 10)).toBe(10);
  });

  it("introspect(): unique = a one-column primary or unique key (not one of a composite key), indexed = leads an index", async () => {
    const cols = await probe().introspect({ table: "cat_a.bifast_tx" });
    expect(cols.map((c) => [c.name, c.nullable, c.unique, c.indexed])).toEqual([
      ["id", false, true, true], ["ref", false, true, true], ["updated_at", false, false, true], ["note", true, false, false], ["amount", true, false, false],
    ]);
    expect((await probe().introspect({ table: "cat_a.pairs" })).map((c) => [c.name, c.unique, c.indexed])).toEqual([["a", false, true], ["b", false, false]]);
    expect((await probe().introspect({ table: "cat_a.tx_view" })).every((c) => c.unique === false && c.indexed === false)).toBe(true);
  });
});
