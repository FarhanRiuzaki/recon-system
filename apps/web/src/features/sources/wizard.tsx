"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BlockedButton, EmptyState, Failure, FormFooter, Panel, type SqlContext, type SqlSuggestion, Wizard } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { DeniedIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ConnectionTestDto, SourceCatalogDto, SourceColumnsDto, SourceDto, SourcePreviewDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import { DetailNotFound } from "@/components/detail-not-found";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import type { TrailCrumb } from "@/lib/client/crumb-trail";
import { ApiError, api, errorText, isNotFound } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { SOURCES_KEY } from "@/lib/shared/queries";
import { WIZARD_SHAPE } from "./shapes";
import { attrNameOf, fieldError, fieldsOfColumns, looksLikeHeader, mergeFields, sampleColumns, sampleHead, storedNameProblem } from "./spec-draft";
import { type CatalogTable, credKey, goneBlocked, goneFields, IDLE, type ListState, type Suggestion, suggest, type TablesPage, tableValue } from "./steps/catalog";
import { suggestCore, withUnit } from "./steps/core-suggest";
import { ConnectionStep } from "./steps/connection";
import { FieldsStep } from "./steps/fields";
import {
  amountProblems, buildSpec, type Column, connBody, connChanged, connectionProblems, connKey, controlOf, ctl, type Draft, EMPTY_CONN, emptySpec, FIELD_CONTROL, type FieldErr, mappingProblem, type Preview, pullProblems,
  type Tested, watermarkProblems,
} from "./steps/model";
import { discardConfirm } from "./discard-dialog";
import { ReviewStep } from "./steps/review";
import {
  EDIT_REASON, NEW_SOURCE_REASON, sourceApi, sourceHref, sourcesHref, useSource, useSpaceRoles, useStartVersion, newVersionHref, versionHref,
} from "./use-sources";

const STEPS = ["Connection", "Fields & mapping", "Review & submit"] as const;
const NEXT = ["Next: fields & mapping", "Next: review", "Submit for approval"] as const;
const DESCRIPTION = (space: string) => [
  `Recons in ${space} read from this source.`,
  "Check what was detected, fix types and formats, and say which columns the recon uses. The preview updates as you change things.",
  "Check the summary, then send the version for approval. A config checker other than you approves it before anything is ingested.",
] as const;
/** A catalog list's failure as its state: the API's sentence, and when Retry may run again after a 429. */
const failed = (e: unknown) => ({ status: "error" as const, message: errorText(e), retryAt: e instanceof ApiError && e.retryAfter ? Date.now() + e.retryAfter * 1000 : null });
/** Next after a pass whose values changed since (copy-guide, REC-F2b); before any pass it is off without a sentence. */
const CHANGED = { db: "The connection changed since you connected. Connect again.", file: "The folder changed since the last check. Check it again." } as const;
/** The table search waits this long after the last key (PO: no request per keystroke). */
const SEARCH_DEBOUNCE_MS = 250;


const step0 = (n: number | null, admin: boolean) => Math.min(2, Math.max(admin ? 0 : 1, (n ?? (admin ? 1 : 2)) - 1));

