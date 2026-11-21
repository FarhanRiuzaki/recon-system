"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, Failure, Panel } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { DeniedIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { BRAND } from "@starterkit/shared/brand";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { isNotFound } from "@/lib/client/api";
import { Builder, type SaveState, type WizardStep } from "./builder";
import { useDraftEndings } from "./draft-actions";
import { at } from "./recon-text";
import { RECON_SETUP_SHAPE } from "./shapes";
import { reconHref, reconsHref, reconVersionHref, useRecon, useSpaceRoles, useStartVersion } from "./use-recons";

const asStep = (n: number | null): WizardStep | null => (n && n >= 1 && n <= 5 ? (n as WizardStep) : null);

/**
 * A recon's setup over its open draft (owner, 22 Nov: one flow, the user knows where to start): five steps as the
 * Sources wizard has them, the step in the URL, the draft saved as it changes. A new recon goes on from step 2; an
 * edit of a live recon opens on Review, every part shown with Edit.
 */
export function ReconSetup({ spaceId, id, step: urlStep }: { spaceId: string; id: string; step: number | null }) {
  const q = useRecon(spaceId, id);
  const roles = useSpaceRoles(spaceId);
  const start = useStartVersion(spaceId, id);
  const endings = useDraftEndings(spaceId, q.data, roles);
  const router = useRouter();
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const [save, setSave] = useState<SaveState | null>(null);
  const r = q.data;
  const first = asStep(urlStep) ?? (r?.published ? 5 : 1);
  const [step, setStep] = useState<WizardStep>(first);
  // the furthest step reached: a live recon's draft has every part already, so every step is open
  const [reached, setReached] = useState<WizardStep>(r?.published ? 5 : first);
  // the step lives in the URL without a server round trip (the canvas view keeps its own ?view=)
  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    if (next.get("step") === String(step)) return;
    next.set("step", String(step));
    window.history.replaceState(window.history.state, "", `?${next}`);
  }, [step]);
  const onStep = (n: WizardStep) => {
    setStep(n);
    setReached((x) => (n > x ? n : x));
    window.scrollTo({ top: 0 });
  };

  if (isNotFound(q.error)) return <DetailNotFound title="Recon" noun="recon" list={{ href: reconsHref(spaceId), label: "Recons" }} />;
  if (q.error && !r) return <div className="grid gap-section"><PageHeader title="Edit recon" /><Panel><Failure title="Couldn't load this recon" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!r || skeleton) return <LoadingShape sections={RECON_SETUP_SHAPE} shown={skeleton} />;

  const maker = roles.includes("config_maker");
  const title = r.published ? "Edit recon" : "New recon";
  const trail = [{ label: r.name, href: reconHref(spaceId, id) }];
  const back = <Button asChild variant="secondary"><Link href={reconHref(spaceId, id)}>Go to {r.name}</Link></Button>;

  if (r.draft?.status === "in_review") {
    return (
      <div className="grid gap-section">
        <PageHeader title={title} trail={trail} />
        <Panel><EmptyState icon={DeniedIcon} title={`Version ${r.draft.version} is in review`} description="A config checker approves or rejects it. It can't be changed meanwhile."
          action={<Button asChild variant="secondary"><Link href={reconVersionHref(spaceId, id, r.draft.id)}>Open version {r.draft.version}</Link></Button>} /></Panel>
      </div>
    );
  }
  if (!r.draft) {
    return (
      <div className="grid gap-section">
        <PageHeader title={title} trail={trail} />
        <Panel><EmptyState icon={DeniedIcon} title="No draft version yet"
          description={`Changes go into a new version made from version ${r.publishedVersion ?? 1}. A config checker approves it before it runs.`}
          action={maker ? (
            <Button type="button" onClick={() => start.mutate()} disabled={start.isPending} aria-busy={start.isPending || undefined}>
              {start.isPending && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Start version {(r.publishedVersion ?? 0) + 1}
            </Button>
          ) : back} /></Panel>
      </div>
    );
  }

  const status = save?.status ?? "saved";
  const saved = status === "saving" ? "Saving…" : status === "failed" || status === "incomplete" ? "Not saved" : `Saved ${at(r.draft.updatedAt)}`;
  const line = `Draft v${r.draft.version} · ${saved}${r.published ? ` · version ${r.published.version} keeps running until this one is approved` : ""}`;

  return (
    <div className="grid gap-section">
      <PageHeader title={title} description={line} trail={trail}
        actions={status === "failed" && save ? <Button type="button" variant="secondary" onClick={save.retry}>Retry</Button> : undefined}
        more={endings.length ? endings : undefined} />
      <Builder key={r.draft.id} spaceId={spaceId} recon={r} version={r.draft} editable={maker} canEdit={maker}
        step={step} reached={reached} onStep={onStep} exitHref={reconHref(spaceId, id)}
        onSubmitted={() => router.push(reconHref(spaceId, id))} onSaveState={setSave} />
    </div>
  );
}
