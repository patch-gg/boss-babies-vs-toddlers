import * as THREE from "three";
import { mulberry32, type Rng } from "./util";

/** Baby-food colours (lightened, no reds): carrot, pea, banana, blueberry, mashed pea, apricot */
export const FOOD = [0xffa648, 0x9be36a, 0xffe066, 0xa99af7, 0xb9ee8d, 0xffbd7a] as const;
/** Soft pastel pink = the pink team's colour (used for damage on the player). */
export const TEAM_PINK = 0xffa8d0;

/** Draw a cartoon food splat (blob + droplets + drips) onto a canvas. */
export function splatCanvas(color: number, seed: number, size = 128): HTMLCanvasElement {
  const r = mulberry32(seed);
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d")!;
  const cr = (color >> 16) & 255, cg = (color >> 8) & 255, cb = color & 255; // sRGB channels (not linear)
  const css = (k: number) => `rgb(${Math.min(255, cr * k) | 0},${Math.min(255, cg * k) | 0},${Math.min(255, cb * k) | 0})`;
  const cx = size / 2, cy = size / 2;
  const blob = (col: string, scale: number) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(cx, cy, size * 0.2 * scale, 0, 7);
    g.fill();
    const n = 9 + ((r() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.4;
      const d = size * (0.16 + r() * 0.17) * scale;
      const rad = size * (0.04 + r() * 0.08) * scale;
      g.beginPath();
      g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rad, 0, 7);
      g.fill();
      // short rounded spike
      g.beginPath();
      g.moveTo(cx + Math.cos(a - 0.2) * d * 0.5, cy + Math.sin(a - 0.2) * d * 0.5);
      g.lineTo(cx + Math.cos(a) * (d + rad * 1.1), cy + Math.sin(a) * (d + rad * 1.1));
      g.lineTo(cx + Math.cos(a + 0.2) * d * 0.5, cy + Math.sin(a + 0.2) * d * 0.5);
      g.fill();
    }
  };
  blob(css(0.9), 1.0);
  // satellite droplets
  g.fillStyle = css(0.9);
  for (let i = 0; i < 7; i++) {
    const a = r() * 7, d = size * (0.36 + r() * 0.12);
    g.beginPath();
    g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.012 + r() * 0.02), 0, 7);
    g.fill();
  }
  // drips (downwards)
  for (let i = 0; i < 3; i++) {
    const x = cx + (r() - 0.5) * size * 0.3, len = size * (0.12 + r() * 0.2), w = size * (0.03 + r() * 0.025);
    g.fillRect(x - w / 2, cy, w, len);
    g.beginPath(); g.arc(x, cy + len, w * 0.75, 0, 7); g.fill();
  }
  blob(css(1.0), 0.8);
  g.fillStyle = css(1.12);
  g.beginPath(); g.ellipse(cx - size * 0.06, cy - size * 0.07, size * 0.06, size * 0.035, -0.6, 0, 7); g.fill();
  return cv;
}

export class SplatTextures {
  private cache = new Map<string, THREE.CanvasTexture>();
  private urls = new Map<string, string>();
  tex(color: number, variant: number) {
    const k = `${color}:${variant}`;
    let t = this.cache.get(k);
    if (!t) {
      t = new THREE.CanvasTexture(splatCanvas(color, 1000 + variant * 77 + color, 128));
      t.colorSpace = THREE.SRGBColorSpace;
      this.cache.set(k, t);
    }
    return t;
  }
  url(color: number, variant: number) {
    const k = `${color}:${variant}`;
    let u = this.urls.get(k);
    if (!u) { u = splatCanvas(color, 500 + variant * 31 + color, 256).toDataURL(); this.urls.set(k, u); }
    return u;
  }
}


