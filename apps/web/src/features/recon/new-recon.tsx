"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { BlockedButton, ErrorSummary, Field, FormFooter, Panel, RequiredNote, useForm } from "@starterkit/ui/ds";
import { rules, type Schema } from "@starterkit/ui/lib/validate";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { toast } from "@starterkit/ui/ui/toast";
import type { ReconDto } from "@starterkit/shared/contracts/recon";
import type { SourceDto, SourceRowDto } from "@starterkit/shared/contracts/sources";
import { RECON_CODE, RECON_NAME_MAX, recordFields } from "@starterkit/shared/recon";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { PageHeader } from "@/components/shell/page-header";
import { ApiError, api, errorText } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { RECON_KEY, sourceDetail } from "@/lib/shared/queries";
import { addPass, defaultSpec, type Fields, placeOf } from "./spec-model";
import { NEW_RECON_REASON, reconApi, reconConfigHref, reconsHref, useSourceOptions, useSpaceRoles } from "./use-recons";

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

/**
 * /spaces/[spaceId]/recons/new (README row Plan 3): a name, a code and the two sides' sources; the API makes the recon
 * and its Draft v1 (with pass 1 ready to edit) together on this first save, then the builder opens over it. A role other than config maker gets
 * the reason. With no published source in the space there is nothing to pick: one sentence and Create source instead.
 */
export function NewRecon({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const roles = useSpaceRoles(spaceId);
  const maker = roles.includes("config_maker");
  const sources = useSourceOptions(spaceId);
  const f = useForm<Values>({ initial: { name: "", code: "", a: "", b: "" }, schema: SCHEMA, idPrefix: "rc" });
  const [codeTyped, setCodeTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [apiErr, setApiErr] = useState<Partial<Record<keyof Values, string>>>({});
  const items = sources.data?.items ?? [];
  const dirty = Object.values(f.values).some(Boolean);
  const guard = useLeaveGuard(dirty && !busy);
  const shown = { ...f.shown, ...apiErr };

  const create = (event: FormEvent<HTMLFormElement>) => f.submit(async (v) => {
    if (saving.current) return;
    const a = items.find((s) => s.id === v.a), b = items.find((s) => s.id === v.b);
    if (!a || !b) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setApiErr({});
    try {
      // pass 1 starts with an "equals" for every core field both sources map (addPass): read their published fields first
      const [fa, fb] = await Promise.all([a, b].map(async (s) => {
        const { key, url } = sourceDetail(spaceId, s.id);
        const spec = (await qc.fetchQuery({ queryKey: key, queryFn: () => api<SourceDto>(url) })).published?.spec;
        return spec ? recordFields(spec) : null;
      }));
      const fields: Fields = [fa ?? null, fb ?? null];
      const spec = addPass(defaultSpec(a, b), fields);
      const r = await api<ReconDto>(reconApi(spaceId), { method: "POST", body: JSON.stringify({ name: v.name.trim(), code: v.code.trim(), spec }) });
      toast(`Created ${r.name} as Draft v1. Add its passes, then save the draft.`);
      await qc.invalidateQueries({ queryKey: RECON_KEY });
      router.push(reconConfigHref(spaceId, r.id)); // its draft: the builder
    } catch (err) {
      const text = errorText(err);
      const place = placeOf(text);
      const at: keyof Values | null = err instanceof ApiError && err.code === "duplicate" ? "code" : place.side === 0 ? "a" : place.side === 1 ? "b" : null;
      if (at) {
        setApiErr({ [at]: at === "code" ? text : place.text });
        requestAnimationFrame(() => document.getElementById(f.id(at))?.focus());
      } else setError(text);
      saving.current = false;
      setBusy(false);
    }
  })(event);

  const pick = (k: "a" | "b") => (
    <Field id={f.id(k)} label={k === "a" ? "Side A" : "Side B"} required error={f.error(k) ?? apiErr[k]}>
      <Select id={f.id(k)} value={f.values[k]} className="w-full" onChange={(e) => { f.set(k, e.target.value); setApiErr((x) => ({ ...x, [k]: undefined })); }}>
        <option value="">{sources.isPending ? "Loading sources…" : "Choose a source"}</option>
        {items.map((s) => <option key={s.id} value={s.id} disabled={s.publishedVersion === null}>{optionText(s)}</option>)}
      </Select>
    </Field>
  );

  return (
    <div className="grid gap-section">
      <PageHeader title="New recon" description="Name the recon and pick the source of each side. The passes and settings come next, in the draft." />
      {sources.data && !items.some((x) => x.publishedVersion !== null) ? (
        <Panel>
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <p className="text-body text-fg">No published source in {spaceName} yet.</p>
            {roles.includes("source_admin")
              ? <Button asChild><Link href={newSourceHref(spaceId)}>Create source</Link></Button>
              : <BlockedButton reason={NEW_SOURCE_REASON}>Create source</BlockedButton>}
          </div>
        </Panel>
      ) : (
      <Panel bodyClassName="md:p-6">
        <form noValidate onSubmit={create} aria-label="New recon" className="grid max-w-xl gap-4">
          {f.submitted && <ErrorSummary errors={shown} idPrefix="rc" labels={LABELS} />}
          <fieldset disabled={busy || !maker} className="contents">
            <RequiredNote />
            <Field id={f.id("name")} label="Name" required error={f.error("name")}>
              <Input {...f.text("name")} autoComplete="off" onChange={(e) => { f.set("name", e.target.value); if (!codeTyped) f.set("code", codeOf(e.target.value)); }} />
            </Field>
            <Field id={f.id("code")} label="Code" required note="Can't be changed later." error={f.error("code") ?? apiErr.code}>
              <Input {...f.text("code")} className="font-mono" autoComplete="off" spellCheck={false}
                onChange={(e) => { setCodeTyped(true); f.set("code", e.target.value); setApiErr((x) => ({ ...x, code: undefined })); }} />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">{pick("a")}{pick("b")}</div>
            {sources.error && <p role="alert" className="text-body-sm text-down-ink">Couldn&apos;t load this space&apos;s sources. {errorText(sources.error)}</p>}
            {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
          </fieldset>
          <FormFooter className="md:-mx-6 md:-mb-6 md:px-6"
            primary={<BlockedButton type="submit" reason={maker ? null : NEW_RECON_REASON} disabled={busy} aria-busy={busy || undefined}>
              {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Create recon
            </BlockedButton>}
            cancel={<Button asChild variant="ghost"><Link href={reconsHref(spaceId)}>Cancel</Link></Button>} />
        </form>
      </Panel>
      )}
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without saving"
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }} description="This recon isn't created yet."
          impact={["What you typed is discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </div>
  );
}
