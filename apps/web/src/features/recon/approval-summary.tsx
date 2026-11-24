"use client";

import { useQuery } from "@tanstack/react-query";
import { ScrollFade, StatusChip } from "@starterkit/ui/ds";
import type { ConnectorOperationsDto } from "@starterkit/shared/contracts/integrations";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { Page } from "@starterkit/shared/contracts/common";
import type { LibraryRowDto } from "@starterkit/shared/contracts/workflows";
import { type CatalogField, type Condition, conditionText } from "@starterkit/shared/conditions";
import { DEFAULT_CHAIN_NAME, DEFAULT_CHAIN_TEXT, TRIGGER_LABEL, TRIGGERS } from "@starterkit/shared/workflows";
import { statusChip } from "@/lib/shared/categories";
import { api } from "@/lib/client/api";
import { connectorOperationsQuery, workflowOptions } from "@/lib/shared/queries-recon";
import { approvalChanges, CHANGED, changeIsSet } from "./approval-model";
import { changedVariants } from "./actions-model";
import { ActionSummary } from "./action-summary";

// The version review's Approval part (loaded after the page, bundle budget DEC-040): who approves each change, what is
// sent to the bank, and the accounts and lookup tables the actions read; on a review, each part the version changes is
// marked and shows the live version's beside it (maker-checker: a checker sees every setting before approving).

const SET = statusChip("set", "Set"), NOT_SET = statusChip("nothing", DEFAULT_CHAIN_NAME);
type Approvals = ReconSpec["approvals"];

/** "Live version:" and what it was, under a part that changed. */
const Was = ({ children }: { children: React.ReactNode }) => (
  <div className="grid gap-1 border-l-2 border-line pl-3 text-caption text-fg-3"><span>Live version:</span>{children}</div>
);

function Accounts({ list }: { list: NonNullable<Approvals>["accounts"] }) {
  if (!list.length) return <span className="text-body-sm text-fg-3">None</span>;
  return (
    <ul className="grid gap-1 text-body-sm">
      {list.map((a) => (
        <li key={a.key} className="grid gap-x-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <span className="text-fg">{a.label || a.key}</span>
          <span className="text-fg-2 tabular">{a.number || "No number yet"}{a.currency ? ` · ${a.currency}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function Lookups({ list }: { list: NonNullable<Approvals>["lookups"] }) {
  if (!list.length) return <span className="text-body-sm text-fg-3">None</span>;
  return (
    <ul className="grid gap-3">
      {list.map((t) => (
        <li key={t.name} className="grid gap-1">
          <span className="text-body-sm text-fg">{t.name} <span className="text-fg-3">· {t.rows.length} {t.rows.length === 1 ? "row" : "rows"}</span></span>
          {t.rows.length > 0 && (
            <ScrollFade className="max-h-48 rounded-md border border-line bg-card" tabIndex={0} aria-label={`Rows of ${t.name}`}>
              <ul className="grid gap-0.5 p-2 text-body-sm">
                {t.rows.map((r, i) => <li key={i} className="grid gap-x-3 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><span className="truncate text-fg">{r.key}</span><span className="truncate text-fg-2">{r.value}</span></li>)}
              </ul>
            </ScrollFade>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The approval setup as sentences: per change, its rules in order, who approves every other request, its actions; then the accounts and lookup tables. */
export function ApprovalSummary({ spaceId, approvals, catalog, live }: { spaceId: string; approvals: Approvals; catalog: readonly CatalogField[]; live?: ReconSpec }) {
  const q = workflowOptions(spaceId);
  const wf = useQuery({ queryKey: q.key, queryFn: () => api<Page<LibraryRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows?pageSize=100&sort=name`), enabled: !!approvals || !!live?.approvals });
  const hasActions = (a: Approvals) => !!a && Object.values(a.changes).some((c) => c?.actions.length);
  const oq = connectorOperationsQuery(spaceId);
  const ops = useQuery({ queryKey: oq.key, queryFn: () => api<ConnectorOperationsDto>(oq.url), enabled: hasActions(approvals) || hasActions(live?.approvals) });
  const changed = approvalChanges(live?.approvals, approvals, !!live);
  const name = (id: string) => wf.data?.items.find((r) => r.id === id)?.name ?? "a workflow";
  const pin = (w: { id: string; version: number } | null) => (w ? `${name(w.id)} (version ${w.version})` : DEFAULT_CHAIN_TEXT);
  const setupOf = (a: Approvals) => ({ accounts: a?.accounts ?? [] });
  const actions = (a: Approvals, k: (typeof TRIGGERS)[number], mark: boolean) => {
    const list = a?.changes[k]?.actions ?? [];
    return list.length > 0 && (
      <span className="grid gap-2">
        <span className="text-fg-2">Sends to the bank:</span>
        {list.map((x, i) => (
          <ActionSummary key={i} action={x} ops={ops.data?.items} catalog={catalog} setup={setupOf(a)}
            changed={mark ? changedVariants(live?.approvals?.changes[k]?.actions, x, !!live) : undefined} />
        ))}
      </span>
    );
  };
  return (
    <ul className="grid gap-4">
      {TRIGGERS.map((k) => {
        const lines = (w: NonNullable<Approvals>["changes"][typeof k] | undefined) => (
          <>
            {w?.workflow.rules.map((r, i) => <span key={i}>{r.name}: when {conditionText(r.when as Condition, catalog)} → {pin(r.workflow)}</span>)}
            <span>{w?.workflow.rules.length ? "Every other request" : "Every request"} → {pin(w?.workflow.default ?? null)}</span>
          </>
        );
        const diff = changed.includes(k);
        return (
          <li key={k} className="grid gap-1 text-body-sm">
            <span className="flex flex-wrap items-center gap-2 text-label text-fg">
              {TRIGGER_LABEL[k]}
              <StatusChip {...(changeIsSet(approvals?.changes[k]) ? SET : NOT_SET)} />
              {diff && <StatusChip {...CHANGED} />}
            </span>
            <span className="grid gap-1 text-fg-2">{lines(approvals?.changes[k])}</span>
            {actions(approvals, k, true)}
            {diff && <Was>{lines(live?.approvals?.changes[k])}{actions(live?.approvals, k, false) || <span>Sends nothing to the bank</span>}</Was>}
          </li>
        );
      })}
      <li className="grid gap-1 border-t border-line pt-4">
        <span className="flex flex-wrap items-center gap-2 text-label text-fg">Accounts{changed.includes("accounts") && <StatusChip {...CHANGED} />}</span>
        <Accounts list={approvals?.accounts ?? []} />
        {changed.includes("accounts") && <Was><Accounts list={live?.approvals?.accounts ?? []} /></Was>}
      </li>
      <li className="grid gap-1">
        <span className="flex flex-wrap items-center gap-2 text-label text-fg">Lookup tables{changed.includes("lookups") && <StatusChip {...CHANGED} />}</span>
        <Lookups list={approvals?.lookups ?? []} />
        {changed.includes("lookups") && <Was><Lookups list={live?.approvals?.lookups ?? []} /></Was>}
      </li>
    </ul>
  );
}