/** Instanced billboard-less sphere particles (cheap, fixed capacity). */
export class ParticleSystem {
  mesh: THREE.InstancedMesh;
  private n: number;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private life: Float32Array; private max: Float32Array; private size: Float32Array;
  private grav: Float32Array; private drag: Float32Array; private grow: Float32Array;
  private cursor = 0;
  private dirtyColor = false;
  private m = new THREE.Matrix4();
  private col = new THREE.Color();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private rng: Rng;
  /** Particles shrink to nothing close to this point (the camera) so they never mask a face or the screen. */
  nearFrom: THREE.Vector3 | null = null;
  constructor(scene: THREE.Scene, capacity: number, material: THREE.Material, rng: Rng, detail = 1) {
    this.rng = rng;
    this.n = capacity;
    const geo = new THREE.IcosahedronGeometry(0.5, detail);
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) { this.mesh.setColorAt(i, this.col.setHex(0xffffff)); }
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    const f = () => new Float32Array(capacity);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.max = f(); this.size = f(); this.grav = f(); this.drag = f(); this.grow = f();
    scene.add(this.mesh);
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number, size: number, life: number, grav = 9, drag = 0.5, grow = 0) {
    const i = this.cursor++ % this.n;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow;
    this.mesh.setColorAt(i, this.col.setHex(color));
    this.dirtyColor = true;
  }
  /** Burst of blobs spraying around a normal. */
  splat(p: THREE.Vector3, nrm: THREE.Vector3, color: number, count = 14, speed = 4, size = 0.08) {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      const sp = speed * (0.3 + r() * 0.9);
      this.emit(p.x, p.y, p.z, (nrm.x + (r() - 0.5) * 1.3) * sp, (nrm.y + (r() - 0.5) * 1.3) * sp + 1.5, (nrm.z + (r() - 0.5) * 1.3) * sp,
        color, size * (0.45 + r() * 0.7), 0.22 + r() * 0.22, 12, 1.6);
    }
  }
  /** Big powder puff / smoke explosion. */
  puff(x: number, y: number, z: number, count: number, spread: number, colors: number[], size = 1.0, up = 1.5) {
    const r = this.rng;
    for (let i = 0; i < count; i++) {
      const a = r() * 6.283, e = (r() - 0.3) * 1.2, sp = spread * (0.3 + r() * 0.7);
      this.emit(x + (r() - 0.5) * 0.4, y + r() * 0.3, z + (r() - 0.5) * 0.4,
        Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp * 0.6 + up * r(), Math.sin(a) * Math.cos(e) * sp,
        colors[(r() * colors.length) | 0], size * (0.5 + r() * 0.7), 0.7 + r() * 0.7, -0.4, 2.2, 1.6);
    }
  }
  update(dt: number) {
    const m = this.m;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (this.size[i] !== 0) { this.size[i] = 0; m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, m); } continue; }
      this.life[i] -= dt;
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d; this.vy[i] = this.vy[i] * d - this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.03 && this.grav[i] > 0) { this.py[i] = 0.03; this.vy[i] *= -0.2; this.vx[i] *= 0.6; this.vz[i] *= 0.6; }
      const t = 1 - this.life[i] / this.max[i];
      let sc = this.size[i] * (1 + this.grow[i] * t) * (t < 0.1 ? t * 10 : 1) * (t > 0.65 ? Math.max(0, (1 - t) / 0.35) : 1);
      if (this.nearFrom) {
        const dd = Math.hypot(this.px[i] - this.nearFrom.x, this.py[i] - this.nearFrom.y, this.pz[i] - this.nearFrom.z);
        if (dd < 2.2) sc *= Math.max(0, (dd - 0.5) / 1.7);
      }
      this.s.set(sc, sc, sc);
      this.p.set(this.px[i], this.py[i], this.pz[i]);
      m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.dirtyColor) { this.mesh.instanceColor!.needsUpdate = true; this.dirtyColor = false; }
  }
}

export class Decals {
  private pool: THREE.Mesh[] = [];
  private cursor = 0;
  private mats = new Map<string, THREE.MeshLambertMaterial>();
  private geo = new THREE.PlaneGeometry(1, 1);
  private scene: THREE.Scene; private tex: SplatTextures; private rng: Rng; private cap: number;
  constructor(scene: THREE.Scene, tex: SplatTextures, rng: Rng, cap = 150) { this.scene = scene; this.tex = tex; this.rng = rng; this.cap = cap; }
  spawn(p: THREE.Vector3, n: THREE.Vector3, color: number, size: number) {
    const variant = (this.rng() * 4) | 0;
    const k = `${color}:${variant}`;
    let mat = this.mats.get(k);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ map: this.tex.tex(color, variant), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.mats.set(k, mat);
    }
    let m = this.pool[this.cursor % this.cap];
    if (!m) { m = new THREE.Mesh(this.geo, mat); m.receiveShadow = true; m.renderOrder = 1; this.scene.add(m); this.pool[this.cursor % this.cap] = m; }
    this.cursor++;
    m.material = mat;
    m.position.copy(p).addScaledVector(n, 0.012 + (this.cursor % 7) * 0.0015);
    m.up.set(0, 1, 0);
    m.lookAt(p.x + n.x, p.y + n.y, p.z + n.z);
    if (Math.abs(n.y) > 0.7) m.rotateZ(this.rng() * 6.283); else m.rotateZ((this.rng() - 0.5) * 0.6);
    m.scale.setScalar(size);
    m.visible = true;
  }
  clear() { for (const m of this.pool) if (m) m.visible = false; }
}
