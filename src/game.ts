import * as THREE from "three";
import { AudioBus, type SfxName } from "./audio";
import { Toddler, type Kind, type Team } from "./characters";
import { Decals, FOOD, ParticleSystem, SplatTextures } from "./fx";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Hud, type MapDot } from "./hud";
import { Input, emptyCmd, type Cmd } from "./input";
import { after, clamp, clock, damp, mulberry32, pick, rr, tickClock, wrapAngle, yawTo, type Rng } from "./util";
import { ViewModel, MELEE_HIT } from "./viewmodel";
import { WEAPONS } from "./weapons";
import { World, type MapId } from "./world";
import { Autopilot } from "./autopilot";

export type GameState = "menu" | "playing" | "won" | "lost";
export type Side = "boss" | "toddlers";
export const SIDES: Record<Side, { name: string; kind: Kind; accent: number; rgb: string; css: string; txt: string }> = {
  boss: { name: "BOSS BABIES", kind: "suit", accent: 0x2f8bff, rgb: "59,155,255", css: "#4da3ff", txt: "#8ec8ff" },
  toddlers: { name: "TODDLERS", kind: "diaper", accent: 0xffb02e, rgb: "255,176,46", css: "#ffc04d", txt: "#ffd98a" },
};
/** Baby voice clip lengths (s). Voices never overlap: the bus cannot stop a clip, so lines are scheduled. */
const VO_DUR: Record<string, number> = {
  baby_booboo: 1.54, baby_bottle: 1.65, cry: 1.65, baby_giggle2: 2.25, baby_gimme: 0.57, baby_mama1: 1.78, baby_mama2: 1.2, baby_mama3: 1.91,
  baby_mama4: 1.67, baby_myturn: 0.73, baby_nightnight: 1.38, baby_nofair: 1.12, baby_peekaboo: 0.57, baby_scream_sfx: 2.25, baby_uhoh: 0.6,
};
const DECK_Y = 1.6;

export const ROUND_TIME = 90;
export const SCORE_LIMIT = 15;
/** player health pool (bots keep 100) */
export const PLAYER_MAX = 150;
const MELEE_RANGE = 2.2;
const EYE = 0.9;
const BOT_DMG_PLAYER = 10;
const BOT_DMG_BOT = 24;

export interface Party {
  id: number; name: string; team: Team; isPlayer: boolean;
  pos: THREE.Vector3; alive: boolean; kills: number; deaths: number;
}

export class Bot implements Party {
  isPlayer = false;
  pos = new THREE.Vector3();
  yaw = 0;
  vx = 0; vz = 0;
  hp = 100;
  alive = false; // "alive" party flag: false while down/gone
  state: "alive" | "down" | "gone" = "gone";
  stateT = 0;
  mode: "wander" | "chase" | "strafe" | "cover" = "wander";
  modeT = 0;
  target: Party | null = null;
  targetVisible = false;
  tgtT = 0;
  goal = new THREE.Vector3();
  strafe = 1;
  fireCd = 1;
  burst = 0;
  burstT = 0;
  reactT = 0;
  inv = 0;
  stuckT = 0;
  lastX = 0; lastZ = 0;
  kills = 0; deaths = 0;
  skill: number;
  steerSign = 1;
  stepAcc = 0;
  tearT = 0;
  cry: THREE.Sprite;
  food: number[];
  speed = 0;
  /** director: run to (x, z) until sim time `until`, ignoring AI */
  force: { x: number; z: number; until: number } | null = null;
  /** two-level navigation: waypoints through a ramp, and the level they lead to */
  route: THREE.Vector3[] | null = null; routeI = 0; routeTop = false;
  vy = 0;
  /** stand still (planted aim) until this sim time */
  stopUntil = 0;
  id: number; name: string; team: Team; toddler: Toddler;
  constructor(id: number, name: string, team: Team, toddler: Toddler, skill: number, cry: THREE.Sprite) {
    this.id = id; this.name = name; this.team = team; this.toddler = toddler;
    this.skill = skill;
    this.cry = cry;
    this.food = team === "pink" ? [FOOD[0], FOOD[2]] : [FOOD[3], FOOD[1]];
    void FOOD;
  }
}

interface Proj {
  mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; owner: Party; dmg: number; grav: number; life: number; color: number; trail: number; active: boolean; fromPlayer: boolean; size: number;
}

interface Drone { group: THREE.Group; rotors: THREE.Object3D[]; pos: THREE.Vector3; target: Bot | null; t: number; buzz: number }
interface Bottle { mesh: THREE.Group; marker: THREE.Mesh; x: number; z: number; delay: number; y: number; v: number; state: 0 | 1 | 2 }

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number, cx: number, cy: number, cz: number, r: number): number {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz, c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = c < 0 ? 0 : -1; // inside
  return t >= 0 && t <= len ? t : -1;
}

export interface GameOpts { seed: number; demo: boolean; team: Side; map: MapId; fps: boolean; fixed: boolean; cap: boolean; step: boolean }
export interface GameEvent { t: number; type: string; [k: string]: unknown }