/** /spaces/[spaceId]/sources/new: a source admin's three steps; the source and its draft are made at the first test. */
export function NewSourceWizard({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const roles = useSpaceRoles(spaceId);
  const initial = useMemo<Draft>(() => ({ name: "", code: "", kind: "db_watermark", conn: EMPTY_CONN, from: "table", spec: emptySpec("db_watermark") }), []);
  if (!roles.includes("source_admin")) return <Refused title="New source" reason={NEW_SOURCE_REASON} back={{ href: sourcesHref(spaceId), label: "Go to sources" }} />;
  // a new source always starts at step 1: nothing typed in a later step survives a reload
  return <SourceWizard spaceId={spaceId} spaceName={spaceName} initial={initial} start={0} admin source={null} />;
}

/**
 * /spaces/[spaceId]/sources/[sourceId]/versions/new: the source's open draft in the wizard (Build notes 02 "Edit
 * source"): a source admin from step 1, a config maker from step 2. Without a draft, one is made from the published
 * version first; a version in review is opened on its own page instead.
 */
export function EditSourceWizard({ spaceId, spaceName, id, step }: { spaceId: string; spaceName: string; id: string; step: number | null }) {
  const q = useSource(spaceId, id);
  const roles = useSpaceRoles(spaceId);
  const start = useStartVersion(spaceId, id);
  const skeleton = useDelayedFlag(!q.data && !q.error);
  if (isNotFound(q.error)) return <DetailNotFound title="Edit source" noun="source" list={{ href: sourcesHref(spaceId), label: "Sources" }} />;
  if (q.error && !q.data) return <div className="grid gap-section"><PageHeader title="Edit source" /><Panel><Failure title="Couldn't load this source" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  const s = q.data;
  if (!s || skeleton) return <LoadingShape sections={WIZARD_SHAPE} shown={skeleton} />;
  const back = { href: sourceHref(spaceId, id), label: `Go to ${s.name}` };
  const trail = [{ label: s.name, href: sourceHref(spaceId, id) }];
  const admin = roles.includes("source_admin");
  if (s.owner) return <Refused title="Edit source" trail={trail} reason={`${s.owner.name} owns this source; only its source admins and config makers change it.`} back={back} />;
  if (!admin && !roles.includes("config_maker")) return <Refused title="Edit source" trail={trail} reason={EDIT_REASON} back={back} />;
  const v = s.draft;
  if (!v) {
    return (
      <div className="grid gap-section">
        <PageHeader title="Edit source" trail={trail} />
        <Panel>
          <EmptyState icon={DeniedIcon} title="No draft version yet" description={`Changes go into a new version made from version ${s.publishedVersion ?? 1}. It is approved by a config checker before it applies.`}
            action={<Button type="button" onClick={() => start.mutate()} disabled={start.isPending} aria-busy={start.isPending || undefined}>
              {start.isPending && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Start version {(s.publishedVersion ?? 0) + 1}
            </Button>} />
        </Panel>
      </div>
    );
  }
  if (v.status === "in_review") {
    return <Refused title="Edit source" trail={trail} back={{ href: versionHref(spaceId, id, v.id), label: `Open version ${v.version}` }}
      reason={`Version ${v.version} is waiting for approval, so it can't change now. A rejected version comes back as a draft.`} />;
  }
  return <SourceWizard key={v.id} spaceId={spaceId} spaceName={spaceName} source={{ s, v }} admin={admin} start={step0(step, admin)} initial={draftOf(s, v)} />;
}

/** The draft as the wizard edits it: the version's spec (or the published one's), the connection never filled in. */
function draftOf(s: SourceDto, v: SourceVersionDto): Draft {
  const spec = v.spec ?? s.published?.spec ?? emptySpec(s.kind);
  const engine = s.connection?.engine ?? "postgres";
  return {
    name: s.name, code: s.code, kind: s.kind, from: spec.input.kind === "db_watermark" && spec.input.query !== undefined ? "query" : "table", spec,
    conn: { ...EMPTY_CONN, engine, port: "", tls: s.connection?.options.tls ?? false },
  };
}

function Refused({ title, reason, back, trail }: { title: string; reason: string; back: { href: string; label: string }; trail?: TrailCrumb[] }) {
  return (
    <div className="grid gap-section">
      <PageHeader title={title} trail={trail} />
      <Panel><EmptyState icon={DeniedIcon} title="This can't be changed here" description={reason} action={<Button asChild variant="secondary"><Link href={back.href}>{back.label}</Link></Button>} /></Panel>
    </div>
  );
}

type Ids = { sourceId: string; versionId: string; version: number } | null;

/** The browser's copy of a draft's unsaved spec (wizard autosave): `base` = the server's spec hash it was made over. */
type Kept = { base: string | null; spec: Draft["spec"]; from: Draft["from"] };
const keptKey = (versionId: string) => `recon:source-draft:${versionId}`;
// storage can be off (private mode, quota): the copy is a safety net, never a reason to fail
function keepLocal(versionId: string, k: Kept) { try { localStorage.setItem(keptKey(versionId), JSON.stringify(k)); } catch { /* not kept */ } }
function dropLocal(versionId: string) { try { localStorage.removeItem(keptKey(versionId)); } catch { /* nothing */ } }
function readLocal(versionId: string): Kept | null {
  try { const raw = localStorage.getItem(keptKey(versionId)); return raw ? (JSON.parse(raw) as Kept) : null; } catch { return null; }
}

/** The published version's table of a watermark source (step 3 says a change of it), else null. */
const publishedTableOf = (s: SourceDto | null) => {
  const i = s?.published?.spec?.input;
  return i?.kind === "db_watermark" ? (i.table ?? null) : null;
};

function SourceWizard({ spaceId, spaceName, initial, start, admin, source }: {
  spaceId: string; spaceName: string; initial: Draft; start: number; admin: boolean; source: { s: SourceDto; v: SourceVersionDto } | null;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [d, setDraft] = useState(initial);
  const [edited, setEdited] = useState(false);
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(start);
  const [ids, setIds] = useState<Ids>(source ? { sourceId: source.s.id, versionId: source.v.id, version: source.v.version } : null);
  const [stored, setStored] = useState(!!source?.s.connection);
  /** The connection as stored, as the form shows it: a difference replaces it (all fields, a test, a PUT at Next). */
  const [base, setBase] = useState(initial.conn);
  const [headerHint, setHeaderHint] = useState(false);
  const [typedNames, setTypedNames] = useState<Record<string, string>>({});
  const typeName = (field: string, name: string | undefined, clear: string[]) => {
    setEdited(true);
    setProblems((x) => Object.fromEntries(Object.entries(x).filter(([id]) => !clear.includes(id))));
    setFieldErr((x) => (x && clear.includes(x.id) ? null : x));
    setTypedNames((t) => { const { [field]: _drop, ...rest } = t; return name === undefined ? rest : { ...rest, [field]: name }; });
  };
  const [tested, setTested] = useState<Tested | null>(null);
  /** The server's short version from the last passing connect (the folded Server line). */
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "test" | "columns" | "next" | "submit">(null);
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [sample, setSample] = useState({ text: "", cut: false });
  const [fileName, setFileName] = useState("");
  const [businessDate, setBusinessDate] = useState("");
  const [preview, setPreview] = useState<Preview>({ result: null, error: null, pending: false });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [fieldErr, setFieldErr] = useState<FieldErr>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // the pickers (REC-F2a): what the source database lists for the login, read after a passing test
  const [names, setNames] = useState<ListState<{ items: string[]; truncated: boolean }>>(IDLE);
  const [tables, setTables] = useState<ListState<TablesPage>>(IDLE);
  /** The credential (apart from the database) and the database of the last passing test: the lists belong to them. */
  const [listed, setListed] = useState<{ cred: string; database: string } | null>(null);
  const [free, setFree] = useState({ database: false, table: false });
  const [tableQuery, setTableQuery] = useState("");
  const [schema, setSchema] = useState("");
  const [picked, setPicked] = useState<{ reading: boolean; n: number | null }>({ reading: false, n: null });
  const [suggested, setSuggested] = useState<Suggestion | null>(null);
  /** Empty core fields filled from the column names (what is set stays); `hint` is what the note says while it is still the value. */
  const withCore = (x: Draft): Draft => {
    const sug = suggestCore(x.spec.fields, x.spec.mapping);
    const y = !Object.keys(sug).length ? x : { ...x, hint: { ...x.hint, ...sug }, spec: { ...x.spec, mapping: { ...x.spec.mapping, ...Object.fromEntries(Object.entries(sug).map(([k, n]) => [k, { field: n }])) } } };
    return withUnit(y);
  };
  /** A database source previews once after its columns are read, so Example isn't empty (one pull, not one per edit). */
  const autoPreview = useRef(false);
  const tablesFor = useRef<string | null>(null);
  const tableSeq = useRef(0);
  const saved = useRef(source?.v.spec ? JSON.stringify(source.v.spec) : null);
  const detect = useRef<Set<string>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  // once the draft exists its edits are kept (autosave and the browser's copy): only a source not made yet can lose them
  const guard = useLeaveGuard(edited && !ids && !done && busy !== "submit");

  const set = (fn: (d: Draft) => Draft) => { setDraft(fn); setEdited(true); };
  const err = (id: string) => problems[id] ?? (fieldErr?.id === id ? fieldErr.reason : undefined);
  const file = d.kind === "file_inbox";
  const native = useMemo(() => new Map((columns ?? []).map((c) => [c.name, c.type])), [columns]);

  // the step lives in the URL (shareable, Build notes 02 routes) without a server round trip; focus follows the heading
  // A new source moves to its edit route once it exists (owner rule, 21 Nov: what was entered never goes away), so a
  // reload opens its saved draft there instead of an empty wizard at …/new.
  useEffect(() => {
    window.history.replaceState(window.history.state, "", !source && ids ? newVersionHref(spaceId, ids.sourceId, (step + 1) as 1 | 2 | 3) : `?step=${step + 1}`);
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step, ids, source, spaceId]);

  /** Shows `list` on their controls and focuses the first; true when there were none. */
  const show = (list: { id: string; reason: string }[]) => {
    setProblems(Object.fromEntries(list.map((p) => [p.id, p.reason])));
    if (list[0]) requestAnimationFrame(() => document.getElementById(list[0]!.id)?.focus());
    return list.length === 0;
  };
  /** An API error on a field: shown on its control (focused when `focus`), else beside the buttons. */
  const fail = (e: unknown, focus: boolean, fallback = "src-columns") => {
    const named = e instanceof ApiError ? fieldError(e.message) : null;
    if (named) {
      const id = controlOf(named.path) ?? fallback;
      setFieldErr({ id, reason: named.reason });
      if (focus) requestAnimationFrame(() => document.getElementById(id)?.focus());
    } else setFormError(errorText(e));
  };

  const replace = !ids || !stored || connChanged(d.conn, base);

  /**
   * Tests exactly the values on screen, storing nothing (fix round 1, I1): a new source's through the space's test
   * route, an existing one's typed connection (or `{}` for the stored one) and folder through its own.
   */
  async function test(x: Draft = d) {
    setFormError(null);
    setFieldErr(null);
    const typedConn = !ids || !stored || connChanged(x.conn, base);
    if (!show(connectionProblems(x, { created: !!ids, replace: typedConn }))) return;
    setBusy("test");
    try {
      const key = connKey(x);
      const i = x.spec.input;
      // a folder is checked before its pattern is typed: every file then counts
      const typed = i.kind === "file_inbox" ? { path: i.path.trim(), pattern: i.pattern.trim() || "*" } : typedConn ? { connection: connBody(x.conn) } : {};
      const result = ids
        ? await api<ConnectionTestDto>(sourceApi(spaceId, ids.sourceId, "/connection/test"), { method: "POST", body: JSON.stringify(typed) })
        : await api<ConnectionTestDto>(`/api/spaces/${encodeURIComponent(spaceId)}/sources/connection-test`, { method: "POST", body: JSON.stringify({ kind: x.kind, ...typed }) });
      setTested({ result, key });
      if (!result.ok) {
        // the sentence sits on the field it names (REC-F2b); a rejected password is selected, ready to retype
        const id = result.field ? FIELD_CONTROL[result.field] : x.kind === "file_inbox" ? ctl("input.path") : "src-connect";
        requestAnimationFrame(() => {
          const el = document.getElementById(id);
          el?.focus();
          if (result.field === "password" && el instanceof HTMLInputElement) el.select();
        });
      }
      if (result.ok && x.kind !== "file_inbox") {
        setVersion(result.version);
        const cred = credKey(x.conn);
        const again = listed?.cred === cred && names.status === "ready";
        setListed({ cred, database: x.conn.database.trim() });
        // the databases (Oracle: schemas) of a typed connection; a stored one keeps its database unless retyped whole
        if (!again && (typedConn || x.conn.engine === "oracle")) void loadNames(x);
      }
    } catch (e) {
      fail(e, true, file ? "src-input-path" : "src-host");
    } finally {
      setBusy(null);
    }
  }

  /** A catalog list over the connection on screen: typed values, or (an existing source, nothing retyped) the stored one. */
  function catalog<T extends SourceCatalogDto>(body: Record<string, unknown>, x: Draft = d): Promise<T> {
    const typedConn = !ids || !stored || connChanged(x.conn, base);
    const url = ids ? sourceApi(spaceId, ids.sourceId, "/connection/catalog") : `/api/spaces/${encodeURIComponent(spaceId)}/sources/catalog`;
    return api<T>(url, { method: "POST", body: JSON.stringify({ ...body, ...(typedConn ? { connection: connBody(x.conn) } : {}) }) });
  }
  /**
   * Suggestions for the source's SELECT (owner, 21 Nov), read over the connection on screen: tables matching the word
   * after FROM/JOIN (the server searches the whole catalog), else the columns of the table before the dot or of every
   * table the query names, with their types. Cached per connection, database and table or prefix: the catalog allows
   * 60 lists a minute, and the editor already waits for typing to pause.
   */
  const sqlCache = useRef(new Map<string, SqlSuggestion[]>());
  async function suggestSql(c: SqlContext): Promise<SqlSuggestion[]> {
    const scope = `${connKey(d)}|${d.conn.engine === "oracle" ? schema : d.conn.database}`;
    const cached = async (key: string, load: () => Promise<SqlSuggestion[]>) => {
      const k = `${scope}|${key}`;
      const hit = sqlCache.current.get(k);
      if (hit) return hit;
      const v = await load();
      sqlCache.current.set(k, v);
      return v;
    };
    if (c.want === "table") {
      return cached(`t:${c.word.toLowerCase()}`, async () => (await catalog<TablesPage>({
        list: "tables", ...(c.word ? { q: c.word } : {}), ...(d.conn.engine === "oracle" && schema ? { schema } : {}),
      })).items.map((t): SqlSuggestion => ({ label: t.schema ? `${t.schema}.${t.name}` : t.name, kind: "table", detail: `${t.kind}, ${t.columns} columns` })));
    }
    const tables = c.table ? [c.table] : c.tables.slice(0, 4);
    const lists = await Promise.all(tables.map((t) => cached(`c:${t.toLowerCase()}`, async () =>
      (await catalog<Extract<SourceCatalogDto, { list: "columns" }>>({ list: "columns", table: t })).columns
        .map((col): SqlSuggestion => ({ label: col.name, kind: "column", detail: c.table || tables.length === 1 ? col.type : `${col.type} · ${t}` })))
      .catch(() => [] as SqlSuggestion[])));
    return lists.flat();
  }
  async function loadNames(x: Draft = d) {
    setNames({ status: "loading" });
    try {
      const r = await catalog<Extract<SourceCatalogDto, { list: "databases" }>>({ list: "databases" }, x);
      setNames({ status: "ready", data: { items: r.items, truncated: r.truncated } });
    } catch (e) {
      setNames(failed(e));
    }
  }
  /** A page of tables for `q`; the latest search wins, and rows on screen stay until it answers. */
  async function loadTables(q: string) {
    const n = ++tableSeq.current;
    setTables((t) => (t.status === "ready" ? t : { status: "loading" }));
    try {
      const r = await catalog<TablesPage>({ list: "tables", ...(q.trim() ? { q: q.trim() } : {}), ...(d.conn.engine === "oracle" && schema ? { schema } : {}) });
      if (n === tableSeq.current) setTables({ status: "ready", data: r });
    } catch (e) {
      if (n === tableSeq.current) setTables(failed(e));
    }
  }
  /** The watermark and id the columns suggest, set unless the user chose their own (a choice the table still has). */
  function applySuggestion(cols: Column[], table: string, kind: CatalogTable["kind"] | null) {
    const s = suggest(d.conn.engine, cols, table, kind);
    const prev = suggested;
    setSuggested(s);
    setDraft((x) => {
      const i = x.spec.input;
      if (i.kind !== "db_watermark") return x;
      const keep = (cur: string, was: string | null | undefined, next: string | null) => (cur && cur !== was && cols.some((c) => c.name === cur) ? cur : next ?? cur);
      return { ...x, spec: { ...x.spec, input: { ...i, watermark: { column: keep(i.watermark.column, prev?.column, s.column), id_column: keep(i.watermark.id_column, prev?.id, s.id) } } } };
    });
  }
  const kindOf = (table: string): CatalogTable["kind"] | null =>
    (tables.status === "ready" ? tables.data.items.find((t) => tableValue(d.conn.engine, t) === table)?.kind ?? null : null);
  /** A table chosen from the list: its columns are read at once (PO step 5) and suggest the watermark and id. */
  async function pickTable(table: string) {
    set((x) => (x.spec.input.kind === "db_watermark" ? { ...x, spec: { ...x.spec, input: { ...x.spec.input, table } } } : x));
    setFieldErr(null);
    setPicked({ reading: true, n: null });
    try {
      const r = await catalog<Extract<SourceCatalogDto, { list: "columns" }>>({ list: "columns", table });
      setColumns(r.columns);
      applySuggestion(r.columns, table, kindOf(table));
      setPicked({ reading: false, n: r.columns.length });
    } catch (e) {
      setPicked({ reading: false, n: null });
      setFieldErr({ id: ctl("input.table"), reason: errorText(e) });
    }
  }
  /** A database chosen from the list: tested at once with it, so its tables list and Next counts the pass. */
  function pickDatabase(database: string) {
    const x = { ...d, conn: { ...d.conn, database } };
    set(() => x);
    void test(x);
  }

  const credNow = credKey(d.conn);
  const listsStale = !!listed && listed.cred !== credNow;
  const tablesStale = !!listed && !listsStale && (!stored || connChanged(d.conn, base)) && d.conn.database.trim() !== listed.database;
  const wantTables = !file && d.kind === "db_watermark" && d.from === "table" && !!listed && !listsStale && !tablesStale
    && (d.conn.engine === "oracle" || !!listed.database || (stored && !connChanged(d.conn, base)));
  const tablesKey = wantTables ? JSON.stringify([listed, schema]) : null;
  // the table list follows the last passing test (and Oracle's schema); a search waits for the typing to stop
  useEffect(() => {
    if (!tablesKey || tablesFor.current === tablesKey) return;
    tablesFor.current = tablesKey;
    setTableQuery("");
    setTables(IDLE);
    void loadTables("");
    // loadTables reads the draft of this render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablesKey]);
  const searched = useRef("");
  useEffect(() => {
    if (!tablesKey || tableQuery === searched.current) return;
    const t = setTimeout(() => { searched.current = tableQuery; void loadTables(tableQuery); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableQuery, tablesKey]);

  /**
   * After a pass (Next on step 1): a new source, its connection and first draft in one call (a taken code shows on the
   * Code field, nothing is made); an existing source's changed connection replaced. Then its ids.
   */
  async function commitConnection(): Promise<Ids> {
    try {
      if (!ids) {
        const s = await api<SourceDto>(`/api/spaces/${encodeURIComponent(spaceId)}/sources`, { method: "POST", body: JSON.stringify({
          code: d.code.trim().toLowerCase(), name: d.name.trim(), kind: d.kind, draft: true, ...(file ? {} : { connection: connBody(d.conn) }),
        }) });
        const made = { sourceId: s.id, versionId: s.draft!.id, version: s.draft!.version };
        setIds(made);
        setStored(!file);
        setBase(d.conn);
        void qc.invalidateQueries({ queryKey: SOURCES_KEY });
        return made;
      }
      if (!file && replace) {
        await api(sourceApi(spaceId, ids.sourceId, "/connection"), { method: "PUT", body: JSON.stringify(connBody(d.conn)) });
        setStored(true);
        setBase(d.conn);
      }
      return ids;
    } catch (e) {
      if (e instanceof ApiError && e.code === "duplicate") show([{ id: "src-code", reason: errorText(e) }]);
      else fail(e, true, "src-name");
      return null;
    }
  }

  /** The source table's (or SELECT's) columns; the fields follow them (merged: what the user set stays). */
  async function readColumns(at: Ids = ids): Promise<boolean> {
    if (!at) return false;
    const i = d.spec.input;
    setBusy("columns");
    setFieldErr(null);
    try {
      const table = i.kind === "db_watermark" && d.from === "table" ? (i.table ?? "").trim() : null;
      const query = i.kind === "db_snapshot" ? i.query : i.kind === "db_watermark" ? (i.query ?? "") : "";
      const r = table
        ? await api<SourceColumnsDto>(sourceApi(spaceId, at.sourceId, `/connection/columns?${new URLSearchParams({ table })}`))
        : await api<SourceColumnsDto>(sourceApi(spaceId, at.sourceId, "/connection/columns"), { method: "POST", body: JSON.stringify({ query, ...(businessDate ? { businessDate } : {}) }) });
      setColumns(r.columns);
      const engine = source?.s.connection?.engine ?? d.conn.engine;
      if (table) applySuggestion(r.columns, table, kindOf(table));
      if (!file) autoPreview.current = true;
      set((x) => {
        const merged = mergeFields(x.spec.fields, fieldsOfColumns(engine, r.columns));
        // a table read: fields its columns lack stay, marked (PO decision 4); a SELECT's columns replace them as before
        const fields = table ? [...merged, ...x.spec.fields.filter((f) => !merged.some((m) => m.name === f.name))] : merged;
        const fresh = fields.filter((f) => !x.spec.fields.some((k) => k.name === f.name));
        return withCore({ ...x, spec: { ...x.spec, fields, mapping: { ...x.spec.mapping, attrs: { ...x.spec.mapping.attrs, ...Object.fromEntries(fresh.map((f) => [attrNameOf(f.name), { field: f.name }])) } } } });
      });
      return true;
    } catch (e) {
      const id = step === 0 ? (i.kind === "db_watermark" && d.from === "table" ? "src-input-table" : "src-input-query") : "src-columns";
      setFieldErr({ id, reason: errorText(e) });
      requestAnimationFrame(() => document.getElementById(id)?.focus());
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** Reads the sample's columns: new ones come in as text, then take the type the preview guesses for them. */
  function readSample() {
    const i = d.spec.input;
    if (i.kind !== "file_inbox") return;
    const names = sampleColumns(sample.text, i.format.delimiter, i.format.quote ?? null, i.format.header);
    if (!names.length) { show([{ id: "src-sample", reason: "Paste at least one line of the file." }]); return; }
    setProblems({});
    setHeaderHint(!i.format.header && looksLikeHeader(sample.text, i.format.delimiter, i.format.quote ?? null));
    set((x) => {
      const fields = mergeFields(x.spec.fields, names.map((name) => ({ name, type: "string" as const, nullable: true, trim: true })));
      const fresh = fields.filter((f) => !x.spec.fields.some((k) => k.name === f.name)).map((f) => f.name);
      detect.current = new Set(fresh);
      return withCore({ ...x, spec: { ...x.spec, fields, mapping: { ...x.spec.mapping, attrs: { ...x.spec.mapping.attrs, ...Object.fromEntries(fresh.map((n) => [attrNameOf(n), { field: n }])) } } } });
    });
  }

  // the live preview (ruling 2): the spec on screen, unsaved, a moment after the last change
  const gone = useMemo(() => (d.from === "table" && d.kind === "db_watermark" ? goneFields(d.spec, columns) : { gone: [], used: [] }), [d, columns]);
  const spec = useMemo(() => buildSpec(d, gone.gone.filter((n) => !gone.used.includes(n))), [d, gone]);
  const specKey = JSON.stringify(spec);
  const previewable = !mappingProblem(spec) && (!file || !!sample.text.trim());
  const seq = useRef(0);
  /** One preview of the spec on screen (a file's sample, or rows pulled from the source database); the latest wins. */
  const runPreview = async () => {
    if (!ids || !previewable) return;
    const n = ++seq.current;
    setPreview((p) => ({ ...p, pending: true }));
    try {
      const body = file ? { sample: sample.text, ...(fileName.trim() ? { fileName: fileName.trim() } : {}), spec } : { spec, ...(businessDate ? { businessDate } : {}) };
      const result = await api<SourcePreviewDto>(sourceApi(spaceId, ids.sourceId, `/versions/${encodeURIComponent(ids.versionId)}/preview`), { method: "POST", body: JSON.stringify(body) });
      if (n !== seq.current) return;
      setFieldErr(null);
      setPreview({ result, error: null, pending: false });
      if (detect.current.size) {
        const guess = new Map(result.columns.map((c) => [c.name, c]));
        const fresh = detect.current;
        detect.current = new Set();
          setDraft((x) => withCore({ ...x, spec: { ...x.spec, fields: x.spec.fields.map((f) => {
          const g = fresh.has(f.name) ? guess.get(f.name) : undefined;
          if (!g || g.type === "string") return f;
          const places = Math.max(2, ...g.examples.map((e) => /[.,](\d+)$/.exec(e)?.[1]?.length ?? 0));
          // the format the sample was read in comes with the type (20261119 → Date, yyyyMMdd)
          return { ...f, type: g.type, ...(g.type === "decimal" ? { format: { scale: Math.min(18, places) } } : g.format ? { format: { date: g.format } } : {}) };
        }) } }));
      }
    } catch (e) {
      if (n !== seq.current) return;
      const named = e instanceof ApiError ? fieldError(e.message) : null;
      if (named) setFieldErr({ id: controlOf(named.path) ?? "src-columns", reason: named.reason });
      setPreview({ result: null, error: named ? `The preview stopped: ${named.reason}` : errorText(e), pending: false });
    }
  };
  // a file's preview is live (ruling 2): a moment after the last change. A database source's pulls from the bank's
  // database, so it runs on demand only (Preview rows; fix round 1).
  useEffect(() => {
    if (step !== 1 || !file || !ids || !previewable) return;
    const t = setTimeout(() => void runPreview(), 600);
    return () => clearTimeout(t);
    // the spec is compared by its JSON (specKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ids, specKey, previewable, sample.text, fileName, file, spaceId]);

  useEffect(() => {
    if (step !== 1 || file || !autoPreview.current || !previewable || !ids) return;
    autoPreview.current = false;
    void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, file, previewable, ids, specKey]);

  /** Saves the spec when it changed since the last save; a refused field is shown and focused. */
  async function save(): Promise<boolean> {
    if (!ids) return false;
    if (saved.current === specKey) return true;
    try {
      await api<SourceVersionDto>(sourceApi(spaceId, ids.sourceId, `/versions/${encodeURIComponent(ids.versionId)}`), { method: "PATCH", body: JSON.stringify({ spec }) });
      saved.current = specKey;
      return true;
    } catch (e) {
      fail(e, true);
      return false;
    }
  }

  // Autosave (owner rule, 21 Nov: data entered in a step is never lost on a reload or a step back): the draft's spec is
  // saved as soon as the step changes, else 800 ms after the last edit. Until the server takes it (a spec it refuses
  // mid-edit: "Rows can change" before its match key), the browser keeps a copy per draft version, restored on the next
  // open while the server's draft is still the one the copy was made over. Quiet: Next still saves and reports.
  const serverHash = useRef<string | null>(source?.v.specHash ?? null);
  const savedStep = useRef(step);
  useEffect(() => {
    if (!ids || saved.current === specKey) return;
    keepLocal(ids.versionId, { base: serverHash.current, spec, from: d.from });
    const moved = savedStep.current !== step;
    const t = setTimeout(() => {
      savedStep.current = step;
      void api<SourceVersionDto>(sourceApi(spaceId, ids.sourceId, `/versions/${encodeURIComponent(ids.versionId)}`), { method: "PATCH", body: JSON.stringify({ spec }) })
        .then((v) => { saved.current = specKey; serverHash.current = v.specHash; dropLocal(ids.versionId); }, () => {});
    }, moved ? 0 : 800);
    return () => clearTimeout(t);
    // the spec is compared by its JSON (specKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, ids, step, spaceId]);
  // the copy kept by an earlier visit, once, after mount (localStorage is the browser's: never in the server render)
  useEffect(() => {
    if (!ids) return;
    const kept = readLocal(ids.versionId);
    if (kept && (kept.base === null || kept.base === serverHash.current)) setDraft((x) => ({ ...x, spec: kept.spec, from: kept.from }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function next() {
    setFormError(null);
    setFieldErr(null);
    if (step === 0) {
      if (!show(pullProblems(d, { replace }))) return;
      setBusy("next");
      const at = await commitConnection();
      setBusy(null);
      if (!at) return;
      if (!file && !(await readColumns(at))) return;
      setStep(1);
      return;
    }
    if (step === 1) {
      const p = mappingProblem(spec);
      if (p) { show([p]); return; }
      if (!show(amountProblems(spec))) return;
      if (admin && !show(watermarkProblems(d))) return;
      const badNames = d.spec.fields.flatMap((f, i) => {
        const t = typedNames[f.name];
        const why = t === undefined ? null : storedNameProblem(t, f.name, d.spec);
        return why ? [{ id: `src-attr-${i}`, reason: why }] : [];
      });
      if (!show(badNames)) return;
      setProblems({});
      setBusy("next");
      const ok = await save();
      setBusy(null);
      if (ok) setStep(2);
      return;
    }
    setBusy("submit");
    try {
      if (!(await save()) || !ids) return;
      await api<SourceVersionDto>(sourceApi(spaceId, ids.sourceId, `/versions/${encodeURIComponent(ids.versionId)}/submit`), { method: "POST", body: "{}" });
      setDone(true);
      toast(`Version ${ids.version} of ${d.name.trim()} sent for approval. A config checker in ${spaceName} approves it.`);
      await qc.invalidateQueries({ queryKey: SOURCES_KEY });
      router.push(versionHref(spaceId, ids.sourceId, ids.versionId));
    } catch (e) {
      setFormError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const tableNow = d.spec.input.kind === "db_watermark" ? (d.spec.input.table ?? "") : "";
  // step 1: Next opens once the connect (or folder check) of the values on screen passed and a table is picked, with no
  // sentence (docs/recon/ux-form-rules.md, exception to ui-standard §5b); step 2: a field whose column is gone
  const ready0 = !!tested?.result.ok && tested.key === connKey(d) && pullProblems(d, { replace }).length === 0;
  const relocked = !!tested?.result.ok && tested.key !== connKey(d);
  const blocked = step === 0 ? (ready0 ? null : relocked ? CHANGED[file ? "file" : "db"] : "") : step === 1 && gone.used.length ? goneBlocked(gone.used.length, tableNow) : null;
  /** A draft source nobody submitted or shared (DELETE …/sources/{id} takes it): made here, or opened as such. */
  const deletable = !!ids && (!source || (source.s.publishedVersion === null && !source.v.submitterId && !source.s.shares.length));
  async function discard() {
    if (!ids) return;
    await api(sourceApi(spaceId, ids.sourceId), { method: "DELETE" });
    setDone(true);
    toast(`Deleted the draft source ${d.name.trim()}.`);
    await qc.invalidateQueries({ queryKey: SOURCES_KEY });
    router.push(sourcesHref(spaceId));
  }
  const title = source ? "Edit source" : "New source";
  const steps = STEPS.map((label, i) => ({ id: label, label, status: (i === step ? "current" : i < step || (i === 0 && !admin) ? "done" : "todo") as "current" | "done" | "todo" }));
  const working = busy !== null;

  return (
    <div className="grid gap-section">
      <PageHeader title={title} description={DESCRIPTION(spaceName)[step]} trail={source ? [{ label: source.s.name, href: sourceHref(spaceId, source.s.id) }] : []}
        more={deletable && admin ? [{ label: "Delete draft source", reason: working ? "Wait for the current step to finish." : null, destructive: true, confirm: discardConfirm(d.name.trim(), discard) }] : undefined} />
      <Wizard title="Setup progress" steps={steps}>
        <form noValidate aria-label={title} onSubmit={(e) => { e.preventDefault(); if (blocked === null && !working) void next(); }} className="grid gap-section">
          {/* the Setup progress rail shows the step (owner, 21 Nov): the heading stays for screen readers and as the focus target of a step change */}
          <h2 ref={heading} tabIndex={-1} className="sr-only">Step {step + 1} of 3 · {STEPS[step]}</h2>
          {step === 0 && (
            <ConnectionStep d={d} set={set} created={!!ids} stored={stored && !connChanged(d.conn, base)} err={err} tested={tested} testing={busy === "test"} onTest={() => void test()}
              connected={!file && listed && !listsStale ? { version } : null} listed={!file && !!listed}
              nextVersion={source?.s.publishedVersion != null && ids ? ids.version : null}
              catalog={{
                names, tables, stale: listsStale, tablesStale, free, onFree: (k, f) => setFree((x) => ({ ...x, [k]: f })), query: tableQuery, onQuery: setTableQuery,
                schema, onSchema: setSchema, onPickDatabase: pickDatabase, onPickTable: (t) => void pickTable(t), onRetryNames: () => void loadNames(), onRetryTables: () => void loadTables(tableQuery),
                columns: picked, onSuggest: suggestSql, onCheckQuery: (query) => catalog<Extract<SourceCatalogDto, { list: "query" }>>({ list: "query", query }),
              }} />
          )}
          {step === 1 && (
            <FieldsStep d={d} set={set} err={err} engine={file ? null : (source?.s.connection?.engine ?? d.conn.engine)} native={native} canRead={admin && !!ids}
              reading={busy === "columns"} onReadColumns={() => void readColumns()} sample={sample.text} sampleCut={sample.cut} fileName={fileName}
              onSample={(text, name) => { setSample(sampleHead(text)); if (name) setFileName(name); setEdited(true); }} onFileName={setFileName} onReadSample={readSample}
              businessDate={businessDate} onBusinessDate={setBusinessDate} preview={previewable ? preview : { result: null, error: null, pending: false }}
              onPreview={file ? null : () => void runPreview()} columns={columns} canChangeReading={admin} headerHint={headerHint} typedNames={typedNames} onTypedName={typeName}
              gone={gone} suggested={suggested} coreHint={d.hint ?? {}}
              onUseHeader={() => { set((x) => (x.spec.input.kind === "file_inbox" ? { ...x, spec: { ...x.spec, fields: [], mapping: { ...x.spec.mapping, attrs: {} }, input: { ...x.spec.input, format: { ...x.spec.input.format, header: true } } } } : x)); setHeaderHint(false); }} />
          )}
          {step === 2 && ids && <ReviewStep d={{ ...d, spec }} version={ids.version} spaceName={spaceName} preview={previewable ? preview.result : null} canConnect={admin} onEdit={setStep}
            publishedTable={publishedTableOf(source?.s ?? null)} />}
          {formError && <p role="alert" className="text-body-sm text-down-ink">{formError}</p>}
          <FormFooter
            primary={<BlockedButton type="submit" reason={blocked || null} variant={blocked === null ? "default" : "secondary"} disabled={(working && blocked === null) || blocked === ""} aria-busy={busy === "next" || busy === "submit" || (step === 0 && busy === "columns") || undefined}>
              {(busy === "next" || busy === "submit" || (step === 0 && busy === "columns")) && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{NEXT[step]}
            </BlockedButton>}
            back={step > (admin ? 0 : 1) && <Button type="button" variant="secondary" disabled={working} onClick={() => { setFieldErr(null); setProblems({}); setStep(step - 1); }}>Back</Button>}
            cancel={<Button asChild variant="ghost"><Link href={source ? sourceHref(spaceId, source.s.id) : sourcesHref(spaceId)}>Cancel</Link></Button>} />
        </form>
      </Wizard>
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without submitting"
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }}
          description={ids ? `Version ${ids.version} stays a draft with what was saved; changes on this step aren't saved.${deletable ? " To remove the source, use Delete draft source." : ""}` : "This source isn't created yet: nothing is saved."}
          impact={["What you typed and didn't save is discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </div>
  );
}
