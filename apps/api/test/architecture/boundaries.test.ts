// The modulith's boundaries (refactor spec "Modular monolith"), read from the source with the TypeScript compiler API:
// (1) a module is used only through its index.ts, (2) kernel/ never imports modules/, and neither imports db/, (3) every table has exactly one
// owning modules/<m>/schema.ts, (4) tests live only in tests/ folders or apps/api/test, (5) no hand-written SQL
// statement in src/ outside the migration runner, (6) every module index and app.ts load alone in a fresh process and
// build their controllers (the module indexes import each other: no export of another module may be used at load),
// (7) modules/spaces never imports kernel/worker-db (the API process loads it, and must not open the worker pool),
// (8) every table with a space_id column has row level security forced with the one recon_space_visible policy, plus
// only the allowlisted read-only (FOR SELECT) policies, (9) each source database driver is imported only by its
// connector file (modules/ingest/connectors/{mysql,mssql,oracle}.ts), (10) every security definer function of the schema
// is allowlisted with why it may pass row level security or the app role's grants.
// Each rule has a fixture that proves it fails.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { client } from "../../src/kernel/db";

type File = { file: string; src: string };

const ROOT = path.join(import.meta.dir, "../..");

/** Where SQL is written by hand, and why; a key ending in "/" covers that folder. */
const RAW_SQL_OK: Record<string, string> = {
  "src/db/migrate.ts": "the migration runner applies SQL files and creates databases",
  "src/modules/ingest/connectors/": "SQL sent to a source database (PostgreSQL, MySQL, SQL Server, Oracle), not ours: Drizzle builds PostgreSQL only; values bound, identifiers from the source's catalog (DEC-036)",
  "src/modules/ingest/tests/unit/dialect.test.ts": "the expected per-dialect SQL of the connectors' query builder",
  "src/modules/ingest/tests/unit/catalog.test.ts": "the expected per-dialect catalog SQL the wizard's pickers send to a source database (REC-F2a)",
  "src/modules/ingest/tests/integration/catalog.test.ts": "builds the schemas, tables, view and grants the catalog reads in <test database>_src, a source database, not the app's",
  "src/modules/sources/tests/integration/catalog.test.ts": "builds the schema, tables and grants the catalog routes read in <test database>_src, a source database, not the app's",
  "src/modules/ingest/tests/integration/postgres.test.ts": "builds the tables the PostgreSQL connector reads in <test database>_src, a source database, not the app's",
  "src/modules/ingest/tests/integration/engines.test.ts": "builds the tables the MySQL, SQL Server and Oracle connectors read on a test server",
  "src/modules/sources/tests/integration/connection.test.ts": "builds the tables the connection routes read in <test database>_src, a source database, not the app's",
  "src/db/seed/demo-sources.ts": "the snapshot query of a demo source: text a source database would run, stored in its spec, never sent to ours",
  "src/modules/ingest/copy.ts": "the bulk writes of ingest (DEC-036): one multi-row INSERT … ON CONFLICT DO NOTHING per chunk and the supersede UPDATE of mutable sources; values bound, identifiers fixed",
  "src/modules/ingest/tests/integration/pipeline.test.ts": "builds the tables the pipeline pulls from in <test database>_src, a source database, not the app's",
  "src/modules/engine/sql/": "the engine's passes compiled to set-based SQL (spec §10, S1: CTEs with FOR UPDATE SKIP LOCKED, window functions, data-modifying CTEs, which the builder can't say): values bound, identifiers fixed or from the side's field whitelist (recordFields), attribute names bound",
  "src/modules/engine/tests/unit/pass.test.ts": "the expected SQL of each pass operator, filter and statement, pinned",
  "src/modules/engine/tests/integration/run-perf.test.ts": "seeds records per side with generate_series in one INSERT … SELECT for the run latency measurement (off unless PERF_ENGINE)",
  "src/modules/ingest/tests/integration/rows-today-perf.test.ts":"seeds a million records per source with generate_series in one INSERT … SELECT for the rowsToday measurement (off unless PERF_ROWS_TODAY)",
};
const rawSqlOk = (file: string) => Object.keys(RAW_SQL_OK).some((k) => (k.endsWith("/") ? file.startsWith(k) : file === k));

