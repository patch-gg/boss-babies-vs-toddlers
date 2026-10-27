import * as THREE from "three";
import { Toddler, type Kind } from "./characters";

/** Render each baby model once into a card canvas (offscreen renderer, disposed afterwards). */
export function renderPortraits(cards: { canvas: HTMLCanvasElement; kind: Kind; tone: "blue" | "pink"; accent: number }[]) {
  let r: THREE.WebGLRenderer | null = null;
  try {
    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.1;
    for (const c of cards) {
      const w = c.canvas.width, h = c.canvas.height;
      r.setSize(w, h, false);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0xffe3c2, 1.7));
      const sun = new THREE.DirectionalLight(0xfff2dd, 2.6); sun.position.set(2.5, 4, 3); scene.add(sun);
      const rim = new THREE.DirectionalLight(0xbfe0ff, 1.2); rim.position.set(-3, 2, -2); scene.add(rim);
      const t = new Toddler({ team: "blue", variant: 0, name: "", kind: c.kind, tone: c.tone, accent: c.accent, seed: 3 });
      t.tag.visible = false;
      t.root.rotation.y = -0.4;
      scene.add(t.root);
      for (let i = 0; i < 8; i++) t.update(1 / 30, 0, "alive");
      const cam = new THREE.PerspectiveCamera(26, w / h, 0.1, 30);
      cam.position.set(0.15, 0.62, 3.1);
      cam.lookAt(0, 0.5, 0);
      r.setClearColor(0x000000, 0);
      r.render(scene, cam);
      const g = c.canvas.getContext("2d")!;
      g.clearRect(0, 0, w, h);
      g.drawImage(r.domElement, 0, 0, w, h);
    }
  } catch { /* cards just show their gradient */ }
  finally { r?.dispose(); r?.forceContextLoss(); }
}
