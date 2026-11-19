"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BlockedButton, EmptyState, Failure, FormActions, Panel, Wizard } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { DeniedIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ConnectionTestDto, SourceColumnsDto, SourceDto, SourcePreviewDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import { DetailNotFound } from "@/components/detail-not-found";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { ApiError, api, errorText, isNotFound } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { SOURCES_KEY } from "@/lib/shared/queries";
import { WIZARD_SHAPE } from "./shapes";
import { attrNameOf, fieldError, fieldsOfColumns, looksLikeHeader, mergeFields, sampleColumns, sampleHead, storedNameProblem } from "./spec-draft";
import { ConnectionStep } from "./steps/connection";
import { FieldsStep } from "./steps/fields";
import {
  buildSpec, type Column, connBody, connChanged, connectionProblems, connKey, controlOf, type Draft, EMPTY_CONN, emptySpec, type FieldErr, mappingProblem, type Preview, pullProblems,
  type Tested, watermarkProblems,
} from "./steps/model";
import { DiscardDialog } from "./discard-dialog";
import { ReviewStep } from "./steps/review";
import {
  EDIT_REASON, NEW_SOURCE_REASON, sourceApi, sourceHref, sourcesHref, useSource, useSpaceRoles, useStartVersion, versionHref,
} from "./use-sources";

const STEPS = ["Connection", "Fields & mapping", "Review & submit"] as const;
const NEXT = ["Next: fields & mapping", "Next: review", "Submit for approval"] as const;
const DESCRIPTION = [
  "Set up where the data comes from. Recons in this space then read from this source.",
  "Check what was detected, fix types and formats, and say which columns the recon uses. The preview updates as you change things.",
  "Check the summary, then send the version for approval. A config checker other than you approves it before anything is ingested.",
] as const;
/** Ruling 1: Next needs a passing test of exactly the values on screen. */
const UNTESTED = { db: "Test the connection first; step 2 reads the columns through it.", file: "Test the folder first; files are picked up from it." } as const;
const CHANGED = { db: "The connection changed since the last test. Test it again.", file: "The folder changed since the last test. Test it again." } as const;

const step0 = (n: number | null, admin: boolean) => Math.min(2, Math.max(admin ? 0 : 1, (n ?? (admin ? 1 : 2)) - 1));