export class Game {
  // public state for tests / recording
  state: GameState = "menu";
  score = 0;
  opts: GameOpts;
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 300);
  audio = new AudioBus();
  input: Input;
  hud: Hud;
  tex = new SplatTextures();
  vm: ViewModel;
  rng: Rng; fxRng: Rng;
  world!: World;
  mapId: MapId;
  decals: Decals;
  bits: ParticleSystem;
  puffs: ParticleSystem;
  bots: Bot[] = [];
  projs: Proj[] = [];
  projGeo = new THREE.SphereGeometry(1, 12, 8);
  projMats = new Map<number, THREE.MeshStandardMaterial>();
  autopilot: Autopilot | null = null;
  paused = false;
  time = 0;
  timeLeft = ROUND_TIME;
  teamScore = { blue: 0, pink: 0 };
  resultT = 0;
  hadLock = false;

  p = {
    pos: new THREE.Vector3(), vx: 0, vz: 0, vy: 0, yaw: 0, pitch: 0, hp: PLAYER_MAX, alive: true, respawnT: 0, inv: 0, weapon: 0, meleeCd: 0, meleePending: false, lungeT: 0,
    ammo: WEAPONS.map((w) => w.mag), reloadT: -1, fireCd: 0, grounded: true, speed: 0, stepAcc: 0, lastHurt: -9,
    kills: 0, deaths: 0, streak: 0, ready4: false, ready5: false, shake: 0, kickPitch: 0, bobPh: 0, landDip: 0, prevFire: false,
    ads: false, sprint: false, headshots: 0, shots: 0, hits: 0, name: "You", team: "blue" as Team, id: 0, isPlayer: true, alive_: true,
    killer: "", lastDyaw: 0, lastDpitch: 0, hitFlashT: 0,
  };
  playerParty: Party;
  drone: Drone | null = null;
  bottles: Bottle[] = [];
  strikeActive = false;
  fovCur = 74;
  /** capture choreography: kills before this sim time do not build the killstreak */
  streakGate = 0;
  /** director: pink damage vs allies, ally damage vs pink */
  pinkBoost = 1; allyDmg = 1;
  /** director: hand the player the Bottle Strike (b-roll) */
  grantDrone() { this.p.ready4 = true; this.hud.toast("DIAPER DRONE READY", "Press 4"); this.audio.play("streak", { vol: 0.5 }); this.hud.setStreaks(true, this.p.ready5); after(300, () => this.audio.play("vo_drone_ready")); }
  grantStrike() { this.p.ready5 = true; this.hud.toast("BOTTLE STRIKE READY", "Press 5"); this.audio.play("streak", { vol: 0.5 }); this.hud.setStreaks(this.p.ready4, true); }
  /** director: stop player health regen */
  noRegen = false;
  strikeFocus = new THREE.Vector3();
  /** demo/capture: multiplier on damage the player takes (director) */
  hurtScale = 1;
  private baseFov = 74;
  private last = 0;
  private acc = 0;
  private frameN = 0;
  private fpsAcc = 0; private fpsN = 0;
  private selectedMap: MapId;
  private cryTex!: THREE.CanvasTexture;
  private scoped = false;
  private menuOrbit = 0;
  side: Side;
  /** "team" = team select, "map" = map + play, null = in a round */
  menuStage: "team" | "map" | null = null;
  private padPrev = { l: false, r: false, a: false, b: false };
  private voiceBusyUntil = 0;
  private voiceQ: { name: SfxName; x: number; y: number; z: number; vol: number; rate: number; t: number }[] = [];
  private lastHitVoice = -9;
  private aimPt = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, opts: GameOpts) {
    this.opts = opts;
    this.side = opts.team;
    this.canvas = canvas;
    this.rng = mulberry32(opts.seed);
    this.fxRng = mulberry32(opts.seed + 99);
    this.mapId = this.selectedMap = opts.map;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.matchMedia("(pointer: coarse)").matches ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.input = new Input(canvas, document.getElementById("touch")!);
    this.input.onGesture = () => this.audio.unlock();
    this.hud = new Hud(this.tex);
    this.vm = new ViewModel(this.tex);
    this.scene.add(this.camera);
    this.decals = new Decals(this.scene, this.tex, this.fxRng, 160);
    this.bits = new ParticleSystem(this.scene, 700, new THREE.MeshBasicMaterial({ color: 0xffffff }), this.fxRng, 1);
    this.puffs = new ParticleSystem(this.scene, 260, new THREE.MeshLambertMaterial({ color: 0xffffff }), this.fxRng, 1);
    this.bits.nearFrom = this.camera.position; this.puffs.nearFrom = this.camera.position;
    clock.step = opts.step; clock.t = 0; this.audio.stepMode = opts.step;
    this.playerParty = this.p as unknown as Party;
    this.p.pos.set(0, 0, 9);
    this.applySide();
    this.makeCryTexture();
    this.buildWorld(opts.map);
    this.makeBots();
    this.resetPlayer();
    this.resetBots();
    if (opts.demo) this.autopilot = new Autopilot(this);
    this.bindUi();
    this.menuStage = opts.demo ? null : "team";
    this.showStage();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("pointerlockchange", () => {
      if (this.input.locked) { this.hadLock = true; this.paused = false; document.getElementById("pause")!.hidden = true; }
      else if (this.hadLock && this.state === "playing" && !this.opts.demo) { this.paused = true; document.getElementById("pause")!.hidden = false; }
    });
    if (opts.fps) this.hud.setFpsText("-- fps");
    if (opts.demo) { this.audio.unlock(); this.start(); }
    if (opts.cap) document.body.classList.add("cap");
    if (!opts.step) requestAnimationFrame((t) => { this.last = t; this.loop(t); });
    else this.renderOnly();
  }

  /** events for tests / capture tooling */
  log: GameEvent[] = [];
  ev(type: string, extra: Record<string, unknown> = {}) { this.log.push({ t: +clock.t.toFixed(3), type, ...extra }); }
  get audioLog() { return this.audio.log; }
  private animT0 = new WeakMap<Animation, number>();

  /** Offline capture: advance the simulation by exactly dt and (optionally) render one frame. HUD animations follow sim time. */
  step(dt = 1 / 60, render = true) {
    this.update(dt);
    this.syncAnims();
    if (render) this.render();
  }
  private renderOnly() { this.resize(); this.render(); }
  private syncAnims() {
    for (const a of document.getAnimations()) {
      let t0 = this.animT0.get(a);
      if (t0 === undefined) { t0 = clock.t; this.animT0.set(a, t0); }
      a.pause();
      a.currentTime = (clock.t - t0) * 1000;
    }
  }

  // ------------------------------------------------------------ setup
  private makeCryTexture() {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 96;
    const g = c.getContext("2d")!;
    g.font = "900 64px 'Arial Rounded MT Bold','Trebuchet MS',Arial,sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.lineWidth = 10; g.strokeStyle = "#2b2150"; g.strokeText("WAAH!", 128, 50);
    g.fillStyle = "#8fd8ff"; g.fillText("WAAH!", 128, 50);
    this.cryTex = new THREE.CanvasTexture(c);
    this.cryTex.colorSpace = THREE.SRGBColorSpace;
  }

  buildWorld(id: MapId) {
    if (this.world) this.world.dispose();
    this.mapId = id;
    this.decals.clear();
    this.world = new World(id, this.scene);
    this.scene.fog = id === "backyard" ? new THREE.Fog(0xcfeaff, 60, 160) : null;
  }

  other(): Side { return this.side === "boss" ? "toddlers" : "boss"; }

  private applySide() {
    const a = SIDES[this.side], f = SIDES[this.other()];
    this.hud.setTeams(a.name, f.name, a, { ...f, hex: this.other() === "toddlers" ? 0xffc04d : 0x6db4ff });
  }

  /** Kids of the player's team wear the player's outfit, the others the opposite one. */
  private makeBots() {
    for (const b of this.bots) this.scene.remove(b.toddler.root);
    this.bots = [];
    const defs: [string, Team][] = [["Lulu", "blue"], ["Gus", "blue"], ["Bo", "pink"], ["Mimi", "pink"], ["Tater", "pink"], ["Peanut", "pink"], ["Pip", "blue"], ["Waffle", "pink"]];
    const seen = { blue: 0, pink: 0 };
    defs.forEach(([name, team], i) => {
      const info = SIDES[team === "blue" ? this.side : this.other()];
      const tone: Team = seen[team]++ % 2 === 0 ? "blue" : "pink";
      const t = new Toddler({ team, variant: i, name, kind: info.kind, tone, accent: info.accent, seed: this.opts.seed + i * 17 });
      const cry = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.cryTex, transparent: true, depthWrite: false }));
      cry.scale.set(0.9, 0.34, 1); cry.position.set(0, 1.5, 0); cry.visible = false;
      t.root.add(cry);
      this.scene.add(t.root);
      t.root.visible = false;
      const b = new Bot(i + 1, name, team, t, team === "blue" ? 0.8 : 1.3 + (i % 3) * 0.1, cry);
      this.bots.push(b);
    });
  }

  /** Choose a side (menu): rebuild the bots in the right outfits. */
  setSide(side: Side) {
    document.querySelectorAll<HTMLElement>(".team").forEach((c) => c.classList.toggle("sel", c.dataset.team === side));
    if (side === this.side && this.bots.length) { this.applySide(); return; }
    this.side = side;
    this.applySide();
    this.makeBots();
    this.resetBots();
    this.menuTag();
  }

  private menuTag() {
    const el = document.getElementById("menu-tag");
    if (el) el.textContent = `${SIDES[this.side].name} vs ${SIDES[this.other()].name}. Splat 'em.`;
  }

  private showStage() {
    const t = document.getElementById("teamsel")!, m = document.getElementById("menu")!;
    t.hidden = this.menuStage !== "team";
    m.hidden = this.menuStage !== "map";
  }

  private setStage(st: "team" | "map" | null) { this.menuStage = st; this.showStage(); }

  /** Menu input from keyboard / gamepad / cards. */
  private menuKeys(dir: number, ok: boolean, back: boolean) {
    if (this.menuStage === "team") {
      if (dir) this.setSide(dir < 0 ? "boss" : "toddlers");
      if (ok) { this.audio.unlock(); this.setStage("map"); }
    } else if (this.menuStage === "map") {
      if (ok) { this.audio.unlock(); this.requestLock(); this.start(); }
      if (back) this.setStage("team");
      if (dir) this.selMap?.(this.selectedMap === "nursery" ? "backyard" : "nursery");
    }
  }
  private selMap: ((id: MapId) => void) | null = null;

  private pollPad() {
    let l = false, r = false, a = false, b = false;
    try {
      for (const gp of navigator.getGamepads?.() ?? []) {
        if (!gp) continue;
        l = l || (gp.axes[0] ?? 0) < -0.55 || !!gp.buttons[14]?.pressed;
        r = r || (gp.axes[0] ?? 0) > 0.55 || !!gp.buttons[15]?.pressed;
        a = a || !!gp.buttons[0]?.pressed || !!gp.buttons[9]?.pressed;
        b = b || !!gp.buttons[1]?.pressed;
      }
    } catch { /* no gamepad */ }
    const pv = this.padPrev;
    const dir = l && !pv.l ? -1 : r && !pv.r ? 1 : 0;
    this.padPrev = { l, r, a, b };
    if (dir || (a && !pv.a) || (b && !pv.b)) this.menuKeys(dir, a && !pv.a, b && !pv.b);
  }

  private bindUi() {
    const q = (id: string) => document.getElementById(id)!;
    const maps = document.querySelectorAll<HTMLElement>(".map");
    const sel = (id: MapId) => {
      this.selectedMap = id;
      maps.forEach((m) => m.classList.toggle("sel", m.dataset.map === id));
      if (id !== this.mapId) { this.buildWorld(id); this.resetBots(); }
    };
    this.selMap = sel;
    maps.forEach((m) => m.addEventListener("click", () => sel(m.dataset.map as MapId)));
    sel(this.opts.map);
    document.querySelectorAll<HTMLElement>(".team").forEach((c) => c.addEventListener("click", () => {
      this.setSide(c.dataset.team as Side);
      this.menuKeys(0, true, false);
    }));
    this.menuTag();
    q("change-team").addEventListener("click", () => this.setStage("team"));
    q("play").addEventListener("click", () => { this.audio.unlock(); this.requestLock(); this.start(); });
    q("r-again").addEventListener("click", () => { this.requestLock(); this.start(); });
    q("r-menu").addEventListener("click", () => this.toMenu());
    q("pause").addEventListener("click", () => { this.requestLock(); if (this.input.noLock) { this.paused = false; q("pause").hidden = true; } });
    this.setSide(this.side);
    window.addEventListener("keydown", (e) => {
      if (this.state !== "menu" || this.opts.demo) return;
      if (this.menuStage === "team") {
        if (e.code === "Digit1" || e.code === "ArrowLeft" || e.code === "KeyA") this.menuKeys(-1, false, false);
        if (e.code === "Digit2" || e.code === "ArrowRight" || e.code === "KeyD") this.menuKeys(1, false, false);
        if (e.code === "Enter" || e.code === "Space") this.menuKeys(0, true, false);
      } else if (this.menuStage === "map") {
        if (e.code === "Digit1") sel("nursery");
        if (e.code === "Digit2") sel("backyard");
        if (e.code === "Enter") this.menuKeys(0, true, false);
        if (e.code === "Escape" || e.code === "Backspace") this.menuKeys(0, false, true);
      }
    });
  }

  requestLock() {
    if (this.input.usingTouch || this.opts.demo) return;
    try { const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined; if (r && r.catch) r.catch(() => { this.input.noLock = true; }); } catch { this.input.noLock = true; }
  }

  toMenu() {
    if (document.pointerLockElement) document.exitPointerLock();
    document.getElementById("result")!.hidden = true;
    this.hud.show(false);
    this.state = "menu";
    this.setStage("team");
    this.resetBots();
    this.resetPlayer();
    this.p.alive = false;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const a = w / h;
    this.camera.aspect = a;
    const hfov = this.opts.cap ? 80 : 92;
    this.baseFov = a >= 1.5 ? 72 : (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / a) * 180) / Math.PI;
    this.vm.resize(a);
  }

  // ------------------------------------------------------------ round control
  start(map?: MapId) {
    if (map && map !== this.mapId) this.buildWorld(map);
    else if (this.selectedMap !== this.mapId) this.buildWorld(this.selectedMap);
    this.decals.clear();
    for (const pr of this.projs) { pr.active = false; pr.mesh.visible = false; }
    this.clearStrikes();
    this.teamScore = { blue: 0, pink: 0 };
    this.score = 0;
    this.timeLeft = ROUND_TIME;
    this.time = 0;
    this.resetPlayer();
    this.resetBots();
    this.state = "playing";
    this.paused = false;
    this.autopilot?.reset();
    this.menuStage = null; this.showStage();
    this.applySide();
    document.getElementById("result")!.hidden = true;
    document.getElementById("pause")!.hidden = true;
    this.hud.show(true);
    this.hud.setScore(0, 0, SCORE_LIMIT);
    this.hud.setStreaks(false, false);
    this.hud.setWeapon(0, WEAPONS[0].name);
    if (!this.opts.cap) this.hud.toast("GO GO GO!", `First team to ${SCORE_LIMIT} splats wins`);
    this.log = []; this.ev("start");
  }
  restart() { this.start(); }

  private clearStrikes() {
    for (const b of this.bottles) { this.scene.remove(b.mesh); this.scene.remove(b.marker); }
    this.bottles = [];
    this.strikeActive = false;
    if (this.drone) { this.scene.remove(this.drone.group); this.drone = null; }
  }

  private resetPlayer() {
    const p = this.p;
    const sp = this.world.spawns[0];
    p.pos.set(sp.x, sp.y, sp.z); p.grounded = true;
    p.yaw = 0; p.pitch = 0; p.vx = p.vz = p.vy = 0;
    p.hp = PLAYER_MAX; p.alive = true; p.respawnT = 0; p.inv = 1.0; p.weapon = 0; p.meleeCd = 0; p.meleePending = false; p.lungeT = 0;
    p.ammo = WEAPONS.map((w) => w.mag);
    p.reloadT = -1; p.fireCd = 0.3; p.kills = 0; p.deaths = 0; p.streak = 0; p.ready4 = p.ready5 = false;
    p.shake = 0; p.shots = p.hits = p.headshots = 0; p.lastHurt = -9;
    if (this.vm.cur !== 0) this.vm.switchTo(0);
  }

  /** spawn points the bots may use (demo/capture keeps everything on the ground) */
  private spawnPool() { return this.opts.demo ? this.world.spawns.filter((s) => s.y < 0.5) : this.world.spawns; }

  private resetBots() {
    const far = this.spawnPool().filter((s) => (s.z < 0 || Math.abs(s.x) > 10) && Math.hypot(s.x - this.p.pos.x, s.z - this.p.pos.z) > 12);
    const taken: THREE.Vector3[] = [];
    const offs: [number, number][] = [[-3.4, 1.0], [3.4, 1.0], [0, 3.0]];
    let ai = 0;
    this.bots.forEach((b) => {
      b.kills = 0; b.deaths = 0;
      b.toddler.root.visible = true;
      b.cry.visible = false;
      let pos: THREE.Vector3;
      if (b.team === "blue") {
        const o = offs[ai++ % offs.length];
        pos = new THREE.Vector3(this.p.pos.x + o[0], this.p.pos.y, this.p.pos.z + o[1]);
      } else {
        pos = pick(this.rng, far).clone();
        for (let k = 0; k < 6 && taken.some((t) => t.distanceTo(pos) < 5); k++) pos = pick(this.rng, far).clone();
        taken.push(pos);
      }
      this.spawnBot(b, pos);
    });
  }

  spawnBot(b: Bot, pos: THREE.Vector3) {
    b.pos.copy(pos); b.vy = 0; b.route = null; b.stopUntil = 0;
    w_resolve(this.world, b.pos);
    b.hp = 100; b.state = "alive"; b.alive = true; b.stateT = 0; b.inv = 1.4; b.mode = "wander"; b.modeT = rr(this.rng, 0.2, 1.2);
    b.target = null; b.vx = b.vz = 0; b.fireCd = rr(this.rng, 1, 2); b.burst = 0; b.reactT = 0.5;
    b.yaw = yawTo(-b.pos.x, -b.pos.z);
    b.toddler.root.visible = true;
    b.toddler.root.position.copy(b.pos);
    b.toddler.root.rotation.y = b.yaw;
    b.toddler.popIn();
    b.cry.visible = false;
    b.steerSign = this.rng() < 0.5 ? 1 : -1;
  }

  private endRound(won: boolean) {
    if (this.state !== "playing") return;
    this.state = won ? "won" : "lost";
    this.resultT = 0;
    this.audio.play(won ? "win" : "lose", { vol: 0.8 });
    after(500, () => this.audio.play(won ? "vo_round_won" : "vo_nap_time", { vol: 1 }));
    this.ev("end", { won, blue: this.teamScore.blue, pink: this.teamScore.pink });
    if (document.pointerLockElement) document.exitPointerLock();
    const r = document.getElementById("result")!;
    r.className = `overlay ${won ? "won" : "lost"}`;
    r.hidden = false;
    document.getElementById("r-title")!.textContent = won ? "ROUND WON" : "NAP TIME";
    document.getElementById("r-sub")!.textContent = won ? `The ${SIDES[this.side].name} splatted the ${SIDES[this.other()].name}. Snack time!` : `The ${SIDES[this.other()].name} win this one. Time for a nap...`;
    const acc = this.p.shots ? Math.round((this.p.hits / this.p.shots) * 100) : 0;
    document.getElementById("r-stats")!.innerHTML =
      `<div><b>${this.teamScore.blue} - ${this.teamScore.pink}</b>${SIDES[this.side].name.toLowerCase()} vs ${SIDES[this.other()].name.toLowerCase()}</div><div><b>${this.p.kills}</b>your splats</div><div><b>${this.p.deaths}</b>naps</div><div><b>${acc}%</b>accuracy</div>`;
    if (won) this.confetti();
  }

  private confetti() {
    for (let i = 0; i < 160; i++) {
      this.bits.emit(this.p.pos.x + (this.fxRng() - 0.5) * 8, 4 + this.fxRng() * 3, this.p.pos.z + (this.fxRng() - 0.5) * 8 - 3,
        (this.fxRng() - 0.5) * 2, -this.fxRng() * 2, (this.fxRng() - 0.5) * 2, FOOD[i % FOOD.length], 0.12 + this.fxRng() * 0.1, 3 + this.fxRng() * 2, 1.5, 0.3);
    }
  }

  // ------------------------------------------------------------ audio helper
  private lastMama = -1;
  /**
   * Baby voice line. Two babies never talk over each other: a line plays only when the previous one has finished.
   * `priority` lines (the victim's death line after a player kill) wait in a short queue instead of being dropped.
   */
  voice(name: SfxName, pos: THREE.Vector3, vol = 0.9, priority = false, rate = 1): boolean {
    const now = clock.t;
    if (now >= this.voiceBusyUntil && this.voiceQ.length === 0) { this.playVoice(name, pos.x, pos.y, pos.z, vol, rate); return true; }
    if (!priority) return false;
    this.voiceQ.push({ name, x: pos.x, y: pos.y, z: pos.z, vol, rate, t: now });
    if (this.voiceQ.length > 2) this.voiceQ.shift();
    return true;
  }
  private playVoice(name: SfxName, x: number, y: number, z: number, vol: number, rate: number) {
    this.voiceBusyUntil = clock.t + (VO_DUR[name] ?? 1) / rate + 0.06;
    this.sfxAt(name, _v3.set(x, y, z), vol, rate);
  }
  private updateVoices() {
    const q = this.voiceQ;
    while (q.length && clock.t - q[0].t > 1.6) q.shift();
    if (q.length && clock.t >= this.voiceBusyUntil) { const e = q.shift()!; this.playVoice(e.name, e.x, e.y, e.z, e.vol, e.rate); }
  }
  /** Death line of a baby. Always when the player scored the splat; one time in three otherwise. */
  mamaFor(pos: THREE.Vector3, byPlayer: boolean) {
    const names = ["baby_mama1", "baby_mama2", "baby_mama3", "baby_mama4", "baby_scream_sfx"] as const;
    const roll = this.fxRng();
    if (!byPlayer && roll >= 1 / 3) return;
    let i = (this.fxRng() * names.length) | 0;
    if (i === this.lastMama) i = (i + 1) % names.length;
    this.lastMama = i;
    this.voice(names[i], pos, 1.5, byPlayer, 1);
  }

  sfxAt(name: SfxName, pos: THREE.Vector3, vol = 1, rate = 1) {
    const d = pos.distanceTo(this.camera.position);
    const v = vol / (1 + d * 0.16);
    _v.copy(pos).sub(this.camera.position).normalize();
    this.camera.getWorldDirection(_v2);
    const pan = _v.x * -_v2.z + _v.z * _v2.x; // dot(dir, right)
    this.audio.play(name, { vol: v, pan: clamp(pan * 0.9, -1, 1), rate });
  }

  // ------------------------------------------------------------ main loop
  private loop = (now: number) => {
    requestAnimationFrame(this.loop);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.05);
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5 && this.opts.fps) { this.hud.setFpsText(`${Math.round(this.fpsN / this.fpsAcc)} fps`); this.fpsAcc = 0; this.fpsN = 0; }
    if (this.opts.fixed) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= 1 / 60 && n++ < 6) { this.update(1 / 60); this.acc -= 1 / 60; }
      if (this.acc > 0.2) this.acc = 0;
    } else this.update(dt);
    this.render();
  };

  /** Advance the simulation without rendering (tests / fast demo checks). */
  fastForward(seconds: number, dt = 1 / 30) {
    for (let t = 0; t < seconds; t += dt) this.update(dt);
  }

  private render() {
    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();
    if (this.state !== "menu" && this.p.alive) r.render(this.vm.scene, this.vm.cam);
  }

  update(dt: number) {
    this.frameN++;
    if (this.paused) return;
    tickClock(dt);
    this.world.update(dt);
    this.updateVoices();
    if (this.state === "menu" && !this.opts.demo) this.pollPad();
    const polled = this.input.poll(dt);
    const cmd = this.state === "menu" ? emptyCmd() : this.autopilot && this.state === "playing" ? this.autopilot.cmd(dt) : polled;
    if (this.state === "playing") {
      this.time += dt;
      this.timeLeft -= dt;
      this.updatePlayer(dt, cmd);
      if (this.timeLeft <= 0) this.endRound(this.teamScore.blue > this.teamScore.pink || (this.teamScore.blue === this.teamScore.pink && this.p.kills > 0));
    } else if (this.state === "menu") {
      this.menuCamera(dt);
    } else {
      this.resultT += dt;
      if (cmd.start && this.resultT > 1.2 && !this.opts.demo) { this.requestLock(); this.start(); }
      this.updateCamera(dt);
    }
    this.updateBots(dt);
    this.updateProjectiles(dt);
    this.updateKillstreaks(dt);
    this.bits.update(dt);
    this.puffs.update(dt);
    this.updateHud(dt);
    for (const s of this.world.shaker) { s.rotation.y += dt * 0.6; s.position.y += Math.sin(this.time * 1.5 + s.position.x) * 0.002; }
  }

  private menuCamera(dt: number) {
    this.menuOrbit += dt * 0.12;
    const hx = this.world.hx, a = this.menuOrbit;
    this.camera.position.set(Math.sin(a) * hx * 0.55, 1.7, Math.cos(a) * this.world.hz * 0.6 + 2);
    this.camera.lookAt(Math.sin(a + 1.4) * 4, 1.0, Math.cos(a + 1.4) * 3);
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ player
  private updatePlayer(dt: number, cmd: Cmd) {
    const p = this.p;
    const wd = WEAPONS[p.weapon];
    p.shake = Math.max(0, p.shake - dt * 2.2);
    p.inv = Math.max(0, p.inv - dt);
    if (!p.alive) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) this.respawnPlayer();
      this.updateCamera(dt);
      return;
    }
    // look
    const zoomK = this.lookScale();
    p.yaw += cmd.dyaw * zoomK; p.pitch = clamp(p.pitch + cmd.dpitch * zoomK, -1.4, 1.4);
    p.lastDyaw = cmd.dyaw; p.lastDpitch = cmd.dpitch;
    // weapons
    if (cmd.slot > 0 && cmd.slot !== p.weapon + 1) this.switchWeapon(cmd.slot - 1);
    if (cmd.cycle) this.switchWeapon((p.weapon + cmd.cycle + WEAPONS.length) % WEAPONS.length);
    if (cmd.reload) this.startReload();
    if (cmd.streak === 4) this.useDrone();
    if (cmd.streak === 5) this.useStrike();
    // movement
    const sprint = cmd.sprint && cmd.mz > 0.2 && p.reloadT < 0 && !cmd.aim;
    p.sprint = sprint;
    const ads = cmd.aim && !sprint && p.reloadT < 0;
    p.ads = ads;
    const spd = (sprint ? 6.2 : 3.7) * (ads ? 0.55 : 1);
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    const wx = (-sy * cmd.mz + cy * cmd.mx) * spd, wz = (-cy * cmd.mz - sy * cmd.mx) * spd;
    const k = p.grounded ? 14 : 3;
    p.vx = damp(p.vx, wx, k, dt); p.vz = damp(p.vz, wz, k, dt);
    if (p.lungeT > 0) { p.lungeT -= dt; p.vx += -sy * 70 * dt; p.vz += -cy * 70 * dt; }
    if (cmd.jump && p.grounded) { p.vy = 3.7; p.grounded = false; this.audio.play("jump", { vol: 0.4 }); }
    p.pos.x += p.vx * dt; p.pos.z += p.vz * dt;
    this.world.resolve(p.pos, 0.3, 0.9);
    // vertical: follow ramps and the deck, drop off ledges
    const gy = this.world.groundY(p.pos.x, p.pos.z, p.pos.y);
    if (p.grounded) {
      if (p.pos.y - gy < 0.35) p.pos.y = gy; else { p.grounded = false; p.vy = 0; }
    }
    if (!p.grounded) {
      p.vy -= 11 * dt;
      p.pos.y += p.vy * dt;
      if (p.pos.y <= gy && p.vy <= 0) { if (p.vy < -2) { p.landDip = 0.06; this.audio.play("step", { vol: 0.5 }); } p.pos.y = gy; p.vy = 0; p.grounded = true; }
    }
    p.speed = Math.hypot(p.vx, p.vz);
    this.world.nudge(p.pos.x, p.pos.z, 0.32, p.vx, p.vz);
    if (p.grounded && p.speed > 0.8) {
      p.stepAcc += p.speed * dt;
      p.bobPh += dt * (5 + p.speed * 1.5);
      if (p.stepAcc > (sprint ? 1.35 : 1.05)) { p.stepAcc = 0; this.audio.play("step", { vol: 0.32 }); }
    }
    p.landDip = damp(p.landDip, 0, 10, dt);
    // regen
    if (!this.noRegen && this.time - p.lastHurt > 5 && p.hp < PLAYER_MAX) p.hp = Math.min(PLAYER_MAX, p.hp + 15 * dt);
    // reload
    if (p.reloadT >= 0) {
      p.reloadT += dt;
      if (p.reloadT >= wd.reload) { p.ammo[p.weapon] = wd.mag; p.reloadT = -1; }
    }
    // fire
    p.fireCd -= dt;
    const want = cmd.fire && !sprint;
    const trigger = wd.auto ? want : want && !p.prevFire;
    p.prevFire = want;
    p.meleeCd -= dt;
    if (cmd.melee && p.meleeCd <= 0 && !this.vm.meleeing && !this.vm.switching) this.startMelee();
    if (p.meleePending && (this.vm.meleeT >= MELEE_HIT || !this.vm.meleeing)) { p.meleePending = false; this.meleeStrike(); }
    if (trigger && p.fireCd <= 0 && p.reloadT < 0 && !this.vm.switching && !this.vm.meleeing) {
      if (p.ammo[p.weapon] <= 0) { this.audio.play("empty", { vol: 0.5 }); p.fireCd = 0.3; this.startReload(); }
      else this.firePlayer();
    }
    this.scoped = wd.scope && ads && this.vm.ads > 0.85;
    this.updateCamera(dt);
    // view model
    this.vm.update(dt, {
      speed: p.speed, sprint, dyaw: cmd.dyaw, dpitch: cmd.dpitch, wantAds: ads, reloadP: p.reloadT >= 0 ? p.reloadT / wd.reload : -1,
      ammoFrac: p.ammo[p.weapon] / wd.mag, grounded: p.grounded, scoped: wd.scope,
    });
    p.kickPitch = damp(p.kickPitch, 0, 9, dt);
  }

  lookScale() { return this.scoped ? 0.28 : this.vm.ads > 0.5 ? 0.62 : 1; }

  private switchWeapon(i: number) {
    const p = this.p;
    if (i === p.weapon || this.vm.switching) return;
    p.weapon = i; p.reloadT = -1;
    this.ev("weapon", { i });
    this.vm.switchTo(i);
    this.audio.play("switch", { vol: 0.5 });
    this.hud.setWeapon(i, WEAPONS[i].name);
  }

  private startReload() {
    const p = this.p, wd = WEAPONS[p.weapon];
    if (p.reloadT >= 0 || p.ammo[p.weapon] >= wd.mag || this.vm.switching) return;
    p.reloadT = 0;
    this.audio.play("reload", { vol: 0.6, rate: wd.reload > 1.5 ? 0.85 : 1.05 });
  }

  /** Rattle bonk: quick swing with a short lunge; the hit lands at MELEE_HIT of the swing. */
  private startMelee() {
    const p = this.p;
    p.meleeCd = 0.75; p.meleePending = true; p.lungeT = 0.16;
    this.vm.melee();
    this.audio.play("rattle", { vol: 0.8 });
    this.ev("melee");
  }

  private meleeStrike() {
    const p = this.p;
    if (!p.alive) return;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    let best: Bot | null = null, bd = 1e9;
    for (const b of this.bots) {
      if (b.team !== "pink" || b.state !== "alive" || b.inv > 0.5) continue;
      const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, d = Math.hypot(dx, dz);
      if (d > MELEE_RANGE || Math.abs(b.pos.y - p.pos.y) > 1.2) continue;
      if (d > 0.2 && (dx * fx + dz * fz) / d < 0.62) continue;
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return;
    _v.set(best.pos.x, best.pos.y + 0.55, best.pos.z);
    _v2.set(-fx, 0.5, -fz).normalize();
    const col = WEAPONS[p.weapon].food[0];
    this.bits.splat(_v, _v2, col, 16, 4.2, 0.05);
    best.toddler.flash();
    best.vx += fx * 3; best.vz += fz * 3;
    this.audio.play("splat", { vol: 0.8 });
    this.audio.play("tick", { vol: 0.4 });
    p.shake += 0.12;
    this.downBot(best, this.playerParty, false, true);
  }

  private firePlayer() {
    const p = this.p, wd = WEAPONS[p.weapon];
    p.ammo[p.weapon]--;
    p.fireCd = wd.interval;
    p.shots++;
    const cam = this.camera;
    cam.getWorldDirection(_v2); // forward
    this.vm.muzzleWorld(cam, _v);
    const ads = this.vm.ads;
    const spreadBase = (ads > 0.5 ? wd.adsSpread : wd.spread) * (p.speed > 2 ? 1.5 : 1) * (p.grounded ? 1 : 2);
    const conv = 18;
    const tf = conv / wd.speed;
    _v3.copy(cam.position).addScaledVector(_v2, conv);
    _v3.y += 0.5 * wd.grav * tf * tf;
    // spread (uniform disc around forward)
    const a = this.rng() * 6.283, rad = Math.sqrt(this.rng()) * spreadBase * conv;
    cam.updateMatrixWorld();
    const right = _v2.clone().cross(cam.up).normalize(), up = right.clone().cross(_v2).normalize();
    _v3.addScaledVector(right, Math.cos(a) * rad).addScaledVector(up, Math.sin(a) * rad);
    const dir = _v3.sub(_v).normalize();
    const color = wd.food[p.shots % 2];
    this.spawnProj(_v, dir, wd.speed, wd.grav, wd.dmg, this.playerParty, color, true, wd.size);
    this.vm.fire(wd.kick);
    p.kickPitch += 0.012 * wd.kick;
    p.pitch = clamp(p.pitch + 0.0035 * wd.kick * (wd.scope ? 8 : 1), -1.4, 1.4);
    p.shake += 0.03 * wd.kick;
    p.yaw += (this.rng() - 0.5) * 0.0025 * wd.kick;
    this.audio.play(wd.sfx === "fire" && p.weapon === 1 ? "fire2" : wd.sfx, { vol: wd.scope ? 0.9 : 0.55 });
    // muzzle splat particles
    this.bits.emit(_v.x, _v.y, _v.z, dir.x * 5, dir.y * 5, dir.z * 5, color, 0.06, 0.25, 6, 2);
  }

  private respawnPlayer() {
    const p = this.p;
    const enemies = this.bots.filter((b) => b.team === "pink" && b.alive);
    const pool = this.spawnPool();
    let best = pool[0], bd = -1;
    for (let i = 0; i < 6; i++) {
      const s = pick(this.rng, pool);
      const d = enemies.reduce((m, e) => Math.min(m, e.pos.distanceTo(s)), 99);
      if (d > bd) { bd = d; best = s; }
    }
    p.pos.set(best.x, best.y, best.z); p.grounded = true; p.vy = 0;
    p.hp = PLAYER_MAX; p.alive = true; p.inv = 1.8; p.vx = p.vz = 0; p.meleePending = false;
    p.ammo = WEAPONS.map((w) => w.mag); p.reloadT = -1;
    p.yaw = yawTo(-best.x, -best.z); p.pitch = 0;
    this.hud.toast("BACK IN!", "Naps are over");
  }

  hurtPlayer(dmg: number, from: THREE.Vector3, owner: Party) {
    const p = this.p;
    if (!p.alive || p.inv > 0 || this.state !== "playing") return;
    if (this.opts.demo) dmg *= 0.75 * this.hurtScale;
    p.hp -= dmg;
    if (this.opts.demo && p.hp < 9) p.hp = 9;
    p.lastHurt = this.time;
    p.shake += 0.25;
    this.ev("hurt", { dmg: +dmg.toFixed(1), hp: +p.hp.toFixed(1), by: owner.name });
    // direction on screen
    const yawToShooter = yawTo(from.x - p.pos.x, from.z - p.pos.z);
    const rel = wrapAngle(p.yaw - yawToShooter); // + = shooter to the right
    this.hud.damage(-rel, ((owner as Bot).id ?? 0) + 3);
    this.audio.play("hurt", { vol: 0.6 });
    if (p.hp <= 0) {
      p.hp = 0; p.alive = false; p.respawnT = 3; p.deaths++; p.streak = 0;
      this.teamScore.pink++;
      owner.kills++;
      this.hud.feed(owner.name, "You", owner.team, "blue", false, false);
      this.hud.toast("NAP TIME!", `${owner.name} splatted you`);
      this.voice("cry", p.pos, 0.5, true, 1.1);
      if (this.fxRng() < 1 / 3) after(900, () => this.voice(this.fxRng() < 0.5 ? "baby_giggle2" : "baby_nightnight", owner.pos, 0.9));
      this.checkWin();
    }
  }

  private updateCamera(dt: number) {
    const p = this.p, cam = this.camera;
    let eye = EYE + Math.abs(Math.sin(p.bobPh)) * 0.025 * clamp(p.speed / 4, 0, 1.4) - p.landDip;
    let roll = Math.sin(p.bobPh) * 0.006 * clamp(p.speed / 4, 0, 1.4);
    if (!p.alive) { eye = damp(cam.position.y - p.pos.y, 0.28, 4, dt); roll = damp(cam.rotation.z, 0.5, 3, dt); }
    cam.position.set(p.pos.x, p.pos.y + eye, p.pos.z);
    const sh = p.shake * p.shake * 0.12;
    cam.rotation.set(p.pitch + p.kickPitch + (this.fxRng() - 0.5) * sh, p.yaw + (this.fxRng() - 0.5) * sh, roll + (this.fxRng() - 0.5) * sh * 2, "YXZ");
    const wd = WEAPONS[p.weapon];
    const zoom = this.vm.ads * (wd.zoom - 1) + 1;
    let fov = this.baseFov * (p.sprint ? 1.06 : 1);
    fov = (2 * Math.atan(Math.tan((fov * Math.PI) / 360) / zoom) * 180) / Math.PI;
    this.fovCur = damp(this.fovCur, fov, 20, dt);
    cam.fov = this.fovCur;
    cam.updateProjectionMatrix();
    this.vm.cam.position.set(0, 0, 0);
  }

  // ------------------------------------------------------------ bots
  /** direction avoiding obstacles */
  steer(x: number, z: number, dx: number, dz: number, sign = 1, look = 2.0, y = 0): [number, number] {
    const base = Math.atan2(dz, dx);
    const offs = [0, 0.55 * sign, -0.55 * sign, 1.1 * sign, -1.1 * sign, 1.7 * sign, -1.7 * sign];
    for (const o of offs) {
      const a = base + o, cx = Math.cos(a), cz = Math.sin(a);
      if (!this.world.raycast(x, y + 0.5, z, cx, 0, cz, look, false, true)) return [cx, cz];
    }
    return [-dx, -dz];
  }

  opponents(team: Team): Party[] {
    const out: Party[] = [];
    if (team === "pink" && this.p.alive) out.push(this.playerParty);
    for (const b of this.bots) if (b.team !== team && b.state === "alive") out.push(b);
    return out;
  }

  private updateBots(dt: number) {
    const world = this.world;
    for (const b of this.bots) {
      const t = b.toddler;
      b.inv = Math.max(0, b.inv - dt);
      if (b.state === "gone") {
        b.stateT -= dt;
        t.root.visible = false;
        if (b.stateT <= 0 && this.state !== "won" && this.state !== "lost") {
          const enemies = this.opponents(b.team);
          const pool = this.spawnPool();
          let best = pool[0], bd = -1;
          for (let i = 0; i < 5; i++) {
            const s = pick(this.rng, pool);
            const d = enemies.reduce((m, e) => Math.min(m, e.pos.distanceTo(s)), 99);
            if (d > bd) { bd = d; best = s; }
          }
          this.spawnBot(b, best);
        }
        continue;
      }
      if (b.state === "down") {
        b.stateT -= dt;
        t.root.position.copy(b.pos);
        t.update(dt, 0, "down");
        b.cry.visible = true;
        const cd = b.pos.distanceTo(this.camera.position);
        const cw = clamp(0.3 + cd * 0.09, 0.3, 0.9);
        b.cry.scale.set(cw, cw * 0.375, 1);
        b.cry.position.y = 1.2 + Math.abs(Math.sin(this.time * 7)) * 0.1;
        b.tearT -= dt;
        if (b.tearT <= 0) {
          b.tearT = 0.05;
          for (const s of [-1, 1]) { t.eye(s, _v); this.bits.emit(_v.x, _v.y, _v.z, s * 0.7 + (this.fxRng() - 0.5) * 0.5, 0.8, 0.5, 0x8fe0ff, 0.045, 0.5, 9, 0.5); }
        }
        if (b.stateT <= 0) {
          b.state = "gone"; b.stateT = 1.6; b.cry.visible = false;
          this.puffs.puff(b.pos.x, 0.6, b.pos.z, 14, 2.2, [0xffffff, 0xfff0f6, 0xe6f4ff, b.team === "pink" ? 0xffc2dc : 0xbfe0ff], 0.55, 0.8);
          for (let i = 0; i < 12; i++) this.bits.emit(b.pos.x, 0.8, b.pos.z, (this.fxRng() - 0.5) * 5, 2 + this.fxRng() * 3, (this.fxRng() - 0.5) * 5, FOOD[i % 6], 0.08, 0.7, 8, 0.5);
          this.sfxAt("poof", b.pos, 0.9);
        }
        continue;
      }
      // ---- alive
      b.tgtT -= dt; b.modeT -= dt; b.fireCd -= dt; b.reactT -= dt;
      const ex = b.pos.x, ez = b.pos.z;
      if (this.state === "playing" || this.state === "menu") {
        if (b.tgtT <= 0) this.pickTarget(b);
        if (b.modeT <= 0) this.pickMode(b);
      }
      const tg = b.target;
      let dist = 99, tdx = 0, tdz = 0;
      if (tg) { tdx = tg.pos.x - ex; tdz = tg.pos.z - ez; dist = Math.hypot(tdx, tdz); }
      // desired move
      let mx = 0, mz = 0, spd = 0;
      const myTop = b.pos.y > DECK_Y;
      let hasGoal = false, gx = 0, gz = 0, gTop = myTop;
      const walk = 2.5, run = 3.5;
      if (this.state === "won" || this.state === "lost") { /* idle */ }
      else if (b.force && clock.t < b.force.until) {
        const fx = b.force.x - ex, fz = b.force.z - ez, fd = Math.hypot(fx, fz);
        if (fd > 0.5) { mx = fx / fd; mz = fz / fd; spd = run; }
      } else if (b.mode === "chase" && tg) {
        const tgTop = tg.pos.y > DECK_Y;
        if (!(b.targetVisible && dist < (tgTop === myTop ? 8 : 12))) { hasGoal = true; gx = tg.pos.x; gz = tg.pos.z; gTop = tgTop; spd = run; }
      } else if (b.mode === "strafe" && tg) {
        const nx = tdx / (dist || 1), nz = tdz / (dist || 1);
        const radial = dist > 11 ? 1 : dist < 5.5 ? -1 : 0;
        mx = -nz * b.strafe + nx * radial * 0.8; mz = nx * b.strafe + nz * radial * 0.8;
        spd = walk * 1.05;
      } else if (b.mode === "cover" || b.mode === "wander") {
        const ggx = b.goal.x - ex, ggz = b.goal.z - ez, gd = Math.hypot(ggx, ggz);
        gTop = b.goal.y > DECK_Y;
        if (gd > 0.6 || gTop !== myTop) { hasGoal = true; gx = b.goal.x; gz = b.goal.z; spd = b.mode === "cover" ? run : walk; }
        else if (b.mode === "wander") b.modeT = 0;
      }
      if (hasGoal) {
        if (gTop !== myTop && world.routes.length) {
          // other level: walk the ramp waypoints
          if (!b.route || b.routeTop !== gTop) {
            b.route = world.route(ex, ez, myTop, gx, gz); b.routeTop = gTop;
            b.routeI = b.route && world.onRamp(ex, ez, b.pos.y) ? 1 : 0;
          }
          if (b.route) {
            const w = b.route[Math.min(b.routeI, b.route.length - 1)];
            gx = w.x; gz = w.z;
            if (Math.hypot(gx - ex, gz - ez) < 0.9 && ++b.routeI >= b.route.length) b.route = null;
          }
        } else b.route = null;
        const rx = gx - ex, rz = gz - ez, rl = Math.hypot(rx, rz);
        if (rl > 1e-3) { mx = rx / rl; mz = rz / rl; }
      }
      if (clock.t < b.stopUntil) spd = 0; // planted while shooting
      const ml = Math.hypot(mx, mz);
      if (ml > 0.01 && spd > 0) {
        const [sx, sz] = this.steer(ex, ez, mx / ml, mz / ml, b.steerSign, 1.9, b.pos.y);
        mx = sx; mz = sz;
      } else { mx = mz = 0; spd = 0; }
      b.vx = damp(b.vx, mx * spd, 8, dt); b.vz = damp(b.vz, mz * spd, 8, dt);
      b.pos.x += b.vx * dt; b.pos.z += b.vz * dt;
      world.resolve(b.pos, 0.32, 1.0);
      // vertical: ramps, deck, drop-offs
      {
        const gy = world.groundY(b.pos.x, b.pos.z, b.pos.y);
        if (b.pos.y <= gy + 0.001) { b.pos.y = gy; b.vy = 0; }
        else if (b.pos.y - gy < 0.35 && b.vy === 0) b.pos.y = gy;
        else { b.vy -= 11 * dt; b.pos.y += b.vy * dt; if (b.pos.y <= gy) { b.pos.y = gy; b.vy = 0; } }
      }
      // separation
      for (const o of this.bots) {
        if (o === b || o.state !== "alive" || Math.abs(o.pos.y - b.pos.y) > 1.2) continue;
        const dx = b.pos.x - o.pos.x, dz = b.pos.z - o.pos.z, d = Math.hypot(dx, dz);
        if (d < 0.75 && d > 1e-4) { const pu = (0.75 - d) * 0.5; b.pos.x += (dx / d) * pu; b.pos.z += (dz / d) * pu; }
      }
      if (this.p.alive && Math.abs(this.p.pos.y - b.pos.y) < 1.2) {
        const dx = b.pos.x - this.p.pos.x, dz = b.pos.z - this.p.pos.z, d = Math.hypot(dx, dz);
        if (d < 0.7 && d > 1e-4) { b.pos.x += (dx / d) * (0.7 - d); b.pos.z += (dz / d) * (0.7 - d); }
      }
      b.speed = Math.hypot(b.vx, b.vz);
      world.nudge(b.pos.x, b.pos.z, 0.3, b.vx, b.vz);
      // stuck
      if (spd > 0) {
        b.stuckT += dt;
        if (b.stuckT > 0.8) {
          const moved = Math.hypot(b.pos.x - b.lastX, b.pos.z - b.lastZ);
          if (moved < 0.5) { b.modeT = 0; b.steerSign *= -1; b.strafe *= -1; if (b.mode !== "chase") b.mode = "wander"; }
          b.lastX = b.pos.x; b.lastZ = b.pos.z; b.stuckT = 0;
        }
      }
      // facing
      let wantYaw = b.yaw;
      const live = this.state === "playing" || this.state === "menu";
      const engaged = !!tg && b.targetVisible && dist < 28 && live;
      if (tg && b.targetVisible && this.state !== "won" && this.state !== "lost") wantYaw = yawTo(tdx, tdz);
      else if (b.speed > 0.5) wantYaw = yawTo(b.vx, b.vz);
      b.yaw += wrapAngle(wantYaw - b.yaw) * (1 - Math.exp(-(engaged ? 13 : 9) * dt));
      // raise the blaster and point it at the target shortly before and while firing
      if (engaged && tg && b.reactT < 0.25 && (b.burst > 0 || b.fireCd < 0.45)) {
        this.aimPointFor(tg, dist, this.aimPt);
        t.aimAt(this.aimPt, 0.3);
      }
      // model faces +Z: yaw convention forward=(-sin,-cos) => model rotation = yaw + PI
      t.root.position.copy(b.pos);
      t.root.rotation.y = b.yaw + Math.PI;
      t.update(dt, b.speed, "alive");
      b.cry.visible = false;
      // footsteps
      if (b.speed > 1) {
        b.stepAcc += b.speed * dt;
        if (b.stepAcc > 1.1) { b.stepAcc = 0; if (b.pos.distanceTo(this.camera.position) < 14) this.sfxAt("step", b.pos, 0.22); }
      }
      // shoot
      if (engaged && tg && b.reactT <= 0) {
        const facing = Math.abs(wrapAngle(yawTo(tdx, tdz) - b.yaw));
        if (facing < 0.3 && t.aimK > 0.55) {
          if (b.burst > 0) {
            b.burstT -= dt;
            if (b.burstT <= 0) { this.botFire(b, tg, dist); b.burst--; b.burstT = 0.16; if (b.burst === 0) b.fireCd = rr(this.rng, 0.45, 1.0) / b.skill; }
          } else if (b.fireCd <= 0) { b.burst = 2 + ((this.rng() * 3) | 0); b.burstT = 0; b.stopUntil = clock.t + 0.18 + b.burst * 0.16; }
        }
      }
    }
    this.updateTags();
    this.updateBars(dt);
  }

  /** Opponent health bars: fade in when damaged or within 25 m, billboarded (sprites), occluded by cover, hidden in a scope. */
  private updateBars(dt: number) {
    const cam = this.camera, show = this.state === "playing" && !this.scoped && this.p.alive;
    for (const b of this.bots) {
      const bar = b.toddler.hpBar, m = bar.material as THREE.SpriteMaterial;
      let want = 0, d = 0;
      if (show && b.team === "pink" && b.state === "alive") {
        d = Math.hypot(b.pos.x - cam.position.x, b.pos.z - cam.position.z);
        if ((d < 25 || b.hp < 100) && d < 50) want = 1;
      }
      m.opacity = damp(m.opacity, want, want ? 10 : 6, dt);
      bar.visible = m.opacity > 0.02;
      if (bar.visible) {
        b.toddler.setHp(b.hp / 100);
        const k = clamp(d / 7, 1, 3); // keep readable at range
        bar.scale.set(0.62 * k, 0.116 * k, 1);
        bar.position.y = 1.27 + 0.05 * (k - 1);
      }
    }
  }

  /** Nametags: only the nearest one or two enemies within 15 m, never overlapping, hidden while a banner shows. */
  private updateTags() {
    for (const b of this.bots) b.toddler.tag.visible = false;
    if (this.state !== "playing" || this.hud.bannerOn() || this.scoped) return;
    const cam = this.camera;
    cam.getWorldDirection(_v2);
    const c: { b: Bot; d: number }[] = [];
    for (const b of this.bots) {
      if (b.team !== "pink" || b.state !== "alive") continue;
      const dx = b.pos.x - cam.position.x, dz = b.pos.z - cam.position.z, d = Math.hypot(dx, dz);
      if (d > 15 || d < 2 || (dx * _v2.x + dz * _v2.z) / (d || 1) < 0.5) continue;
      if (!this.world.clearLine(cam.position.x, cam.position.y, cam.position.z, b.pos.x, b.pos.y + 1.0, b.pos.z)) continue;
      c.push({ b, d });
    }
    c.sort((a, b) => a.d - b.d);
    const shown: THREE.Vector3[] = [];
    for (const { b } of c) {
      if (shown.length >= 2) break;
      _v.copy(b.pos); _v.y = 1.4; _v.project(cam);
      if (shown.some((s) => Math.abs(s.x - _v.x) < 0.2 && Math.abs(s.y - _v.y) < 0.12)) continue;
      shown.push(_v.clone());
      b.toddler.tag.visible = true;
    }
  }

  private pickTarget(b: Bot) {
    b.tgtT = rr(this.rng, 0.35, 0.7);
    const opp = this.opponents(b.team);
    let best: Party | null = null, bs = 1e9, vis = false;
    for (const o of opp) {
      if (o instanceof Bot && o.inv > 0.5) continue;
      const d = Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z);
      const see = d < 32 && this.world.clearLine(b.pos.x, b.pos.y + 0.7, b.pos.z, o.pos.x, o.pos.y + 0.7, o.pos.z);
      let score = d * (o.isPlayer ? 0.75 : 1) + (see ? 0 : 14);
      if (b.target === o) score -= 3;
      if (score < bs) { bs = score; best = o; vis = see; }
    }
    if (best !== b.target) b.reactT = rr(this.rng, 0.2, 0.5) / (b.team === "blue" ? 1.2 : 1.4);
    b.target = best;
    b.targetVisible = vis;
    if (!vis && b.mode === "strafe") b.modeT = Math.min(b.modeT, 0.2);
  }

  private pickMode(b: Bot) {
    const r = this.rng();
    const tg = b.target;
    const dist = tg ? Math.hypot(tg.pos.x - b.pos.x, tg.pos.z - b.pos.z) : 99;
    b.modeT = rr(this.rng, 1.3, 3.2);
    b.strafe = this.rng() < 0.5 ? 1 : -1;
    if (!tg) { b.mode = "wander"; this.pickGoal(b); return; }
    const hurt = b.hp < 50;
    if (hurt && r < 0.55) { this.goCover(b, tg); return; }
    if (!b.targetVisible) { b.mode = r < 0.7 ? "chase" : "wander"; if (b.mode === "wander") this.pickGoal(b); return; }
    if (dist > 14) b.mode = r < 0.5 ? "chase" : r < 0.75 ? "strafe" : "cover";
    else if (dist > 6) b.mode = r < 0.5 ? "strafe" : r < 0.7 ? "cover" : r < 0.85 ? "chase" : "wander";
    else b.mode = r < 0.6 ? "strafe" : r < 0.8 ? "cover" : "wander";
    if (b.mode === "cover") this.goCover(b, tg);
    else if (b.mode === "wander") this.pickGoal(b);
  }

  private goCover(b: Bot, from: Party) {
    const top = b.pos.y > DECK_Y;
    const c = this.world.findCover(b.pos.x, b.pos.z, from.pos.x, from.pos.z, 13, b.pos.y);
    if (c) { b.mode = "cover"; b.goal.set(c.x, top ? (this.world.deck?.y ?? 0) : 0, c.z); b.modeT = rr(this.rng, 1.6, 3.0); }
    else { b.mode = "strafe"; }
  }

  private pickGoal(b: Bot) {
    const w = this.world;
    const dk = w.deck;
    if (dk && !this.opts.demo && this.rng() < 0.4) {
      for (let i = 0; i < 6; i++) {
        const x = rr(this.rng, dk.x0 + 1, dk.x1 - 1), z = rr(this.rng, dk.z0 + 1, dk.z1 - 1);
        if (!w.blocked(x, z, 0.6, dk.y)) { b.goal.set(x, dk.y, z); return; }
      }
    }
    for (let i = 0; i < 8; i++) {
      const x = rr(this.rng, -w.hx + 2, w.hx - 2), z = rr(this.rng, -w.hz + 2, w.hz - 2);
      if (!w.blocked(x, z, 0.6)) { b.goal.set(x, 0, z); return; }
    }
    b.goal.set(0, 0, 0);
  }

  /** Where a bot's blaster should point (chest of the target, with gravity lead). */
  private aimPointFor(tg: Party, dist: number, out: THREE.Vector3) {
    const tv = dist / 24;
    return out.set(tg.pos.x, tg.pos.y + 0.55 + 0.5 * 3 * tv * tv, tg.pos.z);
  }

  private botFire(b: Bot, tg: Party, dist: number) {
    const t = b.toddler;
    t.muzzleWorld(_v);
    this.aimPointFor(tg, dist, this.aimPt);
    const spread = (0.016 + dist * 0.0018) / b.skill;
    _v2.copy(this.aimPt).sub(_v).normalize();
    const a = this.rng() * 6.283, rad = Math.sqrt(this.rng()) * spread;
    _v3.set(Math.cos(a) * rad, Math.sin(a) * rad, 0);
    _v2.x += _v3.x * (1 - Math.abs(_v2.x)); _v2.y += _v3.y; _v2.z += _v3.x * 0.6; _v2.normalize();
    const col = pick(this.rng, b.food);
    this.spawnProj(_v, _v2, 24, 3, tg.isPlayer ? BOT_DMG_PLAYER : BOT_DMG_BOT * (b.team === "pink" ? this.pinkBoost : this.allyDmg), b, col, false, 0.1);
    t.recoil();
    this.bits.emit(_v.x, _v.y, _v.z, _v2.x * 4, _v2.y * 4, _v2.z * 4, col, 0.05, 0.2, 4, 2);
    this.sfxAt("fire", b.pos, 0.38, 0.9 + b.id * 0.03);
  }

  // ------------------------------------------------------------ projectiles
  spawnProj(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, grav: number, dmg: number, owner: Party, color: number, fromPlayer: boolean, size: number) {
    let pr = this.projs.find((x) => !x.active);
    if (!pr) {
      const mesh = new THREE.Mesh(this.projGeo, this.projMat(color));
      mesh.castShadow = true;
      this.scene.add(mesh);
      pr = { mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), owner, dmg, grav, life: 0, color, trail: 0, active: true, fromPlayer, size };
      this.projs.push(pr);
    }
    pr.mesh.material = this.projMat(color);
    pr.pos.copy(pos); pr.vel.copy(dir).multiplyScalar(speed);
    pr.owner = owner; pr.dmg = dmg; pr.grav = grav; pr.life = 2.2; pr.color = color; pr.active = true; pr.fromPlayer = fromPlayer; pr.size = size; pr.trail = 0;
    pr.mesh.visible = true;
    pr.mesh.scale.set(size, size, size * (fromPlayer ? 1.5 : 1.2));
    pr.mesh.position.copy(pos);
  }

  private projMat(color: number) {
    let m = this.projMats.get(color);
    if (!m) { m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.35 }); this.projMats.set(color, m); }
    return m;
  }

  private updateProjectiles(dt: number) {
    const world = this.world;
    for (const pr of this.projs) {
      if (!pr.active) continue;
      pr.life -= dt;
      const ox = pr.pos.x, oy = pr.pos.y, oz = pr.pos.z;
      pr.vel.y -= pr.grav * dt;
      const sx = pr.vel.x * dt, sy = pr.vel.y * dt, sz = pr.vel.z * dt;
      const len = Math.hypot(sx, sy, sz);
      const dx = sx / len, dy = sy / len, dz = sz / len;
      let tw = len + 1, hitWorld = false;
      const wh = world.raycast(ox, oy, oz, dx, dy, dz, len, true);
      if (wh) { tw = wh.t; hitWorld = true; }
      // units
      let tu = len + 1, unit: Party | null = null, head = false;
      const team = pr.owner.team;
      const check = (o: Party) => {
        if (o.team === team || !o.alive) return;
        let cy0 = 0.42, cy1 = 0.94, cy2 = 0.15;
        const base = o.pos.y;
        if (o.isPlayer) { cy0 = 0.5; cy1 = 0.92; cy2 = 0.2; }
        const tb = raySphere(ox, oy, oz, dx, dy, dz, Math.min(len, tw), o.pos.x, base + cy0, o.pos.z, 0.36);
        const th = raySphere(ox, oy, oz, dx, dy, dz, Math.min(len, tw), o.pos.x, base + cy1, o.pos.z, 0.29);
        const tf = raySphere(ox, oy, oz, dx, dy, dz, Math.min(len, tw), o.pos.x, base + cy2, o.pos.z, 0.26);
        for (const [t, isHead] of [[tb, false], [th, true], [tf, false]] as const) {
          if (t >= 0 && t < tu) { tu = t; unit = o; head = isHead; }
        }
      };
      if (this.p.alive && this.p.inv <= 0) check(this.playerParty);
      for (const b of this.bots) if (b.state === "alive" && b.inv <= 0) check(b);
      if (unit && tu <= tw) {
        const hx = ox + dx * tu, hy = oy + dy * tu, hz = oz + dz * tu;
        this.hitUnit(pr, unit, head, hx, hy, hz);
        this.killProj(pr);
        continue;
      }
      if (hitWorld) {
        const h = world.hit;
        const hp = _v.set(ox + dx * h.t, oy + dy * h.t, oz + dz * h.t);
        const nrm = _v2.set(h.nx, h.ny, h.nz);
        if (h.type === "ball" && h.ball) {
          h.ball.vx += dx * 6; h.ball.vz += dz * 6;
        } else if (h.type !== "wall" || Math.abs(hp.y) < 12) {
          this.decals.spawn(hp, nrm, pr.color, (pr.fromPlayer ? 0.75 : 0.6) * (0.8 + this.fxRng() * 0.5) * (pr.size > 0.12 ? 1.5 : 1));
        }
        this.bits.splat(hp, nrm, pr.color, pr.fromPlayer ? 7 : 5, 3.0, 0.05);
        if (pr.fromPlayer || hp.distanceTo(this.camera.position) < 14) this.sfxAt("splat", hp, pr.fromPlayer ? 0.5 : 0.3);
        this.killProj(pr);
        continue;
      }
      pr.pos.set(ox + sx, oy + sy, oz + sz);
      pr.mesh.position.copy(pr.pos);
      pr.mesh.lookAt(pr.pos.x + pr.vel.x, pr.pos.y + pr.vel.y, pr.pos.z + pr.vel.z);
      pr.trail -= dt;
      if (pr.trail <= 0) { pr.trail = 0.03; this.bits.emit(pr.pos.x, pr.pos.y, pr.pos.z, 0, 0, 0, pr.color, pr.size * 0.45, 0.22, 0, 1); }
      if (pr.life <= 0 || pr.pos.y > 14) this.killProj(pr);
    }
  }

  private killProj(pr: Proj) { pr.active = false; pr.mesh.visible = false; }

  private hitUnit(pr: Proj, unit: Party, head: boolean, x: number, y: number, z: number) {
    _v.set(x, y, z);
    _v2.set(-pr.vel.x, 0.4, -pr.vel.z).normalize();
    this.bits.splat(_v, _v2, pr.color, 9, 3.2, 0.045);
    if (unit.isPlayer) {
      this.hurtPlayer(pr.dmg * (head ? 1.4 : 1), pr.owner.pos, pr.owner);
      return;
    }
    const b = unit as Bot;
    const dmg = pr.dmg * (head ? 2 : 1);
    b.hp -= dmg;
    b.toddler.flash();
    b.vx += pr.vel.x * 0.02; b.vz += pr.vel.z * 0.02;
    this.sfxAt("hit", b.pos, pr.fromPlayer ? 0.8 : 0.5);
    if (pr.fromPlayer) {
      this.p.hits++;
      if (head) { this.p.headshots++; this.audio.play("headshot", { vol: 0.4 }); }
      this.hud.hitMarker(b.hp <= 0);
      this.audio.play("tick", { vol: 0.35 });
    }
    // hit reactions: only for hits the player lands, one voice at a time, ~1.5 s apart
    if (b.hp > 0 && pr.fromPlayer && clock.t - this.lastHitVoice > 1.5) {
      const r = this.fxRng() < 0.5;
      const ok = b.hp < 38 ? this.voice(r ? "baby_nofair" : "baby_bottle", b.pos, 0.9) : this.voice(r ? "baby_uhoh" : "baby_booboo", b.pos, 0.85);
      if (ok) this.lastHitVoice = clock.t;
    }
    // react: retaliate toward owner
    if (b.hp > 0 && b.team !== pr.owner.team) { b.target = pr.owner; b.targetVisible = true; b.reactT = Math.min(b.reactT, 0.3); b.tgtT = 1; }
    if (b.hp <= 0) this.downBot(b, pr.owner, head);
  }

  downBot(b: Bot, killer: Party, head: boolean, melee = false) {
    b.hp = 0; b.state = "down"; b.alive = false; b.stateT = 2.2; b.deaths++; b.vx = b.vz = 0; b.tearT = 0;
    killer.kills++;
    this.teamScore[killer.team]++;
    this.ev("kill", { by: killer.name, victim: b.name, head, w: melee ? 9 : killer.isPlayer ? this.p.weapon : -1, d: +Math.hypot(b.pos.x - this.p.pos.x, b.pos.z - this.p.pos.z).toFixed(1), blue: this.teamScore.blue, pink: this.teamScore.pink });
    this.hud.feed(killer.isPlayer ? "You" : killer.name, b.name, killer.team, b.team, killer.isPlayer, head, melee);
    this.mamaFor(b.pos, killer.isPlayer);
    if (killer.isPlayer) {
      this.score = this.p.kills;
      if (clock.t >= this.streakGate) this.p.streak++;
      this.hud.hitMarker(true);
      this.hud.popup(melee ? "RATTLED +100" : head ? "HEADSHOT +150" : "SPLATTED +100", head ? "head" : "kill");
      if (this.p.streak === 3) { this.p.ready4 = true; this.hud.toast("DIAPER DRONE READY", "Press 4"); this.audio.play("streak", { vol: 0.5 }); after(300, () => this.audio.play("vo_drone_ready")); }
      if (this.p.streak === 5) { this.p.ready5 = true; this.hud.toast("BOTTLE STRIKE READY", "Press 5"); this.audio.play("streak", { vol: 0.5 }); after(300, () => this.audio.play("vo_strike_ready")); }
    }
    this.checkWin();
  }

  private checkWin() {
    if (this.state !== "playing") return;
    if (this.teamScore.blue >= SCORE_LIMIT) this.endRound(true);
    else if (this.teamScore.pink >= SCORE_LIMIT) this.endRound(false);
  }

  // ------------------------------------------------------------ killstreaks
  useDrone() {
    const p = this.p;
    if (!p.ready4 || this.drone || !p.alive) return;
    p.ready4 = false;
    this.ev("drone");
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x8ad0ff, roughness: 0.5 });
    const tapeM = new THREE.MeshStandardMaterial({ color: 0xffe066, roughness: 0.5 });
    // the diaper: padded body, two leg-hole bulges, wetness stripe, tape tabs
    const pad = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.16, 0.5, 3, 0.07), white);
    const rear = new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.15, 0.22, 3, 0.07), white); rear.position.set(0, 0.01, -0.22);
    const front = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.15, 0.18, 3, 0.07), white); front.position.set(0, 0.01, 0.27);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.01, 0.62), blue); stripe.position.set(0, 0.085, 0.02);
    g.add(pad, rear, front, stripe);
    for (const sx of [-1, 1]) {
      const tab = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.05, 0.1, 2, 0.02), tapeM); tab.position.set(sx * 0.39, 0.03, -0.22); g.add(tab);
      const heart = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), tapeM); heart.position.set(sx * 0.12, 0.09, 0.2); heart.scale.y = 0.4; g.add(heart);
    }
    const rotors: THREE.Object3D[] = [];
    const cols = [0xffa8d0, 0xa99af7, 0x9be36a, 0xffbd7a];
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sz], i) => {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6), blue);
      arm.rotation.z = Math.PI / 2; arm.rotation.y = Math.atan2(sz, sx) * -1; arm.position.set(sx * 0.3, 0.1, sz * 0.24);
      const rot = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.014, 0.075), new THREE.MeshStandardMaterial({ color: cols[i], roughness: 0.4 }));
      rot.position.set(sx * 0.5, 0.17, sz * 0.38);
      const hub = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), tapeM); hub.position.copy(rot.position);
      g.add(arm, rot, hub); rotors.push(rot);
    });
    g.scale.setScalar(1.15);
    g.traverse((o) => { o.castShadow = true; });
    // launch from just in front of the player, low and to the right (in frame)
    this.camera.getWorldDirection(_v);
    const right = _v2.set(-_v.z, 0, _v.x).normalize().clone();
    const pos = new THREE.Vector3(p.pos.x, p.pos.y + 0.78, p.pos.z).addScaledVector(_v, 1.7).addScaledVector(right, 0.55);
    g.position.copy(pos);
    this.scene.add(g);
    this.drone = { group: g, rotors, pos, target: null, t: 0, buzz: 0 };
    this.hud.setStreaks(p.ready4, p.ready5);
    this.hud.toast("DIAPER DRONE", "Seek and splat");
    this.audio.play("vo_drone_launched");
  }

  useStrike() {
    const p = this.p;
    if (!p.ready5 || this.strikeActive || !p.alive) return;
    p.ready5 = false;
    this.strikeActive = true;
    this.ev("strike");
    this.camera.getWorldDirection(_v);
    const foes = this.bots.filter((b) => b.team === "pink" && b.state === "alive");
    // enemies in front of the player first, so the payoff lands in frame
    foes.sort((a, b2) => ((b2.pos.x - p.pos.x) * _v.x + (b2.pos.z - p.pos.z) * _v.z) - ((a.pos.x - p.pos.x) * _v.x + (a.pos.z - p.pos.z) * _v.z));
    const pts: [number, number][] = foes.map((b) => [b.pos.x + b.vx * 1.2, b.pos.z + b.vz * 1.2]);
    const lead = foes.find((b) => (b.pos.x - p.pos.x) * _v.x + (b.pos.z - p.pos.z) * _v.z > 4);
    const cx = lead ? lead.pos.x : p.pos.x + _v.x * 9, cz = lead ? lead.pos.z : p.pos.z + _v.z * 9;
    for (let k = 0; pts.length < 8; k++) { const a2 = k * 2.4, d = 2.2 + (k % 3) * 1.6; pts.push([cx + Math.cos(a2) * d, cz + Math.sin(a2) * d]); }
    this.strikeFocus.set(cx, 0, cz);
    pts.forEach(([x0, z0], i) => {
      const x = clamp(x0, -this.world.hx + 2, this.world.hx - 2), z = clamp(z0, -this.world.hz + 2, this.world.hz - 2);
      const bg = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.46, 1.5, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, roughness: 0.1 }));
      const food = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.4, 1.2, 14), new THREE.MeshStandardMaterial({ color: FOOD[i % 6], emissive: FOOD[i % 6], emissiveIntensity: 0.3 }));
      food.position.y = -0.1;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.25, 14), new THREE.MeshStandardMaterial({ color: 0x20c4b0 }));
      ring.position.y = 0.8;
      const nip = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), new THREE.MeshStandardMaterial({ color: 0xffd9b8 }));
      nip.position.y = 1.2; nip.scale.y = 1.3;
      bg.add(shell, food, ring, nip);
      bg.rotation.x = Math.PI; // nipple down
      bg.scale.setScalar(1.7);
      bg.position.set(x, 30, z);
      bg.visible = false;
      const marker = new THREE.Mesh(new THREE.RingGeometry(2.9, 3.3, 40), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
      marker.rotation.x = -Math.PI / 2; marker.position.set(x, 0.05, z); marker.visible = false;
      this.scene.add(bg, marker);
      this.bottles.push({ mesh: bg, marker, x, z, delay: 0.9 + i * 0.2, y: 30, v: 0, state: 0 });
    });
    this.hud.setStreaks(p.ready4, p.ready5);
    this.hud.toast("BOTTLE STRIKE INBOUND", "Take cover, babies!");
    this.audio.play("vo_strike_inbound");
    this.audio.play("whistle", { vol: 0.5 });
  }

  explode(x: number, z: number, radius: number, dmg: number, owner: Party, colorIdx: number, big = false) {
    const col = FOOD[colorIdx % 6];
    // big powder puffs (soft white / pastel) + chunky baby-food blobs
    this.puffs.puff(x, 0.5, z, big ? 30 : 22, big ? 6.5 : 5, [0xffffff, 0xfffaf0, 0xfff0f6, 0xeaf4ff], big ? 2.6 : 2.0, big ? 4 : 3);
    for (let i = 0; i < 26; i++) {
      const a = this.fxRng() * 6.283, s = 2.5 + this.fxRng() * 6;
      this.bits.emit(x, 0.3, z, Math.cos(a) * s, 3 + this.fxRng() * 6, Math.sin(a) * s, FOOD[(colorIdx + i) % 6], 0.07 + this.fxRng() * 0.07, 0.55 + this.fxRng() * 0.35, 12, 0.6);
    }
    _v.set(x, 0, z); _v2.set(0, 1, 0);
    this.decals.spawn(_v, _v2, col, radius * 1.25);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 6.283 + this.fxRng(), d = radius * (0.8 + this.fxRng() * 0.6);
      _v3.set(x + Math.cos(a) * d, 0, z + Math.sin(a) * d);
      this.decals.spawn(_v3, _v2, FOOD[(colorIdx + i + 1) % 6], radius * (0.6 + this.fxRng() * 0.5));
    }
    const dist = Math.hypot(this.p.pos.x - x, this.p.pos.z - z);
    this.p.shake = Math.max(this.p.shake, clamp((big ? 1.5 : 1.2) - dist / 25, 0.15, 1));
    this.sfxAt("boom", _v.set(x, 0.5, z), 1.4);
    this.world.nudge(x, z, radius, 4, 4);
    for (const b of this.bots) {
      if (b.team === owner.team || b.state !== "alive") continue;
      const d = Math.hypot(b.pos.x - x, b.pos.z - z);
      if (d < radius) {
        b.hp -= dmg * (d < radius * 0.6 ? 1 : 0.6);
        b.toddler.flash();
        if (b.hp <= 0) this.downBot(b, owner, false);
      }
    }
  }

  private updateKillstreaks(dt: number) {
    const p = this.p;
    if (this.drone) {
      const d = this.drone;
      d.t += dt;
      d.buzz -= dt;
      if (d.buzz <= 0) { d.buzz = 0.45; this.sfxAt("drone", d.pos, 0.35); }
      if (!d.target || d.target.state !== "alive") {
        // prefer a baby in front of the player so the flight stays in frame
        this.camera.getWorldDirection(_v);
        let best: Bot | null = null, bd = 1e9;
        for (const b of this.bots) {
          if (b.team !== "pink" || b.state !== "alive") continue;
          const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, dd = Math.hypot(dx, dz) || 1;
          const front = (dx * _v.x + dz * _v.z) / dd;
          const sc = dd + (front < 0.6 ? 40 : 0) + (dd < 5 ? 12 : 0);
          if (sc < bd) { bd = sc; best = b; }
        }
        d.target = best;
      }
      d.rotors.forEach((r, i) => { r.rotation.y += dt * 60 * (i % 2 ? 1 : -1); });
      d.group.rotation.z = Math.sin(d.t * 5) * 0.08;
      if (d.t > 0.2 && d.t < 4 && (this.frameN & 1) === 0) this.puffs.emit(d.pos.x, d.pos.y - 0.05, d.pos.z, 0, 0.2, 0, 0xffffff, 0.16, 0.5, -0.2, 1.5, 0.5);
      if (d.target) {
        const tg = d.target;
        const dx = tg.pos.x - d.pos.x, dz = tg.pos.z - d.pos.z, dist = Math.hypot(dx, dz);
        const ty = dist < 2.6 ? 0.75 : 1.5 + Math.sin(d.t * 4) * 0.12;
        const sp = d.t < 0.5 ? 4 + d.t * 10 : 9.5;
        d.pos.x += (dx / (dist || 1)) * Math.min(dist, sp * dt);
        d.pos.z += (dz / (dist || 1)) * Math.min(dist, sp * dt);
        d.pos.y = damp(d.pos.y, ty, 3, dt);
        d.group.rotation.y = damp(d.group.rotation.y, Math.atan2(dx, dz), 6, dt);
        if (dist < 0.9 && d.pos.y < 1.3) { this.explodeDrone(d, p); }
      } else d.pos.y += Math.sin(d.t * 3) * 0.01;
      d.group.position.copy(d.pos);
      if (d.t > 9 && this.drone) this.explodeDrone(d, p);
    }
    // bottles
    if (this.bottles.length) {
      let alive = 0;
      for (const b of this.bottles) {
        if (b.state === 2) continue;
        alive++;
        b.delay -= dt;
        if (b.delay > 0.9) continue;
        b.marker.visible = true;
        (b.marker.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(this.time * 18) * 0.25;
        if (b.delay > 0) continue;
        if (b.state === 0) { b.state = 1; b.mesh.visible = true; b.y = 17; b.v = 5; this.sfxAt("whistle", _v.set(b.x, 3, b.z), 0.5, 1 + (b.x % 3) * 0.05); }
        b.v += 20 * dt;
        b.y -= b.v * dt;
        b.mesh.position.set(b.x, b.y + 1.3, b.z);
        b.mesh.rotation.y += dt * 3;
        b.mesh.rotation.z = Math.sin(this.time * 4 + b.x) * 0.12;
        if (b.y <= 0) {
          b.state = 2;
          this.scene.remove(b.mesh); this.scene.remove(b.marker);
          this.explode(b.x, b.z, 3.6, 100, this.playerParty, this.bottles.indexOf(b), true);
        }
      }
      if (!alive) { this.bottles = []; this.strikeActive = false; }
    }
    this.hud.setStreaks(p.ready4, p.ready5);
  }

  private explodeDrone(d: Drone, owner: Party) {
    this.ev("dronePop");
    this.explode(d.pos.x, d.pos.z, 3.0, 100, owner, 4, true);
    this.scene.remove(d.group);
    this.drone = null;
  }

  // ------------------------------------------------------------ HUD
  private updateHud(dt: number) {
    void dt;
    const p = this.p, wd = WEAPONS[p.weapon];
    if (this.state === "menu") return;
    this.hud.setHealth(p.hp, PLAYER_MAX);
    this.hud.setAmmo(p.ammo[p.weapon], wd.mag, p.reloadT >= 0);
    this.hud.setScore(this.teamScore.blue, this.teamScore.pink, SCORE_LIMIT);
    this.hud.setTimer(this.timeLeft);
    this.hud.setScoped(this.scoped);
    this.hud.setAds(this.vm.ads > 0.5);
    this.hud.setSpread(clamp(p.speed * 2.2, 0, 14) + (this.vm.ads > 0.5 ? -5 : 0) + (p.fireCd > 0 ? 3 : 0));
    this.hud.setWeapon(p.weapon, wd.name);
    if (this.frameN % 3 === 0 || this.opts.step) {
      const dots: MapDot[] = this.bots.map((b) => ({ x: b.pos.x, z: b.pos.z, team: b.team, alive: b.state === "alive" }));
      this.hud.minimap(p.yaw, p.pos.x, p.pos.z, this.world.hx, this.world.hz, this.world.mapRects, dots);
    }
  }
}

function w_resolve(w: World, p: THREE.Vector3) { w.resolve(p, 0.35, 1.0); }
