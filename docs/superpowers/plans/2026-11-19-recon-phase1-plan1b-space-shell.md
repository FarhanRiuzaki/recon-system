# Recon fase 1 — Plan 1b: layar Space & shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pengguna bisa berpindah space dari sidebar, melihat anggota space dan role-nya, dan space_admin bisa
menambah, mengubah role, serta menghapus anggota — sesuai page Figma "01 Space & shell".

**Architecture:** API `spaces` (Plan 1) dilengkapi tiga hal yang dibutuhkan layar: detail satu space, data anggota
untuk kolom Status/Last sign-in, dan pencarian calon anggota. Web mendapat feature `spaces`: SpaceSwitcher di slot
sidebar, route `/spaces` yang membuka space terakhir, halaman `/spaces/[spaceId]/members` dengan tiga dialog. Dua
carry-over Plan 1 ditutup: hapus user tidak boleh menghabiskan space_admin terakhir, dan `keepAnAdmin` hanya menghitung
user aktif.

**Tech Stack:** Next 16 / React 19.3 (apps/web), Bun + Elysia + Drizzle (apps/api), design system `@starterkit/ui`.

**Spec:** `docs/superpowers/specs/2026-11-19-recon-architecture-design.md` (§2, §11, §11b). Desain: Figma
`fbGv05DvfJnw6XU0fwZebO` page "01 Space & shell", frame "Build notes · 01 Space & shell" (route, peta komponen, copy
final, responsif) — copy di bawah disalin dari frame itu.

## Global Constraints

- AGENTS.md seluruhnya, terutama §1 (lapisan web, feature tidak mengimpor feature lain), §6–§8 (token, UI standard,
  motion), §9 (first-load JS ≤ 250 kB per route; dialog lewat `next/dynamic`), §10 (copy English, sentence case),
  §11 (tes), §12–§13 (kontrak, route order, cara menambah modul).
- Kata "workspace" terlarang di `apps/web/src`, `packages/ui/src`, `packages/shared/src`.
- Role space: tujuh nilai tetap `SPACE_ROLES` (`packages/shared/src/spaces.ts`); `source_admin` hanya oleh pemegang
  `space.manage`; space_admin terakhir dijaga service (409 `last_space_admin`).
- Halaman per space di `/spaces/[spaceId]/…` (UUID). Belum ada `/today` (Plan 4): fallback pindah space = `members`.
- Desain Figma pra-affectUI: bila tampilan Figma dan kode berbeda, nilai kode (tokens.css, base.css) yang dipakai.
- Aturan dari cek dark mode (REC-D4): sel "—" di RoleMatrix memakai `fg-3` + teks screen reader "Not allowed"; chip
  bertint memakai token `*-soft`, bukan opacity/`color-mix`.
- Commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Non-anggota membuka URL space orang lain** — document load harus 404 nyata (AGENTS §7 "A page the role can't
   open answers a real 404"), tidak membocorkan nama space. Dites di Task 4.
2. **Space_admin melihat checkbox Source admin** — nonaktif dengan alasan; UI tidak boleh mengirim perubahan
   source_admin (server tetap 403). Dites di Task 5.
3. **Admin terakhir dihapus lewat jalan samping** — `DELETE /v1/users/:id` dan deaktivasi user. Dites di Task 1.
4. **Cookie space terakhir menunjuk space yang sudah tidak bisa diakses** — `/spaces` jatuh ke space pertama yang
   masih bisa, atau "No space yet". Dites di Task 3.
5. **Pindah space di halaman yang tidak ada di space tujuan** — membuka `members`, bukan 404. Dites di Task 3.

---

### Task 1: API — detail space, data anggota, calon anggota, admin terakhir

**Files:**
- Modify: `apps/api/src/modules/spaces/{controller,service,rules}.ts`, `packages/shared/src/contracts/spaces.ts`,
  `packages/shared/src/paging.ts` (bila perlu sort baru), `apps/web/scripts/emit-api-schemas.ts`, `docs/api/README.md`
- Modify: `apps/api/src/modules/users/service.ts` (hapus dan deaktivasi user)
- Test: `apps/api/src/modules/spaces/tests/integration/spaces.test.ts`, `apps/api/src/modules/users/tests/integration/users.test.ts`

**Interfaces:**
- Produces (dipakai Task 2–5):
  - `GET /v1/spaces/:spaceId` — guard `{ space: SPACE_ROLES, or: "space.manage" }` → `SpaceRowDto` (space + `roles`
    milik pemanggil; `[]` bila masuk lewat `space.manage`).
  - `SpaceMemberDto` ditambah `active: boolean` (dari `users.is_active`) dan `lastSignInAt: string | null` (ISO,
    `max(auth_log.at)` untuk event `login_success` dan `2fa_success` user itu; baca lewat tabel `authLog` yang diekspor
    `modules/audit/index.ts`). Sort tambahan pada list anggota tidak diperlukan.
  - `GET /v1/spaces/:spaceId/candidates?q=&page=&pageSize=` — guard `{ space: ["space_admin"], or: "space.manage" }`
    → `Page<SpaceCandidateDto>`, `SpaceCandidateDto = { userId, name, username, active, member: boolean }`; hanya user
    yang sudah ada di aplikasi; `q` mencocokkan nama/username (pola `likeEscape` + `pageQuery`); sort `name`.
  - Hapus user (`DELETE /v1/users/:id`, termasuk bulk) dan deaktivasi user (PATCH status, `/status`, bulk) ditolak
    409 `last_space_admin` bila user itu satu-satunya space_admin **aktif** di salah satu space; dicek di bawah
    `xactLock(tx, "spaceAdmins")` lewat fungsi baru `assertNotLastSpaceAdmin(tx, userIds: string[])` yang diekspor
    `modules/spaces/index.ts`. Bulk melewati user itu dengan `skipped: { id, code: "last_space_admin" }`.
  - `keepAnAdmin` hanya menghitung anggota space_admin yang `users.is_active = true`.

- [ ] **Step 1: Tulis tes yang gagal**

```ts
it("GET /v1/spaces/:spaceId gives a member the space and their roles; a non-member 403; non-UUID 404", …);
it("members carry active and lastSignInAt (null before any sign-in, the latest login_success/2fa_success after)", …);
it("candidates: space_admin sees app users with member flags; operator 403; q matches name and username", …);
it("deleting the only active space_admin of a space is 409 last_space_admin and nothing changes", …);
it("deactivating the only active space_admin is 409; bulk deactivate skips them with code last_space_admin", …);
it("an inactive second space_admin does not count: removing the last active one is 409", …);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — `cd apps/api && bun test src/modules/spaces src/modules/users` → FAIL.
- [ ] **Step 3: Implementasi** sesuai Interfaces; kontrak zod + `bun run api:schemas`; baris README untuk dua route
  baru dan kolom error `last_space_admin` di route hapus/deaktivasi user.
- [ ] **Step 4: Jalankan** — modul terkait PASS, lalu `bun run check` dari root PASS.
- [ ] **Step 5: Commit** `feat(api): space detail, member status and last sign-in, member candidates, last space admin across user changes`

### Task 2: Web — plumbing feature `spaces` (query, prefetch, nav, cookie space terakhir)

**Files:**
- Create: `apps/web/src/features/spaces/use-spaces.ts`
- Modify: `apps/web/src/lib/shared/queries.ts`, `apps/web/src/lib/server/prefetch.tsx`, `apps/web/src/lib/shared/nav.ts`,
  `apps/web/src/components/shell/nav-icon.tsx`, `apps/web/src/lib/shared/prefs.ts`, `docs/standards/copy-guide.md` (label nav)
- Test: `apps/web/src/lib/shared/{queries,nav,prefs}.test.ts`, `apps/web/src/features/spaces/use-spaces.test.ts`

**Interfaces:**
- `queries.ts`: `SPACES_KEY = ["spaces"]`; `SPACES` table def (`/api/spaces`), `spaceDetail(id)`,
  `SPACE_MEMBERS(id)` table def (`/api/spaces/{id}/members`), `spaceCandidates(id, q)`.
- `prefetch.tsx` `reads.spaces`, `reads.space(id)`, `reads.spaceMembers(id, sp)`.
- `nav.ts`: grup baru `NavGroup` `"space"` label "Space"; item `{ href: "/spaces", label: "Members", icon: "members",
  shortcut: <huruf bebas berikutnya atau "">, group: "space", perm: null }`. `/spaces` membuka space aktif (Task 3),
  jadi `isActive` menandai Members aktif di `/spaces/<id>/members`.
- `prefs.ts`: `Prefs.space: string | null` — UUID space terakhir (validasi UUID saat parse; selain itu null);
  `prefsCookie` menulisnya. Disebut "remembered per user" di Figma; cookie per browser adalah keputusan plan ini.
- `use-spaces.ts`: `useSpaces()` (list semua space pemanggil, untuk switcher), `useSpace(id)`, `useSpaceMembers(id)`
  (`useTableQuery`), `useCandidates(id, q)`, `spaceHref(id, page: "members")`, `ROLE_LABEL: Record<SpaceRole,string>`,
  `ROLE_DESCRIPTION: Record<SpaceRole,string>` (copy final di bawah).

- [ ] **Step 1: Tes gagal** — `nav.test.ts`: grup "Space" berisi Members untuk semua signed-in user; shortcut unik.
  `prefs.test.ts`: `space` round-trip, nilai bukan UUID → null. `queries.test.ts` sudah membaca nama modul dari
  `apps/api/src/modules/` → kunci "spaces" valid. `use-spaces.test.ts`: `ROLE_LABEL`/`ROLE_DESCRIPTION` punya ketujuh role.
- [ ] **Step 2: Jalankan, gagal** — `bun run --filter @starterkit/web test -- nav prefs queries use-spaces`.
- [ ] **Step 3: Implementasi.**
- [ ] **Step 4: Jalankan, lulus.**
- [ ] **Step 5: Commit** `feat(web): spaces plumbing — queries, prefetch, nav group, remembered space`

### Task 3: Web — SpaceSwitcher di shell + route `/spaces` + "No space yet"

**Files:**
- Create: `apps/web/src/features/spaces/space-switcher.tsx`, `apps/web/src/features/spaces/no-space.tsx`,
  `apps/web/src/app/(main)/spaces/page.tsx`, `apps/web/src/app/(main)/spaces/loading.tsx`
- Modify: `apps/web/src/components/shell/{app-shell,sidebar,mobile-nav}.tsx` (slot di bawah brand; rail; drawer)
- Test: `apps/web/src/features/spaces/space-switcher.test.ts`, `apps/web/tests/e2e/spaces.spec.ts`

**Interfaces:**
- `/spaces` (server page): baca cookie `space` → bila pemanggil masih punya akses (dari `GET /api/spaces`), redirect
  ke `/spaces/<id>/members`; selain itu space pertama (urut nama); tidak ada space → render `NoSpace`.
- `SpaceSwitcher` state sesuai Build notes: Trigger Expanded·Default/Open/Single (satu space = label, bukan tombol),
  Rail (mark saja, nama di tooltip); Menu ≤4 item tanpa cari, ≥5 dengan cari; Item = menuitemradio (mark, nama, kode
  mono, role kamu di sini); `aria-haspopup="menu"`, panah/Enter/Esc mengembalikan fokus. Pilih space → tulis cookie →
  navigasi ke halaman yang sama di space baru bila path-nya ada (fase 1: hanya `members`), selain itu `members`.
  Jumlah recon per space tidak ditampilkan sampai Plan 3 menyediakan datanya.
- `NoSpace`: copy final; `CopyValue` username; pemegang `space.manage` melihat aksi "Create space" (dialog
  `CreateSpaceBody`: code + name; hasilnya membuka `/spaces/<id>/members`).
- Footnote menu: copy final "Switcher footnote".

- [ ] **Step 1: Tes gagal** — unit: target navigasi saat pindah space (path ada → sama; tidak ada → members). E2E:
  user demo dengan dua space berpindah lewat switcher dan URL berganti; cookie berisi UUID space yang sudah tidak bisa
  diakses → `/spaces` membuka space lain yang bisa (Review Focus 4); user tanpa space melihat "You're not a member of any
  space yet"; keyboard: buka menu, panah, Enter, Esc.
- [ ] **Step 2: Jalankan, gagal.**
- [ ] **Step 3: Implementasi.** Menu lewat Radix DropdownMenu yang sudah di-defer (`*-impl`, AGENTS §1).
- [ ] **Step 4: Jalankan unit + `bun run e2e` untuk spec ini, lulus; `bun run budget` tetap ≤ 250 kB.**
- [ ] **Step 5: Commit** `feat(web): space switcher in the shell and the spaces entry route`

### Task 4: Web — halaman Members (daftar + RoleMatrix)

**Files:**
- Create: `apps/web/src/app/(main)/spaces/[spaceId]/members/{page,loading}.tsx`,
  `apps/web/src/features/spaces/{members-page,member-columns,role-matrix}.tsx`
- Modify: `apps/web/src/lib/shared/prefs.ts` (`architecture.test.ts` "every page with a list screen is in VIEW_PAGES"
  mewajibkan halaman ini terdaftar; path-nya dinamis, jadi daftarkan sebagai pola `/spaces/[spaceId]/members` dengan
  view yang diingat per pola — bukan per space — dan perluas `isViewPage`/`viewHref`/tesnya untuk mencocokkan segmen
  dinamis), `apps/web/src/lib/shared/nav.ts` (`pagePerm` untuk `/spaces/*` = null; keanggotaan dicek lewat API di
  `page.tsx`, sehingga "each signed-in page guards with the permission pagePerm gives its path" tetap lulus), `apps/web/tests/e2e/{responsive,responsive-data,a11y,no-flicker}.spec.ts`,
  `apps/web/tests/e2e/helpers.ts` (`demoIds`), `apps/api/src/db/seed/demo.ts` (space demo: Treasury `treasury`, CTOP
  `ctop`, FICO `fico`; anggota dengan beberapa role; satu user tanpa space)
- Test: `apps/web/tests/e2e/spaces.spec.ts`, unit untuk kolom/matrix

**Interfaces:**
- `page.tsx`: guard sesi; ambil `GET /api/spaces/{id}` di server — 403/404 → `notFound()` (Review Focus 1);
  `<Prefetch reads={[reads.space(id), reads.spaceMembers(id, sp)]}>`; title = nama space.
- Kolom (Build notes): Member (title di phone) · Roles in this space (satu chip per role, `components/role-chips.tsx`
  pola) · Status (`StatusChip`: aktif = healthy "Active", nonaktif = stopped "Inactive") · Username (mono) · Last
  sign-in (`RelativeTime`, "Never" bila null). Tablet menyembunyikan Username dan Last sign-in. Toolbar mengikuti
  AGENTS §7 (SavedViewsMenu + ColumnsMenu, server paging, `FilterLayout` dengan search).
- `PageHeader`: judul "Members", deskripsi copy final; aksi utama "Add member" hanya untuk space_admin atau
  `space.manage`.
- Row menu (`ActionMenu`): "View activity" (link ke activity log terfilter user bila pemanggil punya `audit.view`,
  selain itu tidak ditampilkan), "Change roles", "Remove from space" (hanya space_admin / `space.manage`).
- `RoleMatrix`: read-only, 7 role × aksi dari Build notes; sel Does/Approves/Views/—; "—" `fg-3` + sr-only "Not allowed";
  scroll menyamping di dalam kartunya < 1280; catatan kaki aturan source_admin.

- [ ] **Step 1: Tes gagal** — E2E: anggota melihat daftar dengan kolom sesuai; viewer tidak melihat "Add member" dan
  row menu hanya "View activity"; non-anggota membuka URL → halaman 404 tanpa nama space; phone menampilkan kartu.
- [ ] **Step 2: Jalankan, gagal.**
- [ ] **Step 3: Implementasi.**
- [ ] **Step 4: Jalankan; tambah halaman ke responsive/a11y/no-flicker; `bun run e2e` dan `bun run budget` lulus.**
- [ ] **Step 5: Commit** `feat(web): space members page with role matrix`

### Task 5: Web — dialog Add member, Change roles, Remove member

**Files:**
- Create: `apps/web/src/features/spaces/{member-dialogs,role-checklist}.tsx`
- Modify: `apps/web/src/features/spaces/members-page.tsx`
- Test: `apps/web/src/features/spaces/role-checklist.test.ts`, `apps/web/tests/e2e/spaces.spec.ts`

**Interfaces:**
- `RoleChecklist({ value, onChange, canSourceAdmin: boolean, lockedSpaceAdmin: boolean })`: tujuh checkbox dengan
  `ROLE_DESCRIPTION`; Source admin nonaktif bila `!canSourceAdmin` dengan alasan copy final (tetap tercentang bila
  sudah dipegang); Space admin terkunci bila `lockedSpaceAdmin` (anggota ini satu-satunya space_admin aktif).
- Change roles: Save nonaktif sampai ada perubahan; tidak ada role dipilih → error inline copy final "No role
  picked"; `PUT …/members/{userId}`; 409 `last_space_admin` dan 403 ditampilkan di dalam dialog.
- Add member: `Combobox` (SearchCombobox) atas `GET …/candidates`, yang sudah anggota ditandai dan tidak bisa
  dipilih; role checklist; Add nonaktif sampai orang + ≥1 role dipilih; `PUT` untuk user itu.
- Remove member: `ConfirmActionDialog` destruktif dengan copy final; baris dampak break/approval **tidak** ditampilkan
  di fase ini (break dan approval belum ada — Plan 5 menambahkannya); untuk space_admin terakhir, aksi diganti
  `BlockedButton` dengan alasan copy final; `DELETE …/members/{userId}`.
- Semua dialog di-load lewat `next/dynamic` (pola `projects-page.tsx`), hasil diumumkan dengan `toast`.

- [ ] **Step 1: Tes gagal** — unit `RoleChecklist`: source_admin nonaktif untuk non-`space.manage`, tetap tercentang
  bila dipegang (Review Focus 2); space admin terkunci. E2E: space_admin menambah anggota dengan dua role; mengubah
  role; menghapus anggota; mencoba mengosongkan role → error inline; admin terakhir → BlockedButton dengan alasan.
- [ ] **Step 2: Jalankan, gagal.**
- [ ] **Step 3: Implementasi.**
- [ ] **Step 4: Jalankan unit + E2E spaces + `bun run check` + `bun run budget`, lulus.**
- [ ] **Step 5: Commit** `feat(web): add, change roles and remove space members`

## Copy final (dari Build notes · 01)

| Tempat | Teks |
|---|---|
| Members header | Members · People who can work in the {space} space and what each of them may do. A person can hold several roles. |
| Space admin | Adds and removes members, changes roles, approves write-offs above the reviewer limit and reopened days. |
| Source admin | Sets up source connections and credentials, and declares source fields. No access to recon config or breaks. |
| Config maker | Edits config drafts and source mappings, runs simulations, sends them for approval. |
| Config checker | Approves config and source versions that someone else made. |
| Operator | Works breaks: assigns, matches, and requests force matches, unmatches and write-offs. |
| Reviewer | Approves operators' requests and signs off business days. |
| Viewer | Sees recons, breaks and explanations, and exports CSV. |
| SoD caption | Someone can hold a maker and a checker role together. They still can't approve their own requests. |
| No role picked | Pick at least one role. To take {name} out of this space, use Remove from space. |
| Last space admin (tombol) | A space needs at least one space admin. |
| Last space admin (dialog) | Space admin can't be removed: {name} is the only space admin, and a space needs at least one. Make someone else a space admin first. |
| Source admin dinonaktifkan | Only an app admin can grant or remove Source admin. |
| Remove member | Remove {name} from {space}? · {name} loses access to {space} right away. {name}'s past actions stay in the activity log. |
| Add member | Add a member to {space} · People sign in with their bank directory account. Only people who have signed in once can be found. |
| Switcher footnote | The space you pick opens next time you sign in. Ask a space admin to join another space. |
| No space | You're not a member of any space yet · A space admin of your team adds you to their space. If your team has no space yet, a platform admin creates one. Send them your username: |

Catatan: "Add member" menyebut "signed in once"; kandidat di fase ini = semua user aplikasi (Task 1). Bila seorang user
belum pernah sign in, ia tetap bisa ditemukan — copy dipertahankan karena di bank user dibuat lewat sign-in direktori;
penyesuaian copy diputuskan saat review desain-vs-implementasi.

## Setelah plan ini

Minta designer-recon mereview implementasi terhadap page 01 (screenshot desktop/tablet/phone dari E2E). Catat
selisih yang disengaja (nilai kode affectUI) dan perbaiki selisih yang tidak disengaja di plan berikutnya.
