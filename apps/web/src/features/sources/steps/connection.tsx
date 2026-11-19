"use client";

import type { ReactNode } from "react";
import { ChoiceCard, Field, Notice, Panel, Segmented, Switch } from "@starterkit/ui/ds";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { PasswordInput } from "@starterkit/ui/ui/password-input";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { DB_ENGINES, FILE_ENCODINGS, type SourceKind } from "@starterkit/shared/sources";
import { scheduleText } from "../source-text";
import { emptySpec, type Conn, ctl, DEFAULT_PORT, type Draft, type Tested } from "./model";

const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", oracle: "Oracle" } as const;
const STORED = "Stored. Enter a new value to replace it.";
const DELIMITERS = [["|", "Pipe |"], [",", "Comma ,"], [";", "Semicolon ;"], ["\t", "Tab"]] as const;

type WatermarkInput = Extract<SourceSpec["input"], { kind: "db_watermark" }>;

export type ConnectionStepProps = {
  d: Draft;
  set: (fn: (d: Draft) => Draft) => void;
  /** The source exists already: name, code and kind are fixed (no route changes them). */
  created: boolean;
  /** A connection is stored: the credential fields may stay empty to test it as it is. */
  stored: boolean;
  err: (id: string) => string | undefined;
  tested: Tested | null;
  testing: boolean;
  onTest: () => void;
};
/** Under the test's panel title until the source exists (designer's copy). */
const SAVED_AT_NEXT = "Next unlocks once the test passes; the source is saved at Next";

/**
 * Step 1, Connection (Figma 20:5937 file inbox, 21:6049 database, 97:9270 / 101:9658 a failed test): the source's name,
 * where its data comes from, the connection or folder and how it is pulled. A source admin's step; Test connection
 * checks exactly the values on screen, without storing them; the wizard's Next counts the pass only while they stay the
 * same, and makes the source (or replaces its connection) only then.
 */