/** Each source database driver and the one connector file that may import it (its tests may too). */
const DRIVER_FILES: Record<string, string> = {
  mysql2: "src/modules/ingest/connectors/mysql.ts",
  mssql: "src/modules/ingest/connectors/mssql.ts",
  oracledb: "src/modules/ingest/connectors/oracle.ts",
};

const moduleOf = (f: string) => /^src\/modules\/([\w-]+)\//.exec(f)?.[1] ?? null;

/** A specifier as a path from apps/api without extension or `/index`. */
const tidy = (p: string) => p.replace(/\.ts$/, "").replace(/\/index$/, "");

/**
 * The module specifiers a file imports or re-exports: a relative one resolved against the file, a package or absolute
 * one that reaches into this app's `src/modules` (`@starterkit/api/src/modules/…`, `/…/apps/api/src/modules/…`) mapped
 * to `src/modules/…`; other packages stay as they are.
 */
function importsOf({ file, src }: File): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) specs.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return specs.map((s) => {
    if (s.startsWith(".")) return tidy(path.posix.normalize(path.posix.join(path.posix.dirname(file), s)));
    const inApp = /(?:^@starterkit\/api\/|\/apps\/api\/)(src\/.+)$/.exec(s);
    return inApp ? tidy(path.posix.normalize(inApp[1]!)) : s;
  });
}

/** (1) An import of another module's file other than its index; a schema.ts may import another module's schema.ts (foreign keys). */
function deepImports(files: File[]): string[] {
  return files.flatMap((f) => importsOf(f).flatMap((to) => {
    const m = /^src\/modules\/([\w-]+)\/(.+)$/.exec(to);
    if (!m || m[1] === moduleOf(f.file)) return [];
    if (m[2] === "schema" && /^src\/modules\/[\w-]+\/schema\.ts$/.test(f.file)) return [];
    return [`${f.file} → ${to}: import "src/modules/${m[1]}" (its index.ts), not its internals`];
  }));
}

/** (9) A source database driver imported outside its connector file (tests excepted: they set up a real server). */
function driverImports(files: File[]): string[] {
  return files.filter((f) => f.file.startsWith("src/") && !f.file.includes("/tests/")).flatMap((f) => importsOf(f).flatMap((to) => {
    const pkg = Object.keys(DRIVER_FILES).find((p) => to === p || to.startsWith(`${p}/`));
    return pkg && DRIVER_FILES[pkg] !== f.file ? [`${f.file} imports ${to}: only ${DRIVER_FILES[pkg]} imports ${pkg}`] : [];
  }));
}

/**
 * (2) kernel/ importing anything under modules/; kernel/ or modules/ source importing db/ (the runner, janitor and seeds
 * sit above both; tests may read the seed's values).
 */
