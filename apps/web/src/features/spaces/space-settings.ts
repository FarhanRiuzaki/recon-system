// Space settings (PATCH /api/spaces/:spaceId, a space admin of the space or space.manage): the rename form's rule and
// body, the archive confirmation and the space page's ⋯ actions. No React: the dialog loads on click.
import { rules, type Rule, type Schema } from "@starterkit/ui/lib/validate";
import type { SpaceDto } from "@starterkit/shared/contracts/spaces";
import { SPACE_NAME_MAX } from "@starterkit/shared/spaces";
import type { HeaderAction, HeaderConfirm } from "@/components/shell/page-header";

/** A space's name as CreateSpaceBody and UpdateSpaceBody take it: not only spaces, at most SPACE_NAME_MAX after trimming. */
export const SPACE_NAME_RULES: Rule[] = [rules.required("Enter a name."), (v) => (String(v).trim().length > SPACE_NAME_MAX ? `Use ${SPACE_NAME_MAX} characters or fewer.` : null)];

type Values = { name: string };
export const SPACE_SETTINGS_SCHEMA: Schema<Values> = { name: SPACE_NAME_RULES };
/** The PATCH body of a rename: the trimmed name, or null when it is the space's name already (nothing to send). */
export const renameBody = (v: Values, s: Pick<SpaceDto, "name">) => (v.name.trim() === s.name ? null : { name: v.name.trim() });

/** What archiving says before it runs: the guard refuses every change to the space's work, reads and management go on. */
export const archiveConfirm = (s: Pick<SpaceDto, "name">, onConfirm: () => Promise<void>): HeaderConfirm => ({
  title: `Archive ${s.name}`, description: "The space stays listed as archived. A space admin or an app admin can unarchive it.", actionLabel: "Archive space",
  impact: [`Changes to the work in ${s.name} are refused until it is unarchived.`, "Every record stays and can be read; members and roles can still be managed."],
  onConfirm,
});

/** The space page's ⋯ actions for someone the API lets change the space (`manage`); none for anyone else. */
export function spaceMore(s: Pick<SpaceDto, "name" | "status">, manage: boolean, run: { settings: () => void; archive: () => Promise<void>; unarchive: () => void }): HeaderAction[] {
  if (!manage) return [];
  return [
    { label: "Space settings", onSelect: run.settings },
    s.status === "active" ? { label: "Archive space", destructive: true, confirm: archiveConfirm(s, run.archive) } : { label: "Unarchive space", onSelect: run.unarchive },
  ];
}
