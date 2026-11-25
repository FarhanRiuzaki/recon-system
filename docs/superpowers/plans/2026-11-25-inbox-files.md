# Inbox files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new **Inbox files** menu where a user uploads files by hand into per-space folders on disk
(`<first INBOX_ROOT>/<space code>/<folder>/`), sees each folder's and each file's ingest status, and a source wizard that
offers those folders, without a second ingest path.

**Architecture:** A new API module `inbox` owns the per-space folder tree on disk and one table, `inbox_uploads` (who
uploaded what). Uploads stream to a dot-named temp file and are renamed when complete; the existing `file_inbox`
pipeline (`ingest`) reads them like any file. Status is read from `ingest`'s `source_files` for the published sources of
the space whose folder is that folder. The web BFF catch-all streams this one upload path instead of buffering it.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle on PostgreSQL 18, Next.js 16 (App Router BFF), zod contracts in
`packages/shared`, Vitest (web) and `bun test` (API).

**Spec:** `docs/superpowers/specs/2026-11-25-inbox-files-design.md` (approved 25 Nov 2026). Rules: `AGENTS.md`.

## Global Constraints

- Space root = `path.join(<first INBOX_ROOTS entry>, <space code>)`; folders exactly one level below; no nesting.
- Folder name `^[a-z0-9][a-z0-9_-]{0,63}$`; at most `INBOX_FOLDERS_MAX` = 200 folders per space.
- File name: no `/` or `\`, not `.` or `..`, no leading `.`, no control characters, at most 255 bytes (UTF-8).
- Upload limit `INBOX_UPLOAD_MAX_MB` (API env, default 100, integer 1–2048); a file over it is refused and its temp file removed.
- Upload writes `.<name>.uploading` in the target folder, hashes (sha256) while writing, renames to `<name>` on success; an existing `<name>` → 409 `duplicate` ("A file named <name> is already in this folder. Delete it first."), never overwritten.
- Dot files are never listed and never read by the pipeline.
- Permissions (owner, 25 Nov): `SPACE_ACTION.viewInbox` = every `SPACE_ROLES` role; `uploadInbox` = `["operator", "source_admin"]`; `manageInbox` = `["source_admin"]`.
- Activity actions: `inbox.upload`, `inbox.folder.create`, `inbox.folder.delete`, `inbox.file.delete` (target: space; after: folder, name, size, sha256 where they apply).
- `INBOX_ROOTS` empty → every inbox route answers 409 `invalid_state` "File inbox isn't set up on this server." and the page shows that sentence as its empty state (deviation from the spec's "nav hidden": the web has no view of API config; the nav entry stays, the page explains).
- Over-limit upload answers 400 `bad_request` "The file is over <N> MB." (deviation from the spec's 413: `ERROR_STATUS` has no 413 code; adding one is a contract change for one message).
- No archive/move after ingest (owner, 25 Nov).
- Storage on disk only, behind `inbox/disk.ts` (the seam for a later MinIO/S3 backend; no S3 code now). Screen in the S3 console style; Download for `viewInbox` (spec addendum).
- UI copy English, sentence case, AGENTS.md §10; nav label "Inbox files", shortcut "G B", group `setup`.

## Review Focus

1. Two uploads of the same name into one folder at once → exactly one wins (rename is `link`-then-unlink or `open(..., "wx")` on the final name), the other 409, no temp file left. Test in Task 4.
2. A browser tab closed mid-upload (stream aborted) → temp file removed, no `inbox_uploads` row, no activity entry. Test in Task 4.
3. A file name with spaces, upper case, non-ASCII (`Laporan ACT 25-11.TXT`, `résumé.csv`) uploads, lists and deletes by its exact name (header carries it `encodeURIComponent`-ed; delete takes `?name=`). Tests in Task 4 and Task 6.
4. A worker scan racing a delete → the file is either ingested (delete refused 409) or gone before the scan (never half-read). Test in Task 4.
5. A source of space B whose folder is under space A's root → refused on save/submit; a source with a folder outside every space root still saves. Test in Task 5.

---

### Task 1: Shared contracts, space actions, body limit

**Files:**
- Modify: `packages/shared/src/spaces.ts` (add `viewInbox`, `uploadInbox`, `manageInbox` to `SPACE_ACTION`, with one-line doc comments like the neighbours)
- Create: `packages/shared/src/inbox.ts` (zod-free limits: `INBOX_FOLDER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/`, `INBOX_FOLDERS_MAX = 200`, `INBOX_FILE_NAME_MAX = 255`, `isInboxFileName(name: string): boolean`)
- Create: `packages/shared/src/contracts/inbox.ts`
- Modify: `packages/shared/src/body-limit.ts` (`INBOX_UPLOAD_PATH` regex `^/v1/spaces/[0-9a-f-]{36}/inbox/folders/[a-z0-9][a-z0-9_-]{0,63}/files$`; `isInboxUpload(path: string): boolean`; `bodyMaxFor` unchanged for other paths)
- Modify: `packages/shared/src/audit.ts` (`ACTION_LABEL` four actions), `packages/shared/src/paging.ts` (sort keys `name`, `modifiedAt`, `size` for files)
- Modify: `apps/web/scripts/emit-api-schemas.ts` (import + `named` + `COMPOSED: InboxFilePage: pageOf(inbox.InboxFileDto)`)
- Test: `packages/shared/src/inbox.test.ts`, `packages/shared/src/body-limit.test.ts`, `packages/shared/src/spaces.test.ts`

**Interfaces:**
- Produces (contracts/inbox.ts):
  - `InboxState = z.enum(["waiting", "ingested", "duplicate", "failed"])`
  - `InboxFolderDto = { name: string; files: number; newest: string | null; newestAt: string | null; summary: Record<InboxState, number> }`
  - `InboxFolderListDto = { root: string; folders: InboxFolderDto[] }` (`root` = absolute space root, for the wizard)
  - `CreateInboxFolderBody = z.strictObject({ name })`
  - `InboxFileSourceDto = { sourceId: string; sourceName: string; state: InboxState; rowsIn: number | null; rowsQuarantined: number | null }`
  - `InboxFileDto = { name: string; size: number; modifiedAt: string; uploadedBy: { id: string; name: string } | null; uploadedAt: string | null; sources: InboxFileSourceDto[] }`
  - `InboxFileListQuery` = standard paging query (`page`, `pageSize`, `q`, `sort` with keys above, default `-modifiedAt`)
  - `InboxFileNameQuery = z.strictObject({ name: z.string().min(1).max(1024) })` (DELETE's `?name=`)
  - `InboxUploadDto = { name: string; size: number; sha256: string }`

- [ ] **Step 1:** Write failing tests: `isInboxFileName` accepts `act20261125.txt`, `Laporan ACT 25-11.TXT`, `résumé.csv`; refuses `''`, `.x`, `..`, `a/b`, `a\\b`, `a\u0000b`, a 256-byte name; `INBOX_FOLDER_NAME` accepts `act`, `bal_2`, refuses `Act`, `-x`, `a.b`, 65 chars; `isInboxUpload` true for `/v1/spaces/<uuid>/inbox/folders/act/files`, false for `.../files/x` and `.../inbox/folders`; `spaces.test.ts`: `mayDo(["operator"], "uploadInbox")` true, `mayDo(["operator"], "manageInbox")` false, `mayDo(["viewer"], "viewInbox")` true, `mayDo(["space_admin"], "uploadInbox")` false.
- [ ] **Step 2:** Run `bunx vitest run src/inbox.test.ts src/body-limit.test.ts src/spaces.test.ts` in `packages/shared` → FAIL.
- [ ] **Step 3:** Implement the files above.
- [ ] **Step 4:** Run the same → PASS; `bun run typecheck` at the root → the role matrix test may now fail on new rows: fix in `apps/web/src/features/spaces/role-matrix` labels only if it needs a label map entry.
- [ ] **Step 5:** Commit `feat(shared): inbox contracts, space actions and upload path`.

### Task 2: Inbox rules and the disk layer (API, no database)

**Files:**
- Create: `apps/api/src/modules/inbox/rules.ts`, `apps/api/src/modules/inbox/disk.ts`
- Modify: `apps/api/src/modules/ingest/inbox.ts` (`completeFiles` and `inboxProbe` skip names starting with `.`)
- Modify: `apps/api/src/kernel/config.ts` (`INBOX_UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(2048).default(100)` in the API config only)
- Test: `apps/api/src/modules/inbox/tests/unit/rules.test.ts`, `apps/api/src/modules/inbox/tests/integration/disk.test.ts` (temp dir, no DB), `apps/api/src/modules/ingest/tests/unit/inbox.test.ts` (add the dot-file case; create the file if it doesn't exist)

**Interfaces:**
- Produces (rules.ts, pure):
  - `spaceRoot(roots: string[], spaceCode: string): string | null` (null when `roots` empty)
  - `worstState(states: InboxState[]): InboxState` (order failed > duplicate > waiting > ingested; `[]` → `"waiting"`)
  - `folderOfPath(roots: string[], codes: string[], p: string): { code: string; folder: string } | null` (which space root a path is under, by resolved path; used by Task 5)
- Produces (disk.ts):
  - `ensureRoot(root: string): Promise<void>` (mkdir recursive, mode 0o2775)
  - `listFolders(root: string): Promise<{ name: string; files: { name: string; size: number; modifiedAt: number }[] }[]>` (non-dot regular files; folder names failing `INBOX_FOLDER_NAME` skipped)
  - `makeFolder(root: string, name: string): Promise<void>` (EEXIST → `ApiError("duplicate", …)`)
  - `removeFolder(root: string, name: string): Promise<void>` (non-empty → `ApiError("invalid_state", "Delete the files in this folder first.")`)
  - `writeUpload(dir: string, name: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ size: number; sha256: string }>`: writes `.<name>.uploading` with `open(…, "wx")`, counts bytes (over → abort, unlink, `ApiError("bad_request", "The file is over N MB.")`), on stream error unlinks and rethrows; then `link(temp, final)` (EEXIST → unlink temp, `ApiError("duplicate", …)`), then unlink temp. Final mode 0o664.
  - `hideFile(dir: string, name: string): Promise<string>` (rename to `.<name>.deleting`, answers the hidden path) and `unhideFile(hidden: string, dir: string, name: string): Promise<void>`
  - Every path passes through `inboxFile`/realpath containment from `ingest/inbox.ts` (export `folder` as `inboxFolder` from ingest's index for this).

- [ ] **Step 1:** Failing tests: `spaceRoot(["/data/inbox"], "msi") === "/data/inbox/msi"`, `spaceRoot([], "msi") === null`; `worstState(["ingested","waiting"]) === "waiting"`, `worstState(["duplicate","failed"]) === "failed"`; `folderOfPath(["/data/inbox"], ["msi","ctop"], "/data/inbox/msi/act")` → `{ code: "msi", folder: "act" }`, `/data/inbox/act` → null, `/data/inbox/msi/../ctop/x` → ctop. Disk: upload of 3 chunks writes the file with the right sha256 and no dot file left; a second upload of the same name → `duplicate`, first file intact; two concurrent `writeUpload` of one name → one resolves, one `duplicate`; a stream that errors after one chunk leaves no file in the folder; a body over `maxBytes` → `bad_request` and no file; `listFolders` hides `.x.uploading`; `removeFolder` on a non-empty folder → `invalid_state`. Ingest: `completeFiles` with pattern `*` skips `.a.uploading`.
- [ ] **Step 2:** `cd apps/api && bun test src/modules/inbox src/modules/ingest/tests/unit/inbox.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(api): inbox rules and disk layer`.

### Task 3: `inbox_uploads` table, module skeleton, folder routes

**Files:**
- Create: `apps/api/src/modules/inbox/{schema,service,controller,index}.ts`
- Create: migration via `cd apps/api && bun run db:generate -- --name=inbox_uploads`, then a custom one `--custom --name=inbox_uploads_rls` with `select recon_enable_space_rls('inbox_uploads');`
- Modify: `apps/api/src/modules/index.ts` (`.use(inboxController())`), `apps/api/test/architecture/*` allowlists as needed (ownership list in AGENTS.md §12 gains `inbox` inbox_uploads), `docs/api/README.md` endpoint rows, `AGENTS.md` (modules list, ownership line)
- Modify: `apps/api/test/architecture/conformance.test.ts` `NON_LIST_GETS`: `"GET /v1/spaces/:spaceId/inbox/folders": "the space's inbox folders from disk, at most INBOX_FOLDERS_MAX (200)"`
- Test: `apps/api/src/modules/inbox/tests/integration/folders.test.ts`

**Interfaces:**
- Table `inbox_uploads`: `id uuid pk`, `space_id uuid not null → spaces`, `folder text not null`, `name text not null`, `size bigint not null`, `sha256 text not null`, `uploaded_by uuid not null → users`, `uploaded_at timestamptz not null default now()`; unique `(space_id, folder, name, sha256)`; index `(space_id, folder)`.
- Routes (all `{ guard: { space: SPACE_ACTION.<x> } }`, no `or`):
  - `GET /v1/spaces/:spaceId/inbox/folders` (viewInbox) → `InboxFolderListDto`, root created on call
  - `POST /v1/spaces/:spaceId/inbox/folders` (manageInbox) body `CreateInboxFolderBody` → 201 `InboxFolderDto`; 201st folder → 409 `invalid_state` "This space has 200 folders, the most it can have."
  - `DELETE /v1/spaces/:spaceId/inbox/folders/:folder` (manageInbox) → 204; folder name failing the regex → 404; a published source version of the space reading it → 409 `invalid_state` "<source name> reads this folder. Change that source first."
- Produces (service.ts): `inboxRootOf(tx: InTx, spaceId: string): Promise<string>` (409 when roots empty), `readersOf(tx: InTx, spaceId: string, dir: string): Promise<{ id: string; name: string; pattern: string }[]>` (published `sourceVersions` of the space with `input.kind = "file_inbox"` and realpath of `input.path` = `dir`), `statesOf(tx, spaceId, readers, files): Promise<Map<string, InboxFileSourceDto[]>>` (match `sourceFiles` by sourceId, name, size, modifiedAt; status ingested → `ingested` with `rowsIn`/`rowsQuarantined`, rejected → `duplicate`, failed → `failed`, no row → `waiting`; only readers whose pattern matches the name). Folder summary uses `worstState` per file over its sources (a file no source reads counts as nothing: not in any bucket).

- [ ] **Step 1:** Failing integration tests: list on a fresh space creates `<root>/<code>` and answers `{ folders: [] }`; operator POST folder → 403; source_admin POST `act` → 201, activity `inbox.folder.create`; POST `act` again → 409 `duplicate`; POST `Act` → 400; DELETE with a file inside → 409; DELETE an empty folder read by a published source → 409 naming the source; DELETE empty unread → 204 + activity; `INBOX_ROOTS` empty → 409 `invalid_state`; viewer of another space → 403; archived space POST → 409 `space_archived`. Use a temp `INBOX_ROOTS` per test file.
- [ ] **Step 2:** `cd apps/api && bun test src/modules/inbox/tests/integration/folders.test.ts` → FAIL.
- [ ] **Step 3:** Implement schema, migrations (`bun run db:migrate` on the dev DB only if one is configured; tests migrate themselves), service, controller, registration, docs rows, then `bun run api:schemas`.
- [ ] **Step 4:** Same test → PASS; `cd apps/api && bun test test/architecture test/db` → PASS.
- [ ] **Step 5:** Commit `feat(api): inbox module with per-space folders`.

### Task 4: File list, upload and delete routes

**Files:**
- Modify: `apps/api/src/modules/inbox/{service,controller}.ts`, `apps/api/src/kernel/plugins/body-limit.ts` (skip the Content-Length check when `isInboxUpload(path)`; the handler enforces `INBOX_UPLOAD_MAX_MB`), conformance allowlists (the upload reads its raw body, not `body(c, Schema)`: add an allowlist entry with that reason in whichever map (e)/(f) uses, or a new `RAW_BODY` map with a fixture proving a non-listed raw read fails), `docs/api/README.md`
- Test: `apps/api/src/modules/inbox/tests/integration/files.test.ts`

**Interfaces:**
- `GET /v1/spaces/:spaceId/inbox/folders/:folder/files` (viewInbox), query `InboxFileListQuery` → `Page<InboxFileDto>`; paged in memory from disk (q = case-insensitive substring of name; at most 1000 pages per standard paging).
- `POST /v1/spaces/:spaceId/inbox/folders/:folder/files` (uploadInbox), headers `x-file-name` (`encodeURIComponent` of the name) and `Content-Length` (missing → 400 "Send the file's size."), raw body → 201 `InboxUploadDto`; after the file is in place: insert `inbox_uploads` + `recordActivity("inbox.upload")` in one transaction; if that transaction fails, unlink the file and rethrow.
- `GET /v1/spaces/:spaceId/inbox/folders/:folder/files/download?name=` (viewInbox) → the file streamed, `content-type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<encoded>`; dot names and missing files 404; listed in `NON_LIST_GETS` ("one file's bytes"); no activity.
- `DELETE /v1/spaces/:spaceId/inbox/folders/:folder/files?name=` (manageInbox) → 204: `hideFile`, then in a transaction re-read `statesOf` for it; any source state other than `waiting` → `unhideFile` and 409 `invalid_state` "A source has already read this file."; else unlink hidden + activity `inbox.file.delete`.

- [ ] **Step 1:** Failing tests: operator uploads `act20261125.txt` (3 lines) → 201 with sha256 of the bytes, file on disk, `inbox_uploads` row, activity with folder/name/size/sha256; viewer upload → 403 and nothing on disk; same name again → 409; name `../x` → 400; name `Laporan ACT 25-11.TXT` round-trips (upload, list shows exact name, delete `?name=` removes it); body over a test limit of 1 MB (set `INBOX_UPLOAD_MAX_MB=1`) → 400 and no file; aborted stream → no file, no row, no activity; list shows `uploadedBy` for the uploaded file and `null` for a file copied in by `Bun.write`; with a published file source on that folder (pattern `act*.txt`) and a `source_files` row `ingested` for the file → `sources[0].state === "ingested"` and the folder summary `ingested: 1`; a second file with no row → `waiting`; delete of the ingested file → 409 and the file still listed; delete of the waiting file → 204; download of a listed file answers its exact bytes with the attachment header, download of `.x.uploading` → 404; source_admin of space B listing space A's folder → 403.
- [ ] **Step 2:** `bun test src/modules/inbox/tests/integration/files.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `bun test test/architecture test/app.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(api): upload, list and delete inbox files`.

### Task 5: Sources refuse another space's folder

**Files:**
- Modify: `apps/api/src/modules/sources/service.ts` `checkSpec` (and `testConnection`/`testNewSource` for the folder test)
- Test: `apps/api/src/modules/sources/tests/integration/` (the file that covers version saves; add cases)

**Interfaces:**
- Consumes: `folderOfPath` (export it from `inbox/index.ts`), the space codes (`spaces` index: add an exported `spaceCodes(tx): Promise<{ id: string; code: string }[]>` if none exists).
- Rule: if `folderOfPath(roots, codes, input.path)` names a space other than the source's own → `ApiError("bad_request", "Check input.path: Use a folder of this space.")`.

- [ ] **Step 1:** Failing tests: saving a draft of a space-B file source with path `<root>/<codeA>/act` → 400 with that message; `<root>/<codeB>/act` → 200; `<root>/legacy` (no space) → 200; the folder test (`connection/test` with a path) refuses the same way.
- [ ] **Step 2:** Run the sources test file → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `bun test test/architecture` → PASS (module import direction sources → inbox, inbox → sources/ingest via index: if the boundaries test refuses the cycle, put `folderOfPath` in `ingest/inbox.ts` and export it from ingest instead).
- [ ] **Step 5:** Commit `feat(api): a file source reads only its own space's inbox folders`.

### Task 6: BFF streams the upload

**Files:**
- Modify: `apps/web/src/lib/server/forward.ts` (for `isInboxUpload(path)` and POST: no `bodyOf`; pass `req.body` with `duplex: "half"`; require `content-length` else 400; forward `x-file-name`), `apps/web/src/lib/server/backend.ts` (`BackendInit` gains `fileName?: string` → header `x-file-name`, and `timeoutMs?: number`; the upload uses 300000 ms)
- Test: `apps/web/src/lib/server/forward.test.ts`

- [ ] **Step 1:** Failing tests: a 2 MB POST to `/api/spaces/<uuid>/inbox/folders/act/files` with CSRF reaches the API with the same bytes, `content-length` and `x-file-name`; the same without CSRF → 403 `csrf`, API not called; a 2 MB POST to any other path → 400 as before; upload without `content-length` → 400; the browser's other headers still don't pass (existing test pattern).
- [ ] **Step 2:** `bun run --filter @starterkit/web test -- forward` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit `feat(web): stream inbox uploads through the BFF`.

### Task 7: Inbox files screen

**Files:**
- Create: `apps/web/src/features/inbox/{inbox-page.tsx,use-inbox.ts,upload.ts,shapes.ts}`, `apps/web/src/app/(main)/inbox/page.tsx` (space entry redirect, copy of `app/(main)/results/page.tsx` with `"inbox"`), `apps/web/src/app/(main)/spaces/[spaceId]/inbox/{page.tsx,loading.tsx}`
- Modify: `apps/web/src/lib/shared/nav.ts` (`NavIcon` + `"inbox"`, `SPACE_PAGES` + `"inbox"`, `NAV` entry `{ href: "/inbox", label: "Inbox files", icon: "inbox", shortcut: "G B", group: "setup", perm: null, space: "inbox" }` after Sources), `components/shell/nav-icon.tsx` (an inbox/folder icon from `icons.ts`, adding it there first), `lib/shared/queries.ts` (keys starting `"inbox"`: `inboxFolders(spaceId)`, `INBOX_FILES(spaceId, folder)` table definition), `lib/server/prefetch.tsx` (`reads.inboxFolders`, `reads.inboxFiles`), `lib/shared/prefs.ts` (`VIEW_PAGES` + `/spaces/[spaceId]/inbox`), `components/route-shapes.ts`, `docs/standards/copy-guide.md` (nav label), `no-flicker.spec.ts` `PAGES`
- Test: `apps/web/src/features/inbox/upload.test.ts`, `apps/web/src/lib/shared/nav.test.ts` (existing assertions cover shortcut uniqueness)

**Interfaces:**
- `upload.ts`: `uploadFile(spaceId: string, folder: string, file: File, csrf: string | null): Promise<InboxUploadDto>` (`fetch(\`/api/spaces/${…}/inbox/folders/${…}/files\`, { method: "POST", body: file, headers: { "x-file-name": encodeURIComponent(file.name), "x-csrf-token": … } })`; reuse `setCsrf`'s token through a small exported getter in `lib/client/api.ts`, and `apiFailure` for errors); `queueState` reducer for the per-file list: `queued → uploading → done | failed(message)`, files sent one at a time.
- Screen (S3 console style): breadcrumb `Space / folder /` in the panel header; at the space root one `DataTable` of folder rows; inside a folder the file rows; row click opens a detail `Sheet` (size, modified, sha256, uploaded by/at, state per source, Download, Delete); checkboxes + bulk bar "Delete N files" (manageInbox, waiting files only, others skipped with reason). `PageHeader` "Inbox files" with the space; folder list (name, file count, summary chips through `StatusChip`: waiting = `unknown`, ingested = `healthy`, duplicate = `degraded`, failed = `down`, legend in the `Panel`); selected folder in `?folder=`; files `DataTable` server mode (columns: Name (title), Size, Modified, Uploaded by, Status per source; mobile roles); **Upload files** primary button (`mayDo(roles, "uploadInbox")`, else `BlockedButton` "Only operators and source admins upload files.") + drop zone on the table; **New folder** (`manageInbox`) dialog with `Field`; ⋯ row menu "Delete file" (`manageInbox`, `ConfirmActionDialog`, disabled with reason when any source state ≠ waiting); ⋯ folder menu "Delete folder". Empty states: no folders ("Create a folder to upload files into." for manageInbox, else "No folders yet. A source admin creates them."); 409 `invalid_state` from folders → "File inbox isn't set up on this server."

- [ ] **Step 1:** Failing tests (`upload.test.ts`): `queueState` moves a file queued → uploading → done; a failure keeps its message and the next file still starts; `uploadFile` sends `x-file-name` encoded and the CSRF header (mock fetch).
- [ ] **Step 2:** `bun run --filter @starterkit/web test -- upload` → FAIL.
- [ ] **Step 3:** Implement screen, pages, nav, queries, prefetch.
- [ ] **Step 4:** `bun run --filter @starterkit/web test` → PASS (architecture, page-anatomy, nav, prefs, queries tests included).
- [ ] **Step 5:** Commit `feat(web): Inbox files screen`.

### Task 8: Source wizard offers the space's folders

**Files:**
- Modify: `apps/web/src/features/sources/steps/connection.tsx` (File inbox: a "Space folders" select above Folder, filled from `inboxFolders(spaceId)`; choosing one sets Folder to `${root}/${name}`; Folder stays editable), `apps/web/src/features/sources/wizard.tsx` only if the query needs wiring; note `features/sources` must not import `features/inbox`: read the query from `lib/shared/queries.ts` directly
- Test: the existing unit test of `steps/connection` (or a new `connection-folders.test.ts` beside it)

- [ ] **Step 1:** Failing test: with folders `act`, `bal` and root `/data/inbox/msi`, choosing `act` sets Folder to `/data/inbox/msi/act`; with the folders query failing, the select is absent and Folder works as before.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(web): pick a space folder in the file source wizard`.

### Task 9: Deploy wiring, docs, full check, deploy to tibsdev

**Files:**
- Modify: `docker-compose.yml` (api volume `${INBOX_DIR:-./inbox}:/data/inbox` without `:ro`; worker keeps `:ro`; api `INBOX_UPLOAD_MAX_MB: ${INBOX_UPLOAD_MAX_MB:-}`), `.env.compose.example` (`# INBOX_UPLOAD_MAX_MB=100`), `apps/api/.env.example`, `docs/recon/deploy.md` (layout `/data/inbox/<space code>/<folder>/`, folders 2775 for a later FTP group, the limit), `docs/decisions.md` (DEC entry: inbox upload writes to disk, two deviations above), `README.md` Recon › Sources line
- Server (not committed): `/root/apps/recon-system/inbox` owned by uid of container user `bun` (1000) with mode 2775

- [ ] **Step 1:** `bun run check` at the repo root → PASS (needs `apps/api/.env` with a `DATABASE_URL` of a database nobody else uses: create `recon_system_dev` on tibsdbdev for it, never `recon_system`).
- [ ] **Step 2:** Affected E2E only (owner rule): the new page in `responsive.spec.ts`/`no-flicker.spec.ts` and a permissions case; run `bun run e2e -- <those specs>` → PASS, artifacts under `.superpowers/scratch/`.
- [ ] **Step 3:** Commit `chore(deploy): writable inbox for the API, docs`.
- [ ] **Step 4:** Deploy on tibsdev: `chmod -R go+rX` the checkout (umask 077 trap), `chown 1000:1000 inbox && chmod 2775 inbox`, `docker compose -f docker-compose.yml -f docker-compose.tibsdev.yml --env-file .env.compose build`, `… run --rm migrate`, `… up -d`; expect api/worker/web healthy.
- [ ] **Step 5:** Smoke on http://tibsdev.bankmegadev.net:8002 as `reconadmin`: create space folder `act` in a test space, upload a 5 MB file, see it listed as uploaded by the admin; delete it.
