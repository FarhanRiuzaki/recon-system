"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field, useForm } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import type { SpaceDto } from "@starterkit/shared/contracts/spaces";
import { returnToMore } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { renameBody, SPACE_SETTINGS_SCHEMA } from "./space-settings";
import { SPACES_KEY } from "./use-spaces";

/** Space settings: the space's name (PATCH /api/spaces/:spaceId). Its code stays as created. Loaded on click. */
export function SpaceSettingsDialog({ space, onClose }: { space: Pick<SpaceDto, "id" | "code" | "name">; onClose: () => void }) {
  const qc = useQueryClient();
  const f = useForm<{ name: string }>({ initial: { name: space.name }, schema: SPACE_SETTINGS_SCHEMA, idPrefix: "space-settings" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = f.submit(async (v) => {
    const body = renameBody(v, space);
    if (!body) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      const s = await api<SpaceDto>(`/api/spaces/${encodeURIComponent(space.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      toast(`Renamed the space to ${s.name}.`);
      await qc.invalidateQueries({ queryKey: SPACES_KEY });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top" onCloseAutoFocus={returnToMore}>
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle>Space settings</DialogTitle>
            <DialogDescription>The name shows in the space switcher and on every page of the space.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <fieldset disabled={busy} className="grid min-w-0 gap-4">
              <Field id="space-settings-code" label="Code" note="Set when the space was created.">
                <Input id="space-settings-code" value={space.code} readOnly className="font-mono" />
              </Field>
              <Field id={f.id("name")} label="Name" required error={f.error("name")}>
                <Input {...f.text("name")} autoComplete="off" autoFocus />
              </Field>
              {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Rename space</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