export function ConnectionStep(p: ConnectionStepProps) {
  const { d, set, created, err } = p;
  const i = d.spec.input;
  const setInput = (patch: Partial<SourceSpec["input"]>) => set((x) => ({ ...x, spec: { ...x.spec, input: { ...x.spec.input, ...patch } as SourceSpec["input"] } }));
  const setConn = (patch: Partial<Conn>) => set((x) => ({ ...x, conn: { ...x.conn, ...patch } }));
  const setKind = (kind: SourceKind) => set((x) => (x.kind === kind ? x : { ...x, kind, spec: emptySpec(kind) }));
  const db = d.kind !== "file_inbox";

  return (
    <div className="grid gap-section">
      <Panel title="Source" bodyClassName="grid gap-4 md:grid-cols-2">
        <Field id="src-name" label="Name" required={!created} note={created ? "Saved with the source." : "Shown in recons and in the Breaks list."} error={err("src-name")}>
          <Input id="src-name" value={d.name} readOnly={created} onChange={(e) => set((x) => ({ ...x, name: e.target.value }))} autoComplete="off" />
        </Field>
        <Field id="src-code" label="Code" required={!created} note="Used in logs and exports. Can't be changed later." error={err("src-code")}>
          <Input id="src-code" value={d.code} readOnly={created} className="font-mono" onChange={(e) => set((x) => ({ ...x, code: e.target.value }))} autoComplete="off" spellCheck={false} />
        </Field>
      </Panel>

      <Panel title="Where the data comes from" bodyClassName="grid gap-3 md:grid-cols-2">
        <ChoiceCard name="src-from" label="Database" checked={db} disabled={created && !db} onChange={() => setKind("db_watermark")}
          description="PostgreSQL, MySQL, SQL Server or Oracle. Pulled on a schedule, by watermark or as a snapshot per business date." />
        <ChoiceCard name="src-from" label="File inbox" checked={!db} disabled={created && db} onChange={() => setKind("file_inbox")}
          description="Files land in an SFTP or NFS folder and are picked up by file name." />
      </Panel>

      {db ? (
        <Panel title="Connection" description={created ? "Only source admins see and change this" : `Only source admins see and change this · ${SAVED_AT_NEXT}`} bodyClassName="grid gap-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field id="src-engine" label="Engine">
              <Select className="w-full min-w-0" id="src-engine" value={d.conn.engine} onChange={(e) => {
                const engine = e.target.value as Conn["engine"];
                setConn({ engine, port: d.conn.port === DEFAULT_PORT[d.conn.engine] ? DEFAULT_PORT[engine] : d.conn.port });
              }}>
                {DB_ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}
              </Select>
            </Field>
            <Field id="src-host" label="Host" note={p.stored ? STORED : undefined} error={err("src-host")}>
              <Input id="src-host" value={d.conn.host} className="font-mono" onChange={(e) => setConn({ host: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="src-port" label="Port" error={err("src-port")}>
              <Input id="src-port" value={d.conn.port} inputMode="numeric" className="font-mono" onChange={(e) => setConn({ port: e.target.value.replace(/\D/g, "") })} autoComplete="off" />
            </Field>
            <Field id="src-database" label={d.conn.engine === "oracle" ? "Service name" : "Database"} note={p.stored ? STORED : undefined} error={err("src-database")}>
              <Input id="src-database" value={d.conn.database} className="font-mono" onChange={(e) => setConn({ database: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="src-user" label="Username" error={err("src-user")}
              note={`Use an account that can only read. The app never writes here; a read-only account makes sure of it.${p.stored ? ` ${STORED}` : ""}`}>
              <Input id="src-user" value={d.conn.user} className="font-mono" onChange={(e) => setConn({ user: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="src-password" label="Password" note={p.stored ? STORED : "Stored encrypted. Never shown again after saving."} error={err("src-password")}>
              <PasswordInput id="src-password" value={d.conn.password} onChange={(e) => setConn({ password: e.target.value })} autoComplete="off" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-2">
              <Switch id="src-tls" checked={d.conn.tls} onChange={(e) => setConn({ tls: e.target.checked })} aria-label="Encrypt the connection (TLS)" />
              <label htmlFor="src-tls" className="text-body text-fg">Encrypt the connection (TLS)</label>
            </span>
            <TestButton {...p} label="Test connection" />
          </div>
          <TestResult tested={p.tested} />
        </Panel>
      ) : i.kind === "file_inbox" && (
        <Panel title="File inbox" description={created ? undefined : SAVED_AT_NEXT} bodyClassName="grid gap-4 md:grid-cols-2">
          <Field id={ctl("input.path")} label="Folder" note="A folder inside the inbox folders this install allows, as a full path." error={err(ctl("input.path"))}>
            <Input id={ctl("input.path")} value={i.path} className="font-mono" onChange={(e) => setInput({ path: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id={ctl("input.pattern")} label="File name pattern" note="Such as act*.txt. A date in the name (yyyyMMdd) is read as the business date." error={err(ctl("input.pattern"))}>
            <Input id={ctl("input.pattern")} value={i.pattern} className="font-mono" onChange={(e) => setInput({ pattern: e.target.value })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id={ctl("input.completion")} label="File is complete when"
            note="Each file is recognised by its content (sha256). The same content sent again is rejected; a new content under the same name is the next version of that name.">
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
          <Field id={ctl("input.format.delimiter")} label="Delimiter" error={err(ctl("input.format.delimiter"))}>
            <Select className="w-full min-w-0" id={ctl("input.format.delimiter")} value={i.format.delimiter} onChange={(e) => setInput({ format: { ...i.format, delimiter: e.target.value } })}>
              {DELIMITERS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field id={ctl("input.format.encoding")} label="Encoding">
            <Select className="w-full min-w-0" id={ctl("input.format.encoding")} value={i.format.encoding} onChange={(e) => setInput({ format: { ...i.format, encoding: e.target.value as (typeof FILE_ENCODINGS)[number] } })}>
              {FILE_ENCODINGS.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}
            </Select>
          </Field>
          <span className="inline-flex items-center gap-2 md:col-span-2">
            <Switch id={ctl("input.format.header")} checked={i.format.header} onChange={(e) => setInput({ format: { ...i.format, header: e.target.checked } })} aria-label="First row is a header" />
            <label htmlFor={ctl("input.format.header")} className="text-body text-fg">First row is a header</label>
          </span>
          <div className="grid gap-3 md:col-span-2">
            <span><TestButton {...p} label="Test the folder" /></span>
            <TestResult tested={p.tested} />
          </div>
        </Panel>
      )}

      {db && <Pull {...p} setInput={setInput} setKind={setKind} />}
    </div>
  );
}

function TestButton({ testing, onTest, label }: ConnectionStepProps & { label: string }) {
  return (
    <Button type="button" variant="secondary" onClick={onTest} disabled={testing} aria-busy={testing || undefined}>
      {testing && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{label}
    </Button>
  );
}

/** The test's answer under the button (97:9589): the API's sentence, announced; a failure in the warning tone. */
function TestResult({ tested }: { tested: Tested | null }) {
  if (!tested) return null;
  return <Notice tone={tested.result.ok ? "info" : "warn"} live>{tested.result.message}</Notice>;
}

/** How a database source is pulled: by watermark from a table or a SELECT, or a snapshot per business date. Its watermark and id columns are picked in step 2, once the columns are read. */
function Pull(p: ConnectionStepProps & { setInput: (patch: Partial<SourceSpec["input"]>) => void; setKind: (k: SourceKind) => void }) {
  const { d, set, err, created, setInput } = p;
  const i = d.spec.input;
  let body: ReactNode = null;
  if (i.kind === "db_snapshot") {
    body = (
      <>
        <Field id={ctl("input.query")} label="Query" error={err(ctl("input.query"))}
          note="Only SELECT is allowed. :business_date is filled in for each run. A new snapshot becomes active only when the pull finishes; if it fails halfway, the active one stays.">
          <Textarea id={ctl("input.query")} value={i.query} rows={8} className="font-mono" spellCheck={false} onChange={(e) => setInput({ query: e.target.value })} />
        </Field>
        <Field id={ctl("input.schedule")} label="Runs" error={err(ctl("input.schedule"))}
          note={`A cron expression in ${APP_TIME_ZONE_LABEL}: minute hour day month weekday. ${i.schedule.trim() ? `Now: ${scheduleText(i.schedule)}.` : ""}`}>
          <Input id={ctl("input.schedule")} value={i.schedule} className="font-mono" onChange={(e) => setInput({ schedule: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
      </>
    );
  } else if (i.kind === "db_watermark") {
    const w = i as WatermarkInput;
    body = (
      <>
        <Segmented label="Read from" value={d.from} onChange={(from) => set((x) => ({ ...x, from }))} options={[{ value: "table", label: "A table" }, { value: "query", label: "A SELECT" }]} />
        {d.from === "table" ? (
          <Field id={ctl("input.table")} label="Table" note="table or schema.table, as the source's catalog spells it." error={err(ctl("input.table"))}>
            <Input id={ctl("input.table")} value={w.table ?? ""} className="font-mono" onChange={(e) => setInput({ table: e.target.value } as Partial<WatermarkInput>)} autoComplete="off" spellCheck={false} />
          </Field>
        ) : (
          <Field id={ctl("input.query")} label="Query" note="Only SELECT is allowed. Rows are read from it page by page, ordered by the watermark." error={err(ctl("input.query"))}>
            <Textarea id={ctl("input.query")} value={w.query ?? ""} rows={6} className="font-mono" spellCheck={false} onChange={(e) => setInput({ query: e.target.value } as Partial<WatermarkInput>)} />
          </Field>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field id={ctl("input.lookback_seconds")} label="Look back (seconds)" note="Each pull starts this far before the last one, for rows that commit late. Rows read twice are stored once.">
            <Input id={ctl("input.lookback_seconds")} inputMode="numeric" value={String(w.lookback_seconds)}
              onChange={(e) => setInput({ lookback_seconds: Math.min(604_800, Number(e.target.value.replace(/\D/g, "")) || 0) } as Partial<WatermarkInput>)} />
          </Field>
          <Field id={ctl("input.chunk")} label="Rows per page">
            <Input id={ctl("input.chunk")} inputMode="numeric" value={String(w.chunk)}
              onChange={(e) => setInput({ chunk: Math.max(1, Math.min(100_000, Number(e.target.value.replace(/\D/g, "")) || 1)) } as Partial<WatermarkInput>)} />
          </Field>
        </div>
      </>
    );
  }
  return (
    <Panel title="How to pull" bodyClassName="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <ChoiceCard name="src-pull" label="New rows by watermark" checked={d.kind === "db_watermark"} disabled={created && d.kind !== "db_watermark"} onChange={() => p.setKind("db_watermark")}
          description="Pulls rows added or changed since the last pull, every minute. For transactions." />
        <ChoiceCard name="src-pull" label="Whole snapshot per business date" checked={d.kind === "db_snapshot"} disabled={created && d.kind !== "db_snapshot"} onChange={() => p.setKind("db_snapshot")}
          description="Pulls the full position for one date on a schedule. For accounts and balances." />
      </div>
      {body}
    </Panel>
  );
}
