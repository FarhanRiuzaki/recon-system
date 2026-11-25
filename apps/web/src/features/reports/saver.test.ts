import { describe, expect, it } from "vitest";
import { serialSaver } from "./saver";

const later = () => { let done!: () => void; const p = new Promise<void>((r) => { done = r; }); return { p, done }; };

describe("serialSaver", () => {
  it("one save at a time: a change made while one is sent goes after it, and only the latest of those", async () => {
    const sent: string[] = [];
    const gates: ReturnType<typeof later>[] = [];
    const s = serialSaver<string>(async (v) => { sent.push(v); const g = later(); gates.push(g); await g.p; });
    s.push("a"); s.push("b"); s.push("c");
    expect(sent).toEqual(["a"]);
    gates[0]!.done(); await Promise.resolve(); await Promise.resolve();
    expect(sent).toEqual(["a", "c"]);
    const flushed = s.flush();
    gates[1]!.done();
    await flushed;
    expect(sent).toEqual(["a", "c"]);
  });
});
