"use client";

import { mayDo } from "@starterkit/shared/spaces";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { BlockedButton, ErrorSummary, Field, FormFooter, Panel, RequiredNote, useForm, Wizard } from "@starterkit/ui/ds";
import { rules, type Schema } from "@starterkit/ui/lib/validate";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { toast } from "@starterkit/ui/ui/toast";
import type { ReconDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceDto, SourceRowDto } from "@starterkit/shared/contracts/sources";
import { RECON_CODE, RECON_NAME_MAX, recordFields } from "@starterkit/shared/recon";
import { PageHeader } from "@/components/shell/page-header";
import { ApiError, api, errorText } from "@/lib/client/api";
import { RECON_KEY, sourceDetail } from "@/lib/shared/queries";
import { blankSpec, createdSpec, type Fields, type Place, placeOf, SETUP_STEPS, withSource } from "./spec-model";
import { SidesStep } from "./sides-step";
import { NEW_RECON_REASON, reconApi, reconEditHref, reconsHref, useSideSource, useSourceOptions, useSpaceRoles } from "./use-recons";

type Values = { name: string; code: string; a: string; b: string };
const SCHEMA: Schema<Values> = {
  name: [rules.required("Enter a name for the recon."), rules.maxLength(RECON_NAME_MAX)],
  code: [rules.required("Enter a code."), rules.pattern(RECON_CODE, "Use 2–64 lower-case letters, digits, _ or -, starting with a letter or a digit.")],
  a: [rules.required("Pick the source of side A.")],
  b: [rules.required("Pick the source of side B.")],
};
const LABELS = { name: "Name", code: "Code", a: "Side A", b: "Side B" };
/** A code from a name, until the maker types their own: "BI-FAST credit" → "bi-fast-credit". */
export const codeOf = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** The source wizard (the sources feature's first step), and why only a source admin opens it. */
const newSourceHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/sources/new?step=1`;
const NEW_SOURCE_REASON = "Only a source admin of this space adds sources.";

/** A source as a side picker lists it; a source without an approved version can't be a side yet. */
const optionText = (s: SourceRowDto) =>
  `${s.name}${s.owner ? ` · shared from ${s.owner.name}` : ""}${s.publishedVersion === null ? " · no approved version yet" : ""}`;
const BLANK = JSON.stringify(blankSpec());

/**
 * /spaces/[spaceId]/recons/new (README row Plan 3): a name and a code over the setup's step 1, the same SidesStep as an
 * existing recon's (owner 24 Nov: both paths the same), with each side's source picked in its Source field. The API
 * makes the recon and its Draft v1 (step 1 as set, pass 1 ready to edit) together on Next, then its setup goes on at
 * step 2 (Matching). A role other than config maker gets the reason. With no published source in the space there is
 * nothing to pick: one sentence and Create source instead.
 */
export function NewRecon({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const roles = useSpaceRoles(spaceId);
  const maker = mayDo(roles, "editRecon");
  const sources = useSourceOptions(spaceId);
  const f = useForm<Values>({ initial: { name: "", code: "", a: "", b: "" }, schema: SCHEMA, idPrefix: "rc" });
  const [spec, setSpec] = useState<ReconSpec>(blankSpec);
  const [codeTyped, setCodeTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | undefined>();
  const [problem, setProblem] = useState<Place | null>(null);
  const items = useMemo(() => sources.data?.items ?? [], [sources.data]);
  // the picked sources' fields, for the filters (as the builder reads them)
  const sa = useSideSource(spaceId, f.values.a), sb = useSideSource(spaceId, f.values.b);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const json = JSON.stringify(spec);
  const dirty = Object.values(f.values).some(Boolean) || json !== BLANK;
  const shown = { ...f.shown, code: f.shown.code ?? codeErr };
  // Never lose what was typed (owner rule): until the recon exists, the browser keeps step 1 per space (name, code,
  // the sources and the sides as set) and puts it back on the next open; creating it drops the copy (the draft on the
  // server holds it from then on)
  const keptKey = `recon:recon-new:${spaceId}`;
  useEffect(() => {
    try {
      const k = JSON.parse(localStorage.getItem(keptKey) ?? "null") as (Values & { codeTyped?: boolean; spec?: ReconSpec; direction?: ReconSpec["direction"] }) | null;
      if (!k) return;
      (["name", "code", "a", "b"] as const).forEach((key) => { if (typeof k[key] === "string") f.set(key, k[key]); });
      // the browser's copy is only readable after mount: one restore, once
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (k.codeTyped) setCodeTyped(true);
      if (Array.isArray(k.spec?.sides) && k.spec.sides.length === 2) setSpec(k.spec);
      else if (k.direction === "a_to_b") setSpec((s) => ({ ...s, direction: "a_to_b" })); // a copy from before the sides were kept
    } catch { /* nothing kept */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      if (dirty && !busy) localStorage.setItem(keptKey, JSON.stringify({ ...f.values, codeTyped, spec }));
      else if (!dirty) localStorage.removeItem(keptKey);
    } catch { /* not kept */ }
    // the spec is compared by its JSON
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.values, codeTyped, json, dirty, busy, keptKey]);

  const change = (next: ReconSpec) => { setSpec(next); setProblem(null); setError(null); };
  const create = (event: FormEvent<HTMLFormElement>) => f.submit(async (v) => {
    if (saving.current) return;
    const a = items.find((s) => s.id === v.a), b = items.find((s) => s.id === v.b);
    if (!a || !b) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setCodeErr(undefined);
    setProblem(null);
    try {
      // pass 1 starts with an "equals" for every core field both sources map (addPass): their published fields (cached)
      const [fa, fb] = await Promise.all([a, b].map(async (s) => {
        const { key, url } = sourceDetail(spaceId, s.id);
        const published = (await qc.fetchQuery({ queryKey: key, queryFn: () => api<SourceDto>(url) })).published?.spec;
        return published ? recordFields(published) : null;
      }));
      // step 1 as set (its sources are a and b: picking one writes both), then pass 1
      const body = createdSpec(spec, [fa ?? null, fb ?? null]);
      const r = await api<ReconDto>(reconApi(spaceId), { method: "POST", body: JSON.stringify({ name: v.name.trim(), code: v.code.trim(), spec: body }) });
      try { localStorage.removeItem(keptKey); } catch { /* nothing kept */ }
      toast(`Created ${r.name} as Draft v1.`);
      await qc.invalidateQueries({ queryKey: RECON_KEY });
      router.push(reconEditHref(spaceId, r.id, 2)); // its setup goes on with the passes
    } catch (err) {
      const text = errorText(err);
      const place = placeOf(text);
      if (err instanceof ApiError && err.code === "duplicate") {
        setCodeErr(text);
        requestAnimationFrame(() => document.getElementById(f.id("code"))?.focus());
      } else if (place.side !== undefined) {
        // on its side's panel, as the builder shows it
        setProblem(place);
        requestAnimationFrame(() => document.getElementById(`rs-${place.side}-label`)?.focus());
      } else setError(text);
      saving.current = false;
      setBusy(false);
    }
  })(event);

  const picker = (i: 0 | 1) => {
    const k = i === 0 ? "a" : "b";
    return {
      id: f.id(k), error: f.error(k),
      control: (
        <Select id={f.id(k)} value={f.values[k]} className="w-full" onChange={(e) => {
          const was = items.find((s) => s.id === f.values[k]) ?? null;
          f.set(k, e.target.value);
          change(withSource(spec, i, items.find((s) => s.id === e.target.value) ?? null, was));
        }}>
          <option value="">{sources.isPending ? "Loading sources…" : "Choose a source"}</option>
          {items.map((s) => <option key={s.id} value={s.id} disabled={s.publishedVersion === null}>{optionText(s)}</option>)}
        </Select>
      ),
    };
  };
  const editable = maker && !busy;

  return (
    <div className="grid gap-section">
      <PageHeader title="New recon" />
      {sources.data && !items.some((x) => x.publishedVersion !== null) ? (
        <Panel>
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <p className="text-body text-fg">No published source in {spaceName} yet.</p>
            {mayDo(roles, "connectSource")
              ? <Button variant="create-solid" asChild><Link href={newSourceHref(spaceId)}><Icon icon={AddIcon} />Create source</Link></Button>
              : <BlockedButton variant="create-solid" reason={NEW_SOURCE_REASON}><Icon icon={AddIcon} />Create source</BlockedButton>}
          </div>
        </Panel>
      ) : (
      // the setup's first step (owner, 22 Nov: one flow): the same rail as the steps after it
      <Wizard title="Setup progress" steps={([1, 2, 3, 4, 5, 6] as const).map((n) => ({ id: String(n), label: SETUP_STEPS[n], status: n === 1 ? "current" : "todo" }))}>
        <form noValidate onSubmit={create} aria-label="New recon" className="grid gap-section">
          <Panel bodyClassName="md:p-6">
            <fieldset disabled={!editable} className="grid gap-4">
              {f.submitted && <ErrorSummary errors={shown} idPrefix="rc" labels={LABELS} />}
              <RequiredNote />
              {/* two equal columns, as the sides under them (symmetric: labels and controls share a row) */}
              <div className="grid items-start gap-4 md:grid-cols-2">
                <Field id={f.id("name")} label="Name" required error={f.error("name")}>
                  <Input {...f.text("name")} autoComplete="off" onChange={(e) => { f.set("name", e.target.value); if (!codeTyped) f.set("code", codeOf(e.target.value)); }} />
                </Field>
                <Field id={f.id("code")} label="Code" required note="Can't be changed later." error={f.error("code") ?? codeErr}>
                  <Input {...f.text("code")} className="font-mono" autoComplete="off" spellCheck={false}
                    onChange={(e) => { setCodeTyped(true); f.set("code", e.target.value); setCodeErr(undefined); }} />
                </Field>
              </div>
            </fieldset>
          </Panel>
          {/* the same step 1 as an existing recon's setup (sides-step.tsx) */}
          <SidesStep spec={spec} fields={fields} sources={[items.find((s) => s.id === f.values.a), items.find((s) => s.id === f.values.b)]}
            editable={editable} place={problem} picker={picker} onChange={change}
            onRemoved={(message, restore) => toast.undo(message, () => setSpec((cur) => restore(cur) ?? cur))} />
          {sources.error && <p role="alert" className="text-body-sm text-down-ink">Couldn&apos;t load this space&apos;s sources. {errorText(sources.error)}</p>}
          {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
          <FormFooter
            primary={<BlockedButton type="submit" reason={maker ? null : NEW_RECON_REASON} disabled={busy} aria-busy={busy || undefined}>
              {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Next: {SETUP_STEPS[2]}
            </BlockedButton>}
            cancel={<Button asChild variant="ghost"><Link href={reconsHref(spaceId)}>Cancel</Link></Button>} />
        </form>
      </Wizard>
      )}
    </div>
  );
}
