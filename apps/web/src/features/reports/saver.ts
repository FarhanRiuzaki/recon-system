// The draft's saves, one at a time (final review I9): a change made while a save is sent waits for it and only the
// latest waiting one is sent, so an older save can never land after a newer one; flush() waits until all are stored.
export function serialSaver<T>(save: (v: T) => Promise<void>) {
  let running: Promise<void> | null = null;
  let next: { v: T } | null = null;
  const run = (v: T): Promise<void> => {
    running = save(v).finally(() => {
      running = null;
      if (next) { const n = next; next = null; void run(n.v); }
    });
    return running;
  };
  return {
    push(v: T) { if (running) next = { v }; else void run(v); },
    async flush() { while (running) await running.catch(() => {}); },
  };
}
