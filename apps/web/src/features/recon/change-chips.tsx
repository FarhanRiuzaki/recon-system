"use client";

import { useState } from "react";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, CloseIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { CHANGE_KINDS, changeOf, changeText } from "./changes-model";

/**
 * The changes a mapped value goes through, in order, as chips (owner 22 Nov: clear, not typed syntax): each in words
 * with a red X that removes it; Add a change picks a kind from the list and asks for its values, refused (with why)
 * when the engine wouldn't take them.
 */
export function ChangeChips({ value, onChange, label, disabled }: { value: readonly string[]; onChange: (v: string[]) => void; label: string; disabled?: boolean }) {
  const [adding, setAdding] = useState<{ kind: string; values: string[] } | null>(null);
  const kind = CHANGE_KINDS.find((k) => k.id === adding?.kind);
  const built = adding ? changeOf(adding.kind, adding.values) : null;
  return (
    <div className="grid gap-2" role="group" aria-label={label}>
      {value.length > 0 ? (
        <ol className="flex flex-wrap gap-1.5">
          {value.map((t, i) => (
            <li key={`${t}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-card py-0.5 pr-0.5 pl-2.5 text-body-sm text-fg">
              <span className="text-caption text-fg-3 tabular">{i + 1}</span>{changeText(t)}
              {!disabled && (
                <Button type="button" variant="remove" size="icon-sm" className="size-6 rounded-full" aria-label={`Remove change ${i + 1}: ${changeText(t)}`}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon icon={CloseIcon} size={12} /></Button>
              )}
            </li>
          ))}
        </ol>
      ) : <span className="text-body-sm text-fg-3">Sent as it is.</span>}
      {!disabled && (adding ? (
        <div className="grid gap-2 rounded-md border border-line-strong bg-tray p-2.5">
          <Select aria-label={`${label}: kind of change`} value={adding.kind} className="h-8"
            onChange={(e) => setAdding({ kind: e.target.value, values: (CHANGE_KINDS.find((k) => k.id === e.target.value)?.values ?? []).map(() => "") })}>
            {CHANGE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </Select>
          {kind && kind.values.length > 0 && (
            <span className="grid grid-cols-2 gap-2">
              {kind.values.map((v, i) => (
                <Input key={v.name} aria-label={`${label}: ${v.name.toLowerCase()}`} placeholder={`${v.name}, e.g. ${v.placeholder}`} className="h-8 font-mono"
                  value={adding.values[i] ?? ""} onChange={(e) => setAdding({ ...adding, values: adding.values.map((x, j) => (j === i ? e.target.value : x)) })} />
              ))}
            </span>
          )}
          {!built && adding.values.some(Boolean) && <span className="text-caption text-down-ink">Not a value this change takes. Follow the example.</span>}
          <span className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(null)}>Cancel</Button>
            <Button variant="create-solid" type="button" size="sm" disabled={!built} onClick={() => { onChange([...value, built!]); setAdding(null); }}>Add change</Button>
          </span>
        </div>
      ) : (
        <Button type="button" variant="create" size="sm" className="justify-self-start" onClick={() => setAdding({ kind: "date", values: [""] })}>
          <Icon icon={AddIcon} />Add a change
        </Button>
      ))}
    </div>
  );
}
