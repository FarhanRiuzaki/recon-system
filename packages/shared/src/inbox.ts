// Inbox files (docs/superpowers/specs/2026-11-25-inbox-files-design.md): the limits a form needs as values, zod-free for
// client code. A space's inbox is `<first INBOX_ROOTS entry>/<space code>/`, with folders one level below it.

/** A folder name: lower case letters, digits, `_` and `-`, starting with a letter or digit, at most 64. */
export const INBOX_FOLDER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The most folders one space has. */
export const INBOX_FOLDERS_MAX = 200;
/** The longest file name, in UTF-8 bytes. */
export const INBOX_FILE_NAME_MAX = 255;

/** A plain file name: no folder separator, not `.`/`..`, no leading dot (hidden and temporary files), no control character. */
export const isInboxFileName = (name: string): boolean =>
  name.length > 0 && !name.startsWith(".") && !/[/\\\u0000-\u001f\u007f]/.test(name) && new TextEncoder().encode(name).length <= INBOX_FILE_NAME_MAX;

/** The files an inbox upload takes (owner 25 Nov: only what a file source can read), by extension in any case. */
export const INBOX_UPLOAD_EXTENSIONS = [".csv", ".txt", ".dat", ".tsv", ".xlsx", ".xls"] as const;
/** What an upload's name makes it: a data file, an empty `.done` marker (a source that completes by marker), or neither. */
export const uploadKindOf = (name: string): "data" | "marker" | null => {
  const n = name.toLowerCase();
  if (n.endsWith(".done") && n.length > 5) return "marker";
  return INBOX_UPLOAD_EXTENSIONS.some((x) => n.endsWith(x)) ? "data" : null;
};
