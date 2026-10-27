import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { buildWeaponModel } from "./weapons";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clamp, mulberry32 } from "./util";

export type Team = "blue" | "pink";

/** Rotate the imported GLB so it faces +Z (toddler forward). */
const GLB_YAW = 0;

// ---------------------------------------------------------------- GLB templates
/** Imported models are scaled to this height (metres). Hit spheres in game.ts assume ~1.15 m. */
export const TODDLER_HEIGHT = 1.15;
export type Kind = "suit" | "diaper";
const templates = new Map<string, GLTF>();

/** Loads public/models/baby_<suit|diaper>_<blue|pink>.glb (meshopt-compressed, rigged, clips walk/run/idle). Missing files are skipped. */
export async function loadToddlerModels(): Promise<number> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const keys: string[] = [];
  for (const k of ["suit", "diaper"]) for (const t of ["blue", "pink"]) keys.push(`${k}_${t}`);
  await Promise.all(keys.map(async (key) => {
    try {
      const res = await fetch(`/models/baby_${key}.glb`);
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      // Vite/Vercel may answer unknown paths with index.html: only accept real glTF binaries ("glTF" magic).
      if (buf.byteLength < 20 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return;
      templates.set(key, await loader.parseAsync(buf, "/models/"));
    } catch (e) { console.warn("baby glb failed", key, e); }
  }));
  return templates.size;
}

// ---------------------------------------------------------------- procedural toddler
const SKINS = [0xffcfa8, 0xf2b98f, 0xd9966a, 0xffd9bd, 0xb87a52, 0xf8c8a0];
const HAIR = [0x5a3a22, 0x2b1d14, 0xe3b04b, 0xc0561f, 0x3a2a20, 0x8b5a2b];
const ONESIE: Record<Team, number[]> = {
  blue: [0x4dabf7, 0x3b82e0, 0x38c5e8, 0x5c7cfa],
  pink: [0xff7eb6, 0xff5fa2, 0xf06292, 0xff8fa3],
};

export interface ToddlerOpts {
  team: Team; variant: number; name: string; kind?: Kind;
  /** outfit colour variant of the GLB (blue or pink onesie / diaper) */
  tone?: Team;
  /** team accent colour (ring under the feet, nametag outline) */
  accent?: number;
  tagColor?: number;
  /** seeds the idle/walk phase so capture runs are deterministic */
  seed?: number;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _bq = new THREE.Quaternion(), _dq = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _FWD = new THREE.Vector3(0, 0, -1), _X = new THREE.Vector3(1, 0, 0);

let flashTex: THREE.CanvasTexture | null = null;
function muzzleFlashTexture() {
  if (flashTex) return flashTex;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,238,170,0.95)"); gr.addColorStop(0.6, "rgba(255,196,90,0.35)"); gr.addColorStop(1, "rgba(255,170,60,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  flashTex = new THREE.CanvasTexture(c); flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}
const WALK_REF = 1.5, RUN_REF = 3.4;
const GUN_OFFSET = new THREE.Vector3(0.0, 0.0, 0.0);

export type Pose = "alive" | "down";

export class Toddler {
  root = new THREE.Group();
  pivot = new THREE.Group();
  name: string;
  team: Team;
  /** Local muzzle position (blaster tip) in root space */
  muzzle = new THREE.Vector3(0.2, 0.62, 0.62);
  isGlb = false;
  tag: THREE.Sprite;
  /** small billboard health bar over the head (opponents only; Game drives opacity) */
  hpBar: THREE.Sprite;
  private hpCtx: CanvasRenderingContext2D;
  private hpTex: THREE.CanvasTexture;
  private hpFrac = -1;
  private hpEdge: string;
  private mats: THREE.MeshStandardMaterial[] = [];
  private phase = 0;
  private t = 0;
  private flashT = 0;
  private recoilT = 0;
  private popT = 1;
  private rig: Record<string, THREE.Object3D> = {};
  private mixer?: THREE.AnimationMixer;
  private actions: Partial<Record<"walk" | "run" | "idle", THREE.AnimationAction>> = {};
  private bones: Record<string, THREE.Bone> = {};
  private rest: Record<string, THREE.Quaternion> = {};
  private wIdle = 1; private wWalk = 0; private wRun = 0; private downK = 0;
  private gun?: THREE.Object3D;
  private gunMuzzle?: THREE.Object3D;
  private gunRestQ = new THREE.Quaternion();
  private flashSprite?: THREE.Sprite;
  private gunFlashT = 0;
  /** aim pose: 0 = relaxed, 1 = blaster raised and pointed at aimPoint */
  aimK = 0;
  private aimHold = 0;
  private aimPoint = new THREE.Vector3();
  private mouthBase = new THREE.Vector3(1, 1, 1);
  private pacifier = false;
  private cheeks: THREE.Mesh[] = [];
  private lids: THREE.Mesh[] = [];
  private pupils: THREE.Mesh[] = [];
  private brows: THREE.Mesh[] = [];
  private tears: THREE.Mesh[] = [];

