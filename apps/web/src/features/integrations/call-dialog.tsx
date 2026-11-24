"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CategoryChip, CopyValue, Failure, Notice, ScrollFade, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { copyText } from "@starterkit/ui/lib/clipboard";
import { formatDateTime, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { CopyIcon, ShowIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ConnectorCallDto, ConnectorCallFullDto } from "@starterkit/shared/contracts/integrations";
import { ENVIRONMENT_LABEL } from "@starterkit/shared/integrations";
import { api, errorText, retryUnlessNotFound } from "@/lib/client/api";
import { categoryChip } from "@/lib/shared/categories";
import { connectorCall } from "@/lib/shared/queries";
import { callBy, callChip, callName, originKey, originLabel } from "./call-model";

const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** One part of a call as text, with its copy button; nothing when it has no content. */
function Part({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === "") return null;
  const text = pretty(value);
  async function copy() {
    if (await copyText(text)) toast(`Copied the ${label.toLowerCase()}.`);
    else toast.error("Couldn't copy to the clipboard. Select the text and copy it manually.");
  }
  return (
    <section className="grid gap-1.5" aria-label={label}>
      <span className="flex items-center justify-between gap-2">
        <span className="text-label text-fg">{label}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}><Icon icon={CopyIcon} />Copy</Button>
      </span>
      <ScrollFade className="max-h-72 rounded-lg border border-line bg-tray" tabIndex={0} aria-label={label}>
        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-caption text-fg">{text}</pre>
      </ScrollFade>
    </section>
  );
}

/**
 * One logged call (Open API call log): its facts and its request and response as the connector masks them; an
 * integration.debug holder shows the full request and response (each reveal is in the activity log).
 */
export function CallDialog({ id, canDebug, onClose }: { id: string; canDebug: boolean; onClose: () => void }) {
  const d = connectorCall(id);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<ConnectorCallDto>(d.url), retry: retryUnlessNotFound });
  const [full, setFull] = useState<ConnectorCallFullDto | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const c = q.data;
  const skeleton = useDelayedFlag(!c && !q.error);
  async function reveal() {
    setRevealing(true); setRevealError(null);
    try {
      setFull(await api<ConnectorCallFullDto>(`/api/integrations/calls/${encodeURIComponent(id)}/reveal`, { method: "POST" }));
      toast("Showing the full request and response.", { description: "This view is recorded in the activity log." });
    } catch (e) { setRevealError(errorText(e)); }
    finally { setRevealing(false); }
  }
  const chip = c ? callChip(c.outcome) : null;
  const by = c ? callBy(c) : null;
  const facts: [string, ReactNode][] = c ? [
    ["Connector", `${c.connector.name}${c.version !== null ? ` · version ${c.version}` : ""}`],
    ["Environment", <CategoryChip key="env" label={ENVIRONMENT_LABEL[c.environment]} slot={categoryChip("environment", c.environment)} />],
    ["Request", <span key="req" className="font-mono">{c.method} {c.host}{c.path}</span>],
    ["Started", formatDateTime(Date.parse(c.startedAt))],
    ["Duration", `${formatNumber(c.durationMs)} ms`],
    ["HTTP status", c.httpStatus ?? "—"],
    ["Bank code", c.code ?? "—"],
    ["External ID", c.externalId ? <CopyValue key="ext" value={c.externalId} label="external ID" /> : "—"],
    ["Attempt", formatNumber(c.attempt)],
    ["From", c.origin.href ? <Link key="from" href={c.origin.href} className="font-medium text-fg hover:underline">{c.origin.label}</Link> : c.origin.label],
    ["Kind", originLabel(originKey(c.origin))],
    ["By", `${by!.name}${by!.note ? ` ${by!.note}` : ""}`],
  ] : [];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{c ? callName(c) : "Call"}</DialogTitle>
          <DialogDescription>{c ? c.message ?? "" : "The request this app sent and what the bank answered."}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {q.error && !c ? <Failure title="Couldn't load the call" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} />
            : !c ? <div className="grid gap-3" aria-busy={skeleton || undefined}>{skeleton && <><Skeleton className="h-24" /><Skeleton className="h-40" /></>}</div>
            : (
              <div className="grid gap-section">
                {chip && <StatusChip health={chip.health} label={chip.label} />}
                <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                  {facts.map(([k, v]) => <div key={k} className="grid gap-0.5"><dt className="text-caption text-fg-3">{k}</dt><dd className="min-w-0 text-body-sm text-fg">{v}</dd></div>)}
                </dl>
                {full ? (
                  <div className="grid gap-4">
                    <Part label="Request headers" value={full.request.headers} />
                    <Part label="Request body (JSON)" value={full.request.json} />
                    <Part label="Request body as sent (encrypted)" value={full.request.body} />
                    {full.response ? <>
                      <Part label="Response headers" value={full.response.headers} />
                      <Part label="Response body (decrypted)" value={full.response.json} />
                      <Part label="Response body as received" value={full.response.raw} />
                    </> : <Notice>No answer came back for this call.</Notice>}
                  </div>
                ) : (
                  <div className="grid gap-4">
                    <Part label="Request (masked)" value={c.request} />
                    {c.response !== null ? <Part label="Response (masked)" value={c.response} /> : <Notice>No answer came back for this call.</Notice>}
                  </div>
                )}
                {revealError && <p role="alert" className="text-body-sm text-down-ink">{revealError}</p>}
              </div>
            )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          {canDebug && c && !full && (c.full
            ? <Button type="button" variant="secondary" onClick={() => void reveal()} disabled={revealing} aria-busy={revealing || undefined}>
                <Icon icon={revealing ? SpinnerIcon : ShowIcon} className={revealing ? "motion-safe:animate-spin" : undefined} />Show full request and response
              </Button>
            : <span className="text-caption text-fg-3">The full request and response are no longer kept for this call.</span>)}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
