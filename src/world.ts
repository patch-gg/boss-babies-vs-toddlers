import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mulberry32, type Rng } from "./util";

export type MapId = "nursery" | "backyard";
export interface Box {
  kind: 0; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; cover: boolean;
  /** top surface can be stood on / stepped onto (deck, steps) */
  walk?: boolean;
  /** blocks movement only: bullets and sight pass (railings) */
  noRay?: boolean;
}
/** Sloped walkable surface. Height runs linearly along `axis` from hA (at c0) to hB (at c1). */
export interface Ramp { x0: number; x1: number; z0: number; z1: number; axis: "x" | "z"; c0: number; c1: number; hA: number; hB: number }
/** A way between the lower yard and the top level: bottom (ground) and top (deck) waypoints on the ramp axis. */
export interface Route { name: string; bottom: THREE.Vector3; top: THREE.Vector3 }
/** max height a walker steps up without jumping (stairs, ramp surface, deck edge ramps) */
export const STEP_UP = 0.45;
export interface Ball { mesh: THREE.Mesh; x: number; y: number; z: number; vx: number; vz: number; r: number }
export interface RayHit { t: number; nx: number; ny: number; nz: number; type: "floor" | "wall" | "box" | "sph" | "ball"; ball?: Ball }
interface Sph { x: number; y: number; z: number; r: number }

