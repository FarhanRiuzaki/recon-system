import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, LineSegments, NormalBlending, PerspectiveCamera, Plane,
  Points, Raycaster, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer,
} from "three";
import { DUR } from "@starterkit/ui/motion";
import { hexToRgb, LEDGER, planLedgers } from "./ledger-plan";

/**
 * The sign-in backdrop, full bleed: "Two ledgers, matched". A halftone dot floor covers the page; two streams of
 * record dots come in from the left (side A) and the right (side B) toward a matching plane in the middle. When a
 * pair meets, a short arc links them with a brief glow and both settle into a matched lattice that grows outward. A
 * few records find no counterpart and wait at the plane's edge with a slow amber pulse, until the pass (a soft wave
 * across the floor, like a run) brings most of their counterparts. Then the loop fades and starts again. The dots
 * fall into place on load, the scene turns gently and leans toward the pointer, and the pointer lifts the floor
 * under it. The page keeps its text readable with its own scrim (`(auth)/layout.tsx`, `.auth-scrim`).
 *
 * Plain Three.js, loaded on demand by `auth-backdrop.tsx` (never in first-load JS). Decoration only: the records are
 * made up (`ledger-plan.ts`), no data, no network, no text. The loop's own clock (`LEDGER`, the shader constants
 * below) is the scene's timing, not UI motion; the load build-up uses the motion tokens.
 */

export type FieldColors = { ink: string; sun: string; match: string; wait: string; dark: boolean };
export type LedgerField = { setColors: (c: FieldColors) => void; dispose: () => void };

const L = LEDGER;
/** A record never matched in this loop: a time past the loop's end. */
const NEVER = 1e4;
/** Height records fly at; how long a waiting record takes to step to the meeting point. */
const FLY = 0.55;
const STEP = 0.8;

/** The pass front's x at clock t, shared by the floor and the lattice. */
const PASS_GLSL = /* glsl */ `
  float passWave(float x, float t) {
    float k = (t - ${L.passAt.toFixed(1)}) / ${L.pass.toFixed(1)};
    float on = step(0.0, k) * (1.0 - step(1.0, k));
    float front = mix(-22.0, 22.0, k);
    float d = (x - front) * 0.55;
    return exp(-d * d) * on * sin(3.1416 * clamp(k, 0.0, 1.0));
  }
`;

const FLOOR_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uClock;
  uniform float uRise;
  uniform float uSize;
  uniform vec3 uPointer;
  attribute float aRand;
  varying float vPass;
  varying float vLift;
  varying float vAlpha;
  ${PASS_GLSL}
  void main() {
    vec2 p = position.xz;
    float r = length(p);
    float reveal = clamp(uRise * 2.4 - r / 14.0 - aRand * 0.3, 0.0, 1.0);
    reveal = 1.0 - pow(1.0 - reveal, 3.0);
    float sweep = passWave(p.x, uClock);
    float pd = distance(p, uPointer.xy);
    float lift = exp(-pd * pd * 0.5) * uPointer.z;
    float wave = 0.18 * sin(p.x * 0.24 + uTime * 0.3) * cos(p.y * 0.28 - uTime * 0.22);
    float h = wave + sweep * 0.32 + lift * 0.6 + (1.0 - reveal) * (1.0 + aRand * 4.0);
    vec4 mv = modelViewMatrix * vec4(p.x, h, p.y, 1.0);
    gl_Position = projectionMatrix * mv;
    vPass = sweep;
    vLift = lift;
    // The matching plane: a faint seam of brighter dots down the middle.
    float seam = exp(-p.x * p.x * 3.0) * 0.35;
    vAlpha = reveal * (0.42 + seam) * smoothstep(30.0, 9.0, r);
    gl_PointSize = uSize * 0.75 * (1.0 + sweep * 0.5 + lift * 0.6) * (16.0 / -mv.z);
  }
`;
const FLOOR_FRAGMENT = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uSun;
  uniform float uOpacity;
  varying float vPass;
  varying float vLift;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float edge = 1.0 - smoothstep(0.3, 0.5, d);
    vec3 col = mix(uInk, uSun, clamp(vPass * 1.3, 0.0, 1.0));
    float a = edge * vAlpha * uOpacity * 0.45 * (1.0 + vPass * 1.6 + vLift * 0.8);
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, min(a, 1.0));
  }
`;