function kernelImports(files: File[]): string[] {
  return files.flatMap((f) => importsOf(f).flatMap((to) => {
    if (f.file.startsWith("src/kernel/") && to.startsWith("src/modules")) return [`${f.file} → ${to}: kernel/ never imports modules/`];
    if (/^src\/(kernel|modules)\//.test(f.file) && !f.file.includes("/tests/") && to.startsWith("src/db")) return [`${f.file} → ${to}: kernel/ and modules/ never import db/`];
    return [];
  }));
}

/** (3) Tables declared outside a modules/<m>/schema.ts, declared twice, or present in the database without an owner. */
function tableOwners(files: File[], dbTables: string[]): string[] {
  const owners = new Map<string, string[]>();
  const out: string[] = [];
  for (const f of files.filter((x) => x.file.startsWith("src/"))) {
    for (const m of f.src.matchAll(/\bpgTable\(\s*["'`]([\w-]+)["'`]/g)) {
      if (!/^src\/modules\/[\w-]+\/schema\.ts$/.test(f.file)) out.push(`${f.file}: table ${m[1]} declared outside a modules/<m>/schema.ts`);
      owners.set(m[1]!, [...(owners.get(m[1]!) ?? []), f.file]);
    }
  }
  for (const [t, by] of owners) if (by.length > 1) out.push(`table ${t} owned by ${by.join(", ")}`);
  for (const t of dbTables) if (!owners.has(t)) out.push(`table ${t} exists in the database but no module owns it`);
  return out;
}

/** (4) A test file outside modules/<m>/tests/, kernel/tests/ and apps/api/test/. */
function misplacedTests(files: File[]): string[] {
  return files.filter((f) => f.file.endsWith(".test.ts"))
    .filter((f) => !/^(src\/modules\/[\w-]+\/tests\/|src\/kernel\/tests\/|test\/)/.test(f.file))
    .map((f) => `${f.file}: tests live in modules/<m>/tests/, kernel/tests/ or apps/api/test/, not beside the source`);
}

/** SELECT…FROM, INSERT INTO, UPDATE <table> [[as] alias] SET <column> = (table plain, quoted or schema-qualified), DELETE FROM. */
const STATEMENT = [/\bselect\b[\s\S]*?\bfrom\b/i, /\binsert\s+into\b/i, /\bupdate\s+(only\s+)?[\w."]+(\s+(as\s+)?\w+)?\s+set\s+[\w"]+\s*=/i, /\bdelete\s+from\b/i];

/** (5) A string or template literal (placeholders as `?`) that spells a full SELECT…FROM / INSERT INTO / UPDATE…SET / DELETE FROM. */
function rawSql(files: File[]): string[] {
  return files.filter((f) => f.file.startsWith("src/") && !rawSqlOk(f.file)).flatMap((f) => {
    const sf = ts.createSourceFile(f.file, f.src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
      const text = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text
        : ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ? ") : null;
      if (text !== null && STATEMENT.some((r) => r.test(text))) hits.push(`${f.file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: SQL statement written by hand; use the Drizzle builder`);
      if (text === null) ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  });
}

/**
 * (6) `file` imported alone by a fresh `bun` process that then calls every exported `…Controller` factory (and
 * `createApp`): exit 0, or the error. Module indexes may import each other; one that uses another module's export at
 * load (not inside a function) fails here with a ReferenceError, whichever index loads first.
 */
function loadsAlone(file: string, build = true): { ok: boolean; out: string } {
  const code = `const m = await import(${JSON.stringify(file)});
${build ? `for (const [k, v] of Object.entries(m)) if (/Controller$/.test(k) || k === "createApp") v();` : ""}
process.exit(0);`;
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: ROOT, env: process.env, stderr: "pipe", stdout: "pipe" });
  return { ok: r.exitCode === 0, out: r.stderr.toString() };
}

/** Bun SQL or a transaction of it: the tagged template the catalog queries run on. */
type Q = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** The current schema's tables but schema_migrations; a partition counts as its parent's (it has no owner of its own). */
const dbTables = async (q: Q): Promise<string[]> => (await q<{ t: string }[]>`
  select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = current_schema() and c.relkind in ('r', 'p') and not c.relispartition and c.relname <> 'schema_migrations'`).map((r) => r.t);

/** (7) A file of modules/spaces outside its tests importing kernel/worker-db. */
function workerPoolImports(files: File[]): string[] {
  return files.filter((f) => f.file.startsWith("src/modules/spaces/") && !f.file.includes("/tests/"))
    .flatMap((f) => importsOf(f).filter((to) => to === "src/kernel/worker-db").map(() => `${f.file}: imports kernel/worker-db; the API process loads modules/spaces and must not open the worker pool`));
}

type SpaceTable = { table: string; rls: boolean; force: boolean; policies: { name: string; cmd: string; permissive: boolean; using: string | null; check: string | null }[] };

/** Every table (partitions included) of the current schema with a space_id column, its RLS flags and its policies. */
const spaceTables = (q: Q): Promise<SpaceTable[]> => q<SpaceTable[]>`
  select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force,
    coalesce(json_agg(json_build_object('name', p.polname, 'cmd', p.polcmd, 'permissive', p.polpermissive, 'using', pg_get_expr(p.polqual, p.polrelid),
      'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname) filter (where p.oid is not null), '[]') as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'space_id' and not a.attisdropped
  left join pg_policy p on p.polrelid = c.oid
  where n.nspname = current_schema() and c.relkind in ('r', 'p')
  group by c.oid order by c.relname`;

/**
 * Tables with a space_id column that are not space data: read before any space scope exists, so RLS would hide them
 * from the guard itself. A stale entry fails.
 */
const RLS_EXEMPT: Record<string, string> = {
  space_members: "who holds which role in a space: the guard reads it to decide the scope, before withSpace can set one",
};
const VISIBLE = "recon_space_visible(space_id)";

/**
 * Extra policies ("table.policy") a space_id table may have besides its standard one: permissive and FOR SELECT only,
 * so they widen what a space reads and never what it writes (permissive policies OR together per command; INSERT,
 * UPDATE and DELETE see only the standard one). A stale entry fails.
 */
const EXTRA_READ_POLICIES: Record<string, string> = {
  "sources.sources_shared": "a source shared to a space (source_shares) is readable there (spec §11: source_share read-only)",
  "source_versions.source_versions_shared": "a shared source's published and retired versions are readable where it is shared",
  "source_shares.source_shares_to": "the space a source is shared to sees its share row, which the _shared policies read",
  "records.records_shared": "a shared source's records are what a recon in the space it is shared to matches on (DEC-042)",
  "raw_rows.raw_rows_shared": "a shared source's raw rows, the provenance of those records (DEC-042)",
  "source_cursors.source_cursors_shared": "complete_through of a shared source: the grace of a recon reading it and its health",
  "source_snapshots.source_snapshots_shared": "which snapshot of a shared source is active for a date: its records count only then",
  "source_files.source_files_shared": "which files of a shared source are ingested for a date: its health in the space it is shared to",
  "recon_source_uses.recon_source_uses_source_owner": "the space that owns a source reads which published recons (any space it shares to) use which of its fields, to refuse a source version that drops one (Plan 3 A4)",
  "source_day_counts.source_day_counts_shared": "a shared source's records today (kind 'records' only; its quarantined count stays the owner's), shown in the shared space's sources list",
};

/**
 * (8) A space_id table without ENABLE and FORCE row level security, or whose policies are not exactly one permissive
 * policy for every command with recon_space_visible(space_id) as USING and WITH CHECK (drizzle/0009,
 * recon_enable_space_rls) plus only allowlisted permissive FOR SELECT policies.
 */
function rlsGaps(rows: SpaceTable[], exempt: Record<string, string> = RLS_EXEMPT, extra: Record<string, string> = EXTRA_READ_POLICIES): string[] {
  const out: string[] = [];
  for (const r of rows.filter((x) => !(x.table in exempt))) {
    if (!r.rls || !r.force) out.push(`${r.table}: has space_id but row level security is not enabled and forced`);
    const standard = r.policies.filter((p) => !(`${r.table}.${p.name}` in extra));
    const [p, ...more] = standard;
    if (!p || more.length || p.cmd !== "*" || !p.permissive || p.using !== VISIBLE || p.check !== VISIBLE) {
      out.push(`${r.table}: needs exactly one policy, for all commands, USING and WITH CHECK ${VISIBLE} (select recon_enable_space_rls('${r.table}'))`);
    }
    for (const x of r.policies.filter((q) => `${r.table}.${q.name}` in extra && (q.cmd !== "r" || !q.permissive))) {
      out.push(`${r.table}: allowlisted policy ${x.name} must be permissive and FOR SELECT only`);
    }
  }
  for (const t of Object.keys(exempt)) if (!rows.some((r) => r.table === t)) out.push(`${t}: exempt from the RLS rule but no such table has space_id`);
  for (const k of Object.keys(extra)) {
    const [t, name] = k.split(".");
    if (!rows.some((r) => r.table === t && r.policies.some((p) => p.name === name))) out.push(`${k}: allowlisted read policy but no such policy`);
  }
  return out;
}

/**
 * Functions that run as their owner (security definer), passing the app role's grants and row level security, and why.
 * Each answers only what its reason says; a new one, or a stale entry, fails.
 */
const SECURITY_DEFINER: Record<string, string> = {
  recon_ensure_month_partitions: "adds a domain table's monthly partitions: only the owner may (drizzle/0009)",
  recon_analyze_month_partitions: "ANALYZE of partitions a run wrote: only the owner may (drizzle/0026)",
  recon_analyze_table: "ANALYZE of match tables a run wrote: only the owner may (drizzle/0033)",
  recon_source_day_closed: "whether any space closed a source's date: a boolean, no other space's data (drizzle/0042)",
  recon_connector_used_by: "how many recons of active spaces call a connector: (connector_id, count) only, no recon or space data (drizzle/0058)",
};

/** Security definer functions of the current schema, by name. */
const definers = (q: Q): Promise<{ name: string }[]> => q<{ name: string }[]>`
  select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = current_schema() and p.prosecdef order by p.proname`;

/** (10) A security definer function not in `allow`, or an entry with no such function. */
function definerGaps(names: string[], allow: Record<string, string> = SECURITY_DEFINER): string[] {
  return [
    ...names.filter((n) => !(n in allow)).map((n) => `${n}: security definer but not in SECURITY_DEFINER (say what it answers and why it runs as the owner)`),
    ...Object.keys(allow).filter((k) => !names.includes(k)).map((k) => `${k}: in SECURITY_DEFINER but no such security definer function`),
  ];
}

const scan = (dir: string): File[] =>
  [...new Bun.Glob("**/*.ts").scanSync(path.join(ROOT, dir))].map((f) => `${dir}/${f}`).map((file) => ({ file, src: readFileSync(path.join(ROOT, file), "utf8") }));
const real = [...scan("src"), ...scan("test")];
const f = (file: string, src: string): File => ({ file, src });

describe("module boundaries (apps/api)", () => {
  it("a module is used only through its index.ts", () => {
    expect(deepImports(real)).toEqual([]);
  });

  it("kernel/ never imports modules/, and neither imports db/", () => {
    expect(kernelImports(real)).toEqual([]);
  });

  it("every table is owned by exactly one module, the database's tables included", async () => {
    const tables = await dbTables(client);
    expect(tables.length).toBeGreaterThan(0);
    expect(tableOwners(real, tables)).toEqual([]);
  });

  it("modules/spaces never imports kernel/worker-db (its tests may)", () => {
    expect(workerPoolImports(real)).toEqual([]);
  });

  it("each source database driver is imported only by its connector file; every allowlisted SQL path exists", () => {
    expect(driverImports(real)).toEqual([]);
    expect(Object.keys(RAW_SQL_OK).filter((k) => !real.some((x) => (k.endsWith("/") ? x.file.startsWith(k) : x.file === k)))).toEqual([]);
  });

  it("every table with a space_id column forces row level security with the one recon_space_visible policy (exemptions are real tables)", async () => {
    const rows = await spaceTables(client);
    expect(rows.length).toBeGreaterThan(0);
    expect(rlsGaps(rows)).toEqual([]);
  });

  it("every security definer function is allowlisted with its reason", async () => {
    expect(definerGaps((await definers(client)).map((r) => r.name))).toEqual([]);
  });

  it("no test file sits beside the source", () => {
    expect(misplacedTests(real)).toEqual([]);
  });

  it("no hand-written SQL statement in src/ outside the migration runner", () => {
    expect(rawSql(real)).toEqual([]);
  });

  it("every module index and app.ts loads alone and builds its controllers (no export of another module used at load)", () => {
    const entries = [...real.filter((x) => /^src\/modules\/[\w-]+\/index\.ts$/.test(x.file)).map((x) => x.file), "src/app.ts"];
    expect(entries.length).toBeGreaterThan(8);
    expect(entries.map((e) => [e, loadsAlone(path.join(ROOT, e))]).filter(([, r]) => !(r as { ok: boolean }).ok)).toEqual([]);
  }, 60_000);
});

describe("module boundaries: fixtures", () => {
  it("fixture: a security definer function outside the allowlist fails, and so does a stale entry", () => {
    expect(definerGaps(["recon_a", "recon_b"], { recon_a: "why", recon_gone: "why" })).toEqual([
      "recon_b: security definer but not in SECURITY_DEFINER (say what it answers and why it runs as the owner)",
      "recon_gone: in SECURITY_DEFINER but no such security definer function",
    ]);
  });

  it("fixture: two indexes that import each other load; one that uses the other's export at load fails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "isolation-"));
    try {
      writeFileSync(path.join(dir, "a.ts"), `import { b } from "./b"; export const a = 1; export const aController = () => b();`);
      writeFileSync(path.join(dir, "b.ts"), `import { a } from "./a"; export const b = () => a;`);
      writeFileSync(path.join(dir, "c.ts"), `import { d } from "./d"; export const c = 1; export const cController = () => d;`);
      writeFileSync(path.join(dir, "d.ts"), `import { c } from "./c"; export const d = c + 1;`);
      expect(loadsAlone(path.join(dir, "a.ts")).ok).toBe(true);
      const bad = loadsAlone(path.join(dir, "c.ts"));
      expect(bad.ok).toBe(false);
      expect(bad.out).toContain("ReferenceError");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fixture: an index that imports cleanly but whose controller factory hits an uninitialized binding fails (the factory call matters)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "isolation-"));
    try {
      // The factory reads `plugin` before its declaration runs: nothing happens at import, the call throws.
      writeFileSync(path.join(dir, "e.ts"), `export const eController = () => { const app = [plugin]; const plugin = 1; return app; };`);
      expect(loadsAlone(path.join(dir, "e.ts"), false).ok).toBe(true);
      const bad = loadsAlone(path.join(dir, "e.ts"));
      expect(bad.ok).toBe(false);
      expect(bad.out).toContain("ReferenceError");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fixture: a deep import into another module fails; its index, its own files and schema-to-schema pass", () => {
    expect(deepImports([
      f("src/modules/users/service.ts", `import { sessions } from "../auth/schema"; import { createSession } from "../auth/sessions";`),
      f("src/modules/users/controller.ts", `import { guard } from "../auth"; import { users } from "./schema"; export { x } from "../auth/index";`),
      f("src/modules/oauth/schema.ts", `import { sessions } from "../auth/schema";`),
      f("src/db/seed/demo.ts", `import { users } from "../../modules/users/schema";`),
      f("test/helpers/x.ts", `const m = await import("../../src/modules/auth/limits");`),
      f("src/db/seed/x.ts", `import { totp } from "@starterkit/api/src/modules/auth/totp.ts"; import { guard } from "@starterkit/api/src/modules/auth";`),
    ])).toEqual([
      `src/modules/users/service.ts → src/modules/auth/schema: import "src/modules/auth" (its index.ts), not its internals`,
      `src/modules/users/service.ts → src/modules/auth/sessions: import "src/modules/auth" (its index.ts), not its internals`,
      `src/db/seed/demo.ts → src/modules/users/schema: import "src/modules/users" (its index.ts), not its internals`,
      `test/helpers/x.ts → src/modules/auth/limits: import "src/modules/auth" (its index.ts), not its internals`,
      `src/db/seed/x.ts → src/modules/auth/totp: import "src/modules/auth" (its index.ts), not its internals`,
    ]);
  });

  it("fixture: kernel importing a module, or a module importing db/, fails", () => {
    expect(kernelImports([f("src/kernel/plugins/x.ts", `import { guard } from "../../modules/auth";`), f("src/kernel/db.ts", `import { x } from "./config";`)]))
      .toEqual(["src/kernel/plugins/x.ts → src/modules/auth: kernel/ never imports modules/"]);
    expect(kernelImports([f("src/modules/auth/ldap.ts", `import { PW } from "../../db/seed/demo";`), f("src/db/seed/demo.ts", `import { x } from "../../modules/auth";`)]))
      .toEqual(["src/modules/auth/ldap.ts → src/db/seed/demo: kernel/ and modules/ never import db/"]);
  });

  it("fixture: a table declared twice, outside a schema.ts, or only in the database fails", () => {
    expect(tableOwners([
      f("src/modules/a/schema.ts", `export const t = pgTable("things", {}); export const u = pgTable("ones", {});`),
      f("src/modules/b/schema.ts", `export const t = pgTable("things", {});`),
      f("src/modules/b/service.ts", `const tmp = pgTable("scratch", {});`),
    ], ["things", "ones", "scratch", "orphans"])).toEqual([
      "src/modules/b/service.ts: table scratch declared outside a modules/<m>/schema.ts",
      "table things owned by src/modules/a/schema.ts, src/modules/b/schema.ts",
      "table orphans exists in the database but no module owns it",
    ]);
  });

  it("fixture: a test beside a source file fails; tests/ folders and apps/api/test pass", () => {
    expect(misplacedTests([
      f("src/modules/auth/limits.test.ts", ""), f("src/kernel/config.test.ts", ""),
      f("src/modules/auth/tests/unit/totp.test.ts", ""), f("src/kernel/tests/integration/db.test.ts", ""), f("test/db/seed.test.ts", ""),
      f("src/conformance.test.ts", ""), f("src/modules/audit/service.test.ts", ""),
    ])).toEqual([
      "src/modules/auth/limits.test.ts: tests live in modules/<m>/tests/, kernel/tests/ or apps/api/test/, not beside the source",
      "src/kernel/config.test.ts: tests live in modules/<m>/tests/, kernel/tests/ or apps/api/test/, not beside the source",
      "src/conformance.test.ts: tests live in modules/<m>/tests/, kernel/tests/ or apps/api/test/, not beside the source",
      "src/modules/audit/service.test.ts: tests live in modules/<m>/tests/, kernel/tests/ or apps/api/test/, not beside the source",
    ]);
  });

  it("fixture: SELECT…FROM, INSERT INTO, UPDATE…SET and DELETE FROM in a string or template fail; expressions and prose pass", () => {
    expect(rawSql([
      f("src/modules/a/service.ts", [
        "const a = sql`select id from users where id = ${id}`;",
        "const b = tx`insert into activity (id) values (${id})`;",
        "const c = \"update sessions set last_seen_at = now()\";",
        "const d = sql`delete from sessions where id = ${id}`;",
        "const e = sql`array(${q}) || ${x}`; const g = sql`now() - make_interval(mins => ${n})`; const h = sql`pg_advisory_xact_lock(${k})`;",
        "const msg = \"Update your profile, then sign in.\"; // select a row from the table",
        "const i = sql`update users u set name = ${n}`;",
        "const j = sql`UPDATE public.users SET name = ${n}`;",
        "const k = sql`update \"users\" as u set name = ${n}`;",
        "const l = sql`delete from public.sessions where id = ${id}`;",
        "const m = sql`insert into public.activity (id) values (${id})`;",
        "const o = \"Update the role set before you save.\";",
      ].join("\n")),
      f("src/db/migrate.ts", "await conn`select name from schema_migrations`;"),
      f("src/modules/ingest/connectors/postgres.ts", "await sql.unsafe(\"SELECT oid FROM pg_type\");"),
      f("test/helpers/db.ts", "await client`select 1 from pg_tables`;"),
    ])).toEqual([
      "src/modules/a/service.ts:1: SQL statement written by hand; use the Drizzle builder",
      "src/modules/a/service.ts:2: SQL statement written by hand; use the Drizzle builder",
      "src/modules/a/service.ts:3: SQL statement written by hand; use the Drizzle builder",
      "src/modules/a/service.ts:4: SQL statement written by hand; use the Drizzle builder",
      ...[7, 8, 9, 10, 11].map((n) => `src/modules/a/service.ts:${n}: SQL statement written by hand; use the Drizzle builder`),
    ]);
  });

  it("fixture: a driver imported outside its connector file fails; its own file and tests pass", () => {
    expect(driverImports([
      f("src/modules/ingest/connectors/oracle.ts", `import oracledb from "oracledb";`),
      f("src/modules/ingest/connectors/mysql.ts", `import { createConnection } from "mysql2/promise";`),
      f("src/modules/ingest/connectors/postgres.ts", `import oracledb from "oracledb";`),
      f("src/modules/sources/service.ts", `import { ConnectionPool } from "mssql";`),
      f("src/modules/ingest/tests/integration/engines.test.ts", `import { ConnectionPool } from "mssql";`),
    ])).toEqual([
      "src/modules/ingest/connectors/postgres.ts imports oracledb: only src/modules/ingest/connectors/oracle.ts imports oracledb",
      "src/modules/sources/service.ts imports mssql: only src/modules/ingest/connectors/mssql.ts imports mssql",
    ]);
  });

  it("fixture: modules/spaces importing kernel/worker-db fails; its tests and other modules pass", () => {
    expect(workerPoolImports([
      f("src/modules/spaces/service.ts", `import { workerDb } from "../../kernel/worker-db";`),
      f("src/modules/spaces/jobs.ts", `export { workerDb } from "@starterkit/api/src/kernel/worker-db.ts";`),
      f("src/modules/spaces/tests/integration/rls.test.ts", `import { workerDb } from "../../../../kernel/worker-db";`),
      f("src/modules/ingest/handlers.ts", `import { workerDb } from "../../kernel/worker-db";`),
      f("src/modules/spaces/index.ts", `import { db } from "../../kernel/db";`),
    ])).toEqual([
      "src/modules/spaces/service.ts: imports kernel/worker-db; the API process loads modules/spaces and must not open the worker pool",
      "src/modules/spaces/jobs.ts: imports kernel/worker-db; the API process loads modules/spaces and must not open the worker pool",
    ]);
  });

  it("fixture: a space_id table without RLS, without FORCE or with a wrong or extra policy fails; recon_enable_space_rls passes; an allowlisted FOR SELECT policy passes; a partition is no table of its own", async () => {
    const ROLLBACK = new Error("rollback");
    let seen = null as { gaps: string[]; tables: string[] } | null;
    await client.begin(async (tx) => {
      await tx`create table fx_none (space_id uuid not null, x int)`;
      await tx`create table fx_soft (space_id uuid not null)`;
      await tx`alter table fx_soft enable row level security`;
      await tx`create policy fx_soft_space on fx_soft using (recon_space_visible(space_id)) with check (recon_space_visible(space_id))`;
      await tx`create table fx_wide (space_id uuid not null)`;
      await tx`select recon_enable_space_rls('fx_wide')`;
      await tx`create policy fx_wide_all on fx_wide for select using (true)`;
      await tx`create table fx_ok (space_id uuid not null, business_date date not null) partition by range (business_date)`;
      await tx`create table fx_ok_2026_11 partition of fx_ok for values from ('2026-11-01') to ('2026-12-01')`;
      await tx`select recon_enable_space_rls('fx_ok')`;
      await tx`select recon_enable_space_rls('fx_ok_2026_11')`;
      await tx`create table fx_plain (id uuid)`;
      await tx`create table fx_read (space_id uuid not null)`;
      await tx`select recon_enable_space_rls('fx_read')`;
      await tx`create policy fx_read_more on fx_read for select using (true)`;
      await tx`create table fx_write (space_id uuid not null)`;
      await tx`select recon_enable_space_rls('fx_write')`;
      await tx`create policy fx_write_more on fx_write for update using (true)`;
      const q = tx as unknown as Q;
      const extra = { "fx_read.fx_read_more": "fixture", "fx_write.fx_write_more": "fixture", "fx_gone.fx_gone_more": "fixture" };
      seen = { gaps: rlsGaps((await spaceTables(q)).filter((r) => r.table.startsWith("fx_")), {}, extra), tables: (await dbTables(q)).filter((t) => t.startsWith("fx_")).sort() };
      throw ROLLBACK;
    }).catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
    const policy = (t: string) => `${t}: needs exactly one policy, for all commands, USING and WITH CHECK ${VISIBLE} (select recon_enable_space_rls('${t}'))`;
    expect(seen).toEqual({
      gaps: [
        "fx_none: has space_id but row level security is not enabled and forced", policy("fx_none"), "fx_soft: has space_id but row level security is not enabled and forced",
        policy("fx_wide"), "fx_write: allowlisted policy fx_write_more must be permissive and FOR SELECT only", "fx_gone.fx_gone_more: allowlisted read policy but no such policy",
      ],
      tables: ["fx_none", "fx_ok", "fx_plain", "fx_read", "fx_soft", "fx_wide", "fx_write"],
    });
    expect(rlsGaps([], { gone: "x" }, {})).toEqual(["gone: exempt from the RLS rule but no such table has space_id"]);
  });
});
