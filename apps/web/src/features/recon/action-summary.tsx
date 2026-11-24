"use client";

import { CategoryChip, StatusChip } from "@starterkit/ui/ds";
import type { CatalogField } from "@starterkit/shared/conditions";
import type { ActionSpec } from "@starterkit/shared/contracts/recon";
import { CHANGED } from "./approval-model";
import { actionSentence, type Ops, variantFacts, ZERO_OR_NEGATIVE } from "./actions-model";

type Setup = { accounts: readonly { key: string; label: string }[] };

/** One row of a variant: the question on the left (one width in every variant), the answer on the right. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="min-w-0 text-body-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * An approval action as a checker reads it (maker-checker: every setting before approving), the one summary of an
 * action wherever it is shown (the Approval step's card, the version review, the live version beside it): when it
 * runs, then per variant its condition, where it sends (connector, version, operation), how it sends (per item, per
 * request, grouped with its key and cutoff), an amount of 0 or below, and its mapping, masked fields marked.
 * `changed` = the variants that differ from the live version; `ops` undefined while the connectors load.
 */
export function ActionSummary({ action, ops, catalog, setup, changed }: { action: ActionSpec; ops: Ops | undefined; catalog: readonly CatalogField[]; setup: Setup; changed?: ReadonlySet<number> }) {
  return (
    <div className="grid min-w-0 gap-2">
      <span className="text-body-sm text-fg">
        {actionSentence(action)}
        <span className="text-fg-3"> · {action.kind === "posting" ? "marks the item's posting result" : "shows on the item's timeline only"}</span>
      </span>
      <ol className="grid gap-2">
        {action.variants.map((v, i) => {
          const f = variantFacts(v, ops ?? [], catalog, setup);
          return (
            <li key={i} className="grid gap-1.5 border-l-2 border-line pl-3">
              <span className="flex flex-wrap items-center gap-2 text-label text-fg">
                <span className="text-caption text-fg-3 tabular">Variant {i + 1}</span>{f.name}
                {changed?.has(i) && <StatusChip {...CHANGED} />}
              </span>
              <dl className="grid gap-1">
                <Row label="Used for">{f.when}</Row>
                <Row label="Sends to">{ops ? f.sends : "Loading the connectors…"}</Row>
                <Row label="Send">{f.per}</Row>
                <Row label={ZERO_OR_NEGATIVE.label}>{f.zero}</Row>
                <Row label="Fields it fills">
                  {f.mapping.length ? (
                    <ul className="grid gap-1">
                      {f.mapping.map((m) => (
                        <li key={m.field} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-fg">{m.field}</span>
                          <span className="text-fg-3">←</span>
                          <span className="min-w-0 text-fg-2">{m.from}</span>
                          {m.masked && <CategoryChip slot="neutral" label="Masked" />}
                        </li>
                      ))}
                    </ul>
                  ) : <span className="text-fg-3">None mapped</span>}
                </Row>
              </dl>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
