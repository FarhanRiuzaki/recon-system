// The builder's saves in order (Run simulation must simulate the spec as it is on screen): one save at a time, a second
// request while one runs gets that one's answer, and `flush` waits for the save under way, then sends what it left out.

/** `send` sends the spec as it is now and answers whether the API took it; `json` is that spec, serialized. */
export type Send = () => Promise<boolean>;

export function saveQueue(saved: string) {
  let pending: Promise<boolean> | null = null;
  const q = {
    /** The spec as the API last took it. */
    saved: () => saved,
    /** Another save (a reload of the draft) set what the API holds. */
    reset: (json: string) => { saved = json; },
    busy: () => pending !== null,
    /** Sends `json` unless a save runs; then answers that save's outcome. */
    save(json: string, send: Send): Promise<boolean> {
      if (pending) return pending;
      const p = send().then((ok) => { if (ok) saved = json; return ok; }).finally(() => { pending = null; });
      pending = p;
      return p;
    },
    /** `json` saved: waits for a save under way; false when it failed; sends `json` if that save didn't cover it. */
    async flush(json: string, send: Send): Promise<boolean> {
      if (pending && !(await pending)) return false;
      return saved === json ? true : q.save(json, send);
    },
  };
  return q;
}
