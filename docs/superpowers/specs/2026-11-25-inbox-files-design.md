# Inbox files: manual upload into per-space folders (design)

Status: approved by owner 25 Nov 2026 (folder rows show a status summary; archive out of scope).

## Intent and why

Teams get source files (for example the KSEI ACT file, about 5 MB) that today reach recon-engine by browser upload.
recon-system reads files only from a folder on the server (`file_inbox` sources, `INBOX_ROOTS`), and nobody outside IT can
put a file there. Later the other systems will drop their files by FTP. The owner wants a new menu, **Inbox files**,
where a user uploads a file by hand into their space's folder, and the folder layout per space is the one FTP will use
later, so the engine sees one kind of file whatever brought it.

## Goals

- A new menu **Inbox files**: pick a space, see its folders and the files in each, upload a file into a folder.
- One root folder per space, made by the app: `<inbox root>/<space code>/`, with folders one level below it
  (`/data/inbox/msi/act/`). Space codes are immutable (`UpdateSpaceBody` has no `code`), so the path is stable.
- An uploaded file is an ordinary file in that folder: a `file_inbox` source whose folder is there picks it up through
  the pipeline it has now (completion by quiet time or `.done` marker, sha256 duplicate refusal, business date from the
  name, quarantine). Nothing in the ingest pipeline changes.
- Each file row shows who uploaded it and when (or "not uploaded here" for a file that arrived another way), and what
  the pipeline did with it when a source reads that folder (waiting, ingested, refused as duplicate, quarantined rows),
  from the ingest data that exists.
- The source wizard's Folder step offers the space's folders (it still accepts a typed path inside `INBOX_ROOTS`).

## Non-goals (now)

- FTP/SFTP server or receiving files from other systems (later: the FTP account is pointed at
  `/data/inbox/<space code>/...`; no app change expected).
- An API key or machine sign-in for system-to-system upload.
- Nested folders, renaming folders, editing file contents, zip/archive extraction.
- Moving or archiving files after ingest (files stay where they are, as now).

## Anti-goals

- A second ingest path: upload must not parse or load the file itself; the folder stays the only way in.
- A file that is half written being read: the upload writes to a temporary name and renames when complete.
- A path from the user reaching outside the space's folder (no `..`, no separators in names, realpath check as in
  `ingest/inbox.ts`).
- Whole files held in memory in the web or the API.

## Constraints

- Body limit is 64 KB everywhere (`packages/shared/src/body-limit.ts`, web `forward.ts`, API `body-limit.ts`). The upload
  route gets its own limit, `INBOX_UPLOAD_MAX_MB` (default 100), streamed to disk chunk by chunk in the API and passed
  through the BFF as a stream (no `bodyOf` buffering for that path).
- The `api` service mounts the inbox read-write; the `worker` keeps `:ro`. `INBOX_ROOTS` stays the allow-list; the
  per-space root lives under the **first** root.
- AGENTS.md: new module shape (§13), table ownership, contracts in `packages/shared`, activity actions in
  `ACTION_LABEL`, space permissions only through `SPACE_ACTION` + `mayDo`, CSRF on the upload POST, copy rules (§10).
- AGENTS.md rules this design bends, each needing its test/allowlist updated in the same change: no `route.ts` besides
  the catch-all and auth routes (the upload goes through the catch-all, which streams that one path instead of
  `bodyOf`); `body(c, Schema)` is JSON only (the upload route reads the raw stream, allowlisted in conformance);
  `inbox_uploads` has `space_id`, so it gets `recon_enable_space_rls`; the folder and file lists come from disk, not
  `pageQuery` (named in `NON_LIST_GETS` with the reason, capped: at most 200 folders per space, file list paged in memory
  with the standard `page`/`pageSize`/`sort` query).
- The container runs as user `bun`; the app creates the space folders with modes the FTP account can later share
  (group-writable, documented in `docs/recon/deploy.md`).

## Approaches (owner picked A)

- **A. Upload writes into the space folder on disk (picked).** One way in for the engine; FTP later lands in the same
  folders; reuses all of the pipeline. Cost: the API needs a writable mount and a streaming upload route.
- B. Upload stored in the database and fed to ingest directly. No writable disk, but two ingest paths and no real
  per-space folders for FTP.
- C. An upload button on a source's page. Smallest, but no menu and no place to see what FTP drops later.

## Design

### Permissions (confirmed by owner, 25 Nov)

New `SPACE_ACTION` entries:

- `viewInbox`: every space role (see folders and files).
- `uploadInbox`: `operator`, `source_admin` (upload a file).
- `manageInbox`: `source_admin` (create and delete a folder, delete a file).

Superadmin as everywhere else. Every upload, folder create and delete is an activity entry
(`inbox.upload`, `inbox.folder.create`, `inbox.folder.delete`, `inbox.file.delete`) with space, folder, file name, size, sha256.

### Rules settled after the builder check (my calls)

- **Space isolation.** A `file_inbox` source's folder may not sit under *another* space's root: the source version check
  refuses `/data/inbox/<other code>/…` ("Use a folder of this space."), own space root and paths outside every space
  root stay allowed (paths outside: for folders IT set up by hand). The wizard offers only the source's own space
  folders. Shared sources (`source_shares`) read through their owner's source, so they change nothing.
