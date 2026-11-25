"use client";

import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { FolderIcon } from "@starterkit/ui/ui/icons";
import type { InboxFolderListDto } from "@starterkit/shared/contracts/inbox";

type Folder = Pick<InboxFolderListDto["folders"][number], "name" | "files" | "newest">;
type Folders = { root: string; folders: readonly Folder[] };

/**
 * A file name pattern from a file of the folder: its date or number (digits, with - _ . between groups) becomes `*`,
 * the rest kept (`act20261125.txt` → `act*.txt`); without digits, every file of its extension (`*.csv`), or `*`.
 */
export function suggestPattern(name: string): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const runs = [...stem.matchAll(/\d+(?:[-_.]\d+)*/g)];
  const last = runs.at(-1);
  if (!last) return ext ? `*${ext}` : "*";
  return `${stem.slice(0, last.index)}*${stem.slice(last.index + last[0].length)}${ext}`;
}

const pathOf = (root: string, name: string) => `${root.replace(/\/+$/, "")}/${name}`;

/**
 * The File inbox step's folders (Inbox files, owner 25 Nov: listed, not typed): the space's inbox folders, each with
 * its files; picking one answers its path and a pattern suggested from its newest file (null for an empty folder).
 * Absent while the space has no folder, the inbox isn't set up or the list failed.
 */
export function SpaceFolders({ list, path, onPick }: { list: Folders | undefined; path: string; onPick: (path: string, pattern: string | null) => void }) {
  if (!list?.folders.length) return null;
  const current = path.trim().replace(/\/+$/, "");
  return (
    <div role="radiogroup" aria-label="Space folders" className="grid gap-2 sm:grid-cols-2">
      {list.folders.map((f) => {
        const on = pathOf(list.root, f.name) === current;
        return (
          <button key={f.name} type="button" role="radio" aria-checked={on} onClick={() => onPick(pathOf(list.root, f.name), f.newest ? suggestPattern(f.newest) : null)}
            className={cn("flex min-w-0 items-start gap-3 rounded-md border px-3 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary",
              on ? "border-primary bg-primary-soft" : "border-line bg-card hover:bg-tray")}>
            <Icon icon={FolderIcon} className="mt-0.5 shrink-0 text-fg-3" />
            <span className="grid min-w-0 gap-0.5">
              <span className="font-mono text-body text-fg">{f.name}/</span>
              <span className="truncate text-body-sm text-fg-3">{f.files ? `${f.files === 1 ? "1 file" : `${f.files} files`}${f.newest ? ` · newest ${f.newest}` : ""}` : "No files yet"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
