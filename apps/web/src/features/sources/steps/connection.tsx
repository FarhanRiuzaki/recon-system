"use client";

import dynamic from "next/dynamic";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ChoiceCard, Field, InfoTip, Panel, Segmented, type SqlSuggest, Switch } from "@starterkit/ui/ds";
import { APP_TIME_ZONE_LABEL, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CheckIcon, EditIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { PasswordInput } from "@starterkit/ui/ui/password-input";
import { Select } from "@starterkit/ui/ui/select";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import {
  DATE_LOOKBACK_MIN_SECONDS, DB_ENGINES, FILE_ENCODINGS, isLocalHost, LOOKBACK_IDS_DEFAULT, LOOKBACK_IDS_MAX, READ_EVERY, type ReadWhen, readWhenText, type SourceKind,
} from "@starterkit/shared/sources";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { lookbackText, scheduleText } from "../source-text";
import { errorText } from "@/lib/client/api";
import { DATABASE_NOTE, type ListState, type TablesPage } from "./catalog";
import { emptySpec, type Conn, connKey, ctl, type Draft, FIELD_CONTROL, lookbackNote, type Tested, type WatermarkKind, withEngine, withName } from "./model";

// The database, schema and table pickers show only for a database source: they load after the page (preloaded when
// the connection step mounts) and hold a field's height meanwhile, as their own combobox does (bundle budget, DEC-040).
const loadPickers = () => import("./pickers");
const pickerShape = () => <div aria-hidden="true" className="grid gap-1.5"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-full" /></div>;
const NamePicker = dynamic(() => loadPickers().then((m) => m.NamePicker), { ssr: false, loading: pickerShape });
const TablePicker = dynamic(() => loadPickers().then((m) => m.TablePicker), { ssr: false, loading: pickerShape });

// The SQL editor shows only for a query of one's own (a database source): it loads with that choice, not with the page
// (bundle budget, DEC-040); its place keeps the editor's height meanwhile.
const SqlEditor = dynamic(() => import("@starterkit/ui/ds/sql-editor").then((m) => m.SqlEditor), {
  ssr: false, loading: () => <div aria-hidden="true" className="h-36 rounded-md border border-control-border bg-card" />,
});

const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", oracle: "Oracle" } as const;
const STORED = "Stored. Enter a new value to replace it.";
const DELIMITERS = [["|", "Pipe |"], [",", "Comma ,"], [";", "Semicolon ;"], ["\t", "Tab"]] as const;

type WatermarkInput = Extract<SourceSpec["input"], { kind: "db_watermark" }>;

/** The pickers' lists and actions (REC-F2a), kept by the wizard. */
export type CatalogProps = {
  /** "Check query": the columns a SELECT gives over the connection on screen (POST …/catalog list query). */
  onCheckQuery: (query: string) => Promise<{ columns: { name: string }[] }>;
  /** Tables and columns for the SELECT's suggestions, read over the connection on screen. */
  onSuggest: SqlSuggest;
  /** Databases (Oracle: schemas) the login can open, read after a passing test. */
  names: ListState<{ items: string[]; truncated: boolean }>;
  tables: ListState<TablesPage>;
  /** The connection changed since the lists were read (engine, host, port, user, password, TLS). */
  stale: boolean;
  /** The database changed since the table list was read. */
  tablesStale: boolean;
  free: { database: boolean; table: boolean };
  onFree: (k: "database" | "table", free: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  /** Oracle: the schema the table list is narrowed to. */
  schema: string;
  onSchema: (v: string) => void;
  onPickDatabase: (v: string) => void;
  onPickTable: (v: string) => void;
  onRetryNames: () => void;
  onRetryTables: () => void;
  columns: { reading: boolean; n: number | null };
};

export type ConnectionStepProps = {
  d: Draft;
  set: (fn: (d: Draft) => Draft) => void;
  /** The source exists already: name, code and kind are fixed (no route changes them). */
  created: boolean;
  /** A connection is stored and the form still shows it as it is: the credential fields may stay empty. */
  stored: boolean;
  err: (id: string) => string | undefined;
  tested: Tested | null;
  testing: boolean;
  onTest: () => void;
  /**
   * A test passed over the connection on screen (its lists belong to it): the server's short version, else null.
   * `listed` = some test passed since the form opened (the Data stage shows, marked stale when the connection changed).
   */
  connected: { version: string | null } | null;
  listed: boolean;
  catalog: CatalogProps;
  /** Editing a published source: the version a change of how rows are read makes; null otherwise. */
  nextVersion: number | null;
  /** What the picked watermark holds (step 2), which decides its look back; null before a pick. */
  wmKind: WatermarkKind | null;
};

/** A rejected or untested connection string: one sentence, one step. */
const UNREADABLE = "This connection string can't be read. Use postgresql://, mysql://, sqlserver:// or oracle://.";

/**
 * Step 1, Connection (REC-F2b, Figma 02 v1.0.5; rules in docs/recon/ux-form-rules.md): Source → where the data comes
 * from → Server (engine, host and port, then Sign in) → Connect → Data (database, table) → How to pull. A stage shows
 * once the one before it is done; the connected server folds into one line with Change. Connect checks exactly the
 * values on screen, storing nothing; the wizard's Next makes the source (or replaces its connection) only then.
 */
export function ConnectionStep(p: ConnectionStepProps) {
  const { d, set, created } = p;
  useEffect(() => { void loadPickers(); }, []);
  const i = d.spec.input;
  const setInput = (patch: Partial<SourceSpec["input"]>) => set((x) => ({ ...x, spec: { ...x.spec, input: { ...x.spec.input, ...patch } as SourceSpec["input"] } }));
  const setKind = (kind: SourceKind) => set((x) => (x.kind === kind ? x : { ...x, kind, spec: emptySpec(kind) }));
  const db = d.kind !== "file_inbox";
  // a failed test's sentence sits on the field it names while the values it ran with stay on screen (else under Connect)
  const failed = p.tested && !p.tested.result.ok && p.tested.key === connKey(d) ? p.tested.result : null;
  const failedOn = failed ? (failed.field ? FIELD_CONTROL[failed.field] : db ? "src-connect" : ctl("input.path")) : null;
  const err = (id: string) => p.err(id) ?? (failedOn === id ? failed!.message : undefined);
  const [codeOpen, setCodeOpen] = useState(false);

  return (
    <div className="grid gap-section">
      <Panel title="Source" bodyClassName="grid gap-2">
        <Field id="src-name" label="Name" required={!created} error={err("src-name")}>
          <Input id="src-name" value={d.name} readOnly={created} onChange={(e) => { const v = e.target.value; set((x) => withName(x, v)); }} autoComplete="off" />
        </Field>
        {!created && (codeOpen || err("src-code")) ? (
          <Field id="src-code" label="Code" required note="Can't be changed later." error={err("src-code")}>
            <Input id="src-code" value={d.code} className="font-mono" onChange={(e) => { const v = e.target.value; set((x) => ({ ...x, code: v })); }} autoComplete="off" spellCheck={false} />
          </Field>
        ) : (
          <p className="flex flex-wrap items-center gap-1 text-caption text-fg-3">
            <span>Code: <span className="font-mono">{d.code || "–"}</span></span>
            {!created && <><span aria-hidden="true">·</span><Button type="button" variant="edit" size="sm" className="text-caption" onClick={() => {
              setCodeOpen(true);
              requestAnimationFrame(() => document.getElementById("src-code")?.focus());
            }}><Icon icon={EditIcon} />Edit<span className="sr-only"> code</span></Button></>}
          </p>
        )}
      </Panel>

      {/* The two choices are the cards themselves, straight on the tray: one surface level (ui-standard §1a). */}
      <Panel cards title="Where the data comes from" bodyClassName="grid gap-list md:grid-cols-2">
        <ChoiceCard inCard name="src-from" label="Database" checked={db} disabled={created && !db} onChange={() => setKind("db_watermark")}
          description="PostgreSQL, MySQL, SQL Server or Oracle." />
        <ChoiceCard inCard name="src-from" label="File inbox" checked={!db} disabled={created && db} onChange={() => setKind("file_inbox")}
          description="An SFTP or NFS folder; files are picked up by name." />
      </Panel>

      {db ? (
        <>
          <Server {...p} err={err} failed={failedOn === "src-connect" ? failed!.message : null} />
          {p.listed && <Data {...p} err={err} setInput={setInput} />}
          {/* how and when to pull needs no connection: a saved source shows it at once (the table picker above does) */}
          {(p.listed || created) && <Pull {...p} err={err} setInput={setInput} setKind={setKind} />}
        </>
      ) : i.kind === "file_inbox" && <Folder {...p} err={err} setInput={setInput} />}
    </div>
  );
}

/** The stage's action: "Connect", "Connecting…" with a spinner while it runs; the fields stay editable. Secondary: Next is the one primary, lit once the connect succeeds (P6). */
function ActionButton({ testing, onTest, label, busy }: { testing: boolean; onTest: () => void; label: string; busy: string }) {
  return (
    <Button id="src-connect-button" type="button" variant="secondary" className="w-full md:w-48" onClick={() => { if (!testing) onTest(); }} aria-disabled={testing || undefined} aria-busy={testing || undefined}>
      {testing && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{testing ? busy : label}
    </Button>
  );
}

/** Enter in a field of the stage runs its action (rule 10); never the wizard's Next. */
const enterRuns = (run: () => void) => (e: KeyboardEvent<HTMLDivElement>) => {
  const t = e.target as HTMLElement;
  if (e.key !== "Enter" || t.tagName !== "INPUT" || (t as HTMLInputElement).type === "checkbox") return;
  e.preventDefault();
  run();
};

/**
 * A file inbox's folder (Figma 02 v1.0.5, 06): Folder → Check folder (the stage's action, also on Enter) → its answer;
 * then the pattern and format, completion and encoding under a closed Advanced. A pattern typed after the check is
 * checked again when the field is left, so Next counts it.
 */
function Folder(p: ConnectionStepProps & { setInput: (patch: Partial<SourceSpec["input"]>) => void }) {
  const { d, err, setInput } = p;
  const i = d.spec.input;
  const passed = !!p.tested?.result.ok && p.tested.key === connKey(d);
  const want = p.created || !!p.tested?.result.ok;
  const [seen, setSeen] = useState(want);
  if (want && !seen) setSeen(true);
  if (i.kind !== "file_inbox") return null;
  const check = () => p.onTest();
  const completion = i.completion.kind === "marker_file" ? "Complete when a .done file arrives" : `Complete after ${formatNumber(i.completion.seconds)} s without a change`;
  return (
    <Panel title="Folder" bodyClassName="grid gap-4">
      <div className="grid gap-4" onKeyDown={enterRuns(check)}>
        <Field id={ctl("input.path")} label="Folder" required error={err(ctl("input.path"))}>
          <Input id={ctl("input.path")} value={i.path} className="font-mono" onChange={(e) => setInput({ path: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
        <div className="grid gap-2">
          <span><ActionButton testing={p.testing} onTest={check} label="Check folder" busy="Checking…" /></span>
          {passed && <p role="status" className="text-body text-fg">{p.tested!.result.message}</p>}
        </div>
        {seen && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field id={ctl("input.pattern")} label="File name pattern" error={err(ctl("input.pattern"))}>
              <Input id={ctl("input.pattern")} value={i.pattern} className="font-mono" onChange={(e) => setInput({ pattern: e.target.value })} autoComplete="off" spellCheck={false}
                onBlur={() => { if (i.path.trim() && i.pattern.trim() && !passed && !p.testing) check(); }} />
            </Field>
            <Field id={ctl("input.format.delimiter")} label="Delimiter" error={err(ctl("input.format.delimiter"))}>
              <Select className="w-full min-w-0" id={ctl("input.format.delimiter")} value={i.format.delimiter} onChange={(e) => setInput({ format: { ...i.format, delimiter: e.target.value } })}>
                {DELIMITERS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </div>
      {seen && (
        <>
          <span className="inline-flex items-center gap-2">
            <Switch id={ctl("input.format.header")} checked={i.format.header} onChange={(e) => setInput({ format: { ...i.format, header: e.target.checked } })} aria-label="First row is a header" />
            <label htmlFor={ctl("input.format.header")} className="text-body text-fg">First row is a header</label>
          </span>
          <ReadWhenField label="Check the folder" when={i.when} onChange={(when) => setInput({ when })} />
          <Advanced summary={`${completion} · ${i.format.encoding.toUpperCase()}`} open={!!err(ctl("input.completion.seconds"))}>
            <Field id={ctl("input.completion")} label="File is complete when"
              note="The same content sent again is rejected; new content under the same name is the next version.">
              <Select className="w-full min-w-0" id={ctl("input.completion")} value={i.completion.kind} onChange={(e) => setInput({ completion: e.target.value === "marker_file" ? { kind: "marker_file" } : { kind: "stable_seconds", seconds: 60 } })}>
                <option value="stable_seconds">Its size stays the same for a while</option>
                <option value="marker_file">A .done file with the same name arrives</option>
              </Select>
            </Field>
            {i.completion.kind === "stable_seconds" && (
              <Field id={ctl("input.completion.seconds")} label="Seconds without a change" error={err(ctl("input.completion.seconds"))}>
                <Input id={ctl("input.completion.seconds")} inputMode="numeric" value={String(i.completion.seconds)}
                  onChange={(e) => setInput({ completion: { kind: "stable_seconds", seconds: Math.max(1, Math.min(86_400, Number(e.target.value.replace(/\D/g, "")) || 1)) } })} />
              </Field>
            )}
            <Field id={ctl("input.format.encoding")} label="Encoding">
              <Select className="w-full min-w-0" id={ctl("input.format.encoding")} value={i.format.encoding} onChange={(e) => setInput({ format: { ...i.format, encoding: e.target.value as (typeof FILE_ENCODINGS)[number] } })}>
                {FILE_ENCODINGS.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}
              </Select>
            </Field>
          </Advanced>
        </>
      )}
    </Panel>
  );
}

/** Settings rarely changed, closed, with what they are now beside the title (rule 4); opened when one holds an error. */
function Advanced({ summary, open, children }: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="group" open={open || undefined}>
      <summary className="flex min-h-8 cursor-pointer list-none flex-wrap items-center gap-x-2 rounded-sm text-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform duration-(--dur-fast) group-open:rotate-90">›</span>
        <span className="font-medium">Advanced</span>
        <span className="text-caption text-fg-3">{summary}</span>
      </summary>
      <div className="grid gap-4 pt-3 md:grid-cols-2">{children}</div>
    </details>
  );
}

/**
 * Server and Sign in (Figma 02 v1.0.5, 01/03/04/05): engine, host and port (Oracle: service name), a pasted connection
 * string, username and password, TLS, then Connect. Once connected (or opened on a stored connection), one line with
 * Change.
 */
function Server(p: ConnectionStepProps & { failed: string | null }) {
  const { d, set, err, created } = p;
  const c = d.conn;
  const [changing, setChanging] = useState(false);
  const [pasting, setPasting] = useState<{ text: string; error: string | null } | null>(null);
  const [offFor, setOffFor] = useState<string | null>(null);
  // TLS follows the host (off only for this machine) until the user sets it; a stored connection's TLS is the user's
  const tlsChosen = useRef(created);
  const setConn = (patch: Partial<Conn>) => set((x) => {
    const next = { ...x.conn, ...patch };
    if (patch.host !== undefined && !tlsChosen.current) next.tls = !isLocalHost(next.host);
    return { ...x, conn: next };
  });
  const connect = () => { setChanging(false); p.onTest(); };
  // a failure on screen opens the form, but a database refused after a connect (shown on Data's picker)
  const failing = !!p.tested && !p.tested.result.ok && p.tested.key === connKey(d) && !(p.listed && p.tested.result.field === "database");
  const folded = !changing && !failing && (p.connected !== null || (p.stored && !p.listed));
  const wasFolded = useRef(folded);
  // connected: focus moves on to the first field of Data (rule 1, 7); the pickers' list loads after the connect, so
  // its control is waited for a moment
  const first = c.engine === "oracle" ? (p.catalog.names.status !== "idle" ? "src-schema" : ctl("input.table")) : !p.stored ? "src-database" : ctl("input.table");
  const isConnected = p.connected !== null;
  useEffect(() => {
    const start = folded && !wasFolded.current && isConnected;
    wasFolded.current = folded;
    if (!start) return;
    // ponytail: polls up to 3 s for the picker's chunk; a slower load leaves focus where it was
    let n = 0;
    const t = setInterval(() => {
      const el = document.getElementById(first);
      if (el) el.focus();
      if (el || ++n > 60) clearInterval(t);
    }, 50);
    return () => clearInterval(t);
  }, [folded, isConnected, first]);
  const oracle = c.engine === "oracle";
  const note = p.stored ? STORED : undefined;
  // before a connect, Database shows only once it has a value (a pasted string) or an error, then stays while typed in
  const wantDb = !!c.database || !!err("src-database");
  const [dbShown, setDbShown] = useState(wantDb);
  if (wantDb && !dbShown) setDbShown(true);

  // the parser loads on the first paste, not with the page (bundle budget, DEC-040)
  async function paste(text: string) {
    const parsed = (await import("./conn-string")).parseConnString(text);
    if (!parsed) { setPasting({ text, error: UNREADABLE }); return; }
    const { password, ...rest } = parsed;
    setConn({ ...rest, ...(password ? { password } : {}) });
    setPasting(null);
    requestAnimationFrame(() => document.getElementById(password ? "src-connect-button" : "src-password")?.focus());
  }

  if (folded) {
    // which server, port and database it reads (owner, 21 Nov), as user@host:port/database
    const who = c.host.trim() ? `${c.user.trim() ? `${c.user.trim()}@` : ""}${c.host.trim()}:${c.port}${c.database.trim() ? `/${c.database.trim()}` : ""}` : "Stored sign-in";
    const summary = [`${ENGINE_LABEL[c.engine]}${p.connected?.version ? ` ${p.connected.version}` : ""}`, who, `TLS ${c.tls ? "on" : "off"}`].join(" · ");
    return (
      <Panel title="Server" bodyClassName="grid gap-4">
        <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg">
          <span className="min-w-0 break-words">{summary}</span>
          <Button type="button" variant="link" size="sm" onClick={() => {
            setChanging(true);
            requestAnimationFrame(() => document.getElementById("src-host")?.focus());
          }}><Icon icon={EditIcon} />Change<span className="sr-only"> server</span></Button>
        </p>
        {!p.connected && <span><ActionButton testing={p.testing} onTest={connect} label="Connect" busy="Connecting…" /></span>}
      </Panel>
    );
  }

  return (
    <Panel title="Server" bodyClassName="grid gap-4" description={created ? "Changes here apply at once; no new version." : undefined}>
      <div className="grid gap-4" onKeyDown={enterRuns(connect)}>
        <div className="grid gap-2">
          <span className="text-label text-fg" id="src-engine-label">Engine</span>
          <div className="max-md:hidden">
            <Segmented label="Engine" value={c.engine} onChange={(engine) => set((x) => ({ ...x, conn: withEngine(x.conn, engine) }))}
              options={DB_ENGINES.map((e) => ({ value: e, label: ENGINE_LABEL[e] }))} />
          </div>
          {/* phone: four engines don't fit one row of a segmented control; a select, never 3 + 1 (Captain, v1.0.5 P2) */}
          <Select className="w-full min-w-0 md:hidden" aria-labelledby="src-engine-label" value={c.engine}
            onChange={(e) => { const engine = e.target.value as Conn["engine"]; set((x) => ({ ...x, conn: withEngine(x.conn, engine) })); }}>
            {DB_ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-4 md:grid-cols-[minmax(0,1fr)_9rem]">
          <Field id="src-host" label="Host" required={!p.stored} note={note} error={err("src-host")}>
            <Input id="src-host" value={c.host} className="font-mono" onChange={(e) => setConn({ host: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="src-port" label="Port" required={!p.stored} error={err("src-port")}>
            <Input id="src-port" value={c.port} inputMode="numeric" className="font-mono" onChange={(e) => setConn({ port: e.target.value.replace(/\D/g, "") })} autoComplete="off" />
          </Field>
        </div>
        {pasting ? (
          <Field id="src-conn-string" label="Connection string" error={pasting.error}>
            <Input id="src-conn-string" value={pasting.text} className="font-mono" autoComplete="off" spellCheck={false} placeholder="postgresql://user@host:5432/database"
              onChange={(e) => setPasting({ text: e.target.value, error: null })} onPaste={(e) => { e.preventDefault(); void paste(e.clipboardData.getData("text")); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void paste(pasting.text); } if (e.key === "Escape") setPasting(null); }}
              onBlur={() => { if (pasting.text.trim()) void paste(pasting.text); else setPasting(null); }} />
          </Field>
        ) : (
          <span><Button type="button" variant="link" size="sm" className="text-caption" onClick={() => {
            setPasting({ text: "", error: null });
            requestAnimationFrame(() => document.getElementById("src-conn-string")?.focus());
          }}>Paste a connection string</Button></span>
        )}

        {(oracle || (!p.listed && dbShown)) && (
          <Field id="src-database" label={oracle ? "Service name" : "Database"} required={oracle && !p.stored} note={note ?? (oracle ? undefined : DATABASE_NOTE)} error={err("src-database")}>
            <Input id="src-database" value={c.database} className="font-mono" onChange={(e) => setConn({ database: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <h3 className="pt-2 text-title-3 text-fg">Sign in</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="src-user" label="Username" required={!p.stored} error={err("src-user")} note={`Use a read-only account.${note ? ` ${note}` : ""}`}>
            <Input id="src-user" value={c.user} className="font-mono" onChange={(e) => setConn({ user: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="src-password" label="Password" required={!p.stored} note={note} error={err("src-password")}>
            <PasswordInput id="src-password" value={c.password} onChange={(e) => setConn({ password: e.target.value })} autoComplete="off" />
          </Field>
        </div>
        <div className="grid gap-2">
          <span className="inline-flex items-center gap-2">
            <Switch id="src-tls" checked={c.tls} aria-label="Encrypt the connection (TLS)" aria-invalid={err("src-tls") ? true : undefined}
              aria-describedby={err("src-tls") ? "src-tls-error" : undefined} onChange={(e) => {
                if (!e.target.checked && !isLocalHost(c.host)) { setOffFor(c.host.trim() || "this host"); return; }
                tlsChosen.current = true;
                setConn({ tls: e.target.checked });
              }} />
            <label htmlFor="src-tls" className="text-body text-fg">Encrypt the connection (TLS)</label>
          </span>
          {err("src-tls") && <p id="src-tls-error" className="text-body-sm text-down-ink">{err("src-tls")}</p>}
        </div>
      </div>
      <div className="grid gap-2">
        <span><ActionButton testing={p.testing} onTest={connect} label="Connect" busy="Connecting…" /></span>
        {p.failed && <p id="src-connect" role="alert" tabIndex={-1} className="text-body-sm text-down-ink outline-none">{p.failed}</p>}
      </div>
      {offFor && (
        // the dialog's own form must not submit the wizard's (React events bubble through the portal)
        <div className="contents" onSubmit={(e) => e.stopPropagation()}>
          <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setOffFor(null); }} auditFields={false} reasons={[]} impact={[]} destructive
            title={`Turn off TLS for ${offFor}?`} description="The password and the data travel unencrypted. This is recorded in the activity log."
            actionLabel="Turn off TLS" cancelLabel="Keep TLS" alert onCloseAutoFocus={(e) => { e.preventDefault(); document.getElementById("src-tls")?.focus(); }} onConfirm={async () => { tlsChosen.current = true; setConn({ tls: false }); setOffFor(null); }} />
        </div>
      )}
    </Panel>
  );
}

/**
 * Data (Figma 02 v1.0.5, 02): after a connect, the database (Oracle: schema) the login can open, then the table, or a
 * SELECT instead. A stored connection left as it is keeps its database, so only the table is asked.
 */
function Data(p: ConnectionStepProps & { setInput: (patch: Partial<SourceSpec["input"]>) => void }) {
  const { d, set, err, setInput } = p;
  const i = d.spec.input;
  const oracle = d.conn.engine === "oracle";
  const cat = p.catalog;
  const names = cat.names.status === "ready" ? cat.names.data : null;
  const typed = !p.stored;
  if (!(oracle ? cat.names.status !== "idle" : typed) && i.kind !== "db_watermark") return null;
  return (
    <Panel title="Data" bodyClassName="grid gap-4">
      {oracle ? cat.names.status !== "idle" && (
        <NamePicker id="src-schema" label="Schema" noun="schema" value={cat.schema} list={cat.names} names={names} stale={cat.stale} free={cat.free.database}
          onFree={(f) => cat.onFree("database", f)} onRetry={cat.onRetryNames} onChange={cat.onSchema} onPick={cat.onSchema} />
      ) : typed && (
        <NamePicker id="src-database" label="Database" noun="database" value={d.conn.database} error={err("src-database")}
          list={cat.names} names={names} stale={cat.stale} free={cat.free.database} onFree={(f) => cat.onFree("database", f)} onRetry={cat.onRetryNames}
          onChange={(v) => set((x) => ({ ...x, conn: { ...x.conn, database: v } }))} onPick={cat.onPickDatabase} />
      )}
      {i.kind === "db_watermark" && (oracle ? !!cat.schema.trim() || cat.names.status === "idle" : !typed || !!d.conn.database.trim()) && (d.from === "table" ? (
        <div className="grid gap-1">
          <TablePicker id={ctl("input.table")} label="Table" value={i.table ?? ""} error={err(ctl("input.table"))} note="table or schema.table, as the source's catalog spells it."
            engine={d.conn.engine} database={(oracle ? cat.schema : d.conn.database).trim() || "this database"}
            list={cat.tables} page={cat.tables.status === "ready" ? cat.tables.data : null} stale={cat.stale || cat.tablesStale}
            free={cat.free.table} onFree={(f) => cat.onFree("table", f)} onRetry={cat.onRetryTables} query={cat.query} onQuery={cat.onQuery}
            onChange={(v) => setInput({ table: v } as Partial<WatermarkInput>)} onPick={cat.onPickTable} columns={cat.columns} />
          <span><Button type="button" variant="link" size="sm" onClick={() => set((x) => ({ ...x, from: "query" }))}>Write a SELECT instead</Button></span>
        </div>
      ) : (
        <div className="grid gap-1">
          <QueryField note="Only SELECT is allowed." error={err(ctl("input.query"))} value={i.query ?? ""} rows={6} check={cat.onCheckQuery} suggest={cat.onSuggest}
            onChange={(query) => setInput({ query } as Partial<WatermarkInput>)} />
          <span><Button type="button" variant="link" size="sm" onClick={() => set((x) => ({ ...x, from: "table" }))}>Choose a table instead</Button></span>
        </div>
      ))}
    </Panel>
  );
}

/**
 * How a database source is pulled (Figma 02 v1.0.5, 02): shown once a table is picked (or a SELECT is written, or a
 * snapshot chosen), then kept. New rows by watermark (look back and rows per page under a closed Advanced) or a whole
 * snapshot per business date (its SELECT and schedule). The watermark and id columns are picked in step 2.
 */
function Pull(p: ConnectionStepProps & { setInput: (patch: Partial<SourceSpec["input"]>) => void; setKind: (k: SourceKind) => void }) {
  const { d, err, created, setInput } = p;
  const i = d.spec.input;
  const want = created || i.kind === "db_snapshot" || (i.kind === "db_watermark" && (d.from === "query" || !!(i.table ?? "").trim()));
  const [seen, setSeen] = useState(want);
  if (want && !seen) setSeen(true);
  if (!seen) return null;
  let body: ReactNode = null;
  if (i.kind === "db_snapshot") {
    body = (
      <>
        <QueryField error={err(ctl("input.query"))} value={i.query} rows={8} check={p.catalog.onCheckQuery} suggest={p.catalog.onSuggest} params={BUSINESS_DATE} onChange={(query) => setInput({ query })}
          note="Only SELECT is allowed. :business_date is filled in for each run. A new snapshot becomes active only when the pull finishes; if it fails halfway, the active one stays." />
        <Field id={ctl("input.schedule")} label="Runs" error={err(ctl("input.schedule"))}
          note={`A cron expression in ${APP_TIME_ZONE_LABEL}: minute hour day month weekday. ${i.schedule.trim() ? `Now: ${scheduleText(i.schedule)}.` : ""}`}>
          <Input id={ctl("input.schedule")} value={i.schedule} className="font-mono" onChange={(e) => setInput({ schedule: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
      </>
    );
  } else if (i.kind === "db_watermark") {
    const w = i as WatermarkInput;
    const kind = p.wmKind;
    const digits = (v: string) => Number(v.replace(/\D/g, "")) || 0;
    // a date-only watermark looks back a day at least: kept while typing, raised to a day when the field is left
    const minSeconds = kind === "date" ? DATE_LOOKBACK_MIN_SECONDS : 0;
    const seconds = w.lookback_seconds ?? minSeconds;
    body = (
      <>
      <ReadWhenField label="Pull" when={w.when} onChange={(when) => setInput({ when } as Partial<WatermarkInput>)} />
      <Advanced open={!!err(ctl("input.lookback_seconds")) || !!err(ctl("input.lookback_ids"))}
        summary={`Look back ${lookbackText(w, kind).toLowerCase()} · ${formatNumber(w.chunk)} rows per page`}>
        {kind === "int" ? (
          <Field id={ctl("input.lookback_ids")} label="Look back (ids)" error={err(ctl("input.lookback_ids"))}
            note={lookbackNote(kind)}>
            <Input id={ctl("input.lookback_ids")} inputMode="numeric" value={String(w.lookback_ids ?? LOOKBACK_IDS_DEFAULT)}
              onChange={(e) => setInput({ lookback_ids: Math.min(LOOKBACK_IDS_MAX, digits(e.target.value)) } as Partial<WatermarkInput>)} />
          </Field>
        ) : (
          <Field id={ctl("input.lookback_seconds")} label="Look back (seconds)" error={err(ctl("input.lookback_seconds"))}
            note={lookbackNote(kind)}>
            <Input id={ctl("input.lookback_seconds")} inputMode="numeric" value={String(seconds)}
              onChange={(e) => setInput({ lookback_seconds: Math.min(604_800, digits(e.target.value)) } as Partial<WatermarkInput>)}
              onBlur={() => { if (seconds < minSeconds) setInput({ lookback_seconds: minSeconds } as Partial<WatermarkInput>); }} />
          </Field>
        )}
        <Field id={ctl("input.chunk")} label="Rows per page">
          <Input id={ctl("input.chunk")} inputMode="numeric" value={String(w.chunk)}
            onChange={(e) => setInput({ chunk: Math.max(1, Math.min(100_000, Number(e.target.value.replace(/\D/g, "")) || 1)) } as Partial<WatermarkInput>)} />
        </Field>
      </Advanced>
      </>
    );
  }
  return (
    <Panel title="How to pull" bodyClassName="grid gap-4" description={p.nextVersion ? `A change here makes version ${p.nextVersion}, approved by a config checker.` : undefined}>
      <div className="grid gap-3 md:grid-cols-2">
        <ChoiceCard inCard name="src-pull" label="New rows by watermark" checked={d.kind === "db_watermark"} disabled={created && d.kind !== "db_watermark"} onChange={() => p.setKind("db_watermark")}
          description="Rows added or changed since the last pull." />
        <ChoiceCard inCard name="src-pull" label="Whole snapshot per business date" checked={d.kind === "db_snapshot"} disabled={created && d.kind !== "db_snapshot"} onChange={() => p.setKind("db_snapshot")}
          description="The full position for one date." />
      </div>
      {body}
    </Panel>
  );
}

/**
 * A source's SELECT (owner, 21 Nov): coloured as SQL, with "Check query" inside the box. A check reads the columns the
 * query gives (no rows) over the connection on screen; its result belongs to the text it checked, so an edit clears it.
 * A failure is the field's error (the sentence the API gives), a pass a green line naming the columns.
 */
const BUSINESS_DATE = [":business_date"] as const;

function QueryField({ value, rows, note, error, onChange, check, suggest, params }: {
  value: string; rows: number; note: string; error?: string | null; onChange: (query: string) => void; check: CatalogProps["onCheckQuery"];
  suggest: SqlSuggest; params?: readonly string[];
}) {
  const [run, setRun] = useState<{ query: string; busy: boolean; ok?: string; failed?: string } | null>(null);
  const mine = run && run.query === value ? run : null;
  async function go() {
    const query = value;
    setRun({ query, busy: true });
    try {
      const r = await check(query);
      setRun({ query, busy: false, ok: `${r.columns.length} ${r.columns.length === 1 ? "column" : "columns"}: ${r.columns.map((c) => c.name).join(", ")}.` });
    } catch (e) {
      setRun({ query, busy: false, failed: errorText(e) });
    }
  }
  return (
    <div className="grid gap-1.5">
      <Field id={ctl("input.query")} label="Query" note={note} error={error || mine?.failed || undefined}>
        <SqlEditor id={ctl("input.query")} value={value} rows={rows} onChange={(e) => onChange(e.target.value)} suggest={suggest} params={params}
          action={<Button type="button" variant="secondary" size="sm" onClick={() => void go()} disabled={!value.trim() || !!mine?.busy} aria-busy={mine?.busy || undefined}>
            {mine?.busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Check query</Button>} />
      </Field>
      {mine?.ok && <p role="status" className="flex items-start gap-1.5 text-body-sm text-healthy-ink"><Icon icon={CheckIcon} className="mt-0.5 size-4 shrink-0" />{mine.ok}</p>}
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
/**
 * When to read (owner, 21 Nov): how often a pull runs or the folder is checked, and optionally only between two whole
 * hours (Asia/Jakarta; a window past midnight wraps). Read every minute, all day, when left as it starts.
 */
function ReadWhenField({ label, when, onChange }: { label: string; when: ReadWhen | undefined; onChange: (w: ReadWhen | undefined) => void }) {
  const every = when?.every_minutes ?? 1;
  const set = (w: ReadWhen) => onChange(w.every_minutes === 1 && !w.hours ? undefined : { ...(w.every_minutes !== 1 ? { every_minutes: w.every_minutes } : {}), ...(w.hours ? { hours: w.hours } : {}) });
  const hour = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  const on = !!when?.hours, hours = when?.hours ?? { from: 6, to: 22 };
  const switchId = ctl("input.when.hours");
  return (
    // two equal columns, as the choice cards above (owner rule, 21 Nov: symmetric): each a label row, then its control
    // row, so labels and controls line up; the hours stay in place, off while the switch is, so nothing jumps
    <div className="grid gap-3">
      <div className="grid gap-x-3 gap-y-4 md:grid-cols-2">
        <Field id={ctl("input.when.every_minutes")} label={`${label} every`} help="How often the source is read. A recon still matches what arrived; reading less often only delays it.">
          <Select id={ctl("input.when.every_minutes")} className="w-full min-w-0" value={String(every)} onChange={(e) => set({ every_minutes: Number(e.target.value), hours: when?.hours })}>
            {READ_EVERY.map((n) => <option key={n} value={n}>{n === 1 ? "Minute" : n === 60 ? "Hour" : `${n} minutes`}</option>)}
          </Select>
        </Field>
        <div className="grid min-w-0 content-start gap-2">
          <span className="flex min-w-0 items-center gap-1">
            <label htmlFor={switchId} className="text-label text-fg">Only between</label>
            <InfoTip label="Only between">Read only in these hours, in {APP_TIME_ZONE_LABEL}, such as while the bank&apos;s system is up. A window past midnight wraps: 22:00 to 06:00 reads overnight.</InfoTip>
          </span>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <Switch id={switchId} checked={on} onChange={(e) => set({ every_minutes: every, hours: e.target.checked ? hours : undefined })} />
            <Select aria-label="From" className="w-full min-w-0" disabled={!on} value={String(hours.from)} onChange={(e) => set({ every_minutes: every, hours: { ...hours, from: Number(e.target.value) } })}>
              {HOURS.map((h) => <option key={h} value={h}>{hour(h)}</option>)}
            </Select>
            <span className="text-body-sm text-fg-2">to</span>
            <Select aria-label="To" className="w-full min-w-0" disabled={!on} value={String(hours.to)} onChange={(e) => set({ every_minutes: every, hours: { ...hours, to: Number(e.target.value) } })}>
              {HOURS.map((h) => h + 1).map((h) => <option key={h} value={h}>{hour(h)}</option>)}
            </Select>
          </div>
        </div>
      </div>
      <p className="text-caption text-fg-3">Reads {readWhenText(when)}.</p>
    </div>
  );
}
