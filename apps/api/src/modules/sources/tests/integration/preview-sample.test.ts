// The preview's sample (owner, 21 Nov: the preview runs by itself on each change): the same reading answers from the
// rows pulled in the last 2 minutes, so mapping edits never query the bank's database again.
import { describe, expect, it } from "bun:test";
import { SAMPLE_TTL_MS, sampleOf } from "../../service";

describe("sampleOf", () => {
  it("pulls once per reading within the TTL; fresh, another reading or an older sample pull again", async () => {
    let pulls = 0, t = 1_000_000;
    const now = () => t;
    const pull = async () => { pulls++; return [{ a: String(pulls) }]; };
    const k = `k-${Bun.randomUUIDv7()}`;
    expect(await sampleOf(k, false, pull, now)).toEqual([{ a: "1" }]);
    expect(await sampleOf(k, false, pull, now)).toEqual([{ a: "1" }]);
    expect(pulls).toBe(1);
    expect(await sampleOf(k, true, pull, now)).toEqual([{ a: "2" }]); // Preview again
    expect(await sampleOf(`${k}-other`, false, pull, now)).toEqual([{ a: "3" }]);
    t += SAMPLE_TTL_MS;
    expect(await sampleOf(k, false, pull, now)).toEqual([{ a: "4" }]);
    expect(pulls).toBe(4);
  });
  it("a failed pull keeps nothing, so the next preview tries again", async () => {
    const k = `k-${Bun.randomUUIDv7()}`;
    expect(await sampleOf(k, false, async () => { throw new Error("down"); }).catch((e: Error) => e.message)).toBe("down");
    expect(await sampleOf(k, false, async () => [{ a: "ok" }])).toEqual([{ a: "ok" }]);
  });
});
