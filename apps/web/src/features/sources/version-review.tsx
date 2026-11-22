"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { BlockedButton, Failure, Field, Notice, Panel, StatusChip } from "@starterkit/ui/ds";
import { VersionDecision, VersionLayout } from "@/components/version-layout";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { SourcePreviewDto, SourceVersionDetailDto } from "@starterkit/shared/contracts/sources";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { APPROVALS_FROM, approvalsHref } from "@/lib/shared/nav";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { useAuth } from "@/lib/client/auth-context";
import { api, errorText, isNotFound } from "@/lib/client/api";
import { APPROVALS_KEY, SOURCES_KEY } from "@/lib/shared/queries";
import { versionChip } from "@/lib/shared/source-status";
import { VERSION_SHAPE } from "./shapes";
import { at } from "./source-text";
import { changes, reviewReason, sampleHead, specDiff } from "./spec-draft";
import { PreviewResult } from "./steps/fields";
import type { Preview } from "./steps/model";
import { EDIT_REASON, newVersionHref, sourceApi, sourceHref, sourcesHref, useSource, useSpaceRoles, useVersion } from "./use-sources";

const nameOf = (v: SourceVersionDetailDto, id: string | null) => (id ? (v.people.find((p) => p.id === id)?.name ?? "a removed user") : null);

/** One sentence under the title: who did what, and what applies meanwhile (Figma 98:9211). */
function lineOf(v: SourceVersionDetailDto, published: number | null): string {
  if (v.status === "in_review") {
    const by = nameOf(v, v.submitterId);
    const when = v.submittedAt ? at(v.submittedAt) : null;
    return [by ? `Submitted by ${by}${when ? `, ${when}` : ""}` : `Submitted${when ? ` ${when}` : ""}`, "waiting for a config checker",
      published ? `version ${published} stays published until this is approved` : "nothing is ingested until this is approved"].join(" · ");
  }
  // sent back (designer's copy, Figma 127:10092)
  if (v.status === "draft" && v.reviewComment) return ["Draft", `sent back by ${nameOf(v, v.checkerId) ?? "a config checker"}`, ...(published ? [`version ${published} stays published`] : [])].join(" · ");
  if (v.status === "published") return `Published${v.publishedAt ? ` ${at(v.publishedAt)}` : ""}${v.checkerId ? ` · approved by ${nameOf(v, v.checkerId)}` : ""} · in use`;
  if (v.status === "retired") return `Retired · replaced by a newer published version${v.checkerId ? ` · approved by ${nameOf(v, v.checkerId)}` : ""}`;
  return `Draft · last saved by ${nameOf(v, v.makerId) ?? "nobody yet"}, ${at(v.updatedAt)}`;
}

/**
 * A source version (Figma 98:9211 / 101:9840 for the checker, 98:9467 / 101:9992 for its maker): its changes against
 * the published version, field by field; a preview through it (not stored); and the decision. Approve and Reject are
 * BlockedButtons saying who may act (designer's final copy); the API's 409 self_approval / invalid_state shows beside
 * them. A decision answers with a toast and returns focus to the page heading.
 */
