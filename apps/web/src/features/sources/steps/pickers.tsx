"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Input } from "@starterkit/ui/ui/input";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import type { DbEngine } from "@starterkit/shared/sources";
import {
  EMPTY_DATABASES, emptyTables, goneNote, listFailed, type ListState, noMatch, shownText, STALE_NOTE, tableLine, type TablesPage, tableValue, truncatedText, TYPED_NOTE,
} from "./catalog";

// the searchable list (cmdk) shows only once a test passed: its chunk stays out of the wizard's first load (AGENTS §9)
const Combobox = dynamic(() => import("@starterkit/ui/ds/combobox-command").then((m) => m.CommandCombobox), { ssr: false, loading: () => <Skeleton className="h-8 w-full" /> });

/** Seconds until a failed list may be asked again (a 429's Retry-After), ticking to 0. */
function useWait(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null || at <= now) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(1000, at - now));
    return () => clearTimeout(t);
  }, [at, now]);
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

type Common = {
  id: string; label: string; value: string; error?: string;
  /** The list as read after the last test; idle = not read (no test yet, or nothing to list for). */
  list: ListState<unknown>;
  /** The connection changed since the list was read: the pick stays, the list doesn't open. */
  stale: boolean;
  /** Typed instead of chosen ("Type a name instead"). */
  free: boolean;
  onFree: (free: boolean) => void;
  onRetry: () => void;
  /** The note when there is no list to choose from. */
  note?: string;
};

function Escape({ free, onFree, list }: Pick<Common, "free" | "onFree" | "list">) {
  if (list.status === "idle") return null;
  return <span><Button type="button" variant="link" size="sm" onClick={() => onFree(!free)}>{free ? "Choose from the list" : "Type a name instead"}</Button></span>;
}

/**
 * Database (non-Oracle) or Oracle's Schema, chosen from what the login can open once the test passed (REC-F2a); typed
 * as before when there is no list or by choice. Filtered in the browser: at most 500 names.
 */
export function NamePicker(p: Common & { noun: "database" | "schema"; names: { items: string[]; truncated: boolean } | null; onChange: (v: string) => void; onPick: (v: string) => void }) {
  const wait = useWait(p.list.status === "error" ? p.list.retryAt : null);
  const listed = p.list.status !== "idle" && !p.free;
  const gone = p.names && p.value && !p.names.items.includes(p.value) ? goneNote(p.value) : undefined;
  const note = !listed ? p.note : p.stale ? STALE_NOTE : gone;
  return (
    <div className="grid min-w-0 content-start gap-1">
      <Field id={p.id} label={p.label} note={note} error={p.error}>
        {listed ? (
          <Combobox id={p.id} label={p.label} placeholder={p.noun === "schema" ? "Choose a schema" : "Choose a database"} searchPlaceholder={`Search ${p.noun}s`} phone="sheet"
            value={p.value ? [p.value] : []} onValueChange={(v) => { if (v[0]) p.onPick(v[0]); }} disabled={p.stale}
            options={(p.names?.items ?? []).map((n) => ({ value: n, label: n, mono: true }))}
            loading={p.list.status === "loading"} loadingText={`Loading ${p.noun}s…`}
            error={p.list.status === "error" ? listFailed(p.noun, p.list.message) : undefined} onRetry={p.onRetry} retryDisabled={wait > 0}
            emptyText={p.noun === "schema" ? "This account can't read a table in any schema. Ask IT to grant SELECT." : EMPTY_DATABASES}
            footer={<div className="grid gap-1">{p.names?.truncated && <span>Showing the first 500. Type to narrow the list.</span>}<span><Button type="button" variant="link" size="sm" onClick={() => p.onFree(true)}>Type a name instead</Button></span></div>} />
        ) : (
          <Input id={p.id} value={p.value} className="font-mono" onChange={(e) => p.onChange(e.target.value)} autoComplete="off" spellCheck={false} />
        )}
      </Field>
      <Escape free={p.free} onFree={p.onFree} list={p.list} />
    </div>
  );
}

/**
 * The watermark source's table (REC-F2a), chosen from the tables and views the login can SELECT: grouped by schema
 * (MySQL has none), searched on the server as one types (the caller debounces), 50 a page; typed as before otherwise.
 * `columns` = reading the picked table's columns, then how many were read.
 */
export function TablePicker(p: Common & {
  engine: DbEngine; database: string; page: TablesPage | null; query: string; onQuery: (q: string) => void; onChange: (v: string) => void;
  onPick: (value: string) => void; columns: { reading: boolean; n: number | null };
}) {
  const wait = useWait(p.list.status === "error" ? p.list.retryAt : null);
  const listed = p.list.status !== "idle" && !p.free;
  const items = p.page?.items ?? [];
  const gone = p.page && !p.query && p.value && !items.some((t) => tableValue(p.engine, t) === p.value) && !p.page.next ? goneNote(p.value) : undefined;
  const read = p.columns.reading ? "Reading columns…" : p.columns.n !== null ? `${p.columns.n} columns read.` : undefined;
  const note = !listed ? (p.free ? TYPED_NOTE : p.note) : p.stale ? STALE_NOTE : gone ?? read;
  const truncated = p.page ? truncatedText(p.page) : null;
  return (
    <div className="grid min-w-0 content-start gap-1">
      <Field id={p.id} label="Table" note={note} error={p.error}>
        {listed ? (
          <Combobox id={p.id} label="Table" placeholder="Choose a table" searchPlaceholder="Search tables" phone="sheet" query={p.query} onQuery={p.onQuery}
            value={p.value ? [p.value] : []} onValueChange={(v) => { if (v[0]) p.onPick(v[0]); }} disabled={p.stale}
            options={items.map((t) => ({ value: tableValue(p.engine, t), label: t.name, chosen: tableValue(p.engine, t), description: tableLine(t), mono: true, ...(p.engine === "mysql" ? {} : { group: t.schema }) }))}
            loading={p.list.status === "loading"} loadingText="Loading tables…"
            error={p.list.status === "error" ? listFailed("table", p.list.message) : undefined} onRetry={p.onRetry} retryDisabled={wait > 0}
            emptyText={p.query.trim() ? noMatch(p.query.trim()) : emptyTables(p.database)} status={p.page ? shownText(p.page) : undefined}
            footer={<div className="grid gap-1">{truncated && <span>{truncated}</span>}<span><Button type="button" variant="link" size="sm" onClick={() => p.onFree(true)}>Type a name instead</Button></span></div>} />
        ) : (
          <Input id={p.id} value={p.value} className="font-mono" onChange={(e) => p.onChange(e.target.value)} autoComplete="off" spellCheck={false} />
        )}
      </Field>
      <Escape free={p.free} onFree={p.onFree} list={p.list} />
    </div>
  );
}
