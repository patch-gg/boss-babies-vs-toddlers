import * as THREE from "three";
import { buildWeaponModel, WEAPONS, type WeaponModel } from "./weapons";
import { clamp, damp, smoothstep } from "./util";
import type { SplatTextures } from "./fx";

interface Slot { model: WeaponModel; holder: THREE.Group; bottleBase: THREE.Vector3; adsPos: THREE.Vector3; flash: THREE.Sprite }

const HIP = new THREE.Vector3(0.21, -0.2, -0.52);
const VM_SCALE = 0.74;

function buildHand(grip: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(grip);
  const skin = new THREE.MeshStandardMaterial({ color: 0xf4c3a3, roughness: 0.6 });
  const sleeveM = new THREE.MeshStandardMaterial({ color: 0x1c1c24, roughness: 0.6 });
  const cuffM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.056, 16, 12), skin);
  palm.scale.set(0.95, 1.15, 1.05);
  g.add(palm);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.03 - i * 0.002, 12, 10), skin);
    f.position.set(0.03, 0.045 - i * 0.034, -0.045);
    f.scale.set(1.0, 0.95, 1.5);
    g.add(f);
  }
  const th = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), skin);
  th.position.set(-0.03, 0.06, -0.035); th.scale.set(1, 1, 1.5); g.add(th);
  const th2 = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), skin);
  th2.position.set(-0.02, 0.075, -0.075); g.add(th2);
  // arm in a puffy sleeve running back toward the camera
  const dir = new THREE.Vector3(0.28, -0.5, 0.82).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), skin);
  wrist.quaternion.copy(q); wrist.position.copy(dir).multiplyScalar(0.06); g.add(wrist);
  const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.022, 8, 16), cuffM);
  cuff.quaternion.copy(q); cuff.position.copy(dir).multiplyScalar(0.14); g.add(cuff);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.6, 14), sleeveM);
  sleeve.quaternion.copy(q); sleeve.position.copy(dir).multiplyScalar(0.44); g.add(sleeve);
  return g;
}

/** Baby rattle: orange flower-shaped head ring around a yellow/green ball, green stick, green ring handle. Head along +Y. */
export function buildRattle(): THREE.Group {
  const g = new THREE.Group();
  const orange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.35 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xffd800, roughness: 0.3 });
  const green = new THREE.MeshStandardMaterial({ color: 0x86c232, roughness: 0.35 });
  // flower ring: 6 soft lobes with a round window
  const R = 0.1, sh = new THREE.Shape();
  const N = 72;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2, r = R * (1 + 0.17 * Math.cos(a * 6));
    if (i === 0) sh.moveTo(Math.cos(a) * r, Math.sin(a) * r); else sh.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, R * 0.68, 0, Math.PI * 2, true);
  sh.holes.push(hole);
  const ring = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.034, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 3, curveSegments: 6 }), orange);
  ring.position.set(0, 0.12, -0.017);
  g.add(ring);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.066, 24, 16), yellow);
  ball.position.set(0, 0.12, 0);
  g.add(ball);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.0675, 24, 12, 0, Math.PI * 2, 0, 1.05), green);
  cap.position.copy(ball.position); cap.rotation.set(0.5, 0, 0.7);
  g.add(cap);
  const collar = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), green);
  collar.position.set(0, 0.016, 0); collar.scale.y = 0.8;
  g.add(collar);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.18, 10), green);
  stick.position.set(0, -0.08, 0); g.add(stick);
  const grip = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.0125, 10, 28), green);
  grip.position.set(0, -0.2, 0); g.add(grip);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  return g;
}

export const MELEE_TIME = 0.45;
/** fraction of the swing at which the bonk lands */
export const MELEE_HIT = 0.42;