- **Ingest state per source, not per file.** The file row lists each source of this space that reads the folder and
  matches the name, with that source's state from `source_files`: waiting (no row yet), ingested (rows in, rows
  quarantined: `rows_quarantined`), refused as duplicate (`rejected`), failed. No join to `quarantine_rows`.
- **`INBOX_ROOTS` empty** = the feature is off: the nav entry is hidden and the inbox routes answer 409 `invalid_state`
  ("File inbox isn't set up on this server."). Space roots live under the first root; nothing else at boot.
- **Existing folders under the root** are left alone. A space root is `<root>/<space code>/`; a folder there not made by
  the app still shows (it is just a folder). No migration.
- **Delete a file** only while no source has a `source_files` row for it (nothing picked it up yet). The delete first
  renames the file to a dot name (atomic; the worker skips dot files), checks again, then removes it; a row that
  appeared meanwhile → rename back and 409 `invalid_state` ("A source has already read this file.").

### Data

Table `inbox_uploads` (module `inbox`): id, space_id, folder, name, size, sha256, uploaded_by, uploaded_at.
It records only who uploaded what; the folder on disk is the truth for which files exist. A file on disk without a row
shows "not uploaded here".

### API (module `inbox`)

- `GET /v1/spaces/:spaceId/inbox/folders`: folders under the space root with file count, newest file and a status summary (files waiting, ingested, refused as duplicate, failed, over the sources of this space that read the folder; a file counts once, by its worst state: failed > duplicate > waiting > ingested); the root is
  created on first call.
- `POST /v1/spaces/:spaceId/inbox/folders` `{ name }`: name `^[a-z0-9][a-z0-9_-]{0,63}$`; 409 when it exists.
- `DELETE /v1/spaces/:spaceId/inbox/folders/:folder`: only when empty and no source version points at it.
- `GET /v1/spaces/:spaceId/inbox/folders/:folder/files`: paged list (name, size, modified time, uploaded by/at or null,
  ingest state when a source reads this folder: waiting / ingested / duplicate / failed, matched by name+size+time as
  `ingest` does now).
- `POST /v1/spaces/:spaceId/inbox/folders/:folder/files` (raw body, `x-file-name` header, `Content-Length` required):
  name must be a plain file name (no separators, no leading dot, at most 255 bytes); streams to `.<name>.uploading`,
  computes sha256 while writing, then renames to `<name>`. An existing file of that name → 409 (no overwrite; delete
  first). Over `INBOX_UPLOAD_MAX_MB` → 413 and the temporary file removed. Disk errors name the system code only.
- `DELETE /v1/spaces/:spaceId/inbox/folders/:folder/files/:name`: only a file the pipeline has not ingested.

Temporary `.uploading` names do not match a source's pattern if it starts with a letter; the file list hides dot files.
`completeFiles` also skips dot files (one-line change, so a pattern like `*` can't read a half-written upload).

### Web

- Navigation: **Inbox files** for users with `viewInbox` in any space. Route `/spaces/[spaceId]/inbox` and `/inbox`
  (space picker, as Results does).
- Page: folder list on the left (or stacked at 390 px), files of the selected folder on the right, **Upload** (primary)
  for `uploadInbox`, drag-and-drop onto the file table as well, progress per file, several files at once (sent one by
  one). **New folder** and delete for `manageInbox`.
- Source wizard, File inbox step: a "Space folders" choice listing the space's folders, filling Folder with its absolute
  path; typing a path stays possible.

### Deploy

- `docker-compose.yml`: api mount `${INBOX_DIR}:/data/inbox` read-write; worker stays `:ro`. `INBOX_UPLOAD_MAX_MB` added
  to the api allow-list and `.env.compose.example`.
- `docs/recon/deploy.md`: folder layout, owner/group for a later FTP account, the size limit.

## Left to the builder

- Exact component choices and copy, within AGENTS.md §7/§10.
- How the BFF streams the upload (a dedicated route handler beside the catch-all is fine) while keeping CSRF.
- Tests: unit for name validation and path containment; integration for upload (temp + rename, 409, 413, sha256,
  activity), folder create/delete rules, permission matrix; web unit for the upload flow. E2E only what is affected
  (owner rule).

## Addendum, 25 Nov (owner)

- **Storage stays on disk now; MinIO or another open-source S3 comes next.** Every file operation of the `inbox`
  module goes through `disk.ts` (one seam), so an S3 backend can replace it without changing routes or screens. FTP
  from other systems still lands in the same folders. Out of scope now: any S3/MinIO code or service.
- **The screen looks like the S3 console:** breadcrumb `Space / folder /`, folders and files in one table (folder rows
  first, with file count and status summary), checkboxes for bulk delete, a detail panel per file (size, modified,
  sha256, uploaded by and when, state per source), drag and drop onto the table. Still one folder level.
- **Download** a file: `GET /v1/spaces/:spaceId/inbox/folders/:folder/files/download?name=` (`viewInbox`), streamed with
  `Content-Disposition: attachment`; it is a read and writes no activity entry.
