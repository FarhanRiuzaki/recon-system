"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Field, Notice, Panel, Timeline } from "@starterkit/ui/ds";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { BindingSpec, PreviewDto } from "@starterkit/shared/contracts/workflows";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import type { Trigger } from "@starterkit/shared/workflows";
import { needWords, People } from "@/components/request-chain";
import { api, errorText } from "@/lib/client/api";
import { APPROVALS_KEY } from "@/lib/shared/queries";

const useDebounced = <T,>(v: T, ms: number) => {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
};

/**
 * "Who approves" (DEC-052, after Oracle AME's test workbench): sample attributes of a request, the rule and workflow
 * the rules on screen (`spec`; null = the live ones) would give it, and the people who could approve each group today;
 * a group with too few people warns.
 */
export function WhoApproves({ spaceId, trigger, spec, recons }: { spaceId: string; trigger: Trigger; spec: BindingSpec | null; recons: { id: string; name: string }[] }) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("IDR");
  const [recon, setRecon] = useState("");
  const [age, setAge] = useState("");
  const e = CURRENCY_EXPONENT[currency] ?? 2;
  const minor = /^\d{1,15}(\.\d+)?$/.test(amount.replace(/[\s,]/g, "")) ? (() => { const [i, f = ""] = amount.replace(/[\s,]/g, "").split("."); return f.length <= e ? String(BigInt(i! + f.padEnd(e, "0"))) : undefined; })() : undefined;
  const body = useDebounced(JSON.stringify({ ...(spec ? { spec } : {}), attributes: { ...(minor ? { amount: minor } : {}), currency, ...(recon ? { recon } : {}), ...(/^\d{1,5}$/.test(age) ? { ageDays: Number(age) } : {}) } }), 350);
  const q = useQuery({
    queryKey: [...APPROVALS_KEY, "rules-preview", spaceId, trigger, body],
    queryFn: () => api<PreviewDto>(`/api/spaces/${encodeURIComponent(spaceId)}/approval-rules/${trigger}/preview`, { method: "POST", body }),
    placeholderData: (prev) => prev,
  });
  const p = q.data;
  return (
    <Panel title="Who approves" description="Try a request and see the chain it takes today">
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field id="wa-amount" label="Amount"><Input id="wa-amount" inputMode="decimal" placeholder="1,500,000" value={amount} onChange={(ev) => setAmount(ev.target.value)} /></Field>
          <Field id="wa-ccy" label="Currency">
            <Select id="wa-ccy" className="w-full" value={currency} onChange={(ev) => setCurrency(ev.target.value)}>
              {Object.keys(CURRENCY_EXPONENT).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field id="wa-recon" label="Recon">
            <Select id="wa-recon" className="w-full" value={recon} onChange={(ev) => setRecon(ev.target.value)}>
              <option value="">Any recon</option>
              {recons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
          <Field id="wa-age" label="Age in days"><Input id="wa-age" inputMode="numeric" placeholder="0" value={age} onChange={(ev) => setAge(ev.target.value)} /></Field>
        </div>
        {q.error && <Notice tone="warn">Couldn&apos;t work out the chain. {errorText(q.error)}</Notice>}
        {p && (
          <div className="grid gap-3" aria-live="polite">
            <p className="text-body-sm text-fg-2">
              {p.rule.index === null ? "No rule matches" : <>Rule {p.rule.index + 1} · <span className="text-fg">{p.rule.name}</span></>}
              {" → "}<span className="text-fg">{p.workflow?.name ?? "Default chain"}</span>
            </p>
            <Timeline label="The chain it takes" items={p.levels.map((l, i) => ({
              id: String(i), title: l.name ? `Level ${i + 1} · ${l.name}` : `Level ${i + 1}`, status: "upcoming" as const,
              actor: (
                <span className="grid gap-2 pt-1">
                  {l.groups.map((g, gi) => (
                    <span key={gi} className="grid gap-1">
                      {gi > 0 && <span className="text-caption text-fg-3">and</span>}
                      <span className="text-caption text-fg-3">{needWords(g.need)}</span>
                      <People people={g.approvers} />
                    </span>
                  ))}
                </span>
              ),
              note: l.groups.some((g) => g.short) ? "Not enough people can approve this level. Requests that reach it are refused until it has." : undefined,
            }))} />
          </div>
        )}
      </div>
    </Panel>
  );
}
