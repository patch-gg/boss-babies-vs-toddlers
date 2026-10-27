import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type WeaponId = "blaster" | "pacifier" | "binky";

export interface WeaponDef {
  id: WeaponId;
  name: string;
  tag: string;
  auto: boolean;
  interval: number;
  mag: number;
  reload: number;
  dmg: number;
  speed: number;
  grav: number;
  spread: number;
  adsSpread: number;
  zoom: number;
  scope: boolean;
  kick: number;
  size: number;
  sfx: "fire" | "fire2" | "sniper";
  food: number[];
}

export const WEAPONS: WeaponDef[] = [
  { id: "blaster", name: "SPLAT BLASTER", tag: "AUTO", auto: true, interval: 0.115, mag: 30, reload: 1.7, dmg: 20, speed: 46, grav: 3.5, spread: 0.03, adsSpread: 0.01, zoom: 1.3, scope: false, kick: 1, size: 0.1, sfx: "fire", food: [0xffa648, 0x9be36a] },
  { id: "pacifier", name: "PACIFIER PISTOL", tag: "SEMI", auto: false, interval: 0.2, mag: 12, reload: 1.2, dmg: 34, speed: 58, grav: 3.0, spread: 0.014, adsSpread: 0.003, zoom: 1.2, scope: false, kick: 1.3, size: 0.11, sfx: "fire", food: [0xffbd7a, 0xffe066] },
  { id: "binky", name: "BINKY-SCOPE", tag: "SNIPER", auto: false, interval: 1.0, mag: 4, reload: 2.1, dmg: 100, speed: 140, grav: 0.8, spread: 0.07, adsSpread: 0, zoom: 4.2, scope: true, kick: 3, size: 0.14, sfx: "sniper", food: [0xa99af7, 0x9be36a] },
];

export interface WeaponModel {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  bottle: THREE.Group;
  fill: THREE.Mesh;
  /** local position of the right hand's palm */
  grip: THREE.Vector3;
}

const mats = new Map<number, THREE.MeshStandardMaterial>();
export function plastic(color: number, rough = 0.28) {
  const k = color * 10 + Math.round(rough * 10);
  let m = mats.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.0 }); mats.set(k, m); }
  return m;
}

function rb(w: number, h: number, d: number, color: number, x: number, y: number, z: number, r = 0.015) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), plastic(color));
  m.position.set(x, y, z);
  return m;
}
function cyl(rt: number, rb2: number, len: number, color: number, x: number, y: number, z: number, axisZ = true) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb2, len, 14), plastic(color));
  if (axisZ) m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

function makeBottle(x: number, y: number, z: number, len: number, rad: number, food: number, ringColor: number) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 0.95, len, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, transparent: true, opacity: 0.38 }));
  shell.position.y = -len / 2;
  const geo = new THREE.CylinderGeometry(rad * 0.84, rad * 0.8, len * 0.92, 14);
  geo.translate(0, len * 0.46, 0);
  const fill = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: food, roughness: 0.4, emissive: food, emissiveIntensity: 0.25 }));
  fill.position.y = -len + 0.01;
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.15, rad * 1.15, len * 0.14, 14), plastic(ringColor));
  ring.position.y = -0.005;
  const nip = new THREE.Mesh(new THREE.SphereGeometry(rad * 0.55, 10, 8), plastic(0xffd9b8, 0.5));
  nip.scale.y = 1.2; nip.position.y = -len - rad * 0.2;
  g.add(shell, fill, ring, nip);
  return { g, fill };
}

