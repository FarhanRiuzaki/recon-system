import { describe, expect, it } from "vitest";
import { saveQueue } from "./save-queue";

/** A send whose answer the test gives later. */
function deferred() {
  let answer!: (ok: boolean) => void;
  const calls: string[] = [];
  const send = (json: string) => () => { calls.push(json); return new Promise<boolean>((r) => { answer = r; }); };
  return { send, calls, answer: (ok: boolean) => answer(ok) };
}

describe("saveQueue: Run simulation simulates the spec on screen", () => {
  it("flush waits for the save under way, then sends the change it left out, in that order", async () => {
    const q = saveQueue("v0"), d = deferred();
    void q.save("v1", d.send("v1"));
    const flushed = q.flush("v2", d.send("v2"));
    expect(d.calls).toEqual(["v1"]);
    d.answer(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.calls).toEqual(["v1", "v2"]);
    d.answer(true);
    expect(await flushed).toBe(true);
    expect(q.saved()).toBe("v2");
  });

  it("flush sends nothing when the save under way already holds the spec", async () => {
    const q = saveQueue("v0"), d = deferred();
    void q.save("v1", d.send("v1"));
    const flushed = q.flush("v1", d.send("v1-again"));
    d.answer(true);
    expect(await flushed).toBe(true);
    expect(d.calls).toEqual(["v1"]);
  });

  it("flush answers false and sends nothing more when the save under way was refused", async () => {
    const q = saveQueue("v0"), d = deferred();
    void q.save("v1", d.send("v1"));
    const flushed = q.flush("v1", d.send("again"));
    d.answer(false);
    expect(await flushed).toBe(false);
    expect(d.calls).toEqual(["v1"]);
    expect(q.saved()).toBe("v0");
  });

  it("a save while one runs gets that one's answer; nothing is sent twice", async () => {
    const q = saveQueue("v0"), d = deferred();
    const a = q.save("v1", d.send("v1")), b = q.save("v2", d.send("v2"));
    expect(b).toBe(a);
    d.answer(true);
    await a;
    expect(d.calls).toEqual(["v1"]);
    expect(q.busy()).toBe(false);
  });

  it("flush with nothing pending and nothing changed answers true without a request", async () => {
    const q = saveQueue("v0"), d = deferred();
    expect(await q.flush("v0", d.send("v0"))).toBe(true);
    expect(d.calls).toEqual([]);
  });
});