export function VersionReview({ spaceId, id, versionId }: { spaceId: string; id: string; versionId: string }) {
  const sq = useSource(spaceId, id);
  const vq = useVersion(spaceId, id, versionId);
  const roles = useSpaceRoles(spaceId);
  const { user } = useAuth();
  const qc = useQueryClient();
  const router = useRouter();
  // opened from the approvals inbox: back there once decided
  const fromInbox = useSearchParams().get("from") === APPROVALS_FROM;
  const skeleton = useDelayedFlag((!sq.data || !vq.data) && !sq.error && !vq.error);

  const list = { href: sourcesHref(spaceId), label: "Sources" };
  if (isNotFound(sq.error) || isNotFound(vq.error)) return <DetailNotFound title="Source version" noun="version" list={list} />;
  const failed = (sq.error && !sq.data) || (vq.error && !vq.data);
  if (failed) {
    return <div className="grid gap-section"><PageHeader title="Source version" />
      <Panel><Failure title="Couldn't load this version" error={sq.error ?? vq.error} source={BRAND.name} onRetry={() => { void sq.refetch(); void vq.refetch(); }} /></Panel></div>;
  }
  const s = sq.data, v = vq.data;
  if (!s || !v || skeleton) return <LoadingShape sections={VERSION_SHAPE} shown={skeleton} />;

  const checker = roles.includes("config_checker");
  const approveWhy = reviewReason(v, user.id, checker, "approve", isSuperadmin(user.roles));
  const rejectWhy = reviewReason(v, user.id, checker, "reject", isSuperadmin(user.roles));
  const published = s.published;
  // a published or retired version shows its own settings: comparing a retired one with the newer published one reads backwards
  const isPublished = published?.id === v.id || v.status === "retired";
  const rows = v.spec ? specDiff(isPublished ? null : (published?.spec ?? null), v.spec) : [];
  const sentBack = v.status === "draft" && !!v.reviewComment;
  const st = versionChip(v);
  const maker = roles.includes("source_admin") || roles.includes("config_maker");
  // the open draft opens in the wizard (a sent-back one included); a role that can't change sources gets the reason
  const edit = v.status === "draft" && s.draft?.id === v.id && (maker
    ? <Button asChild><Link href={newVersionHref(spaceId, id, roles.includes("source_admin") ? 1 : 2)}>Edit version {v.version}</Link></Button>
    : <BlockedButton reason={EDIT_REASON}>Edit version {v.version}</BlockedButton>);

  async function decide(act: "approve" | "reject", comment: string) {
    await api(sourceApi(spaceId, id, `/versions/${encodeURIComponent(versionId)}/${act}`), { method: "POST", body: JSON.stringify(act === "reject" ? { comment } : {}) });
    toast(act === "approve" ? `Version ${v!.version} of ${s!.name} approved. It is in use from the next run.` : `Version ${v!.version} of ${s!.name} sent back to its maker with your comment.`);
    await Promise.all([qc.invalidateQueries({ queryKey: SOURCES_KEY }), qc.invalidateQueries({ queryKey: APPROVALS_KEY })]);
    if (fromInbox) router.push(approvalsHref(spaceId));
  }

  const table = (
    <Panel flush title={isPublished || !published ? `Settings of version ${v.version}` : `Changes from version ${published.version}`}
      description={isPublished || !published ? "Every field, mapping and setting" : rows.length ? `${changes(rows.length)}; everything else is as in version ${published.version}` : "Nothing differs"}>
      {!v.spec ? <p className="px-4 py-6 text-body-sm text-fg-3">This draft has no fields and mapping yet.</p> : rows.length === 0
        ? <p className="px-4 py-6 text-body-sm text-fg-3">The spec is the same as version {published?.version}.</p> : (
          <div className="min-w-0">
            <Table aria-label="Changes">
              <TableHeader><TableRow>
                <TableHead>Field</TableHead>
                {!isPublished && published && <TableHead>Version {published.version} (published)</TableHead>}
                <TableHead>Version {v.version}</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    {/* a field or derived name is a machine value (mono); a setting's name is words */}
                    <TableCell className={/^(field|attrs|derive):/.test(r.key) ? "font-mono text-mono text-fg" : "text-fg"}>{r.label}</TableCell>
                    {!isPublished && published && <TableCell className="whitespace-normal wrap-anywhere text-fg-2 md:min-w-56">{r.before ?? <span className="text-fg-3">Not there</span>}</TableCell>}
                    <TableCell className="whitespace-normal wrap-anywhere text-fg md:min-w-56">{r.after ?? <span className="text-fg-3">Removed</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
    </Panel>
  );
  const comparing = !isPublished && !!published;

  return (
    <VersionLayout
      header={<PageHeader title={`${s.name} · version ${v.version}`} crumb={`Version ${v.version}`} status={<StatusChip health={st.health} label={st.label} description={st.description} />}
        description={lineOf(v, published && !isPublished ? published.version : null)} trail={[{ label: s.name, href: sourceHref(spaceId, id) }]} actions={edit || undefined} />}
      notice={sentBack && <Notice tone="warn">Sent back by {nameOf(v, v.checkerId) ?? "a config checker"}: {v.reviewComment}</Notice>}
      // a decision is for a version in review only (Figma 98:9211); anyone who may not decide sees why (98:9467)
      decision={v.status === "in_review" && (
        <VersionDecision id="src-review-comment" version={v.version} mine={[v.submitterId, v.makerId, ...v.contributorIds].includes(user.id)}
          approveWhy={approveWhy} rejectWhy={rejectWhy} onDecide={decide}
          effect={`Approving publishes version ${v.version}${comparing ? ` and retires version ${published.version}` : ""}. Pulls and files use it from the next run.`} />
      )}
      changes={comparing && table}
      settings={!comparing && table}
      preview={v.spec && <VersionPreview spaceId={spaceId} id={id} v={v} canPreview={roles.some((r) => r === "source_admin" || r === "config_maker" || r === "config_checker")} />} />
  );
}

/** A preview through this version's saved spec, on demand (a file source needs a sample; a database source pulls). */
function VersionPreview({ spaceId, id, v, canPreview }: { spaceId: string; id: string; v: SourceVersionDetailDto; canPreview: boolean }) {
  const file = v.spec!.input.kind === "file_inbox";
  const [sample, setSample] = useState("");
  const [fileName, setFileName] = useState("");
  const [businessDate, setBusinessDate] = useState("");
  const [p, setP] = useState<Preview>({ result: null, error: null, pending: false });
  async function run() {
    setP({ result: null, error: null, pending: true });
    try {
      const body = file ? { sample: sampleHead(sample).text, ...(fileName.trim() ? { fileName: fileName.trim() } : {}) } : (businessDate ? { businessDate } : {});
      const result = await api<SourcePreviewDto>(sourceApi(spaceId, id, `/versions/${encodeURIComponent(v.id)}/preview`), { method: "POST", body: JSON.stringify(body) });
      setP({ result, error: null, pending: false });
    } catch (e) {
      setP({ result: null, error: errorText(e), pending: false });
    }
  }
  if (!canPreview) {
    return <Panel title="Preview"><p className="text-body-sm text-fg-3">Source admins, config makers and config checkers of this space can preview a version.</p></Panel>;
  }
  return (
    <Panel title="Preview" description={`With version ${v.version} · not stored`} bodyClassName="grid gap-4">
      {file ? (
        <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field id="src-version-sample" label="Sample" note="Paste the first lines of a file. Up to 32 KB is read.">
            <Textarea id="src-version-sample" value={sample} rows={4} className="font-mono" spellCheck={false} onChange={(e) => setSample(e.target.value)} />
          </Field>
          <Field id="src-version-file" label="File name" note="Its date is the business date.">
            <Input id="src-version-file" value={fileName} className="font-mono" onChange={(e) => setFileName(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      ) : v.spec!.input.kind === "db_snapshot" && (
        <div className="max-w-xs">
          <Field id="src-version-date" label="Business date" note={`Today (${APP_TIME_ZONE_LABEL}) when empty.`}>
            <Input id="src-version-date" type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
          </Field>
        </div>
      )}
      <span>
        <Button type="button" variant="secondary" onClick={() => void run()} disabled={p.pending || (file && !sample.trim())} aria-busy={p.pending || undefined}>
          {p.pending && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Run the preview
        </Button>
      </span>
      <PreviewResult preview={{ ...p, pending: false }} file={file} />
    </Panel>
  );
}