  constructor(o: ToddlerOpts) {
    this.name = o.name;
    this.team = o.team;
    const rng = mulberry32((o.seed ?? ((Math.random() * 1e9) | 0)) + 31);
    this.phase = rng() * 6; this.t = rng() * 10;
    this.root.add(this.pivot);
    const tpl = templates.get(`${o.kind ?? (o.variant % 2 ? "diaper" : "suit")}_${o.tone ?? o.team}`) ?? null;
    if (tpl) this.buildGlb(tpl, o); else this.buildProcedural(o);
    this.tag = this.makeTag(o.name, o.tagColor ?? o.accent ?? (o.team === "blue" ? 0x2f8bff : 0xffb02e));
    this.tag.position.set(0, 1.38, 0);
    this.root.add(this.tag);
    {
      const cv = document.createElement("canvas");
      cv.width = 128; cv.height = 24;
      this.hpCtx = cv.getContext("2d")!;
      this.hpTex = new THREE.CanvasTexture(cv);
      this.hpTex.colorSpace = THREE.SRGBColorSpace;
      this.hpEdge = "#" + (o.tagColor ?? o.accent ?? 0xffb02e).toString(16).padStart(6, "0");
      this.hpBar = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.hpTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }));
      this.hpBar.scale.set(0.62, 0.116, 1);
      this.hpBar.position.set(0, 1.27, 0);
      this.hpBar.renderOrder = 6;
      this.hpBar.visible = false;
      this.root.add(this.hpBar);
      this.setHp(1);
    }
  }

  private mk(color: number, rough = 0.55) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough });
    this.mats.push(m);
    return m;
  }
  private sph(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, parent?: THREE.Object3D) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    (parent ?? this.pivot).add(m);
    return m;
  }

  private buildProcedural(o: ToddlerOpts) {
    const v = o.variant;
    const skinC = SKINS[(v * 5 + (o.team === "pink" ? 2 : 0)) % SKINS.length];
    const skin = this.mk(skinC, 0.6);
    const suit = this.mk(ONESIE[o.team][v % 4], 0.5);
    const white = this.mk(0xffffff, 0.6);
    const trim = this.mk(o.team === "blue" ? 0xffffff : 0xfff0a8, 0.5);
    const dark = this.mk(0x1a1220, 0.35);
    const shoe = this.mk([0xffd23f, 0xff8c1a, 0x69db7c, 0xb197fc][v % 4], 0.4);
    const hairC = HAIR[(v * 3 + 1) % HAIR.length];
    const hair = this.mk(hairC, 0.7);
    const P = this.pivot;

    // torso (onesie) + poofy diaper
    const bodyG = new THREE.Group(); bodyG.position.y = 0.46; P.add(bodyG); this.rig.body = bodyG;
    this.sph(0.27, suit, 0, 0.04, 0, 1, 1.05, 0.92, bodyG);
    this.sph(0.285, white, 0, -0.17, -0.02, 1.02, 0.72, 1.0, bodyG); // diaper
    this.sph(0.12, white, 0, -0.2, -0.22, 1.2, 0.9, 0.9, bodyG); // back poof
    const belly = this.sph(0.1, trim, 0, 0.04, 0.22, 1.3, 1, 0.3, bodyG); belly.name = "belly";
    // collar
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.04, 8, 18), trim);
    collar.rotation.x = Math.PI / 2; collar.position.y = 0.26; bodyG.add(collar);

    // head
    const head = new THREE.Group(); head.position.y = 0.92; P.add(head); this.rig.head = head;
    this.sph(0.27, skin, 0, 0, 0, 1.0, 0.96, 0.98, head);
    for (const s of [-1, 1]) {
      this.sph(0.06, skin, s * 0.265, -0.01, 0, 0.6, 1, 0.9, head); // ears
      this.lids.push(this.sph(0.075, white, s * 0.1, 0.035, 0.225, 1, 1.18, 0.55, head)); // eye white
      const pup = this.sph(0.042, dark, s * 0.1, 0.03, 0.262, 1, 1.15, 0.5, head); pup.name = "pupil"; this.pupils.push(pup);
      this.sph(0.014, white, s * 0.1 + 0.012, 0.055, 0.285, 1, 1, 0.6, head);
      this.cheeks.push(this.sph(0.058, this.mk(0xffa5a5, 0.7), s * 0.165, -0.065, 0.2, 1, 0.65, 0.5, head)); // cheek
      const tear = this.sph(0.026, this.mk(0xa6e4ff, 0.15), s * 0.15, -0.11, 0.245, 0.9, 1.7, 0.7, head); tear.visible = false; this.tears.push(tear);
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.01, 0.06, 4, 6), hair);
      brow.position.set(s * 0.1, 0.115, 0.255); brow.rotation.z = Math.PI / 2 - s * 0.15; brow.userData.s = s; head.add(brow); this.brows.push(brow);
    }
    this.sph(0.03, this.mk(new THREE.Color(skinC).multiplyScalar(0.93).getHex(), 0.6), 0, -0.015, 0.265, 1, 0.8, 0.8, head); // nose (skin tone, never red)
    const mouth = this.sph(0.036, this.mk(0x5a2a38, 0.5), 0, -0.1, 0.25, 1.5, 0.7, 0.5, head); mouth.name = "mouth";
    this.rig.mouth = mouth;
    this.mouthBase.copy(mouth.scale);
    // pacifier on some babies
    if (v % 3 === 1) {
      const col = this.mk(o.team === "blue" ? 0xffd23f : 0x6fe3c4, 0.3);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.016, 16), col);
      disc.rotation.x = Math.PI / 2; disc.position.set(0, -0.105, 0.285); head.add(disc);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.009, 6, 12), col); ring.position.set(0, -0.105, 0.31); head.add(ring);
      this.sph(0.03, white, 0, -0.1, 0.268, 1, 1, 0.8, head);
      mouth.visible = false; this.rig.mouth = disc; this.pacifier = true; this.mouthBase.set(1, 1, 1);
    }
    // hair / hats
    const style = v % 4;
    if (style === 0) { // soft hair cap + one little curl
      const softHair = this.mk(new THREE.Color(hairC).lerp(new THREE.Color(0xd9a45a), 0.45).getHex(), 0.85);
      this.sph(0.25, softHair, 0, 0.1, -0.05, 1.0, 0.62, 0.95, head);
      const curl = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.02, 8, 16, Math.PI * 1.55), softHair);
      curl.position.set(0.02, 0.285, 0.05); curl.rotation.set(0.2, 0.5, 0.6); curl.castShadow = true; head.add(curl);
    } else if (style === 1) { // beanie with pompom
      const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.285, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.46), this.mk(o.team === "blue" ? 0xffd23f : 0x7a6cf0, 0.6));
      beanie.position.y = 0.025; beanie.rotation.x = -0.15; beanie.castShadow = true; head.add(beanie);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.035, 8, 22), white); band.rotation.x = Math.PI / 2 - 0.15; band.position.y = 0.06; head.add(band);
      this.sph(0.07, white, 0, 0.3, -0.04, 1, 1, 1, head);
    } else if (style === 2) { // pigtails
      this.sph(0.2, hair, 0, 0.1, -0.05, 1.05, 0.7, 1, head);
      for (const s of [-1, 1]) { this.sph(0.075, hair, s * 0.24, 0.2, -0.02, 1, 1, 1, head); this.sph(0.035, this.mk(0xff5c8a, 0.4), s * 0.2, 0.17, -0.02, 1, 1, 1, head); }
    } else { // bonnet with bow
      const bonnet = new THREE.Mesh(new THREE.SphereGeometry(0.29, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), this.mk(o.team === "blue" ? 0xe6f2ff : 0xfff0f6, 0.8));
      bonnet.position.set(0, 0.0, -0.025); bonnet.rotation.x = -0.25; bonnet.castShadow = true; head.add(bonnet);
      const frill = new THREE.Mesh(new THREE.TorusGeometry(0.255, 0.03, 8, 22, Math.PI * 1.2), white); frill.position.set(0, 0.07, 0.17); frill.rotation.set(-0.3, 0, Math.PI * 0.4); head.add(frill);
      for (const s of [-1, 1]) this.sph(0.05, this.mk(0xff5c8a, 0.4), s * 0.07, -0.22, 0.17, 1.2, 0.8, 0.6, head);
      this.sph(0.04, this.mk(0xff5c8a, 0.4), 0, -0.22, 0.18, 1, 1, 1, head);
    }

    // arms
    const mkArm = (s: number) => {
      const a = new THREE.Group();
      a.position.set(s * 0.3, 0.64, 0);
      const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.13, 6, 10), suit);
      sleeve.position.y = -0.1; sleeve.castShadow = true; a.add(sleeve);
      this.sph(0.075, skin, 0, -0.24, 0, 1, 1, 1, a);
      P.add(a);
      return a;
    };
    this.rig.armL = mkArm(-1);
    this.rig.armR = mkArm(1);
    // legs
    const mkLeg = (s: number) => {
      const l = new THREE.Group();
      l.position.set(s * 0.13, 0.27, 0);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.092, 0.07, 6, 10), skin);
      leg.position.y = -0.08; leg.castShadow = true; l.add(leg);
      this.sph(0.1, shoe, 0, -0.2, 0.05, 1.0, 0.7, 1.45, l);
      P.add(l);
      return l;
    };
    this.rig.legL = mkLeg(-1);
    this.rig.legR = mkLeg(1);
    // blaster in the right hand
    const gun = buildWeaponModel("blaster").group;
    gun.scale.setScalar(0.62);
    gun.rotation.x = -Math.PI / 2;
    gun.position.set(0, -0.24, 0.02);
    (this.rig.armR as THREE.Group).add(gun);
    this.gun = gun;
    this.muzzle.set(0.3, 0.42, 0.62);
  }

  private buildGlb(tpl: GLTF, o: ToddlerOpts) {
    this.isGlb = true;
    const model = cloneSkinned(tpl.scene);
    model.rotation.y = GLB_YAW;
    const wrap = new THREE.Group();
    wrap.add(model);
    // skinned geometry is authored in metres (the cm armature scale cancels in the skin matrices): size from the bind-pose geometry
    let h = 0, minY = 0;
    model.traverse((c) => {
      const m = c as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) { m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox!; h = Math.max(h, bb.max.y - bb.min.y); minY = bb.min.y; }
    });
    h = h || 0.9;
    const s = TODDLER_HEIGHT / h;
    model.scale.setScalar(s);
    model.position.y = -minY * s;
    // per-baby material clones so the hit flash does not light up everybody; texture stays shared
    model.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; // blob shadow below instead (skinned shadow pass is costly)
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.roughness = 0.8; mat.metalness = 0;
        m.material = mat; this.mats.push(mat);
      }
      if ((c as THREE.Bone).isBone) this.bones[c.name] = c as THREE.Bone;
    });
    this.pivot.add(wrap);
    // team ring under the feet
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.5, 28), new THREE.MeshBasicMaterial({ color: o.accent ?? (o.team === "blue" ? 0x2f8bff : 0xffb02e), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
    this.root.add(ring);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.36, 20), new THREE.MeshBasicMaterial({ color: 0x20120a, transparent: true, opacity: 0.26, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.012; this.root.add(blob);
    // blaster in the right hand: compensate the bone's world scale (armature is in cm) and orient along the hand
    const hand = this.bones.RightHand;
    const gm = buildWeaponModel("blaster");
    const gun = gm.group;
    this.gun = gun; this.gunMuzzle = gm.muzzle;
    if (hand) {
      this.root.updateWorldMatrix(true, true);
      const ws = new THREE.Vector3(), wq = new THREE.Quaternion(), wp = new THREE.Vector3();
      hand.matrixWorld.decompose(wp, wq, ws);
      const k = 0.55 / ws.x;
      gun.scale.setScalar(k);
      // gun forward is -Z in its own frame; aim it along the root's +Z at rest
      const rootQ = new THREE.Quaternion(); this.root.getWorldQuaternion(rootQ);
      const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
      gun.quaternion.copy(wq.invert().multiply(rootQ).multiply(want));
      gun.position.copy(GUN_OFFSET).divideScalar(ws.x);
      this.gunRestQ.copy(gun.quaternion);
      hand.add(gun);
    } else { gun.scale.setScalar(0.5); gun.position.set(0.3, 0.55, 0.3); this.pivot.add(gun); }
    this.muzzle.set(0.28, 0.62, 0.7);
    // muzzle flash sprite (shown for a few frames when the baby fires)
    const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    fl.visible = false; fl.scale.setScalar(0.4); fl.renderOrder = 5;
    this.root.add(fl); this.flashSprite = fl;
    this.mixer = new THREE.AnimationMixer(model);
    for (const a of tpl.animations) {
      const n = a.name.toLowerCase();
      const key = n.includes("run") ? "run" : n.includes("walk") ? "walk" : n.includes("idle") ? "idle" : "";
      if (!key) continue;
      const act = this.mixer.clipAction(a);
      act.play(); act.setEffectiveWeight(key === "idle" ? 1 : 0);
      if (key === "walk") act.time = (this.phase / 6) % 1;
      this.actions[key as "walk"] = act;
    }
    for (const n of ["Hips", "Spine", "Spine01", "Spine02", "Head", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftShoulder", "RightShoulder", "RightHand", "LeftHand"]) {
      const bn = this.bones[n]; if (bn) this.rest[n] = bn.quaternion.clone();
    }
  }

  private makeTag(text: string, color: number) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 72;
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(20,20,40,0.55)";
    g.beginPath(); g.roundRect(8, 8, 240, 56, 28); g.fill();
    g.lineWidth = 5; g.strokeStyle = "#" + color.toString(16).padStart(6, "0"); g.stroke();
    g.fillStyle = "#fff"; g.font = "800 36px 'Arial Rounded MT Bold', 'Trebuchet MS', Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 128, 38);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
    s.scale.set(0.58, 0.163, 1);
    return s;
  }

  /** crying face: squeezed eyes, sad brows, flushed puffy cheeks, tear streams */
  private cry(on: boolean) {
    if (this.crying === on) return;
    this.crying = on;
    this.lids.forEach((l) => l.scale.set(1, on ? 0.28 : 1.18, 0.55));
    this.pupils.forEach((p) => (p.visible = !on));
    this.cheeks.forEach((c) => { c.scale.set(on ? 1.5 : 1, on ? 1.05 : 0.65, 0.5); (c.material as THREE.MeshStandardMaterial).color.setHex(on ? 0xff9a9a : 0xffa5a5); });
    this.tears.forEach((t) => (t.visible = on));
    this.brows.forEach((b) => { const s = b.userData.s as number; b.rotation.z = Math.PI / 2 + (on ? s * 0.45 : -s * 0.15); b.position.y = on ? 0.14 : 0.115; });
  }
  private crying = false;

  flash() { this.flashT = 0.14; }

  /** Redraw the health bar: rounded pill, team-tinted outline, green -> yellow -> orange fill (no red). */
  setHp(frac: number) {
    frac = Math.max(0, Math.min(1, frac));
    if (Math.abs(frac - this.hpFrac) < 0.004) return;
    this.hpFrac = frac;
    const g = this.hpCtx, W = 128, H = 24;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(20,20,40,0.7)";
    g.beginPath(); g.roundRect(1, 1, W - 2, H - 2, 11); g.fill();
    const w = Math.max(0, (W - 10) * frac);
    if (w > 1) {
      const gr = g.createLinearGradient(5, 0, W - 5, 0);
      gr.addColorStop(0, "#ff9f3a"); gr.addColorStop(0.5, "#ffd93d"); gr.addColorStop(1, "#7fd13b");
      g.save();
      g.beginPath(); g.roundRect(5, 5, W - 10, H - 10, 7); g.clip();
      g.fillStyle = gr; g.fillRect(5, 5, w, H - 10);
      g.fillStyle = "rgba(255,255,255,0.28)"; g.fillRect(5, 5, w, 3);
      g.restore();
    }
    g.lineWidth = 3; g.strokeStyle = this.hpEdge;
    g.beginPath(); g.roundRect(1.5, 1.5, W - 3, H - 3, 11); g.stroke();
    this.hpTex.needsUpdate = true;
  }
  recoil() { this.recoilT = 0.14; this.gunFlashT = 0.07; }
  /** Raise the blaster and point it at a world position for the next `hold` seconds (GLB rigs only). */
  aimAt(p: THREE.Vector3, hold = 0.35) { this.aimPoint.copy(p); this.aimHold = hold; }
  /** World position of the blaster tip (follows the aim pose). */
  muzzleWorld(out: THREE.Vector3) {
    if (this.isGlb && this.gunMuzzle) {
      this.gunMuzzle.getWorldPosition(out);
      return out;
    }
    return this.worldPoint(this.muzzle, out);
  }
  popIn() { this.popT = 0; }
  skipPop() { this.popT = 1; this.root.scale.setScalar(1); }

  worldPoint(local: THREE.Vector3, out: THREE.Vector3) {
    this.root.updateWorldMatrix(true, false);
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  /** Eye position in world space (for tears). */
  eye(side: number, out: THREE.Vector3) {
    return this.worldPoint(new THREE.Vector3(side * 0.1, 0.95 + this.pivot.position.y, 0.25), out);
  }

  /** Blend a bone from whatever the mixer wrote toward rest * euler by weight k. */
  private bq(name: string, k: number, x: number, y = 0, z = 0) {
    const b = this.bones[name], r = this.rest[name];
    if (!b || !r) return;
    _q.copy(r).multiply(_q2.setFromEuler(_e.set(x, y, z)));
    b.quaternion.slerp(_q, k);
  }
  private add(name: string, x: number, y = 0, z = 0) {
    const b = this.bones[name];
    if (b) b.quaternion.multiply(_q2.setFromEuler(_e.set(x, y, z)));
  }

  /** Rotate a bone by a world-space delta rotation (convention independent), blended by weight w. */
  private rotWorld(bone: THREE.Object3D, delta: THREE.Quaternion, w: number) {
    bone.getWorldQuaternion(_bq);
    (bone.parent as THREE.Object3D).getWorldQuaternion(_pq);
    _wq.copy(delta).multiply(_bq);
    _pq.invert().multiply(_wq);
    bone.quaternion.slerp(_pq, w);
  }

  /** Point `bone`'s child chain (bone -> end) at world point `aim`, using shoulder-to-end as the arm vector. */
  private pointArm(arm: THREE.Object3D | undefined, end: THREE.Object3D | undefined, aim: THREE.Vector3, w: number) {
    if (!arm || !end) return;
    arm.getWorldPosition(_a); end.getWorldPosition(_b);
    _c.copy(_b).sub(_a); if (_c.lengthSq() < 1e-8) return;
    _d.copy(aim).sub(_a); if (_d.lengthSq() < 1e-8) return;
    _dq.setFromUnitVectors(_c.normalize(), _d.normalize());
    this.rotWorld(arm, _dq, w);
  }

  /** Aim pose after the animation mixer: lean the torso, point both arms and the blaster at aimPoint, look at it. */
  private aimPass() {
    const k = this.aimK;
    if (k < 0.01 || !this.gun) return;
    const B = this.bones, root = this.root;
    root.updateMatrixWorld(true);
    // torso pitch toward the target (about the baby's own right axis)
    const chest = B.Spine ?? B.Spine01;
    if (chest) {
      chest.getWorldPosition(_a);
      _c.copy(this.aimPoint).sub(_a);
      const flat = Math.hypot(_c.x, _c.z) || 1e-3;
      const pitch = Math.atan2(_c.y, flat);
      _d.copy(_X).applyQuaternion(root.getWorldQuaternion(_wq));
      const kick = this.recoilT > 0 ? Math.sin((this.recoilT / 0.14) * Math.PI) : 0;
      _dq.setFromAxisAngle(_d.normalize(), -(pitch * 0.35) + kick * 0.1);
      for (const n of ["Spine02", "Spine01", "Spine"]) if (B[n]) this.rotWorld(B[n], _dq, k * 0.5);
      root.updateMatrixWorld(true);
    }
    // arms: right arm points at the target, left arm supports the blaster
    const aim = this.aimPoint;
    const kickUp = this.recoilT > 0 ? Math.sin((this.recoilT / 0.14) * Math.PI) * 0.12 : 0;
    if (B.RightArm && B.RightHand) {
      B.RightArm.getWorldPosition(_a);
      _c.copy(aim).sub(_a);
      if (kickUp) _c.y += _c.length() * kickUp; // blaster kicks up on the shot
      _d.copy(_a).add(_c);
      this.pointArm(B.RightArm, B.RightHand, _d, k);
      root.updateMatrixWorld(true);
    }
    if (B.RightForeArm) { B.RightForeArm.quaternion.slerp(this.rest.RightForeArm ?? B.RightForeArm.quaternion, k * 0.7); root.updateMatrixWorld(true); }
    if (B.LeftArm && B.LeftHand && B.RightHand) {
      B.RightHand.getWorldPosition(_c);
      // support hand goes to the front of the blaster (a bit toward the muzzle side)
      this.gunMuzzle?.getWorldPosition(_d);
      _c.lerp(_d, 0.25);
      this.pointArm(B.LeftArm, B.LeftHand, _c, k * 0.9);
      root.updateMatrixWorld(true);
    }
    // head looks at the target
    const head = B.Head;
    if (head) {
      head.getWorldPosition(_a);
      _d.copy(aim).sub(_a).normalize();
      _c.set(0, 0, 1).applyQuaternion(root.getWorldQuaternion(_wq)); // baby forward
      _dq.setFromUnitVectors(_c, _d);
      _dq.slerp(_q.identity(), 0.4);
      this.rotWorld(head, _dq, k);
      root.updateMatrixWorld(true);
    }
    // the blaster: world-aligned to the target, from wherever the hand ended up
    const hand = B.RightHand;
    if (hand) {
      this.gun.getWorldPosition(_a);
      _d.copy(aim).sub(_a).normalize();
      _dq.setFromUnitVectors(_FWD, _d);
      hand.getWorldQuaternion(_bq);
      _pq.copy(_bq).invert().multiply(_dq);
      this.gun.quaternion.copy(this.gunRestQ).slerp(_pq, k);
      this.gun.updateMatrixWorld(true);
    }
  }

  /** Skinned baby: blend idle / walk / run by speed, plop onto the bum when downed. */
  private updateGlb(dt: number, speed: number, down: boolean) {
    const A = this.actions, P = this.pivot;
    const k = 1 - Math.exp(-10 * dt);
    const tIdle = down || speed < 0.25 ? 1 : 0;
    const tRun = !down && speed > 2.6 ? clamp((speed - 2.6) / 1.2, 0, 1) : 0;
    const tWalk = down || speed < 0.25 ? 0 : 1 - tRun;
    this.wIdle += (tIdle - this.wIdle) * k; this.wWalk += (tWalk - this.wWalk) * k; this.wRun += (tRun - this.wRun) * k;
    A.idle?.setEffectiveWeight(this.wIdle); A.walk?.setEffectiveWeight(this.wWalk); A.run?.setEffectiveWeight(this.wRun);
    // keep the feet from skating: stride speed follows ground speed
    if (A.walk) A.walk.timeScale = clamp(speed / WALK_REF, 0.5, 1.7);
    if (A.run) A.run.timeScale = clamp(speed / RUN_REF, 0.7, 1.5);
    this.mixer!.update(dt);
    // sit-down state (overrides on top of the idle pose)
    this.downK += ((down ? 1 : 0) - this.downK) * (1 - Math.exp(-(down ? 14 : 18) * dt));
    const d = this.downK;
    // breathing / waddle on the pivot
    const amp = clamp(speed / 3.2, 0, 1);
    P.position.set(0, 0, 0); P.rotation.set(0, 0, 0);
    if (d > 0.01) {
      P.position.y = -0.30 * d + Math.sin(this.t * 22) * 0.008 * d;
      P.rotation.x = -0.35 * d;
      P.rotation.z = Math.sin(this.t * 14) * 0.07 * d;
      const w = Math.sin(this.t * 17) * 0.35;
      this.bq("LeftUpLeg", d, -1.45, 0, 0.25); this.bq("RightUpLeg", d, -1.45, 0, -0.25);
      this.bq("LeftLeg", d, 0.15); this.bq("RightLeg", d, 0.15);
      this.bq("LeftArm", d, -2.3 + w, 0, 0.3); this.bq("RightArm", d, -2.3 - w, 0, -0.3);
      this.bq("Head", d, -0.25 + Math.sin(this.t * 13) * 0.05, 0, Math.sin(this.t * 9) * 0.12);
      if (this.gun) this.gun.visible = false;
    } else {
      P.position.y = Math.abs(Math.sin(this.phase)) * 0.02 * amp;
      if (this.gun) this.gun.visible = true;
      const kick = this.recoilT > 0 ? Math.sin((this.recoilT / 0.14) * Math.PI) : 0;
      if (kick > 0 && this.aimK < 0.05) this.add("Spine02", -kick * 0.12);
      this.aimPass();
    }
  }

  update(dt: number, speed: number, pose: Pose) {
    this.t += dt;
    const P = this.pivot, rig = this.rig;
    this.recoilT = Math.max(0, this.recoilT - dt);
    // aim pose ramps in/out
    this.aimHold = Math.max(0, this.aimHold - dt);
    this.aimK += ((pose === "alive" && this.aimHold > 0 ? 1 : 0) - this.aimK) * (1 - Math.exp(-(this.aimHold > 0 ? 16 : 9) * dt));
    if (this.aimK < 0.005) this.aimK = 0;
    // pop-in scale
    if (this.popT < 1) {
      this.popT = Math.min(1, this.popT + dt * 3.2);
      const e = this.popT, s = 1 + Math.sin(e * Math.PI) * 0.25 * (1 - e) + (e - 1) * 0.0;
      this.root.scale.setScalar(clamp(e * 1.2, 0, 1) * Math.max(0.0, s));
    }
    // flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(0, this.flashT / 0.14);
      for (const m of this.mats) { m.emissive.setRGB(k, k, k); }
    }
    const amp = clamp(speed / 3.2, 0, 1);
    const down = pose === "down";
    if (down) this.phase = 0; else this.phase += dt * (5 + speed * 2.4);
    const ph = this.phase;
    const sw = Math.sin(ph);
    if (this.isGlb && this.mixer) {
      this.updateGlb(dt, speed, down);
      if (this.flashSprite) {
        this.gunFlashT = Math.max(0, this.gunFlashT - dt);
        const on = this.gunFlashT > 0 && !down && this.gunMuzzle;
        this.flashSprite.visible = !!on;
        if (on) {
          this.gunMuzzle!.getWorldPosition(_a);
          this.flashSprite.position.copy(this.root.worldToLocal(_a));
          this.flashSprite.scale.setScalar(0.3 + (this.gunFlashT / 0.07) * 0.22);
        }
      }
      return;
    }
    if (this.mixer) this.mixer.update(dt);
    P.position.y = down ? -0.2 + Math.sin(this.t * 22) * 0.012 : Math.abs(sw) * 0.055 * amp;
    P.position.x = down ? Math.sin(this.t * 31) * 0.02 : 0;
    P.rotation.z = down ? Math.sin(this.t * 16) * 0.05 : sw * 0.12 * amp;
    P.rotation.x = down ? -0.12 : 0.1 * amp;
    const r = (k: string) => rig[k];
    const legL = r("legL"), legR = r("legR"), armL = r("armL"), armR = r("armR"), head = r("head"), body = r("body"), mouth = r("mouth");
    if (down) {
      legL.rotation.x = legR.rotation.x = -1.45;
      legL.rotation.z = 0.28; legR.rotation.z = -0.28;
      legL.position.y = legR.position.y = 0.27;
      armL.rotation.set(-2.5 + Math.sin(this.t * 17) * 0.18, 0, 0.45);
      armR.rotation.set(-2.5 + Math.sin(this.t * 17 + 2) * 0.18, 0, -0.45);
      head.rotation.set(-0.3 + Math.sin(this.t * 13) * 0.05, 0, Math.sin(this.t * 9) * 0.1);
      body.rotation.x = -0.12;
      if (this.pacifier) mouth.scale.set(1, 1, 1); else mouth.scale.set(this.mouthBase.x * 1.3, this.mouthBase.y * (4 + Math.sin(this.t * 14)), this.mouthBase.z * 1.4);
      if (this.gun) this.gun.visible = false;
      this.cry(true);
      return;
    }
    this.cry(false);
    if (this.gun) this.gun.visible = true;
    legL.rotation.set(sw * 0.85 * amp, 0, 0);
    legR.rotation.set(-sw * 0.85 * amp, 0, 0);
    legL.rotation.z = legR.rotation.z = 0;
    // left arm swings; right arm holds the blaster forward
    armL.rotation.set(-sw * 0.8 * amp, 0, 0.1);
    const kick = this.recoilT > 0 ? Math.sin((this.recoilT / 0.14) * Math.PI) * 0.35 : 0;
    armR.rotation.set(-1.35 - kick + Math.sin(this.t * 2) * 0.02 + Math.sin(ph * 2) * 0.03 * amp, 0.12, 0);
    head.rotation.set(Math.sin(this.t * 1.7) * 0.02, 0, -sw * 0.07 * amp);
    body.rotation.set(0, sw * 0.12 * amp, 0);
    body.scale.y = 1 + Math.sin(this.t * 2.2) * 0.012;
    mouth.scale.copy(this.mouthBase);
  }
}
