/**
 * The pure part of the sign-in backdrop ("Two ledgers, matched", `ledger-field.ts`): where each record dot starts,
 * when it meets its counterpart and which lattice slot the pair settles into. No three, no DOM: unit-tested in
 * `ledger-plan.test.ts`. Decoration only: the records are made up for the picture, never real data.
 */

/** The scene's own clock, in seconds of one loop, and its layout in world units. */
export const LEDGER = {
  seed: 2207,
  /** One loop: records arrive, the pass runs, the lattice holds, everything fades and starts again. */
  cycle: 36,
  /** When the pass (a soft wave across the floor, left to right) starts, and how long it takes to cross. */
  passAt: 21,
  pass: 6,
  /** A record's trip from the page's side to the matching plane; a matched pair's glide into its slot; the loop's fade. */
  travel: 4.8,
  settle: 1.6,
  fade: 3,
  /** Pairs that match on arrival; records that wait for a counterpart, and how many of those the pass leaves waiting. */
  pairs: 24,
  orphans: 6,
  unresolved: 2,
  /** The matched lattice: rows along z, rings outward from the middle on each side. */
  rows: 8,
  rings: 4,
  spacing: 0.46,
  /** Where records start (|x|), where a pair meets (|x|) and where a record with no counterpart waits (|x|). */
  reach: 13,
  meet: 0.55,
  wait: 1.3,
} as const;

export type XZ = readonly [number, number];
export type LedgerRecord = {
  /** -1 = side A (enters from the left), 1 = side B (from the right). */
  side: -1 | 1;
  tStart: number;
  /** Reaches its hold point; equal to tMatch unless it waits. */
  tArrive: number;
  /** Meets its counterpart; Infinity when it never does in this loop. */
  tMatch: number;
  waits: boolean;
  from: XZ;
  hold: XZ;
  slot: XZ;
};
export type LedgerPair = { a: number; b: number; tMatch: number; ring: number };

/** Deterministic picks (mulberry32): the same picture every visit. */
export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lattice slots from the middle outward: inner ring first, centre rows first within a ring. */
function slots() {
  const { rows, rings } = LEDGER;
  const mid = (rows - 1) / 2;
  const all: { ring: number; row: number }[] = [];
  for (let ring = 0; ring < rings; ring++) for (let row = 0; row < rows; row++) all.push({ ring, row });
  return all.sort((x, y) => x.ring - y.ring || Math.abs(x.row - mid) - Math.abs(y.row - mid) || x.row - y.row);
}
const rowZ = (row: number) => (row - (LEDGER.rows - 1) / 2) * LEDGER.spacing;
const ringX = (ring: number) => (ring + 0.75) * LEDGER.spacing;

export function planLedgers(seed: number): { records: LedgerRecord[]; pairs: LedgerPair[] } {
  const L = LEDGER;
  const rand = seeded(seed);
  const side = (): -1 | 1 => (rand() < 0.5 ? -1 : 1);
  type Draft = { side: -1 | 1; tStart: number; tArrive: number; tMatch: number; waits: boolean };
  const drafts: Draft[] = [];
  const matches: { a: number; b: number; tMatch: number }[] = [];
  const onArrival = (tMatch: number) => {
    const trip = L.travel * (0.85 + rand() * 0.3);
    return { tStart: tMatch - trip, tArrive: tMatch, tMatch, waits: false };
  };

  // Pairs that match as they arrive, spread evenly up to the pass.
  const first = L.travel * 1.15 + 0.4;
  const gap = (L.passAt - 1 - first) / L.pairs;
  for (let k = 0; k < L.pairs; k++) {
    const t = first + k * gap + rand() * gap * 0.5;
    drafts.push({ side: -1, ...onArrival(t) }, { side: 1, ...onArrival(t) });
    matches.push({ a: drafts.length - 2, b: drafts.length - 1, tMatch: t });
  }

  // Records with no counterpart yet: they arrive and wait. The pass brings most counterparts, one after another as
  // the wave crosses the middle; a random few stay unmatched.
  const order = Array.from({ length: L.orphans }, (_, j) => ({ j, r: rand() })).sort((x, y) => x.r - y.r).map((o) => o.j);
  const left = new Set(order.slice(0, L.unresolved));
  let resolved = 0;
  for (let j = 0; j < L.orphans; j++) {
    const s = side();
    const tStart = 1 + j * ((L.passAt - L.travel * 1.2 - 2) / L.orphans) + rand() * 0.6;
    const tArrive = tStart + L.travel * (0.9 + rand() * 0.2);
    if (left.has(j)) { drafts.push({ side: s, tStart, tArrive, tMatch: Infinity, waits: true }); continue; }
    const tMatch = L.passAt + L.pass * 0.5 + resolved++ * 0.35;
    drafts.push({ side: s, tStart, tArrive, tMatch, waits: true }, { side: s === -1 ? 1 : -1, ...onArrival(tMatch) });
    const [w, c] = [drafts.length - 2, drafts.length - 1];
    matches.push(s === -1 ? { a: w, b: c, tMatch } : { a: c, b: w, tMatch });
  }

  // Slots in the order pairs match, so the lattice grows outward.
  const free = slots();
  const slotOf = new Map<number, XZ>();
  const pairs: LedgerPair[] = [...matches].sort((x, y) => x.tMatch - y.tMatch).map((m, k) => {
    const { ring, row } = free[k]!;
    slotOf.set(m.a, [-ringX(ring), rowZ(row)]);
    slotOf.set(m.b, [ringX(ring), rowZ(row)]);
    return { ...m, ring };
  });

  const records: LedgerRecord[] = drafts.map((d, i) => {
    const slot = slotOf.get(i) ?? [d.side * L.meet, rowZ(Math.floor(rand() * L.rows))];
    const z = slot[1];
    const from: XZ = [d.side * L.reach * (0.9 + rand() * 0.2), z * 2.4 + (rand() - 0.5) * 3];
    const hold: XZ = [d.side * (d.waits ? L.wait : L.meet), z];
    return { ...d, from, hold, slot: slotOf.has(i) ? slot : hold };
  });
  return { records, pairs: pairs.sort((x, y) => x.a - y.a) };
}

/** A token's `#rrggbb` or `#rgb` as 0–1 channels; anything else is null (the scene keeps its last colour). */
export function hexToRgb(value: string): [number, number, number] | null {
  const v = value.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}