export class ViewModel {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.02, 10);
  private slots: Slot[] = [];
  cur = 0;
  private pending = -1;
  private switchT = 1;
  private kickZ = 0; private kickV = 0; private kickR = 0; private kickRV = 0;
  private swayX = 0; private swayY = 0;
  private bobPh = 0;
  ads = 0;
  private flashT = 0;
  private aspectK = 1;
  private rattle = new THREE.Group();
  private meleeP = -1;

  constructor(tex: SplatTextures) {
    this.scene.add(this.cam);
    this.buildRattleRig();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xffddc0, 1.6));
    const d = new THREE.DirectionalLight(0xfff2dd, 2.4);
    d.position.set(1.5, 2.5, 1.2);
    this.scene.add(d);
    const adsPos = [new THREE.Vector3(0, -0.168, -0.42), new THREE.Vector3(0, -0.11, -0.36), new THREE.Vector3(0, -0.2, -0.28)];
    WEAPONS.forEach((w, i) => {
      const model = buildWeaponModel(w.id);
      const holder = new THREE.Group();
      holder.scale.setScalar(VM_SCALE);
      holder.add(model.group);
      model.group.add(buildHand(model.grip));
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.tex(w.food[0], 1), transparent: true, depthTest: false, depthWrite: false }));
      spr.visible = false;
      model.muzzle.add(spr);
      this.scene.add(holder);
      holder.visible = i === 0;
      this.slots.push({ model, holder, bottleBase: model.bottle.position.clone(), adsPos: adsPos[i], flash: spr });
    });
  }

  /** Start the rattle swing. */
  melee() { this.meleeP = 0; }
  get meleeing() { return this.meleeP >= 0; }
  get meleeT() { return this.meleeP; }

  private buildRattleRig() {
    const hand = buildHand(new THREE.Vector3(0, 0, 0));
    const rat = buildRattle();
    rat.position.set(0, 0.02, 0); // palm sits on the stick
    this.rattle.add(rat, hand);
    this.rattle.scale.setScalar(0.95);
    this.rattle.visible = false;
    this.scene.add(this.rattle);
  }

  resize(aspect: number) {
    this.cam.aspect = aspect;
    // keep the horizontal field of view at least that of a 1.2:1 window, so the gun stays small on phones
    this.cam.fov = aspect >= 1.2 ? 55 : (2 * Math.atan(Math.tan((55 * Math.PI) / 360) * (1.2 / aspect)) * 180) / Math.PI;
    this.cam.updateProjectionMatrix();
    this.aspectK = Math.max(0.65, Math.min(1, aspect / 1.4));
  }

  switchTo(i: number) {
    if (i === this.cur || this.pending >= 0) return;
    this.pending = i;
    this.switchT = 0;
  }
  get switching() { return this.pending >= 0; }

  fire(kick: number) {
    this.kickV += 1.1 * kick;
    this.kickRV += 2.2 * kick;
    this.flashT = 0.07;
    const s = this.slots[this.cur];
    s.flash.visible = true;
    s.flash.scale.setScalar((0.28 + Math.random() * 0.16) * (this.cur === 2 ? 1.4 : 1));
    s.flash.material.rotation = Math.random() * 6.28;
  }

  /** Where shots visually leave the barrel, expressed as a world point for the main camera. */
  muzzleWorld(main: THREE.PerspectiveCamera, out: THREE.Vector3) {
    const s = this.slots[this.cur];
    s.model.muzzle.getWorldPosition(out);
    this.cam.updateMatrixWorld(true);
    out.project(this.cam);
    out.z = 0.9;
    out.unproject(main);
    return out;
  }

  update(dt: number, o: { speed: number; sprint: boolean; dyaw: number; dpitch: number; wantAds: boolean; reloadP: number; ammoFrac: number; grounded: boolean; scoped: boolean }) {
    // switching
    if (this.pending >= 0) {
      this.switchT = Math.min(1, this.switchT + dt / 0.4);
      if (this.switchT >= 0.5 && this.cur !== this.pending) {
        this.slots[this.cur].holder.visible = false;
        this.cur = this.pending;
        this.slots[this.cur].holder.visible = true;
      }
      if (this.switchT >= 1) this.pending = -1;
    }
    const s = this.slots[this.cur];
    this.ads = damp(this.ads, o.wantAds && this.pending < 0 && o.reloadP < 0 ? 1 : 0, 14, dt);
    // recoil spring
    this.kickV += (-140 * this.kickZ - 16 * this.kickV) * dt; this.kickZ += this.kickV * dt;
    this.kickRV += (-120 * this.kickR - 15 * this.kickRV) * dt; this.kickR += this.kickRV * dt;
    // sway
    this.swayX = damp(this.swayX, clamp(-o.dyaw * 1.2, -0.06, 0.06), 9, dt);
    this.swayY = damp(this.swayY, clamp(-o.dpitch * 1.2, -0.05, 0.05), 9, dt);
    const moving = o.grounded ? clamp(o.speed / 4, 0, 1.6) : 0;
    this.bobPh += dt * (6 + o.speed * 1.4);
    const bobA = (1 - this.ads * 0.85) * moving;
    const bx = Math.sin(this.bobPh) * 0.011 * bobA, by = Math.abs(Math.cos(this.bobPh)) * 0.014 * bobA - 0.004 * bobA + Math.sin(performance.now() * 0.0016) * 0.0018;
    const h = s.holder;
    const a = this.ads;
    const hip = HIP.clone(); hip.x *= this.aspectK;
    h.position.lerpVectors(hip, s.adsPos, a);
    h.position.x += bx + this.swayX * (1 - a * 0.8);
    h.position.y += by + this.swayY * (1 - a * 0.8);
    h.position.z += this.kickZ * 0.08 * (1 - a * 0.5);
    h.rotation.set(this.kickR * 0.05 + this.swayY * 0.8, 0.07 * (1 - a) + this.swayX * 1.5, 0);
    // sprint pose
    const sp = o.sprint && o.speed > 3 && a < 0.1 ? 1 : 0;
    const spk = (h.userData.spk = damp(h.userData.spk ?? 0, sp, 9, dt));
    h.rotation.y += -0.35 * spk; h.rotation.x += 0.18 * spk; h.position.y -= 0.03 * spk; h.position.x -= 0.03 * spk;
    // switch dip
    if (this.pending >= 0) {
      const e = Math.sin(this.switchT * Math.PI);
      h.position.y -= 0.32 * e; h.rotation.x -= 0.7 * e; h.rotation.z += 0.3 * e;
    }
    // reload
    const b = s.model.bottle;
    b.position.copy(s.bottleBase); b.rotation.set(0, 0, 0); b.visible = true;
    s.model.fill.scale.y = Math.max(0.02, o.ammoFrac);
    if (o.reloadP >= 0) {
      const p = o.reloadP;
      const e = smoothstep(0, 0.18, p) - smoothstep(0.82, 1, p);
      h.position.y -= 0.1 * e; h.rotation.z += 0.45 * e; h.rotation.x -= 0.3 * e; h.position.x -= 0.04 * e;
      const out = smoothstep(0.12, 0.36, p) - smoothstep(0.58, 0.82, p);
      b.position.y -= 0.32 * out; b.position.x += 0.06 * out; b.rotation.z = -0.5 * out;
      b.visible = !(p > 0.35 && p < 0.58) || true;
      if (p > 0.34 && p < 0.58) { b.position.y += Math.sin(p * 60) * 0.01; b.position.y -= 0.32; s.model.fill.scale.y = 1; }
      if (p >= 0.58) s.model.fill.scale.y = 1;
      if (p < 0.34) s.model.fill.scale.y = Math.max(0.02, o.ammoFrac);
      if (p > 0.5 && p < 0.6) { /* sync with sound click */ }
    }
    // rattle bonk: gun drops away, rattle comes in from the lower right, winds back, swings across, returns
    if (this.meleeP >= 0) {
      this.meleeP += dt / MELEE_TIME;
      if (this.meleeP >= 1) this.meleeP = -1;
    }
    const mp = this.meleeP;
    this.rattle.visible = mp >= 0;
    if (mp >= 0) {
      const away = smoothstep(0, 0.2, mp) - smoothstep(0.75, 1, mp);
      h.position.y -= 0.35 * away; h.position.x += 0.12 * away; h.rotation.x -= 0.5 * away;
      const R = this.rattle, wind = smoothstep(0, 0.3, mp), strike = smoothstep(0.3, MELEE_HIT + 0.08, mp), back = smoothstep(0.62, 1, mp);
      // keyframes in camera space: in (low right) -> wind-up (high right) -> strike (centre, forward, down-left) -> out
      const x = 0.34 + (0.30 - 0.34) * wind + (-0.02 - 0.30) * strike + (0.38 + 0.02) * back;
      const y = -0.5 + (-0.12 + 0.5) * wind + (-0.17 + 0.12) * strike + (-0.5 + 0.17) * back;
      const z = -0.32 + (-0.42 + 0.32) * wind + (-0.62 + 0.42) * strike + (-0.3 + 0.62) * back;
      R.position.set(x * this.aspectK + (1 - this.aspectK) * 0.05, y, z);
      // head tilts back during wind-up, snaps forward on the strike
      const rx = -0.2 - 0.9 * wind + 1.5 * strike - 0.7 * back;
      R.rotation.set(rx, 0.35 - 0.7 * strike + 0.5 * back, -0.35 + 0.25 * wind + 0.45 * strike - 0.3 * back);
      const shake = Math.sin(mp * 90) * 0.08 * (wind - strike * 0.5);
      R.rotation.z += shake;
    }
    // muzzle flash
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) s.flash.visible = false; }
    // hide in scope
    h.visible = !(o.scoped && this.ads > 0.85) && this.slots[this.cur] === s && !(mp >= 0 && mp > 0.1 && mp < 0.88);
  }
}
