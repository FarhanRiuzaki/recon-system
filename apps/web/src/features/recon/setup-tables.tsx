"use client";

import { useState } from "react";
import { Field, Panel } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { ReconApprovalSpec } from "@starterkit/shared/contracts/recon";

// The recon's accounts and lookup tables (stage 4, O2: accounts come from the recon setup): what an action's mapping
// names — {accounts.suspense.number} in a template, an account as a source, a lookup of merchant → account.

type Accounts = ReconApprovalSpec["accounts"];
type Lookups = ReconApprovalSpec["lookups"];
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/** "key,value" lines ↔ rows; a line without a comma is a key with an empty value. */
export const rowsOf = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
  const at = l.indexOf(",");
  return at < 0 ? { key: l, value: "" } : { key: l.slice(0, at).trim(), value: l.slice(at + 1).trim() };
}).slice(0, 500);

function LookupEditor({ l, onChange, onRemove, disabled }: { l: Lookups[number]; onChange: (l: Lookups[number]) => void; onRemove: () => void; disabled: boolean }) {
  const [text, setText] = useState(l.rows.map((r) => `${r.key},${r.value}`).join("\n"));
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-card p-card">
      <span className="flex items-center gap-2">
        <Input aria-label="Lookup name" value={l.name} disabled={disabled} className="h-8 font-mono md:w-64" onChange={(e) => onChange({ ...l, name: keyOf(e.target.value) })} />
        <span className="text-caption text-fg-3">{l.rows.length} rows</span>
        {!disabled && <Button type="button" variant="remove" size="icon-sm" aria-label={`Remove lookup ${l.name}`} className="ml-auto" onClick={onRemove}><Icon icon={RemoveIcon} /></Button>}
      </span>
      <Textarea aria-label={`${l.name}: rows, one key,value per line`} rows={4} value={text} disabled={disabled} className="font-mono" placeholder={"M0001,1234567890\nM0002,9876543210"}
        onChange={(e) => { setText(e.target.value); onChange({ ...l, rows: rowsOf(e.target.value) }); }} />
    </div>
  );
}

export function SetupTables({ accounts, lookups, onChange, disabled }: { accounts: Accounts; lookups: Lookups; onChange: (a: Accounts, l: Lookups) => void; disabled: boolean }) {
  const setAccount = (i: number, a: Accounts[number]) => onChange(accounts.map((x, j) => (j === i ? a : x)), lookups);
  return (
    <Panel title="Accounts and lookup tables" description="Named accounts and small tables the actions' fields can take values from">
      <div className="grid gap-section">
        <div className="grid gap-list">
          <span className="text-body font-medium text-fg">Accounts</span>
          {accounts.length === 0 && <span className="text-body-sm text-fg-3">No account yet. Add the ones the postings debit or credit, e.g. a suspense account.</span>}
          {accounts.map((a, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_5rem_2rem] items-end gap-2 max-md:grid-cols-2">
              <Field id={`acc-key-${i}`} label="Key"><Input id={`acc-key-${i}`} value={a.key} disabled={disabled} className="font-mono" onChange={(e) => setAccount(i, { ...a, key: keyOf(e.target.value) })} /></Field>
              <Field id={`acc-label-${i}`} label="Name"><Input id={`acc-label-${i}`} value={a.label} disabled={disabled} maxLength={80} onChange={(e) => setAccount(i, { ...a, label: e.target.value })} /></Field>
              <Field id={`acc-num-${i}`} label="Number"><Input id={`acc-num-${i}`} value={a.number} disabled={disabled} maxLength={40} className="font-mono" onChange={(e) => setAccount(i, { ...a, number: e.target.value })} /></Field>
              <Field id={`acc-ccy-${i}`} label="Currency"><Input id={`acc-ccy-${i}`} value={a.currency} disabled={disabled} maxLength={3} className="font-mono uppercase" onChange={(e) => setAccount(i, { ...a, currency: e.target.value.toUpperCase() })} /></Field>
              {!disabled ? <Button type="button" variant="remove" size="icon" aria-label={`Remove account ${a.label || a.key}`} onClick={() => onChange(accounts.filter((_, j) => j !== i), lookups)}><Icon icon={RemoveIcon} /></Button> : <span />}
            </div>
          ))}
          {!disabled && accounts.length < 50 && (
            <Button type="button" variant="create" size="sm" className="justify-self-start" onClick={() => onChange([...accounts, { key: `account_${accounts.length + 1}`, label: "", number: "", currency: "IDR" }], lookups)}><Icon icon={AddIcon} />Add an account</Button>
          )}
        </div>
        <div className="grid gap-list">
          <span className="text-body font-medium text-fg">Lookup tables</span>
          {lookups.length === 0 && <span className="text-body-sm text-fg-3">No lookup table yet. Add one to map a value to another, e.g. a merchant to its account.</span>}
          {lookups.map((l, i) => (
            <LookupEditor key={i} l={l} disabled={disabled} onChange={(n) => onChange(accounts, lookups.map((x, j) => (j === i ? n : x)))} onRemove={() => onChange(accounts, lookups.filter((_, j) => j !== i))} />
          ))}
          {!disabled && lookups.length < 20 && (
            <Button type="button" variant="create" size="sm" className="justify-self-start" onClick={() => onChange(accounts, [...lookups, { name: `lookup_${lookups.length + 1}`, rows: [] }])}><Icon icon={AddIcon} />Add a lookup table</Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