/** /spaces/[spaceId]/sources/new: a source admin's three steps; the source and its draft are made at the first test. */
export function NewSourceWizard({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const roles = useSpaceRoles(spaceId);
  const initial = useMemo<Draft>(() => ({ name: "", code: "", kind: "file_inbox", conn: EMPTY_CONN, from: "table", spec: emptySpec("file_inbox") }), []);
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
  const admin = roles.includes("source_admin");
  if (s.owner) return <Refused title={`Edit ${s.name}`} reason={`${s.owner.name} owns this source; only its source admins and config makers change it.`} back={back} />;
  if (!admin && !roles.includes("config_maker")) return <Refused title={`Edit ${s.name}`} reason={EDIT_REASON} back={back} />;
  const v = s.draft;
  if (!v) {
    return (
      <div className="grid gap-section">
        <PageHeader title={`Edit ${s.name}`} trail={[{ label: s.name, href: sourceHref(spaceId, id) }]} />
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
    return <Refused title={`Edit ${s.name}`} back={{ href: versionHref(spaceId, id, v.id), label: `Open version ${v.version}` }}
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

function Refused({ title, reason, back }: { title: string; reason: string; back: { href: string; label: string } }) {
  return (
    <div className="grid gap-section">
      <PageHeader title={title} />
      <Panel><EmptyState icon={DeniedIcon} title="This can't be changed here" description={reason} action={<Button asChild variant="secondary"><Link href={back.href}>{back.label}</Link></Button>} /></Panel>
    </div>
  );
}

type Ids = { sourceId: string; versionId: string; version: number } | null;

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
  const [discarding, setDiscarding] = useState(false);
  const [headerHint, setHeaderHint] = useState(false);
  const [typedNames, setTypedNames] = useState<Record<string, string>>({});
  const typeName = (field: string, name: string | undefined, clear: string[]) => {
    setEdited(true);
    setProblems((x) => Object.fromEntries(Object.entries(x).filter(([id]) => !clear.includes(id))));
    setFieldErr((x) => (x && clear.includes(x.id) ? null : x));
    setTypedNames((t) => { const { [field]: _drop, ...rest } = t; return name === undefined ? rest : { ...rest, [field]: name }; });
  };
  const [tested, setTested] = useState<Tested | null>(null);
  const [busy, setBusy] = useState<null | "test" | "columns" | "next" | "submit">(null);
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [sample, setSample] = useState({ text: "", cut: false });
  const [fileName, setFileName] = useState("");
  const [businessDate, setBusinessDate] = useState("");
  const [preview, setPreview] = useState<Preview>({ result: null, error: null, pending: false });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [fieldErr, setFieldErr] = useState<FieldErr>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const saved = useRef(source?.v.spec ? JSON.stringify(source.v.spec) : null);
  const detect = useRef<Set<string>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const guard = useLeaveGuard(edited && !done && busy !== "submit");

  const set = (fn: (d: Draft) => Draft) => { setDraft(fn); setEdited(true); };
  const err = (id: string) => problems[id] ?? (fieldErr?.id === id ? fieldErr.reason : undefined);
  const file = d.kind === "file_inbox";
  const native = useMemo(() => new Map((columns ?? []).map((c) => [c.name, c.type])), [columns]);

  // the step lives in the URL (shareable, Build notes 02 routes) without a server round trip; focus follows the heading
  useEffect(() => {
    window.history.replaceState(window.history.state, "", `?step=${step + 1}`);
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);

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
  async function test() {
    setFormError(null);
    setFieldErr(null);
    if (!show(connectionProblems(d, { created: !!ids, replace }))) return;
    setBusy("test");
    try {
      const key = connKey(d);
      const i = d.spec.input;
      const typed = i.kind === "file_inbox" ? { path: i.path.trim(), pattern: i.pattern.trim() } : replace ? { connection: connBody(d.conn) } : {};
      const result = ids
        ? await api<ConnectionTestDto>(sourceApi(spaceId, ids.sourceId, "/connection/test"), { method: "POST", body: JSON.stringify(typed) })
        : await api<ConnectionTestDto>(`/api/spaces/${encodeURIComponent(spaceId)}/sources/connection-test`, { method: "POST", body: JSON.stringify({ kind: d.kind, ...typed }) });
      setTested({ result, key });
    } catch (e) {
      fail(e, true, file ? "src-input-path" : "src-host");
    } finally {
      setBusy(null);
    }
  }

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
      set((x) => {
        const fields = mergeFields(x.spec.fields, fieldsOfColumns(engine, r.columns));
        const fresh = fields.filter((f) => !x.spec.fields.some((k) => k.name === f.name));
        return { ...x, spec: { ...x.spec, fields, mapping: { ...x.spec.mapping, attrs: { ...x.spec.mapping.attrs, ...Object.fromEntries(fresh.map((f) => [attrNameOf(f.name), { field: f.name }])) } } } };
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
      return { ...x, spec: { ...x.spec, fields, mapping: { ...x.spec.mapping, attrs: { ...x.spec.mapping.attrs, ...Object.fromEntries(fresh.map((n) => [attrNameOf(n), { field: n }])) } } } };
    });
  }

  // the live preview (ruling 2): the spec on screen, unsaved, a moment after the last change
  const spec = useMemo(() => buildSpec(d), [d]);
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
        setDraft((x) => ({ ...x, spec: { ...x.spec, fields: x.spec.fields.map((f) => {
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

  async function next() {
    setFormError(null);
    setFieldErr(null);
    if (step === 0) {
      if (!show(pullProblems(d))) return;
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

  const blocked = step === 0 ? (!tested || !tested.result.ok ? UNTESTED[file ? "file" : "db"] : tested.key !== connKey(d) ? CHANGED[file ? "file" : "db"] : null) : null;
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
  const title = source ? `Edit ${source.s.name}` : "New source";
  const steps = STEPS.map((label, i) => ({ id: label, label, status: (i === step ? "current" : i < step || (i === 0 && !admin) ? "done" : "todo") as "current" | "done" | "todo" }));
  const working = busy !== null;

  return (
    <div className="grid gap-section">
      <PageHeader title={title} description={DESCRIPTION[step]} trail={source ? [{ label: source.s.name, href: sourceHref(spaceId, source.s.id) }] : []} />
      <Wizard title="Setup progress" steps={steps}>
        <form noValidate aria-label={title} onSubmit={(e) => { e.preventDefault(); if (!blocked && !working) void next(); }} className="grid gap-section">
          <h2 ref={heading} tabIndex={-1} className="text-title-2 text-fg outline-none">Step {step + 1} of 3 · {STEPS[step]}</h2>
          {step === 0 && (
            <ConnectionStep d={d} set={set} created={!!ids} stored={stored && !connChanged(d.conn, base)} err={err} tested={tested} testing={busy === "test"} onTest={() => void test()} />
          )}
          {step === 1 && (
            <FieldsStep d={d} set={set} err={err} engine={file ? null : (source?.s.connection?.engine ?? d.conn.engine)} native={native} canRead={admin && !!ids}
              reading={busy === "columns"} onReadColumns={() => void readColumns()} sample={sample.text} sampleCut={sample.cut} fileName={fileName}
              onSample={(text, name) => { setSample(sampleHead(text)); if (name) setFileName(name); setEdited(true); }} onFileName={setFileName} onReadSample={readSample}
              businessDate={businessDate} onBusinessDate={setBusinessDate} preview={previewable ? preview : { result: null, error: null, pending: false }}
              onPreview={file ? null : () => void runPreview()} columns={columns} canChangeReading={admin} headerHint={headerHint} typedNames={typedNames} onTypedName={typeName}
              onUseHeader={() => { set((x) => (x.spec.input.kind === "file_inbox" ? { ...x, spec: { ...x.spec, fields: [], mapping: { ...x.spec.mapping, attrs: {} }, input: { ...x.spec.input, format: { ...x.spec.input.format, header: true } } } } : x)); setHeaderHint(false); }} />
          )}
          {step === 2 && ids && <ReviewStep d={{ ...d, spec }} version={ids.version} spaceName={spaceName} preview={previewable ? preview.result : null} canConnect={admin} onEdit={setStep} />}
          {formError && <p role="alert" className="text-body-sm text-down-ink">{formError}</p>}
          <FormActions className="justify-end">
            {deletable && admin && <Button type="button" variant="ghost" className="mr-auto text-down-ink" disabled={working} onClick={() => setDiscarding(true)}>Delete draft source</Button>}
            <Button asChild variant="ghost"><Link href={source ? sourceHref(spaceId, source.s.id) : sourcesHref(spaceId)}>Cancel</Link></Button>
            {step > (admin ? 0 : 1) && <Button type="button" variant="secondary" disabled={working} onClick={() => { setFieldErr(null); setProblems({}); setStep(step - 1); }}>Back</Button>}
            <BlockedButton type="submit" reason={blocked} disabled={working && !blocked} aria-busy={busy === "next" || busy === "submit" || (step === 0 && busy === "columns") || undefined}>
              {(busy === "next" || busy === "submit" || (step === 0 && busy === "columns")) && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{NEXT[step]}
            </BlockedButton>
          </FormActions>
        </form>
      </Wizard>
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without submitting"
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }}
          description={ids ? `Version ${ids.version} stays a draft with what was saved; changes on this step aren't saved.${deletable ? " To remove the source, use Delete draft source." : ""}` : "This source isn't created yet: nothing is saved."}
          impact={["What you typed and didn't save is discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
      {discarding && <DiscardDialog name={d.name.trim()} onClose={() => setDiscarding(false)} onConfirm={discard} />}
    </div>
  );
}