const PASTEL = [0xff6b6b, 0xffd23f, 0x4dabf7, 0x69db7c, 0xb197fc, 0xffa94d, 0xf783ac];

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")!] as const;
}
function tex(c: HTMLCanvasElement, rx = 1, ry = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

export class World {
  id: MapId;
  hx: number; hz: number;
  group = new THREE.Group();
  boxes: Box[] = [];
  spheres: Sph[] = [];
  balls: Ball[] = [];
  spawns: THREE.Vector3[] = [];
  /** raycast-only solids (slabs approximating ramps) */
  rayBoxes: Box[] = [];
  ramps: Ramp[] = [];
  routes: Route[] = [];
  /** top level footprint (backyard deck) */
  deck: { x0: number; x1: number; z0: number; z1: number; y: number } | null = null;
  sun!: THREE.DirectionalLight;
  hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0, type: "floor" };
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private letterTex = new Map<string, THREE.CanvasTexture>();
  private r: Rng;
  private scene: THREE.Scene;
  /** footprints for the minimap: [cx, cz, w, d] */
  mapRects: number[][] = [];
  shaker: THREE.Object3D[] = [];

  constructor(id: MapId, scene: THREE.Scene) {
    this.id = id;
    this.scene = scene;
    this.r = mulberry32(id === "nursery" ? 7 : 11);
    this.hx = id === "nursery" ? 27 : 30;
    this.hz = id === "nursery" ? 18 : 19.5;
    scene.add(this.group);
    if (id === "nursery") this.buildNursery(); else this.buildBackyard();
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.mats.forEach((m) => m.dispose());
    this.letterTex.forEach((t) => t.dispose());
  }

  // ---------- helpers
  M(color: number, rough = 0.7, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    const key = `${color}|${rough}|${metal}|${Object.keys(extra).length}`;
    let m = this.mats.get(key);
    if (!m || Object.keys(extra).length) {
      m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
      this.mats.set(key, m);
    }
    return m;
  }

  add<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) { c.castShadow = cast; c.receiveShadow = receive; }
    });
    this.group.add(o);
    return o;
  }

  /** Solid box with base at y, optional collider. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material | THREE.Material[], collide = true, rounded = 0, cast = true, fl: Partial<Box> = {}) {
    const geo = rounded > 0 ? new RoundedBoxGeometry(w, h, d, 3, rounded) : new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + h / 2, z);
    this.add(m, cast, true);
    if (collide) this.collider(x, z, w, d, y, y + h, !fl.noRay, fl);
    return m;
  }

  collider(x: number, z: number, w: number, d: number, y0: number, y1: number, rect = true, fl: Partial<Box> = {}) {
    this.boxes.push({ kind: 0, x0: x - w / 2, x1: x + w / 2, y0, y1, z0: z - d / 2, z1: z + d / 2, cover: y1 - y0 >= 1.0 && !fl.noRay, ...fl });
    if (rect && y1 - y0 >= 0.3) this.mapRects.push([x, z, w, d]);
  }

  letterMat(letter: string, color: number) {
    const key = letter + color;
    let t = this.letterTex.get(key);
    if (!t) {
      const [c, g] = canvas(128, 128);
      g.fillStyle = hex(color);
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = "rgba(255,255,255,0.28)";
      g.fillRect(10, 10, 108, 108);
      g.strokeStyle = "rgba(0,0,0,0.12)"; g.lineWidth = 4; g.strokeRect(4, 4, 120, 120);
      g.fillStyle = "#fff";
      g.font = "900 88px 'Arial Rounded MT Bold', 'Trebuchet MS', Arial, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.shadowColor = "rgba(0,0,0,0.3)"; g.shadowBlur = 0; g.shadowOffsetX = 3; g.shadowOffsetY = 4;
      g.fillText(letter, 64, 70);
      t = tex(c);
      this.letterTex.set(key, t);
    }
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.45 });
  }

  /** Alphabet block stack (collider covers the whole stack). */
  blocks(x: number, z: number, s: number, levels: number, yaw = 0, y0 = 0) {
    const r = this.r;
    const col0 = PASTEL[(r() * PASTEL.length) | 0];
    for (let i = 0; i < levels; i++) {
      const col = PASTEL[(((r() * PASTEL.length) | 0) + i) % PASTEL.length] ?? col0;
      const mats = Array.from({ length: 6 }, () => this.letterMat(String.fromCharCode(65 + ((r() * 26) | 0)), col));
      const g = new RoundedBoxGeometry(s, s, s, 2, s * 0.05);
      const m = new THREE.Mesh(g, mats);
      const jitter = i === 0 ? yaw : (r() - 0.5) * 0.35;
      m.position.set(x + (i ? (r() - 0.5) * s * 0.1 : 0), y0 + s * (i + 0.5), z + (i ? (r() - 0.5) * s * 0.1 : 0));
      m.rotation.y = jitter;
      this.add(m);
    }
    const ext = yaw === 0 ? s : s * 1.1;
    this.collider(x, z, ext, ext, y0, y0 + s * levels);
  }

  sphereCollider(x: number, y: number, z: number, r: number) {
    this.spheres.push({ x, y, z, r });
    this.mapRects.push([x, z, r * 1.6, r * 1.6]);
  }

  ball(x: number, z: number, r: number, color: number, dynamic: boolean) {
    const [c, g] = canvas(128, 64);
    g.fillStyle = hex(color); g.fillRect(0, 0, 128, 64);
    g.fillStyle = "#fff";
    for (let i = 0; i < 4; i++) g.fillRect(i * 32 + 8, 0, 16, 64);
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshStandardMaterial({ map: tex(c), roughness: 0.3 }));
    m.position.set(x, r, z);
    this.add(m);
    if (dynamic) this.balls.push({ mesh: m, x, y: r, z, vx: 0, vz: 0, r });
    else this.sphereCollider(x, r, z, r);
  }

  scatterBalls(n: number, avoid: (x: number, z: number) => boolean) {
    const r = this.r;
    let placed = 0;
    for (let i = 0; i < 200 && placed < n; i++) {
      const x = (r() * 2 - 1) * (this.hx - 2), z = (r() * 2 - 1) * (this.hz - 2);
      if (avoid(x, z) || this.blocked(x, z, 0.9)) continue;
      this.ball(x, z, 0.28 + r() * 0.2, PASTEL[(r() * PASTEL.length) | 0], true);
      placed++;
    }
  }

  /** True if a walker standing at feet height y would be inside something at (x, z). Overhead slabs (deck from below) do not count. */
  blocked(x: number, z: number, rad: number, y = 0) {
    for (const b of this.boxes) {
      if (b.y0 >= y + 1.0 || b.y1 <= y + 0.1) continue;
      if (x > b.x0 - rad && x < b.x1 + rad && z > b.z0 - rad && z < b.z1 + rad) return true;
    }
    if (y < 0.5) for (const s of this.spheres) if (Math.hypot(x - s.x, z - s.z) < s.r + rad) return true;
    for (const rp of this.ramps) {
      if (x > rp.x0 - rad && x < rp.x1 + rad && z > rp.z0 - rad && z < rp.z1 + rad) { const h = this.rampH(rp, x, z); if (h > y + STEP_UP && h - 0.15 < y + 1.0) return true; }
    }
    return false;
  }

  rampH(rp: Ramp, x: number, z: number) {
    const c = rp.axis === "z" ? z : x;
    const t = Math.min(1, Math.max(0, (c - rp.c0) / (rp.c1 - rp.c0)));
    return rp.hA + (rp.hB - rp.hA) * t;
  }

  /** True while (x, z, y) is on a ramp surface. */
  onRamp(x: number, z: number, y: number): boolean {
    for (const rp of this.ramps) {
      if (x < rp.x0 || x > rp.x1 || z < rp.z0 || z > rp.z1) continue;
      const h = this.rampH(rp, x, z);
      if (h > 0.25 && Math.abs(y - h) < 0.3) return true;
    }
    return false;
  }

  /** Highest surface under (x, z) that a walker at feet height y can stand on (steps up to STEP_UP). */
  groundY(x: number, z: number, y: number): number {
    let g = 0;
    const lim = y + STEP_UP + 1e-3;
    for (const b of this.boxes) {
      if (!b.walk || b.y1 > lim || b.y1 <= g) continue;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) g = b.y1;
    }
    for (const rp of this.ramps) {
      if (x < rp.x0 || x > rp.x1 || z < rp.z0 || z > rp.z1) continue;
      const h = this.rampH(rp, x, z);
      if (h <= lim && h > g) g = h;
    }
    return g;
  }

  /** Lower-yard <-> top-level path: waypoints a bot should walk through, or null when both are on the same level. */
  route(fx: number, fz: number, fromTop: boolean, tx: number, tz: number): THREE.Vector3[] | null {
    if (!this.routes.length) return null;
    let best: Route | null = null, bd = 1e9;
    for (const r of this.routes) {
      const a = fromTop ? r.top : r.bottom, b = fromTop ? r.bottom : r.top;
      const d = Math.hypot(fx - a.x, fz - a.z) + Math.hypot(tx - b.x, tz - b.z);
      if (d < bd) { bd = d; best = r; }
    }
    if (!best) return null;
    return fromTop ? [best.top.clone(), best.bottom.clone()] : [best.bottom.clone(), best.top.clone()];
  }

  sky(top: number, bottom: number) {
    const [c, g] = canvas(8, 256);
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, hex(top)); gr.addColorStop(0.5, hex(bottom)); gr.addColorStop(1, hex(bottom));
    g.fillStyle = gr; g.fillRect(0, 0, 8, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 16, 12), new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false }));
    dome.renderOrder = -10;
    this.group.add(dome);
  }

  lights(sunPos: THREE.Vector3, sunColor: number, sunI: number, hemiSky: number, hemiGround: number, hemiI: number) {
    this.group.add(new THREE.HemisphereLight(hemiSky, hemiGround, hemiI));
    const s = new THREE.DirectionalLight(sunColor, sunI);
    s.position.copy(sunPos);
    s.castShadow = true;
    s.shadow.mapSize.set(2048, 2048);
    const e = Math.max(this.hx, this.hz) * 1.25;
    Object.assign(s.shadow.camera, { left: -e * 1.3, right: e * 1.3, top: e, bottom: -e, near: 5, far: 140 });
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.04;
    s.shadow.radius = 3;
    this.group.add(s, s.target);
    this.sun = s;
  }

  floor(texture: THREE.Texture, w: number, d: number) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 }));
    f.rotation.x = -Math.PI / 2;
    f.receiveShadow = true;
    this.group.add(f);
  }

  perimeterSpawns(n: number) {
    const r = this.r;
    let tries = 0;
    while (this.spawns.length < n && tries++ < 500) {
      const a = r() * Math.PI * 2;
      const x = Math.cos(a) * (this.hx - 2.5) * (r() < 0.5 ? 1 : 0.55), z = Math.sin(a) * (this.hz - 2.5) * (r() < 0.5 ? 1 : 0.6);
      if (!this.blocked(x, z, 1.2)) this.spawns.push(new THREE.Vector3(x, 0, z));
    }
  }

  // ---------- NURSERY
  buildNursery() {
    const { hx, hz } = this;
    const r = this.r;
    this.sky(0xbfe3ff, 0xfdf3df);
    (this.scene as THREE.Scene).background = new THREE.Color(0xdff1ff);
    this.lights(new THREE.Vector3(26, 38, 10), 0xfff0d6, 2.7, 0xfff6e8, 0xffd2b0, 1.35);

    // floor: soft wood planks
    {
      const [c, g] = canvas(512, 512);
      for (let i = 0; i < 8; i++) {
        const l = 0.74 + r() * 0.1;
        g.fillStyle = `hsl(${30 + r() * 6},${52 + r() * 10}%,${l * 100 - 12}%)`;
        g.fillRect(0, i * 64, 512, 64);
        g.strokeStyle = "rgba(120,70,30,0.10)";
        for (let k = 0; k < 7; k++) { g.lineWidth = 1 + r() * 2; g.beginPath(); const y = i * 64 + 6 + r() * 52; g.moveTo(0, y); g.bezierCurveTo(150, y + (r() - 0.5) * 10, 330, y + (r() - 0.5) * 10, 512, y); g.stroke(); }
        g.fillStyle = "rgba(90,50,20,0.35)"; g.fillRect(0, i * 64, 512, 2);
        const off = r() * 400; g.fillRect(off, i * 64, 2, 64);
      }
      this.floor(tex(c, hx / 2, hz / 2), hx * 2, hz * 2);
    }
    // ceiling (unlit cream) so it reads as a room
    {
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2), new THREE.MeshBasicMaterial({ color: 0xfff6ea }));
      ceil.rotation.x = Math.PI / 2; ceil.position.y = 9;
      this.group.add(ceil);
    }
    // walls
    const wallTex = (base: number, stripe: number) => {
      const [c, g] = canvas(256, 256);
      g.fillStyle = hex(base); g.fillRect(0, 0, 256, 256);
      g.fillStyle = hex(stripe);
      for (let i = 0; i < 4; i++) g.fillRect(i * 64 + 32, 0, 32, 256);
      g.fillStyle = "rgba(255,255,255,0.7)";
      for (let i = 0; i < 12; i++) { const x = (i % 4) * 64 + 16 + ((i / 4) | 0) % 2 * 32, y = ((i / 4) | 0) * 80 + 30; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
      return c;
    };
    const wallH = 9;
    const walls: [number, number, number, number, number, number][] = [
      [0, -hz, 0, hx * 2, 0xc9f2dd, 0xb4e8cc], [0, hz, Math.PI, hx * 2, 0xfff0b8, 0xffe58f],
      [-hx, 0, Math.PI / 2, hz * 2, 0xffd3e0, 0xffbfd3], [hx, 0, -Math.PI / 2, hz * 2, 0xcfe8ff, 0xb8dcff],
    ];
    for (const [x, z, ry, len, base, stripe] of walls) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(len, wallH), new THREE.MeshStandardMaterial({ map: tex(wallTex(base, stripe), len / 4, wallH / 4), roughness: 0.9 }));
      w.position.set(x, wallH / 2, z); w.rotation.y = ry; w.receiveShadow = true;
      this.group.add(w);
      // wainscot + baseboard
      const wain = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, 0.15), this.M(0xffffff, 0.6));
      wain.position.set(x, 0.7, z); wain.rotation.y = ry;
      wain.translateZ(0.07);
      this.add(wain, false, true);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.22), this.M(0xffffff, 0.5));
      rail.position.set(x, 1.45, z); rail.rotation.y = ry; rail.translateZ(0.1);
      this.add(rail, false, true);
    }
    // rainbow on the back wall
    const rainbow = [0xff6b6b, 0xffa94d, 0xffd93d, 0x69db7c, 0x4dabf7, 0xb197fc];
    rainbow.forEach((c, i) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(5.6 - i * 0.42, 0.21, 8, 40, Math.PI), this.M(c, 0.6));
      m.position.set(0, 2.2, -hz + 0.25);
      this.add(m, false, false);
    });
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.7 + (k % 2) * 0.25, 12, 8), this.M(0xffffff, 0.9));
        s.position.set(sx * (5.2 + (k - 1.5) * 0.5), 2.2 + 0.2 * (k % 2), -hz + 0.5); s.scale.z = 0.5;
        this.add(s, false, false);
      }
    }
    // windows on right wall
    for (const z of [-11, 0, 11]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(4, 4.4), new THREE.MeshBasicMaterial({ color: 0xcfeeff }));
      win.position.set(hx - 0.05, 4.8, z); win.rotation.y = -Math.PI / 2;
      this.group.add(win);
      const fr = this.M(0xffffff, 0.5);
      const parts: [number, number, number, number][] = [[0.2, 4.6, 0, 0], [0.2, 4.6, 0, 0]];
      void parts;
      for (const [w, h, ox, oy] of [[4.4, 0.25, 0, 2.2], [4.4, 0.25, 0, -2.2], [0.25, 4.6, 2.1, 0], [0.25, 4.6, -2.1, 0], [0.12, 4.4, 0, 0], [4, 0.12, 0, 0]] as number[][]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, w), fr);
        b.position.set(hx - 0.12, 4.8 + oy, z + ox);
        this.add(b, false, false);
      }
    }
    // hanging mobile bits
    for (let i = 0; i < 9; i++) {
      const x = (r() * 2 - 1) * (hx - 4), z = (r() * 2 - 1) * (hz - 3), y = 5.8 + r() * 1.6;
      const star = new THREE.Mesh(i % 3 === 0 ? new THREE.SphereGeometry(0.5, 12, 8) : new THREE.OctahedronGeometry(0.55), this.M(PASTEL[i % PASTEL.length], 0.5));
      star.position.set(x, y, z);
      const str = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 9 - y, 4), this.M(0xffffff));
      str.position.set(x, (9 + y) / 2, z);
      this.add(star, false, false); this.add(str, false, false);
      this.shaker.push(star);
    }
    // play mat (soft puzzle tiles)
    {
      const [c, g] = canvas(512, 512);
      const cols = [0xff6b6b, 0xffd23f, 0x4dabf7, 0x69db7c];
      for (let i = 0; i < 4; i++) {
        const x = (i % 2) * 256, y = ((i / 2) | 0) * 256;
        g.fillStyle = hex(cols[(i + ((i / 2) | 0)) % 4]); g.fillRect(x, y, 256, 256);
        g.strokeStyle = "rgba(255,255,255,0.45)"; g.lineWidth = 8; g.strokeRect(x + 6, y + 6, 244, 244);
        g.fillStyle = "rgba(255,255,255,0.9)"; g.font = "900 150px Arial"; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("ABCD"[i], x + 128, y + 136);
      }
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(18, 12), new THREE.MeshStandardMaterial({ map: tex(c, 3, 2), roughness: 0.9 }));
      mat.rotation.x = -Math.PI / 2; mat.position.set(-1.5, 0.012, 4.8); mat.receiveShadow = true;
      this.group.add(mat);
    }
    // alphabet block cover
    const S = 1.5;
    const B = (x: number, z: number, s: number, l: number, yaw = 0) => this.blocks(x * S, z * S, s, l, yaw);
    B(-8, -2, 2.2, 2); B(-5.4, -3.2, 1.6, 1); B(6, -4, 2.4, 2); B(8.5, -4.3, 1.6, 1);
    B(0.5, -0.5, 1.8, 3); B(-12.5, 4.5, 2, 1); B(-14.7, 4.7, 2, 2); B(10.5, 3.8, 2, 2);
    B(13, 2.6, 1.5, 1); B(-3.6, 7, 1.5, 1); B(4, 7.4, 1.5, 1); B(-6.5, -8.4, 2.2, 2);
    B(3.2, -9.2, 2, 1); B(5.5, -9.2, 2, 2); B(-1.4, 4.0, 1.2, 1, 0);
    // extra cover so the bigger room still has fights at every range
    const R = (x: number, z: number, s: number, l: number) => this.blocks(x, z, s, l);
    R(-6, -12, 2, 2); R(8, -14, 2.2, 1); R(16, -4, 2, 3); R(-22, 8, 2, 2); R(-11, 9.5, 1.8, 1); R(11, 10, 2, 2); R(0, -8.5, 2, 2);
    R(24, 0, 1.6, 1); R(-17, -4, 1.6, 2); R(14, -1, 1.4, 1); R(-3, 13.5, 1.6, 2); R(5, -5, 1.4, 1); R(-24, -3, 2, 1); R(20, 16, 1.8, 2);
    R(-8, 4.5, 1.4, 1); R(2, 6, 1.6, 2); R(-19, 14, 2, 1); R(7, 14, 1.4, 1);
    {
      // cardboard boxes
      const card = this.M(0xd9a86a, 0.9), tape = this.M(0xf3dfb4, 0.8);
      for (const [x, z, w, h, d] of [[-9, 14, 2.6, 1.5, 2.0], [17, -9, 2.2, 1.3, 2.2], [-4, -4.5, 2.0, 1.2, 2.4], [26, 11, 2.4, 1.6, 2.0]] as number[][]) {
        this.box(w, h, d, x, 0, z, card, true, 0.06);
        this.box(0.35, 0.05, d + 0.02, x, h, z, tape, false);
      }
      // stacking rings tower
      const rx = 3, rz = -13;
      [1.7, 1.4, 1.1, 0.8].forEach((rad, i) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 0.4, 20), this.M(PASTEL[(i + 2) % PASTEL.length], 0.4));
        m.position.set(rx, 0.2 + i * 0.4, rz); this.add(m);
      });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.4, 10), this.M(0xffffff, 0.4)); pole.position.set(rx, 1.2, rz); this.add(pole);
      this.collider(rx, rz, 2.4, 2.4, 0, 1.6);
      // wooden toy train
      const tx = -14, tz = 5;
      const cols = [0xff6b6b, 0x4dabf7, 0xffd23f, 0x69db7c];
      cols.forEach((c, i) => {
        const x = tx + i * 2.35;
        this.box(2.0, 0.9, 1.3, x, 0.25, tz, this.M(c, 0.4), true, 0.1);
        for (const wx of [-0.6, 0.6]) for (const wz of [-0.7, 0.7]) {
          const w = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 12), this.M(0x2b2b33, 0.5)); w.rotation.x = Math.PI / 2; w.position.set(x + wx, 0.28, tz + wz); this.add(w);
        }
      });
      const chim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.9, 12), this.M(0x333333, 0.5)); chim.position.set(tx + 0.6, 1.6, tz); this.add(chim);
    }
    // crib
    {
      const cx = -19.5, cz = -14.1, L = 5, D = 2.8;
      const wood = this.M(0xf2d6a8, 0.5), white = this.M(0xffffff, 0.45);
      this.box(L, 0.3, D, cx, 1.0, cz, this.M(0xfff5fa, 0.6), false, 0.05);
      this.box(L - 0.3, 0.3, D - 0.3, cx, 1.28, cz, this.M(0xffc2d9, 0.9), false, 0.12);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.box(0.3, 1.0, 0.3, cx + sx * (L / 2 - 0.15), 0, cz + sz * (D / 2 - 0.15), wood, false);
      for (const sz of [-1, 1]) this.box(L, 0.22, 0.22, cx, 2.75, cz + sz * (D / 2 - 0.11), wood, false, 0.05);
      for (const sx of [-1, 1]) {
        this.box(0.22, 1.8, 0.22, cx + sx * (L / 2 - 0.11), 1.2, cz - D / 2 + 0.11, wood, false);
        this.box(0.22, 1.8, 0.22, cx + sx * (L / 2 - 0.11), 1.2, cz + D / 2 - 0.11, wood, false);
        this.box(0.22, 0.22, D, cx + sx * (L / 2 - 0.11), 2.75, cz, wood, false, 0.05);
      }
      const bars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), white, 44);
      const mm = new THREE.Matrix4(); let k = 0;
      for (const sz of [-1, 1]) for (let i = 0; i < 14; i++) { mm.makeTranslation(cx - L / 2 + 0.45 + i * ((L - 0.9) / 13), 2.0, cz + sz * (D / 2 - 0.11)); bars.setMatrixAt(k++, mm); }
      for (const sx of [-1, 1]) for (let i = 0; i < 8; i++) { mm.makeTranslation(cx + sx * (L / 2 - 0.11), 2.0, cz - D / 2 + 0.45 + i * ((D - 0.9) / 7)); bars.setMatrixAt(k++, mm); }
      bars.count = k;
      this.add(bars);
      this.collider(cx, cz, L, D, 0, 1.4);
      // little teddy peeking over the rail
      const bear = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), this.M(0xc98f5a, 0.9));
      bear.position.set(cx + 1, 2.0, cz); this.add(bear);
      const bh = new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 12), this.M(0xc98f5a, 0.9));
      bh.position.set(cx + 1, 2.7, cz); this.add(bh);
    }
    // toy box
    {
      const x = 21.3, z = -12.9;
      const blue = this.M(0x4dabf7, 0.4), yellow = this.M(0xffd23f, 0.4);
      this.box(3.4, 1.8, 2.2, x, 0, z, blue, true, 0.08);
      this.box(3.5, 0.2, 2.3, x, 1.75, z, yellow, false, 0.05);
      const lid = new THREE.Mesh(new RoundedBoxGeometry(3.4, 0.18, 2.2, 2, 0.05), yellow);
      lid.position.set(x, 3.0, z - 1.55); lid.rotation.x = -1.0;
      this.add(lid);
      // star on front
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), this.M(0xff6b6b, 0.4));
      star.position.set(x - 1.75, 0.9, z); star.scale.set(0.3, 1, 1); this.add(star);
      for (let i = 0; i < 5; i++) {
        const t = new THREE.Mesh(i % 2 ? new THREE.SphereGeometry(0.45, 12, 8) : new THREE.BoxGeometry(0.7, 0.7, 0.7), this.M(PASTEL[i], 0.5));
        t.position.set(x - 1 + i * 0.5, 2.0 + (i % 2) * 0.2, z + (i - 2) * 0.2); t.rotation.set(i, i * 2, 0);
        this.add(t);
      }
    }
    // slide
    {
      const x = 22.5, z = 12;
      this.box(2.4, 3.0, 2.4, x, 0, z, this.M(0xffd23f, 0.45), false, 0.08);
      this.box(2.8, 0.25, 2.8, x, 3.0, z, this.M(0xff6b6b, 0.45), false, 0.08);
      this.collider(x, z, 2.8, 2.8, 0, 3.25);
      for (const sx of [-1, 1]) this.box(0.1, 3, 0.1, x + sx * 0.5, 0, z + 1.5, this.M(0xdddddd, 0.4), false);
      for (let i = 0; i < 7; i++) this.box(1.0, 0.08, 0.08, x, 0.35 + i * 0.4, z + 1.5, this.M(0xdddddd, 0.4), false);
      const ang = Math.atan2(2.85, 5.2), len = Math.hypot(2.85, 5.2);
      const ramp = new THREE.Mesh(new RoundedBoxGeometry(len, 0.14, 1.5, 2, 0.04), this.M(0x4dabf7, 0.25));
      ramp.position.set(x - 1.2 - 2.6 + 0.0, 1.6, z); ramp.rotation.z = ang;
      ramp.position.set(x - 1.2 - 2.6, 3.0 - 1.425 + 0.1, z);
      this.add(ramp);
      for (const sz of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.35, 0.1), this.M(0xff6b6b, 0.4));
        rail.position.set(x - 1.2 - 2.6, 3.0 - 1.425 + 0.25, z + sz * 0.72); rail.rotation.z = ang;
        this.add(rail);
      }
      const segs: [number, number, number][] = [[x - 3, x - 1.2, 2.0], [x - 4.8, x - 3, 1.0], [x - 6.4, x - 4.8, 0.05]];
      for (const [a, b, h] of segs) if (h > 0.3) this.collider((a + b) / 2, z, b - a, 1.5, 0, h);
    }
    // big plush bear + balls
    {
      const bx = -24, bz = 0.8;
      const brown = this.M(0xc98f5a, 0.95), tan = this.M(0xf1d3a8, 0.95);
      const body = new THREE.Mesh(new THREE.SphereGeometry(1.5, 24, 16), brown); body.position.set(bx, 1.5, bz); body.scale.y = 1.05;
      const head = new THREE.Mesh(new THREE.SphereGeometry(1.0, 24, 16), brown); head.position.set(bx + 0.3, 3.4, bz);
      const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), tan); muzzle.position.set(bx + 1.15, 3.2, bz);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), this.M(0x222222, 0.4)); nose.position.set(bx + 1.5, 3.35, bz);
      this.add(body); this.add(head); this.add(muzzle); this.add(nose);
      for (const s of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 8), brown); ear.position.set(bx + 0.2, 4.2, bz + s * 0.75); this.add(ear);
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), this.M(0x111111, 0.3)); eye.position.set(bx + 1.2, 3.65, bz + s * 0.32); this.add(eye);
        const arm = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), brown); arm.position.set(bx + 0.9, 1.7, bz + s * 1.5); this.add(arm);
        const leg = new THREE.Mesh(new THREE.SphereGeometry(0.65, 12, 8), brown); leg.position.set(bx + 1.5, 0.65, bz + s * 1.0); this.add(leg);
      }
      this.sphereCollider(bx, 1.5, bz, 1.6);
      this.ball(12.6, 14.2, 0.9, 0xff6b6b, false);
      this.ball(-14.2, 14.7, 0.8, 0x4dabf7, false); this.ball(0, -16, 0.9, 0xffd23f, false); this.ball(-6, 0.5, 0.8, 0x69db7c, false);
    }
    this.scatterBalls(12, (x, z) => Math.abs(x - 22.5) < 5 && Math.abs(z - 12) < 6);
    this.spawns.push(new THREE.Vector3(0, 0, 14));
    this.perimeterSpawns(20);
  }

  // ---------- BACKYARD
  buildBackyard() {
    const { hx, hz } = this;
    const r = this.r;
    this.sky(0x6ec1ff, 0xe6f6ff);
    this.scene.background = new THREE.Color(0xbfe4ff);
    this.lights(new THREE.Vector3(-22, 42, 16), 0xfff4d2, 3.0, 0xcfe9ff, 0x9bd16a, 1.25);
    // lawn
    {
      const [c, g] = canvas(512, 512);
      g.fillStyle = "#6cc04a"; g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = `hsla(${88 + r() * 25},${50 + r() * 25}%,${34 + r() * 22}%,0.45)`;
        const x = r() * 512, y = r() * 512;
        g.fillRect(x, y, 2, 6 + r() * 8);
      }
      for (let i = 0; i < 14; i++) { g.fillStyle = "rgba(255,255,255,0.08)"; g.beginPath(); g.arc(r() * 512, r() * 512, 30 + r() * 50, 0, 7); g.fill(); }
      this.floor(tex(c, hx / 3, hz / 3), hx * 2 + 30, hz * 2 + 30);
    }
    // tall grass blades + flowers (instanced)
    {
      const N = 5200;
      const blades = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.4, 3), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const x = (r() * 2 - 1) * hx, z = (r() * 2 - 1) * hz, s = 0.6 + r();
        q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, r() * 6, (r() - 0.5) * 0.4));
        m.compose(new THREE.Vector3(x, 0.18 * s, z), q, new THREE.Vector3(1, s, 1));
        blades.setMatrixAt(i, m);
        blades.setColorAt(i, col.setHSL(0.24 + r() * 0.08, 0.6, 0.3 + r() * 0.15));
      }
      this.group.add(blades);
      const F = 180;
      const fl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }), F);
      for (let i = 0; i < F; i++) {
        m.makeTranslation((r() * 2 - 1) * hx, 0.45 + r() * 0.2, (r() * 2 - 1) * hz);
        fl.setMatrixAt(i, m);
        fl.setColorAt(i, col.setHex([0xffffff, 0xffe14d, 0xff8fb8][i % 3]));
      }
      this.group.add(fl);
    }
    // fence: pickets + rails
    {
      const fh = 3.6;
      const white = this.M(0xffffff, 0.55);
      const pk: [number, number, number][] = [];
      for (let x = -hx; x <= hx; x += 0.52) { pk.push([x, -hz - 0.1, 0]); pk.push([x, hz + 0.1, 0]); }
      for (let z = -hz; z <= hz; z += 0.52) { pk.push([-hx - 0.1, z, 1]); pk.push([hx + 0.1, z, 1]); }
      const pickets = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, fh, 0.12), white, pk.length);
      const m = new THREE.Matrix4();
      pk.forEach(([x, z, rot], i) => { m.makeRotationY(rot ? Math.PI / 2 : 0).setPosition(x, fh / 2 - 0.1, z); pickets.setMatrixAt(i, m); });
      this.add(pickets);
      const tips = new THREE.InstancedMesh(new THREE.ConeGeometry(0.28, 0.4, 4), white, pk.length);
      pk.forEach(([x, z, rot], i) => { m.makeRotationY(Math.PI / 4 + (rot ? Math.PI / 2 : 0)).setPosition(x, fh - 0.1 + 0.2, z); tips.setMatrixAt(i, m); });
      this.add(tips);
      for (const y of [0.9, 2.4]) {
        this.box(hx * 2 + 0.6, 0.22, 0.2, 0, y, -hz - 0.28, white, false); this.box(hx * 2 + 0.6, 0.22, 0.2, 0, y, hz + 0.28, white, false);
        this.box(0.2, 0.22, hz * 2 + 0.6, -hx - 0.28, y, 0, white, false); this.box(0.2, 0.22, hz * 2 + 0.6, hx + 0.28, y, 0, white, false);
      }
      // backdrop: hedges, trees, house, hills
      const green = [0x3f9a3a, 0x4fae45, 0x2f8a35];
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const x = Math.cos(a) * (hx + 7 + r() * 3) * 1.1, z = Math.sin(a) * (hz + 7 + r() * 3) * 1.45;
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 5, 8), this.M(0x8a5a35, 0.9)); t.position.set(x, 2.5, z);
        this.add(t, true, false);
        for (let k = 0; k < 3; k++) {
          const lf = new THREE.Mesh(new THREE.SphereGeometry(3 + r() * 1.4, 12, 8), this.M(green[(i + k) % 3], 0.9));
          lf.position.set(x + (r() - 0.5) * 2.4, 6 + k * 1.2 + r(), z + (r() - 0.5) * 2.4);
          this.add(lf, true, false);
        }
      }
      const house = new THREE.Mesh(new THREE.BoxGeometry(22, 9, 8), this.M(0xffe0b8, 0.8)); house.position.set(-4, 4.5, -hz - 14); this.add(house, true, false);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(13.5, 5, 4), this.M(0xe0605a, 0.8)); roof.position.set(-4, 11.5, -hz - 14); roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.55); this.add(roof, true, false);
      for (const wx of [-10, -4, 2]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3, 0.2), this.M(0xcfeeff, 0.2)); w.position.set(wx, 5, -hz - 9.9); this.add(w, false, false);
      }
      for (let i = 0; i < 5; i++) {
        const hill = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 10), this.M(0x7cc86a, 1)); hill.scale.y = 0.35;
        hill.position.set(-80 + i * 40, -3, -hz - 70 - (i % 2) * 15); this.add(hill, false, false);
      }
    }
    // ---- two levels: a raised wooden deck / playhouse platform with ramps, and the lower yard around and under it
    this.buildDeck();
    // sandbox
    {
      const x = -15, z = -8, W = 8.5, D = 5.8, wood = this.M(0xc78a4e, 0.7);
      const sand = new THREE.Mesh(new THREE.PlaneGeometry(W, D), this.M(0xf0d58c, 1));
      sand.rotation.x = -Math.PI / 2; sand.position.set(x, 0.06, z); sand.receiveShadow = true; this.group.add(sand);
      this.box(W + 0.4, 0.34, 0.4, x, 0, z - D / 2, wood, true, 0.05); this.box(W + 0.4, 0.34, 0.4, x, 0, z + D / 2, wood, true, 0.05);
      this.box(0.4, 0.34, D - 0.4, x - W / 2, 0, z, wood, true, 0.05); this.box(0.4, 0.34, D - 0.4, x + W / 2, 0, z, wood, true, 0.05);
      // bucket castle
      const cx = x - 1.8, cz = z + 0.4;
      const pail = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.65, 1.3, 16), this.M(0xff6b6b, 0.4)); pail.position.set(cx, 0.7, cz); this.add(pail);
      const pt = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 16), this.M(0xf0d58c, 1)); pt.position.set(cx, 1.5, cz); this.add(pt);
      this.collider(cx, cz, 1.6, 1.6, 0, 1.75);
      const shovel = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.5), this.M(0x4dabf7, 0.4)); shovel.position.set(x + 1.7, 0.12, z - 0.4); shovel.rotation.y = 0.5; this.add(shovel);
      const sh2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.9), this.M(0x4dabf7, 0.4)); sh2.position.set(x + 2.6, 0.12, z - 0.8); sh2.rotation.y = 0.5; this.add(sh2);
    }
    // kiddie pool
    {
      const x = 21, z = -12, W = 7.4, D = 4.8;
      this.box(W, 0.7, D, x, 0, z, this.M(0xff8fb8, 0.35), true, 0.3);
      const water = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.8, D - 0.8), new THREE.MeshStandardMaterial({ color: 0x5fd0ff, roughness: 0.08, metalness: 0.1 }));
      water.rotation.x = -Math.PI / 2; water.position.set(x, 0.62, z); this.group.add(water);
      const duck = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), this.M(0xffe14d, 0.4)); duck.position.set(x + 0.5, 0.85, z + 0.2); duck.scale.set(1.2, 0.9, 0.9);
      const dh = new THREE.Mesh(new THREE.SphereGeometry(0.33, 12, 10), this.M(0xffe14d, 0.4)); dh.position.set(x + 1.15, 1.35, z + 0.2);
      const beak = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.25), this.M(0xff8a1f, 0.4)); beak.position.set(x + 1.5, 1.3, z + 0.2);
      this.add(duck, false); this.add(dh, false); this.add(beak, false);
    }
    // swing set (behind the deck)
    {
      const z = -16, top = 4.8, red = this.M(0xe0405a, 0.45), sx0 = 2;
      for (const sx of [-4.6, 4.6]) for (const sz of [-1.2, 1.2]) this.box(0.28, top, 0.28, sx0 + sx, 0, z + sz, red, true, 0.05);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 9.8, 10), red); bar.rotation.z = Math.PI / 2; bar.position.set(sx0, top, z); this.add(bar);
      for (const sx of [-2, 2]) {
        for (const o of [-0.35, 0.35]) {
          const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, top - 0.5, 5), this.M(0x333333)); rope.position.set(sx0 + sx + o, (top + 0.5) / 2, z); this.add(rope, false);
        }
        this.box(1.1, 0.12, 0.5, sx0 + sx, 0.4, z, this.M(sx < 0 ? 0xffd23f : 0x4dabf7, 0.4), false, 0.04);
      }
    }
    // toy vehicles
    const car = (x: number, z: number, color: number, along: boolean, truck = false) => {
      const g = new THREE.Group();
      const bodyM = this.M(color, 0.25), dark = this.M(0x2b2b33, 0.6);
      const body = new THREE.Mesh(new RoundedBoxGeometry(4.4, 1.0, 2.2, 3, 0.2), bodyM); body.position.y = 0.85; g.add(body);
      const cab = new THREE.Mesh(new RoundedBoxGeometry(truck ? 1.6 : 2.4, 0.9, 1.9, 3, 0.2), truck ? bodyM : this.M(0xdff3ff, 0.15)); cab.position.set(truck ? 1.3 : -0.1, 1.75, 0); g.add(cab);
      if (truck) { const bed = new THREE.Mesh(new RoundedBoxGeometry(2.5, 0.9, 2.1, 3, 0.1), this.M(0xffd23f, 0.35)); bed.position.set(-0.9, 1.75, 0); bed.rotation.z = 0.12; g.add(bed); }
      for (const wx of [-1.4, 1.4]) for (const wz of [-1.1, 1.1]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16), dark); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.5, wz); g.add(w);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.44, 10), this.M(0xffd23f, 0.4)); hub.rotation.x = Math.PI / 2; hub.position.set(wx, 0.5, wz); g.add(hub);
      }
      for (const lz of [-0.7, 0.7]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), this.M(0xfff3a0, 0.3, 0, { emissive: 0xfff3a0, emissiveIntensity: 0.5 })); l.position.set(2.2, 0.95, lz); g.add(l); }
      g.position.set(x, 0, z);
      if (!along) g.rotation.y = Math.PI / 2;
      this.add(g);
      const w = along ? 4.5 : 2.8, d = along ? 2.8 : 4.5;
      this.collider(x, z, w, d, 0, 2.2);
    };
    car(-8, 8, 0xe0405a, true); car(19, 5, 0xffd23f, false); car(-22, 10, 0x4dabf7, true, true); car(10, 14, 0x69db7c, true); car(-9, -15, 0xb197fc, true);
    // wagon (under the deck)
    {
      const x = 4, z = -2.2;
      this.box(3.2, 0.9, 1.7, x, 0.4, z, this.M(0xe0405a, 0.4), true, 0.1);
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), this.M(0x333333)); h.position.set(x + 2.3, 0.9, z); h.rotation.z = 1.2; this.add(h);
      for (const wx of [-1, 1]) for (const wz of [-0.9, 0.9]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.15, 14), this.M(0xffffff, 0.5)); w.rotation.x = Math.PI / 2; w.position.set(x + wx, 0.4, z + wz); this.add(w);
      }
    }
    // alphabet blocks
    this.blocks(8, 10.5, 2, 2); this.blocks(12, 11.5, 1.5, 1); this.blocks(-12, 14, 2, 1); this.blocks(24, -3, 2, 2); this.blocks(-25, -2, 1.8, 2);
    this.blocks(-5, 11.5, 1.4, 1); this.blocks(16, 1, 2, 2); this.blocks(-12, 1, 2, 2); this.blocks(26, 9, 2, 1); this.blocks(-6, 4, 1.6, 2);
    this.blocks(4.2, 3.4, 1.8, 2); this.blocks(24, 15, 1.8, 2); this.blocks(-21, 16, 1.8, 1); this.blocks(14, -9, 1.6, 2); this.blocks(-8, -11, 2, 2);
    this.blocks(1, -6.2, 1.4, 1); this.blocks(8.5, -2.5, 1.4, 1); // under the deck
    // hedges and flower pots: low cover in the lower yard
    {
      const hedge = this.M(0x2f8a35, 0.95), potM = this.M(0xd9763a, 0.7);
      const H = (x: number, z: number, w: number, d: number) => {
        this.box(w, 1.25, d, x, 0, z, hedge, true, 0.35);
        const top = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), this.M(0x3f9a3a, 0.95)); top.scale.set(w * 0.45, 0.45, d * 0.45); top.position.set(x, 1.2, z); this.add(top, true, false);
      };
      H(-8, -4, 5.5, 1.1); H(14.5, -12.5, 4.5, 1.1); H(-18, 5, 1.1, 5); H(5, 7, 4.5, 1.1); H(-14, -15, 5, 1.1); H(23, 4, 1.1, 4);
      for (const [x, z] of [[-6.5, 12], [18, 12], [-5.5, -8.5], [13, 6.5], [-19, -1]]) {
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.55, 1.1, 14), potM); pot.position.set(x, 0.55, z); this.add(pot);
        const bush = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), this.M(0x3f9a3a, 0.9)); bush.position.set(x, 1.45, z); this.add(bush);
        this.collider(x, z, 1.5, 1.5, 0, 1.9);
      }
    }
    this.ball(-18, 15, 0.9, 0xffa94d, false); this.ball(14, -14, 0.8, 0x4dabf7, false); this.ball(3, 9.5, 0.8, 0xf783ac, false);
    // garden hose
    {
      const pts = [[3, 16], [6, 15], [10, 16.2], [13.5, 15], [16, 12.8], [12.5, 11], [9, 12.3]].map(([x, z]) => new THREE.Vector3(x, 0.14, z));
      const curve = new THREE.CatmullRomCurve3(pts);
      const hose = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.14, 8), this.M(0x2e9c4f, 0.5));
      this.add(hose, true, true);
      const nz = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.7, 8), this.M(0xffd23f, 0.4)); nz.rotation.z = Math.PI / 2; nz.position.set(8.4, 0.22, 12.6); nz.rotation.y = 0.4; this.add(nz);
    }
    this.scatterBalls(10, (x, z) => (x > -20 && x < -10 && z > -11 && z < -5) || (x > -4 && x < 1.5 && z > -1 && z < 10.5) || (x > 9.5 && x < 21.5 && z > -6.5 && z < -1.5) || (x > -4 && x < 12 && z > -10 && z < 1));
    // ground spawns first (player team at the front of the lawn), deck spawns last
    this.spawns.push(new THREE.Vector3(0, 0, 14.5));
    this.perimeterSpawns(18);
    const d = this.deck!;
    for (const [x, z] of [[1, -6.5], [7.5, -2.5], [9, -6.5], [-1, -3]]) this.spawns.push(new THREE.Vector3(x, d.y, z));
  }

  /** Raised wooden deck + playhouse, two ramps, railings. Top level at y = 3. */
  private buildDeck() {
    const X0 = -3, X1 = 11, Z0 = -9, Z1 = 0, TOP = 3.0;
    this.deck = { x0: X0, x1: X1, z0: Z0, z1: Z1, y: TOP };
    const woodD = this.M(0x8c5a2e, 0.8), white = this.M(0xffffff, 0.5), red = this.M(0xe0405a, 0.5);
    // plank top texture
    const [c, g] = canvas(256, 256);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = `hsl(${30 + (i % 3) * 3},${52 + (i % 2) * 6}%,${54 + (i % 4) * 3}%)`; g.fillRect(0, i * 32, 256, 32);
      g.fillStyle = "rgba(70,40,15,0.45)"; g.fillRect(0, i * 32, 256, 2);
      g.fillStyle = "rgba(70,40,15,0.18)"; g.fillRect(((i * 97) % 256), i * 32, 2, 32);
    }
    const deckMat = new THREE.MeshStandardMaterial({ map: tex(c, (X1 - X0) / 3, (Z1 - Z0) / 3), roughness: 0.8 });
    const w = X1 - X0, d = Z1 - Z0, cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
    const mats = [woodD, woodD, deckMat, woodD, woodD, woodD];
    this.box(w, 0.3, d, cx, TOP - 0.3, cz, mats, true, 0, true, { walk: true });
    // posts + cross beams under the deck
    const post = (x: number, z: number) => this.box(0.45, TOP - 0.3, 0.45, x, 0, z, woodD, true, 0.04);
    for (const x of [X0 + 0.4, cx, X1 - 0.4]) for (const z of [Z0 + 0.4, Z1 - 0.4]) post(x, z);
    post(cx - 4.5, cz); post(cx + 4.5, cz);
    for (const z of [Z0 + 0.4, Z1 - 0.4]) this.box(w, 0.3, 0.3, cx, 2.0, z, woodD, false);
    // ---- railings (movement blockers only: bullets fly through)
    const railV = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(z1 - z0, x1 - x0);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      for (const y of [TOP + 0.95, TOP + 0.5]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.14), white); r.position.set(mx, y, mz); r.rotation.y = -ang; this.add(r, true, true);
      }
      const n = Math.max(2, Math.round(len / 1.3) + 1);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1), px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.1, 0.18), red); p.position.set(px, TOP + 0.55, pz); this.add(p, true, true);
      }
      const nb = Math.round(len / 0.32);
      const pk = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.8, 0.06), white, nb);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
      for (let i = 0; i < nb; i++) { const t = (i + 0.5) / nb; m4.compose(new THREE.Vector3(x0 + (x1 - x0) * t, TOP + 0.45, z0 + (z1 - z0) * t), q, new THREE.Vector3(1, 1, 1)); pk.setMatrixAt(i, m4); }
      pk.castShadow = true; this.group.add(pk);
      this.collider(mx, mz, Math.abs(x1 - x0) + 0.2, Math.abs(z1 - z0) + 0.2, TOP, TOP + 1.0, false, { noRay: true });
    };
    // south edge (ramp A opening at x -2.5..-0.1), east edge (ramp B opening z -5.2..-2.8), west edge (drop-off gap z -6..-3), north edge full
    railV(X0, Z1, -2.7, Z1); railV(0.1, Z1, X1, Z1);
    railV(X1, Z0, X1, -5.4); railV(X1, -2.6, X1, Z1);
    railV(X0, Z0, X0, -6.2); railV(X0, -2.8, X0, Z1);
    railV(X0, Z0, X1, Z0);
    // ---- playhouse on the deck (NE corner): three solid walls + roof, open to the south
    {
      const hx0 = 5.2, hx1 = 10.2, hz0 = Z0 + 0.1, hz1 = Z0 + 3.0, wh = 2.3, th = 0.25;
      const wall = this.M(0xffe0b8, 0.7), trim = this.M(0xe0605a, 0.6);
      this.box(hx1 - hx0, wh, th, (hx0 + hx1) / 2, TOP, hz0 + th / 2, wall, true, 0.03);
      this.box(th, wh, hz1 - hz0, hx0 + th / 2, TOP, (hz0 + hz1) / 2, wall, true, 0.03);
      this.box(th, wh, hz1 - hz0, hx1 - th / 2, TOP, (hz0 + hz1) / 2, wall, true, 0.03);
      // window frame on the back wall
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 0.1), this.M(0xcfeeff, 0.2)); win.position.set((hx0 + hx1) / 2, TOP + 1.3, hz0 + th + 0.04); this.add(win, false, false);
      this.box(hx1 - hx0 + 0.5, 0.2, hz1 - hz0 + 0.5, (hx0 + hx1) / 2, TOP + wh, (hz0 + hz1) / 2, trim, true, 0.04);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 1.8, 4), trim); roof.position.set((hx0 + hx1) / 2, TOP + wh + 0.2 + 0.9, (hz0 + hz1) / 2); roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.62); this.add(roof);
      // flag
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), white); pole.position.set(hx1 - 0.6, TOP + wh + 1.9, hz0 + 0.8); this.add(pole, false, false);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), this.M(0xffd23f, 0.6)); flag.material = new THREE.MeshStandardMaterial({ color: 0xffd23f, side: THREE.DoubleSide }); flag.position.set(hx1 - 0.2, TOP + wh + 2.3, hz0 + 0.8); this.add(flag, false, false);
    }
    // cover on the deck: toy chests, blocks
    this.box(2.4, 1.1, 1.2, 1.6, TOP, -3.2, this.M(0x4dabf7, 0.4), true, 0.08);
    this.box(2.5, 0.12, 1.3, 1.6, TOP + 1.1, -3.2, this.M(0xffd23f, 0.4), false, 0.04);
    this.box(1.2, 1.2, 2.6, 6.4, TOP, -4.6, this.M(0xff8fb8, 0.4), true, 0.08);
    this.blocks(-0.2, -7.6, 1.6, 2, 0, TOP); this.blocks(4, -6.5, 1.3, 1, 0, TOP); this.blocks(4.6, -1.6, 1.4, 1, 0, TOP);
    // ---- ramps
    const slab = (x0: number, x1: number, z0: number, z1: number, axis: "x" | "z", c0: number, c1: number, hA: number, hB: number) => {
      this.ramps.push({ x0, x1, z0, z1, axis, c0, c1, hA, hB });
      const run = c1 - c0, rise = hA - hB, L = Math.hypot(run, rise), ang = Math.atan2(rise, run);
      const ww = axis === "z" ? x1 - x0 : z1 - z0;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, my = (hA + hB) / 2 - 0.1;
      const pl = new THREE.Mesh(new THREE.BoxGeometry(axis === "z" ? ww : L, 0.2, axis === "z" ? L : ww), deckMat);
      pl.position.set(mx, my, mz);
      if (axis === "z") pl.rotation.x = ang; else pl.rotation.z = -ang;
      this.add(pl);
      // cleats
      const nC = Math.floor(L / 0.9);
      for (let i = 1; i < nC; i++) {
        const t = i / nC, cc = c0 + run * t, hh = hA - rise * t;
        const cl = new THREE.Mesh(new THREE.BoxGeometry(axis === "z" ? ww : 0.1, 0.06, axis === "z" ? 0.1 : ww), woodD);
        cl.position.set(axis === "z" ? mx : cc, hh + 0.02, axis === "z" ? cc : mz); if (axis === "z") cl.rotation.x = ang; else cl.rotation.z = -ang;
        this.add(cl, false, false);
      }
      // side rails: visual posts + top rail, plus sloped movement blockers (slices)
      for (const side of [-1, 1]) {
        const off = ww / 2 + 0.05;
        const rx = axis === "z" ? mx + side * off : mx, rz = axis === "z" ? mz : mz + side * off;
        const rail = new THREE.Mesh(new THREE.BoxGeometry(axis === "z" ? 0.1 : L, 0.1, axis === "z" ? L : 0.1), white);
        rail.position.set(rx, my + 0.95, rz); if (axis === "z") rail.rotation.x = ang; else rail.rotation.z = -ang;
        this.add(rail, true, false);
        const nP = Math.floor(L / 1.5) + 1;
        for (let i = 0; i < nP; i++) {
          const t = i / (nP - 1), cc = c0 + run * t, hh = hA - rise * t;
          const pst = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), red);
          pst.position.set(axis === "z" ? rx : cc, hh + 0.45, axis === "z" ? cc : rz); this.add(pst, true, false);
        }
        const nS = Math.ceil(run / 1.0);
        for (let i = 0; i < nS; i++) {
          const ca = c0 + (run * i) / nS, cb = c0 + (run * (i + 1)) / nS;
          const ha = hA - (rise * i) / nS, hb = hA - (rise * (i + 1)) / nS;
          const lo = Math.min(ha, hb), hi = Math.max(ha, hb);
          const bx = axis === "z" ? rx : (ca + cb) / 2, bz = axis === "z" ? (ca + cb) / 2 : rz;
          this.collider(bx, bz, axis === "z" ? 0.16 : Math.abs(cb - ca) + 0.02, axis === "z" ? Math.abs(cb - ca) + 0.02 : 0.16, lo - 0.1, hi + 1.0, false, { noRay: true });
        }
      }
      // raycast-only slab slices so bullets and sight lines see the ramp surface
      const nR = Math.ceil(run / 0.8);
      for (let i = 0; i < nR; i++) {
        const ca = c0 + (run * i) / nR, cb = c0 + (run * (i + 1)) / nR;
        const ha = hA - (rise * i) / nR, hb = hA - (rise * (i + 1)) / nR;
        const hi = Math.max(ha, hb), lo = Math.min(ha, hb) - 0.2;
        this.rayBoxes.push({ kind: 0, x0: axis === "z" ? x0 : ca, x1: axis === "z" ? x1 : cb, z0: axis === "z" ? ca : z0, z1: axis === "z" ? cb : z1, y0: lo, y1: hi, cover: false });
      }
    };
    // A: south face of the deck, runs down toward the lawn
    slab(-2.5, -0.1, Z1, Z1 + 9, "z", Z1, Z1 + 9, TOP, 0);
    this.routes.push({ name: "A", bottom: new THREE.Vector3(-1.3, 0, Z1 + 10.4), top: new THREE.Vector3(-1.3, TOP, Z1 - 2.2) });
    // B: east face, toward the pool side
    slab(X1, X1 + 9, -5.2, -2.8, "x", X1, X1 + 9, TOP, 0);
    this.routes.push({ name: "B", bottom: new THREE.Vector3(X1 + 10.4, 0, -4), top: new THREE.Vector3(X1 - 2.2, TOP, -4) });
    // minimap footprints for the ramps (long, thin)
    this.mapRects.push([-1.3, 4.5, 2.4, 9], [15.5, -4, 9, 2.4]);
    // "WHEE" drop-off marker at the west gap: two small cones on the lawn side
    for (const z of [-6.2, -2.8]) { const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 8), this.M(0xff9f1a, 0.5)); cone.position.set(X0 - 0.12, TOP + 0.28, z); this.add(cone, false, false); }
  }

  // ---------- queries
  /** Ray vs world. Fills and returns this.hit, or null. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, balls = true, move = false): RayHit | null {
    const h = this.hit;
    let best = maxT;
    let found = false;
    const set = (t: number, nx: number, ny: number, nz: number, type: RayHit["type"], ball?: Ball) => {
      best = t; found = true; h.t = t; h.nx = nx; h.ny = ny; h.nz = nz; h.type = type; h.ball = ball;
    };
    if (dy < -1e-6) { const t = -oy / dy; if (t > 0 && t < best) set(t, 0, 1, 0, "floor"); }
    if (dx > 1e-6) { const t = (this.hx - ox) / dx; if (t > 0 && t < best) set(t, -1, 0, 0, "wall"); }
    else if (dx < -1e-6) { const t = (-this.hx - ox) / dx; if (t > 0 && t < best) set(t, 1, 0, 0, "wall"); }
    if (dz > 1e-6) { const t = (this.hz - oz) / dz; if (t > 0 && t < best) set(t, 0, 0, -1, "wall"); }
    else if (dz < -1e-6) { const t = (-this.hz - oz) / dz; if (t > 0 && t < best) set(t, 0, 0, 1, "wall"); }
    if (dy > 1e-6) { const t = (9 - oy) / dy; if (t > 0 && t < best && this.id === "nursery") set(t, 0, -1, 0, "wall"); }
    const nb = this.boxes.length, total = move ? nb : nb + this.rayBoxes.length;
    for (let bi = 0; bi < total; bi++) {
      const b = bi < nb ? this.boxes[bi] : this.rayBoxes[bi - nb];
      if (!move && b.noRay) continue;
      if (move && b.walk && b.y1 - (oy - 0.5) <= STEP_UP + 0.6) continue; // steerable step-up (deck edge seen from the ramp)
      let t0 = 0, t1 = best, nx = 0, ny = 0, nz = 0, ok = true;
      if (Math.abs(dx) < 1e-9) { if (ox < b.x0 || ox > b.x1) ok = false; }
      else { let a = (b.x0 - ox) / dx, c = (b.x1 - ox) / dx, s = -1; if (a > c) { const q = a; a = c; c = q; s = 1; } if (a > t0) { t0 = a; nx = s; ny = 0; nz = 0; } if (c < t1) t1 = c; }
      if (ok) {
        if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.y1) ok = false; }
        else { let a = (b.y0 - oy) / dy, c = (b.y1 - oy) / dy, s = -1; if (a > c) { const q = a; a = c; c = q; s = 1; } if (a > t0) { t0 = a; nx = 0; ny = s; nz = 0; } if (c < t1) t1 = c; }
      }
      if (ok) {
        if (Math.abs(dz) < 1e-9) { if (oz < b.z0 || oz > b.z1) ok = false; }
        else { let a = (b.z0 - oz) / dz, c = (b.z1 - oz) / dz, s = -1; if (a > c) { const q = a; a = c; c = q; s = 1; } if (a > t0) { t0 = a; nx = 0; ny = 0; nz = s; } if (c < t1) t1 = c; }
      }
      if (ok && t0 <= t1 && t0 > 0 && (nx || ny || nz) && t0 < best) set(t0, nx, ny, nz, "box");
    }
    const sph = (cx: number, cy: number, cz: number, rad: number): number => {
      const lx = ox - cx, ly = oy - cy, lz = oz - cz;
      const bb = lx * dx + ly * dy + lz * dz, cc = lx * lx + ly * ly + lz * lz - rad * rad;
      const disc = bb * bb - cc;
      if (disc < 0) return -1;
      const t = -bb - Math.sqrt(disc);
      return t > 0 ? t : -1;
    };
    for (const s of this.spheres) {
      const t = sph(s.x, s.y, s.z, s.r);
      if (t > 0 && t < best) set(t, (ox + dx * t - s.x) / s.r, (oy + dy * t - s.y) / s.r, (oz + dz * t - s.z) / s.r, "sph");
    }
    if (balls) for (const b of this.balls) {
      const t = sph(b.x, b.y, b.z, b.r);
      if (t > 0 && t < best) set(t, (ox + dx * t - b.x) / b.r, (oy + dy * t - b.y) / b.r, (oz + dz * t - b.z) / b.r, "ball", b);
    }
    return found ? h : null;
  }

  /** Push a circle (x,z,radius) at feet height y out of colliders and keep it inside the arena. */
  resolve(p: { x: number; y: number; z: number }, rad: number, height = 1.0): boolean {
    let hit = false;
    for (const b of this.boxes) {
      if (p.y >= b.y1 - (b.walk ? STEP_UP : 0.02) || p.y + height <= b.y0) continue;
      const cx = Math.max(b.x0, Math.min(p.x, b.x1)), cz = Math.max(b.z0, Math.min(p.z, b.z1));
      let dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rad * rad) continue;
      hit = true;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); p.x = cx + (dx / d) * rad; p.z = cz + (dz / d) * rad; }
      else {
        const l = p.x - b.x0, rr = b.x1 - p.x, f = p.z - b.z0, bk = b.z1 - p.z, m = Math.min(l, rr, f, bk);
        if (m === l) p.x = b.x0 - rad; else if (m === rr) p.x = b.x1 + rad; else if (m === f) p.z = b.z0 - rad; else p.z = b.z1 + rad;
      }
    }
    for (const rp of this.ramps) {
      if (p.x < rp.x0 - rad || p.x > rp.x1 + rad || p.z < rp.z0 - rad || p.z > rp.z1 + rad) continue;
      const cx = Math.max(rp.x0, Math.min(p.x, rp.x1)), cz = Math.max(rp.z0, Math.min(p.z, rp.z1));
      const h = this.rampH(rp, cx, cz);
      // walkable surface, or high enough to walk under: no collision
      if (p.y + STEP_UP >= h || p.y + height <= h - 0.2) continue;
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= rad * rad && !(dx === 0 && dz === 0)) continue;
      hit = true;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); p.x = cx + (dx / d) * rad; p.z = cz + (dz / d) * rad; }
      else if (rp.axis === "z") { const l = p.x - rp.x0, rr2 = rp.x1 - p.x; if (l < rr2) p.x = rp.x0 - rad; else p.x = rp.x1 + rad; }
      else { const l = p.z - rp.z0, rr2 = rp.z1 - p.z; if (l < rr2) p.z = rp.z0 - rad; else p.z = rp.z1 + rad; }
    }
    for (const s of this.spheres) {
      if (p.y >= s.y + s.r * 0.8) continue;
      const dx = p.x - s.x, dz = p.z - s.z, d = Math.hypot(dx, dz), m = s.r * 0.95 + rad;
      if (d < m) { hit = true; const k = d > 1e-6 ? m / d : 1; p.x = s.x + (d > 1e-6 ? dx * k : m); p.z = s.z + dz * k; }
    }
    const mx = this.hx - rad, mz = this.hz - rad;
    if (p.x > mx) { p.x = mx; hit = true; } else if (p.x < -mx) { p.x = -mx; hit = true; }
    if (p.z > mz) { p.z = mz; hit = true; } else if (p.z < -mz) { p.z = -mz; hit = true; }
    return hit;
  }

  /** True if the segment between two points at the given heights is not blocked by boxes/spheres. */
  clearLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const h = this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len, false);
    return !h || h.type === "floor" || h.type === "wall";
  }

  /** Find a hiding spot behind a cover block as seen from threat. */
  findCover(fx: number, fz: number, tx: number, tz: number, maxDist = 14, y = 0): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = maxDist;
    for (const b of this.boxes) {
      if (!b.cover || b.noRay || b.y1 <= y + 0.5 || b.y0 > y + 0.6) continue;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      let dx = cx - tx, dz = cz - tz;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const hw = (b.x1 - b.x0) / 2, hd = (b.z1 - b.z0) / 2;
      const ex = Math.abs(dx) > 1e-4 ? hw / Math.abs(dx) : 1e9, ez = Math.abs(dz) > 1e-4 ? hd / Math.abs(dz) : 1e9;
      const off = Math.min(ex, ez) + 0.75;
      const px = cx + dx * off, pz = cz + dz * off;
      if (Math.abs(px) > this.hx - 1 || Math.abs(pz) > this.hz - 1 || this.blocked(px, pz, 0.35, y)) continue;
      const d = Math.hypot(px - fx, pz - fz);
      if (d < bd) { bd = d; best = { x: px, z: pz }; }
    }
    return best;
  }

  update(dt: number) {
    for (const b of this.balls) {
      b.x += b.vx * dt; b.z += b.vz * dt;
      const sp = Math.hypot(b.vx, b.vz);
      const k = Math.exp(-1.1 * dt);
      b.vx *= k; b.vz *= k;
      const p = { x: b.x, y: 0, z: b.z };
      if (this.resolve(p, b.r, b.r * 2)) {
        if (sp > 0.2) { const nx = p.x - b.x, nz = p.z - b.z; if (Math.abs(nx) > 1e-4) b.vx *= -0.6; if (Math.abs(nz) > 1e-4) b.vz *= -0.6; }
        b.x = p.x; b.z = p.z;
      }
      b.mesh.position.set(b.x, b.r, b.z);
      if (sp > 0.05) {
        const ax = new THREE.Vector3(b.vz, 0, -b.vx).normalize();
        b.mesh.rotateOnWorldAxis(ax, (sp * dt) / b.r);
      }
    }
  }

  /** Kick balls near a point. */
  nudge(x: number, z: number, rad: number, vx: number, vz: number) {
    for (const b of this.balls) {
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < rad + b.r) {
        const nx = (b.x - x) / (d || 1), nz = (b.z - z) / (d || 1);
        const s = Math.hypot(vx, vz) + 1.5;
        b.vx = nx * s * 1.1; b.vz = nz * s * 1.1;
      }
    }
  }
}