const RECORD_VERTEX = /* glsl */ `
  uniform float uClock;
  uniform float uRise;
  uniform float uSize;
  attribute vec2 aFrom;
  attribute vec2 aHold;
  attribute vec2 aSlot;
  attribute vec3 aTime;
  attribute float aSide;
  attribute float aWaits;
  varying float vSettled;
  varying float vFresh;
  varying float vWait;
  varying float vAlpha;
  ${PASS_GLSL}
  float smooth01(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
  float easeOut(float x) { x = clamp(x, 0.0, 1.0); return 1.0 - pow(1.0 - x, 3.0); }
  void main() {
    float t = uClock;
    float tS = aTime.x, tA = aTime.y, tM = aTime.z;
    vec2 meet = vec2(aSide * ${L.meet.toFixed(2)}, aSlot.y);
    vec2 p = mix(aFrom, aHold, smooth01((t - tS) / max(tA - tS, 0.001)));
    p = mix(p, meet, smooth01((t - (tM - ${STEP.toFixed(1)})) / ${STEP.toFixed(1)}));
    float s = easeOut((t - tM) / ${L.settle.toFixed(1)});
    p = mix(p, aSlot, s);
    float y = mix(${FLY.toFixed(2)} + 0.05 * sin(t * 1.3 + aFrom.y * 2.0), 0.12, s);
    float sweep = passWave(p.x, t) * s;
    y += sweep * 0.2;
    vec4 mv = modelViewMatrix * vec4(p.x, y, p.y, 1.0);
    gl_Position = projectionMatrix * mv;

    float waiting = aWaits * step(tA, t) * (1.0 - step(tM - ${STEP.toFixed(1)}, t));
    vWait = waiting * (0.6 + 0.4 * sin(t * 1.4 + aFrom.x));
    vSettled = s;
    vFresh = step(tM, t) * exp(-max(t - tM, 0.0) * 1.2) + sweep * 0.6;
    float shown = smoothstep(tS, tS + 0.8, t) * (1.0 - smoothstep(${(L.cycle - L.fade).toFixed(1)}, ${L.cycle.toFixed(1)}, t));
    vAlpha = shown * clamp(uRise * 2.0 - 0.6, 0.0, 1.0);
    gl_PointSize = uSize * mix(2.8, 2.3, s) * (1.0 + vFresh * 0.6 + waiting * 0.35) * (16.0 / -mv.z);
  }
`;
const RECORD_FRAGMENT = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uMatch;
  uniform vec3 uWait;
  uniform float uOpacity;
  varying float vSettled;
  varying float vFresh;
  varying float vWait;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float edge = 1.0 - smoothstep(0.32, 0.5, d);
    vec3 col = mix(uInk, mix(uInk, uMatch, 0.85), vSettled);
    col = mix(col, uMatch, clamp(vFresh, 0.0, 1.0));
    col = mix(col, uWait, step(0.01, vWait));
    float a = edge * vAlpha * uOpacity * (1.0 + vFresh * 0.4 + vWait * 0.5);
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, min(a, 1.0));
  }