export function buildWeaponModel(id: WeaponId): WeaponModel {
  const g = new THREE.Group();
  let muzzleZ = -0.58;
  let bottle: { g: THREE.Group; fill: THREE.Mesh };
  const grip = new THREE.Vector3(0, -0.17, 0.09);
  if (id === "blaster") {
    g.add(rb(0.12, 0.15, 0.46, 0xff8c1a, 0, 0, -0.08, 0.03));
    g.add(rb(0.06, 0.04, 0.36, 0x20c4b0, 0, 0.095, -0.1));
    g.add(rb(0.04, 0.05, 0.04, 0x20c4b0, 0, 0.14, -0.22), rb(0.04, 0.05, 0.04, 0x20c4b0, 0, 0.14, 0.03));
    g.add(cyl(0.038, 0.038, 0.24, 0x20c4b0, 0, 0.0, -0.42));
    g.add(cyl(0.052, 0.052, 0.05, 0xffd23f, 0, 0.0, -0.545));
    g.add(rb(0.075, 0.1, 0.12, 0xffd23f, 0, -0.095, -0.27));
    const gr = rb(0.075, 0.17, 0.09, 0xe86a00, 0, -0.15, 0.1, 0.03); gr.rotation.x = 0.22; g.add(gr);
    g.add(rb(0.09, 0.12, 0.22, 0x20c4b0, 0, -0.01, 0.3, 0.03));
    bottle = makeBottle(0, -0.075, -0.1, 0.19, 0.045, 0xff8a1f, 0x20c4b0);
  } else if (id === "pacifier") {
    muzzleZ = -0.4;
    g.add(rb(0.095, 0.11, 0.3, 0xff7eb6, 0, 0, -0.1, 0.035));
    g.add(rb(0.05, 0.03, 0.22, 0xffffff, 0, 0.07, -0.1));
    const gr = rb(0.078, 0.18, 0.095, 0x6fe3c4, 0, -0.14, 0.07, 0.03); gr.rotation.x = 0.2; g.add(gr);
    const tg = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 20), plastic(0x6fe3c4)); tg.position.set(0, -0.09, -0.08); tg.rotation.y = Math.PI / 2; g.add(tg);
    const disc = cyl(0.1, 0.1, 0.014, 0xfff1f6, 0, 0.0, -0.27); g.add(disc);
    const disc2 = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.013, 8, 24), plastic(0xff7eb6)); disc2.position.set(0, 0, -0.27); g.add(disc2);
    const nip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), plastic(0xffd9b8, 0.5)); nip.scale.z = 1.5; nip.position.set(0, 0, -0.34); g.add(nip);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.01, 8, 16), plastic(0x6fe3c4)); ring.position.set(0, 0.0, -0.245); ring.rotation.y = 0; g.add(ring);
    bottle = makeBottle(0, -0.215, 0.1, 0.13, 0.04, 0xff5c8a, 0xff7eb6);
    grip.set(0, -0.13, 0.07);
  } else {
    muzzleZ = -0.95;
    g.add(rb(0.09, 0.11, 0.66, 0x8e6cf0, 0, 0, -0.15, 0.03));
    g.add(cyl(0.03, 0.03, 0.5, 0x20c4b0, 0, 0.0, -0.66));
    g.add(cyl(0.05, 0.05, 0.05, 0xffd23f, 0, 0, -0.9));
    const bk = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 22), plastic(0x6fe3c4)); bk.position.set(0, 0, -0.9); g.add(bk);
    // scope
    g.add(cyl(0.048, 0.048, 0.34, 0x1a8f86, 0, 0.125, -0.14));
    const lens = cyl(0.062, 0.062, 0.03, 0x222a35, 0, 0.125, -0.32); g.add(lens);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.052, 16), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x4dc3ff, emissiveIntensity: 0.6, roughness: 0.05 }));
    glass.position.set(0, 0.125, -0.337); glass.rotation.y = Math.PI; g.add(glass);
    g.add(cyl(0.056, 0.056, 0.03, 0x222a35, 0, 0.125, 0.03));
    g.add(rb(0.03, 0.05, 0.04, 0x222a35, 0, 0.075, -0.05), rb(0.03, 0.05, 0.04, 0x222a35, 0, 0.075, -0.24));
    const gr = rb(0.078, 0.17, 0.09, 0xffc2d9, 0, -0.15, 0.1, 0.03); gr.rotation.x = 0.22; g.add(gr);
    g.add(rb(0.085, 0.15, 0.3, 0xff7eb6, 0, -0.02, 0.4, 0.035));
    bottle = makeBottle(0, -0.055, -0.18, 0.15, 0.04, 0x7a6cf0, 0x8e6cf0);
  }
  g.add(bottle.g);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, muzzleZ);
  g.add(muzzle);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group: g, muzzle, bottle: bottle.g, fill: bottle.fill, grip };
}
