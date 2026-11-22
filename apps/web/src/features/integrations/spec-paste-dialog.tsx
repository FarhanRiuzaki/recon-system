"use client";

import { useState } from "react";
import { Checkbox, Field, ScrollFade } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import { fieldPaths, operationsFromSpec } from "@starterkit/shared/integrations";
import { mergeSpecOperations } from "./connector-model";

// Paste a whole spec (DEC-053): the bank's document copied at once (PDF or Word); one operation per section with a
// Method line, its path, request and response fields and a suggested success rule; shown before anything is added.

export function SpecPasteDialog({ spec, onApply, onClose }: { spec: ConnectorSpec; onApply: (next: ConnectorSpec, note: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [read, setRead] = useState<ReturnType<typeof operationsFromSpec> | null>(null);
  const [fill, setFill] = useState(true);
  const keys = new Set(spec.operations.map((o) => o.key));
  const canFill = !!read?.baseUrl && !spec.environments.dev.baseUrl;
  function apply() {
    if (!read) return;
    const r = mergeSpecOperations(spec, read, canFill && fill);
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.skipped && `${r.skipped} left out (a connector has at most 50)`].filter(Boolean);
    onApply(r.spec, `Operations from the spec: ${parts.join(", ")}.`);
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Paste a whole spec</DialogTitle>
          <DialogDescription>Copy the bank&apos;s spec (PDF or Word) and paste it here. Each section with a Method line becomes an operation, with its path and fields.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-4">
        {!read || !read.operations.length ? (
          <Field id="spec-text" label="The spec" error={read && !read.operations.length ? "No operations were found. Paste the sections with their Method, Path, Request and Response." : null}>
            <Textarea id="spec-text" rows={12} className="font-mono" value={text} onChange={(e) => { setText(e.target.value); setRead(null); }}
              placeholder={"1. Account Search\nMethod   POST\nPath     https://openapi.bank.local:15000/openapi/v1.0/…\nRequest\nField   Type   Data Type   Length   Description\n…"} />
          </Field>
        ) : (
          <div className="grid gap-3">
            <span className="text-body-sm text-fg">{read.operations.length} {read.operations.length === 1 ? "operation" : "operations"} found</span>
            <ScrollFade className="rounded-lg border border-line" style={{ height: `${Math.min(20, read.operations.length * 4.75)}rem` }} tabIndex={0} aria-label="Operations found">
              <ul className="grid divide-y divide-line">
                {read.operations.map((o) => (
                  <li key={o.key} className="grid gap-0.5 px-3 py-2 motion-safe:animate-enter">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-body-sm text-fg">{o.name}</span>
                      <span className="text-caption text-fg-3">{keys.has(o.key) ? "Updates the operation with this key" : "New"}</span>
                    </span>
                    <span className="font-mono text-caption text-fg-2">{o.method} {o.path}</span>
                    <span className="text-caption text-fg-3">
                      {fieldPaths(o.request).length} request fields{Object.keys(o.auto).length ? ` (${Object.keys(o.auto).length} auto generated)` : ""} · {fieldPaths(o.response).length} response fields{o.success ? ` · success when ${o.success.field} is ${o.success.equals} (suggested)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollFade>
            {canFill && (
              <span className="flex items-center gap-2">
                <Checkbox id="spec-fill" label={`Set the development address to ${read.baseUrl}`} checked={fill} onToggle={() => setFill(!fill)} />
                <label htmlFor="spec-fill" className="text-body-sm text-fg">Set the development address to <span className="font-mono">{read.baseUrl}</span></label>
              </span>
            )}
          </div>
        )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={read?.operations.length ? () => setRead(null) : onClose}>{read?.operations.length ? "Back" : "Cancel"}</Button>
          {read?.operations.length
            ? <Button type="button" onClick={apply}>Add {read.operations.length} {read.operations.length === 1 ? "operation" : "operations"}</Button>
            : <Button type="button" onClick={() => setRead(operationsFromSpec(text))} disabled={!text.trim()}>Read operations</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
