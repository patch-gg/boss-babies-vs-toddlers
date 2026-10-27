export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));
export const rr = (r: Rng, a: number, b: number) => a + (b - a) * r();
export const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length];
export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Yaw convention: forward = (-sin yaw, 0, -cos yaw). Yaw that looks along (dx, dz). */
export const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** Simulation-time scheduler. In step mode (offline capture) timers follow sim time, otherwise they are plain setTimeout. */
export const clock = { step: false, t: 0, seq: 1, q: [] as { id: number; at: number; fn: () => void }[] };
export function after(ms: number, fn: () => void): number {
  if (!clock.step) return window.setTimeout(fn, ms);
  const id = clock.seq++;
  clock.q.push({ id, at: clock.t + ms / 1000, fn });
  return id;
}
export function cancel(id: number) {
  if (!clock.step) { clearTimeout(id); return; }
  const i = clock.q.findIndex((x) => x.id === id);
  if (i >= 0) clock.q.splice(i, 1);
}
export function tickClock(dt: number) {
  clock.t += dt;
  if (!clock.step || !clock.q.length) return;
  const due = clock.q.filter((x) => x.at <= clock.t);
  if (due.length) { clock.q = clock.q.filter((x) => x.at > clock.t); for (const d of due) d.fn(); }
}
