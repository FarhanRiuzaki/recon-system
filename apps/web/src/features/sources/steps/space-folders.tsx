"use client";

import { Field } from "@starterkit/ui/ds";
import { Select } from "@starterkit/ui/ui/select";
import type { InboxFolderListDto } from "@starterkit/shared/contracts/inbox";

type Folders = { root: string; folders: readonly Pick<InboxFolderListDto["folders"][number], "name">[] };

/**
 * The File inbox step's "Space folder" (Inbox files): the space's inbox folders to pick from, filling Folder with the
 * folder's absolute path; Folder stays editable (a folder IT set up by hand). Absent while the space has no folder,
 * the inbox isn't set up or the list failed.
 */
export function SpaceFolders({ list, path, onPick }: { list: Folders | undefined; path: string; onPick: (path: string) => void }) {
  if (!list?.folders.length) return null;
  const pathOf = (name: string) => `${list.root.replace(/\/+$/, "")}/${name}`;
  const current = list.folders.find((f) => pathOf(f.name) === path.trim().replace(/\/+$/, ""))?.name ?? "";
  return (
    <Field id="src-space-folder" label="Space folder" note="A folder of this space's Inbox files. Files uploaded there are read by this source.">
      <Select id="src-space-folder" aria-label="Space folder" value={current} onChange={(e) => { if (e.target.value) onPick(pathOf(e.target.value)); }}>
        <option value="">Choose a folder</option>
        {list.folders.map((f) => <option key={f.name} value={f.name}>{f.name}/</option>)}
      </Select>
    </Field>
  );
}
