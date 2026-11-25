// POST …/sources/detect: how a sample file is read, from an Inbox files folder or a picked file; the preview reads the
// same sample by its id.
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DetectDto, SourceDto, SourcePreviewDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { utils, write } from "xlsx";
import { api, call, request, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { tendInbox } from "../../../inbox";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { ksei } from "../spec";

const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
let A: string, code: string, adm: string, mk: string, dir: string;
const app = api();
const base = () => `/v1/spaces/${A}/sources`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const pick = (token: string, name: string, bytes: Uint8Array) => request(app, `${base()}/detect`, {
  method: "POST", headers: { "X-Internal-Token": process.env.INTERNAL_API_TOKEN!, Authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), "content-length": String(bytes.length) }, body: bytes,
});
const KSEI = Array.from({ length: 5 }, (_, i) => ["A1", "B1", `TSTSRE00${i}`, "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11", "L12", `TSTSID00000000${i}`, "N14"].join("|")).join("\n") + "\n";

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  code = `d${A.slice(-10)}`;
  await db.insert(spaces).values({ id: A, code, name: "MSI" });
  const grant = async (u: string, role: SpaceRole) => { const [x] = await db.select({ id: users.id }).from(users).where(eq(users.username, u)); await db.insert(spaceMembers).values({ spaceId: A, userId: x!.id, role }); };
  await grant("admin", "source_admin"); await grant("viewer", "config_maker");
  adm = await signIn("admin"); mk = await signIn("viewer");
  dir = path.join(ROOT, code, "act");
  rmSync(path.join(ROOT, code), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

describe("POST …/sources/detect", () => {
  it("reads the newest matching file of an Inbox files folder; its sample id names that file", async () => {
    writeFileSync(path.join(dir, "act20261124.txt"), "x|y\n");
    writeFileSync(path.join(dir, "act20261125.txt"), KSEI);
    utimesSync(path.join(dir, "act20261124.txt"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const r = await json<DetectDto>(call("POST", `${base()}/detect`, { token: adm, body: { inbox: { path: dir, pattern: "act*.txt" } } }));
    expect(r).toMatchObject({ supported: true, fileName: "act20261125.txt", format: { kind: "delimited", delimiter: "|", header: false } });
    expect((r as { sampleId: string }).sampleId.startsWith("inbox:")).toBe(true);
  });

  it("an empty folder is 409 with what to do", async () => {
    const r = await call("POST", `${base()}/detect`, { token: adm, body: { inbox: { path: dir, pattern: "act*.txt" } } });
    expect([r.status, ((await r.json()) as { error: { message: string } }).error.message]).toEqual([409, "No file in this folder matches act*.txt yet. Upload one in Inbox files or pick a file."]);
  });

  it("a picked workbook is kept as a sample (24 h) and detected; a PDF isn't supported; over 20 MB is 413", async () => {
    const wb = utils.book_new(); utils.book_append_sheet(wb, utils.aoa_to_sheet([["ref", "amount"], ["A1", 1], ["A2", 2], ["A3", 3]]), "S");
    const r = await json<DetectDto>(pick(adm, "act.xlsx", new Uint8Array(write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer)));
    expect(r).toMatchObject({ supported: true, format: { kind: "excel", header: true } });
    expect(readdirSync(path.join(ROOT, code, ".samples"))).toHaveLength(1);
    expect(await json(pick(adm, "x.pdf", new TextEncoder().encode("%PDF-1.7")))).toMatchObject({ supported: false, type: "PDF" });
    expect((await pick(adm, "big.txt", new Uint8Array(21 * 1024 * 1024))).status).toBe(413);
  });

  it("a config maker can't detect (403): how a file is read is a source admin's", async () => {
    expect((await call("POST", `${base()}/detect`, { token: mk, body: { inbox: { path: dir, pattern: "*" } } })).status).toBe(403);
  });

  it("the janitor sweeps a sample a day old", async () => {
    const r = await json<DetectDto>(pick(adm, "a.txt", new TextEncoder().encode(KSEI)));
    expect(r.supported).toBe(true);
    const samples = path.join(ROOT, code, ".samples");
    const [f] = readdirSync(samples);
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(path.join(samples, f!), old, old);
    await tendInbox(db);
    expect(existsSync(path.join(samples, f!))).toBe(false);
  });
});

describe("the preview of a detected sample", () => {
  it("previews the spec over the sample by its id; a changed inbox file is 409", async () => {
    writeFileSync(path.join(dir, "act20261125.txt"), KSEI);
    const d = await json<DetectDto & { sampleId: string }>(call("POST", `${base()}/detect`, { token: adm, body: { inbox: { path: dir, pattern: "act*.txt" } } }));
    const s = await json<SourceDto>(call("POST", base(), { token: adm, body: { code: "act", name: "ACT", kind: "file_inbox" } }));
    const v = await json<SourceVersionDto>(call("POST", `${base()}/${s.id}/versions`, { token: mk }));
    const k = ksei();
    const spec = { ...k, input: { ...k.input, path: dir } };
    const p = await json<SourcePreviewDto>(call("POST", `${base()}/${s.id}/versions/${v.id}/preview`, { token: adm, body: { sampleId: d.sampleId, spec } }));
    expect(p.records.length).toBe(5);
    writeFileSync(path.join(dir, "act20261125.txt"), KSEI + KSEI);
    const r = await call("POST", `${base()}/${s.id}/versions/${v.id}/preview`, { token: adm, body: { sampleId: d.sampleId, spec } });
    expect([r.status, ((await r.json()) as { error: { message: string } }).error.message]).toEqual([409, "The sample file changed. Detect again."]);
  });
});
