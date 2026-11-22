"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { activeElement, Field, focusBack, useForm } from "@starterkit/ui/ds";
import { rules, type Schema } from "@starterkit/ui/lib/validate";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import type { SpaceDto } from "@starterkit/shared/contracts/spaces";
import { SPACE_CODE, SPACE_NAME_MAX } from "@starterkit/shared/spaces";
import { api, errorText } from "@/lib/client/api";
import { usePrefs } from "@/lib/client/prefs-context";
import { spaceHref, SPACES_KEY } from "./use-spaces";

type Values = { code: string; name: string };
// CreateSpaceBody's rules, as the API applies them (trimmed; the code in any case, stored lower case).
export const CREATE_SPACE_SCHEMA: Schema<Values> = {
  code: [rules.required("Enter a code."), (v) => (SPACE_CODE.test(String(v).trim().toLowerCase()) ? null : "Use 2 to 32 letters, digits or hyphens.")],
  name: [rules.required("Enter a name."), (v) => (String(v).trim().length > SPACE_NAME_MAX ? `Use ${SPACE_NAME_MAX} characters or fewer.` : null)],
};
/** The POST body: what CreateSpaceBody would make of the form's values. */
export const createSpaceBody = (v: Values) => ({ code: v.code.trim().toLowerCase(), name: v.name.trim() });

/** POST /api/spaces (space.manage), then opens the new space's members. Loaded on click (Radix dialog). */
export function CreateSpaceDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { update } = usePrefs();
  const f = useForm<Values>({ initial: { code: "", name: "" }, schema: CREATE_SPACE_SCHEMA, idPrefix: "space" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // No DialogTrigger, so Radix has nothing to return focus to: go back to what opened the dialog (the button, the switcher).
  const [opener] = useState(activeElement);

  const save = f.submit(async (v) => {
    setBusy(true);
    setError(null);
    try {
      const s = await api<SpaceDto>("/api/spaces", { method: "POST", body: JSON.stringify(createSpaceBody(v)) });
      toast(`Created ${s.name}.`);
      await qc.invalidateQueries({ queryKey: SPACES_KEY });
      update({ space: s.id });
      router.push(spaceHref(s.id, "members"));
      onClose(); // opened from the switcher, the dialog outlives the page it was opened on
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      requestAnimationFrame(() => document.getElementById(f.id("code"))?.focus()); // a taken code is the usual cause
    }
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top" onCloseAutoFocus={(e) => { e.preventDefault(); focusBack(opener); }}>
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle>Create space</DialogTitle>
            <DialogDescription>A space holds one team&apos;s work. Add its first space admin on the members page next.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <fieldset disabled={busy} className="grid min-w-0 gap-4">
            <Field id={f.id("code")} label="Code" required note="2 to 32 letters, digits or hyphens. Unique, ignoring letter case." error={f.error("code")}>
              <Input {...f.text("code")} autoComplete="off" autoFocus className="font-mono" />
            </Field>
            <Field id={f.id("name")} label="Name" required error={f.error("name")}>
              <Input {...f.text("name")} autoComplete="off" />
            </Field>
            {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
          </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Create space</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