`;

/** The link between a pair as they meet: drawn from A to B, then fading. */
const ARC_VERTEX = /* glsl */ `
  uniform float uClock;
  attribute float aT;
  attribute float aMatch;
  varying float vA;
  void main() {
    float t = uClock;
    float drawn = clamp((t - (aMatch - 0.35)) / 0.35, 0.0, 1.0);
    float fade = 1.0 - smoothstep(aMatch + 0.8, aMatch + 2.8, t);
    vA = step(aT, drawn) * fade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ARC_FRAGMENT = /* glsl */ `
  uniform vec3 uMatch;
  uniform float uOpacity;
  varying float vA;
  void main() { if (vA < 0.01) discard; gl_FragColor = vec4(uMatch, clamp(vA * uOpacity, 0.0, 1.0)); }
`;

/** The arc again as round beads, so the link reads thicker than WebGL's 1 px line (owner 24 Nov: "kurang terlihat"). */
const ARC_DOT_VERTEX = /* glsl */ `
  uniform float uClock;
  uniform float uSize;
  attribute float aT;
  attribute float aMatch;
  varying float vA;
  void main() {
    float t = uClock;
    float drawn = clamp((t - (aMatch - 0.35)) / 0.35, 0.0, 1.0);
    float fade = 1.0 - smoothstep(aMatch + 0.8, aMatch + 2.8, t);
    vA = step(aT, drawn) * fade * 0.8;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * 0.9 * (16.0 / -mv.z);
  }
`;
const ARC_DOT_FRAGMENT = /* glsl */ `
  uniform vec3 uMatch;
  uniform float uOpacity;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = (1.0 - smoothstep(0.3, 0.5, d)) * vA * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uMatch, min(a, 1.0));
  }
`;

/** A soft glow over the arc's top when a pair meets. */
const GLOW_VERTEX = /* glsl */ `
  uniform float uClock;
  uniform float uSize;
  attribute float aMatch;
  varying float vA;
  void main() {
    float k = (uClock - aMatch) / 0.9;
    vA = exp(-k * k);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * 11.0 * (16.0 / -mv.z);
  }
`;
const GLOW_FRAGMENT = /* glsl */ `
  uniform vec3 uMatch;
  uniform float uOpacity;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = exp(-d * d * 16.0) * vA * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uMatch, min(a, 1.0));
  }
`;

const ease = (x: number) => 1 - (1 - x) ** 3;

export function createLedgerField(canvas: HTMLCanvasElement, { reduced, colors }: { reduced: boolean; colors: FieldColors }): LedgerField {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 120);
  const field = new Group();
  scene.add(field);
  const phone = canvas.clientWidth < 768;
  const { records, pairs } = planLedgers(L.seed);

  const shared = {
    uTime: { value: 0 },
    uClock: { value: 0 },
    uRise: { value: reduced ? 1 : 0 },
    uSize: { value: 3 },
    uInk: { value: new Color() },
    uSun: { value: new Color() },
    uMatch: { value: new Color() },
    uWait: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const material = (vertexShader: string, fragmentShader: string, extra: Record<string, { value: unknown }> = {}) =>
    new ShaderMaterial({ uniforms: { ...shared, ...extra }, vertexShader, fragmentShader, transparent: true, depthWrite: false });
  const geometry = (attrs: Record<string, [Float32Array, number]>) => {
    const g = new BufferGeometry();
    for (const [name, [data, size]] of Object.entries(attrs)) g.setAttribute(name, new BufferAttribute(data, size));
    return g;
  };
  const rand = (() => { let s = 91; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

  // The halftone floor over the whole page.
  const GAP = phone ? 0.5 : 0.4;
  const floor: number[] = [];
  for (let x = -30; x <= 30; x += GAP) for (let z = -20; z <= 20; z += GAP) floor.push(x + GAP / 2, 0, z + GAP / 2);
  const floorGeo = geometry({ position: [new Float32Array(floor), 3], aRand: [Float32Array.from({ length: floor.length / 3 }, rand), 1] });
  const pointer = new Vector3();
  const floorMat = material(FLOOR_VERTEX, FLOOR_FRAGMENT, { uPointer: { value: pointer } });
  const floorDots = new Points(floorGeo, floorMat);
  floorDots.frustumCulled = false;
  field.add(floorDots);

  // Record dots: every position is worked out in the shader from the plan's times.
  const n = records.length;
  const at = (pick: (r: (typeof records)[number]) => readonly number[], size: number): [Float32Array, number] =>
    [Float32Array.from(records.flatMap((r) => [...pick(r)])), size];
  const recordGeo = geometry({
    position: [new Float32Array(n * 3), 3],
    aFrom: at((r) => r.from, 2),
    aHold: at((r) => r.hold, 2),
    aSlot: at((r) => r.slot, 2),
    aTime: at((r) => [r.tStart, r.tArrive, Number.isFinite(r.tMatch) ? r.tMatch : NEVER], 3),
    aSide: at((r) => [r.side], 1),
    aWaits: at((r) => [r.waits ? 1 : 0], 1),
  });
  const recordMat = material(RECORD_VERTEX, RECORD_FRAGMENT);
  const recordDots = new Points(recordGeo, recordMat);
  recordDots.frustumCulled = false;
  field.add(recordDots);

  // One arc per pair between the two meeting points, and a glow over its top.
  const SEGS = 28;
  const arcPos: number[] = [], arcT: number[] = [], arcMatch: number[] = [];
  const glowPos: number[] = [], glowMatch: number[] = [];
  for (const p of pairs) {
    const z = records[p.a]!.slot[1];
    const point = (u: number) => [(u * 2 - 1) * L.meet, FLY + Math.sin(Math.PI * u) * 0.45, z];
    for (let k = 0; k < SEGS; k++) {
      arcPos.push(...point(k / SEGS), ...point((k + 1) / SEGS));
      arcT.push(k / SEGS, (k + 1) / SEGS);
      arcMatch.push(p.tMatch, p.tMatch);
    }
    glowPos.push(0, FLY + 0.45, z);
    glowMatch.push(p.tMatch);
  }
  const arcGeo = geometry({ position: [new Float32Array(arcPos), 3], aT: [new Float32Array(arcT), 1], aMatch: [new Float32Array(arcMatch), 1] });
  const arcMat = material(ARC_VERTEX, ARC_FRAGMENT);
  field.add(new LineSegments(arcGeo, arcMat));
  const arcDotMat = material(ARC_DOT_VERTEX, ARC_DOT_FRAGMENT);
  const arcDots = new Points(arcGeo, arcDotMat);
  arcDots.frustumCulled = false;
  field.add(arcDots);
  const glowGeo = geometry({ position: [new Float32Array(glowPos), 3], aMatch: [new Float32Array(glowMatch), 1] });
  const glowMat = material(GLOW_VERTEX, GLOW_FRAGMENT);
  const glow = new Points(glowGeo, glowMat);
  glow.frustumCulled = false;
  field.add(glow);

  const materials = [floorMat, recordMat, arcMat, arcDotMat, glowMat];
  const tint = (c: Color, value: string) => { const rgb = hexToRgb(value); if (rgb) c.setRGB(...rgb); };
  function setColors(c: FieldColors) {
    // Raw token values: these shaders write their colour as given, so the screen shows the token itself.
    tint(shared.uInk.value, c.ink);
    tint(shared.uSun.value, c.sun);
    tint(shared.uMatch.value, c.match);
    tint(shared.uWait.value, c.wait);
    shared.uOpacity.value = c.dark ? 0.9 : 1;
    for (const m of materials) {
      m.blending = c.dark ? AdditiveBlending : NormalBlending;
      m.needsUpdate = true;
    }
    if (reduced) draw();
  }

  /** The matching plane sits between the headline and the form; on a phone, in the space under the form. */
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const narrow = w < 768;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const back = camera.aspect < 1 ? Math.max(1.3, 0.9 / camera.aspect) : w < 1280 ? 1.15 : 1;
    camera.position.set(0, 8.5 * back, 10.5 * back);
    camera.lookAt(0, 0, 0.4);
    const cy = narrow ? h * 0.8 : h * 0.56;
    camera.setViewOffset(w, h, 0, h / 2 - cy, w, h);
    camera.updateProjectionMatrix();
    shared.uSize.value = 3.2 * renderer.getPixelRatio() * (narrow ? 1.1 : 1);
    if (reduced) draw();
  }

  // The pointer, on the ground plane in the field's own frame.
  const ray = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const ndc = new Vector2();
  const hit = new Vector3();
  const target = new Vector3();
  let pointerSeen = 0;
  function onPointer(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (ray.ray.intersectPlane(ground, hit)) {
      field.worldToLocal(hit);
      target.set(hit.x, hit.z, 1);
    }
    pointerSeen = performance.now();
  }

  function draw() {
    renderer.render(scene, camera);
  }

  let frame = 0;
  let start = 0;
  let hiddenAt = 0;
  let turn = 0;
  // The build-up uses motion tokens: one flash plus two tweens, eased out.
  const riseSeconds = DUR.flash + DUR.tween + DUR.tween;
  function tick(now: number) {
    if (!start) start = now;
    const t = (now - start) / 1000;
    shared.uTime.value = t;
    shared.uClock.value = t % L.cycle;
    shared.uRise.value = ease(Math.min(1, t / riseSeconds));
    if (now - pointerSeen > 2500) target.z = 0;
    pointer.x += (target.x - pointer.x) * 0.1;
    pointer.y += (target.y - pointer.y) * 0.1;
    pointer.z += (target.z - pointer.z) * 0.06;
    turn += (ndc.x * 0.1 - turn) * 0.03;
    field.rotation.y = Math.sin(t * 0.06) * 0.08 + turn;
    field.rotation.x = -ndc.y * 0.03;
    draw();
    frame = requestAnimationFrame(tick);
  }
  // A hidden tab stops the loop; the clock resumes where it stopped.
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      hiddenAt = performance.now();
    } else if (!frame) {
      if (start) start += performance.now() - hiddenAt;
      frame = requestAnimationFrame(tick);
    }
  }

  setColors(colors);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  if (reduced) {
    // One still frame: the lattice nearly grown, a few records waiting for the pass.
    shared.uTime.value = 2;
    shared.uClock.value = L.passAt - 0.5;
    draw();
  } else {
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) frame = requestAnimationFrame(tick);
    else hiddenAt = performance.now();
  }

  return {
    setColors,
    dispose() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const g of [floorGeo, recordGeo, arcGeo, glowGeo]) g.dispose();
      for (const m of materials) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
