// Demo autopilot (?demo=1): plays the round for the camera with smooth, eased aiming.
// With ?cap=1 it also runs the "director": a scripted beat sheet for the launch video
// (hook kill, strafing fight, scoped sniper kill, Diaper Drone, Bottle Strike, low-health finish, close win).
import * as THREE from "three";
import type { Game, Bot } from "./game";
import { emptyCmd, type Cmd } from "./input";
import { clamp, wrapAngle, yawTo } from "./util";
import { WEAPONS } from "./weapons";


interface Beats { snipeAt: number; streakGate: number; lowFrom: number; winAt: number; hookDist: number }
const NURSERY: Beats = { snipeAt: 12, streakGate: 11, lowFrom: 25, winAt: 34, hookDist: 3.9 };

const BACKYARD: Beats = { snipeAt: 3, streakGate: 999, lowFrom: 99, winAt: 99, hookDist: 0 };

export class Autopilot {
  private BEATS: Beats = NURSERY;
  private g: Game;
  private t = 0;
  private avY = 0;
  private avP = 0;
  private strafeDir = 1;
  private strafeT = 0;
  private weaponT = 0;
  private sniperDone = false;
  private lastKills = 0;
  private streakDelay = 0;
  private stuckT = 0;
  private lastX = 0;
  private lastZ = 0;
  private fireToggle = false;
  /** rattle bonks used / time spent running in for the current one */
  private melees = 0; private rushT = 0;
  private target: Bot | null = null;
  private retargetT = 0;
  private jumpT = 0;
  private goalYaw = 0;
  private script: boolean;
  private hook: Bot | null = null;
  private focus: THREE.Vector3 | null = null;
  private focusUntil = 0;
  private strikeLookUntil = 0;
  private scopedT = 0;
  private acqT = 0;
  private lastTarget: Bot | null = null;
  private sniperCandidate: Bot | null = null;
  private waitCall = 0;
  private moveYaw = 0;
  private granted = false;
  private usedDrone = false;
  private usedStrike = false;
  private snipeTry = 0;
  private snipeSince = 0;

  constructor(g: Game) { this.g = g; this.script = g.opts.cap; }

  /** blue score the round should have by time t (linear to the win time) */
  private pace(t: number) { return 15 * clamp(t / this.BEATS.winAt, 0, 1); }
  private pinkPace(t: number) { return 20.5 * clamp(t / this.BEATS.winAt, 0, 1); }

  reset() {
    this.t = 0; this.avY = this.avP = 0; this.sniperDone = false; this.lastKills = 0; this.streakDelay = 0; this.target = null; this.retargetT = 0;
    this.hook = null; this.focus = null; this.focusUntil = 0; this.strikeLookUntil = 0; this.scopedT = 0; this.acqT = 0; this.waitCall = 0; this.granted = false; this.usedDrone = this.usedStrike = false; this.snipeTry = 0; this.snipeSince = 0; this.sniperCandidate = null;
    const g = this.g;
    g.streakGate = 0; g.pinkBoost = 1; g.allyDmg = 1; g.hurtScale = 1; g.noRegen = false;
    if (!this.script) return;
    this.BEATS = g.mapId === "backyard" ? BACKYARD : NURSERY;
    g.streakGate = this.BEATS.streakGate;
    g.allyDmg = 0.8;
    for (const b of g.bots) if (b.team === "blue") b.skill = 0.5;
    if (g.mapId === "backyard") { g.allyDmg = 0.6; return; }
    // HOOK: a pink baby sprints straight at the camera from 7 m, nothing in between
    const p = g.p;
    const bo = g.bots.find((b) => b.name === "Bo")!;
    const pos = new THREE.Vector3(p.pos.x, 0, p.pos.z - this.BEATS.hookDist);
    g.spawnBot(bo, pos);
    bo.inv = 0; bo.hp = 60; bo.mode = "chase"; bo.modeT = 9; bo.tgtT = 9; bo.target = g.playerParty; bo.targetVisible = true; bo.reactT = 1.6;
    bo.force = { x: p.pos.x, z: p.pos.z - 1.5, until: 2.0 };
    bo.toddler.skipPop();
    this.hook = bo;
    // keep the others out of the first second; they come in from the sides
    for (const b of g.bots) if (b.team === "pink" && b !== bo) { b.reactT = 1.2; b.inv = 0.6; }
    p.yaw = 0; p.pitch = Math.atan2(0.62 - 0.9, this.BEATS.hookDist);
    p.fireCd = 0; p.inv = 1.2; this.avY = this.avP = 0;
  }

  private pickTarget(): Bot | null {
    const g = this.g, p = g.p;
    let best: Bot | null = null, bs = 1e9;
    for (const b of g.bots) {
      if (b.team !== "pink" || b.state !== "alive" || b.inv > 0) continue;
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      const vis = g.world.clearLine(p.pos.x, 0.8, p.pos.z, b.pos.x, 0.6, b.pos.z);
      // keep some stickiness; prefer visible enemies, then ones in front
      const off = this.script ? Math.abs(wrapAngle(yawTo(b.pos.x - p.pos.x, b.pos.z - p.pos.z) - p.yaw)) * 5 : 0;
      const s = d + off + (vis ? 0 : 14) - (b === this.target ? (this.script ? 6 : 4) : 0);
      if (s < bs) { bs = s; best = b; }
    }
    return best;
  }

  /** Make sure a distant, visible pink baby exists for the scoped kill (director). */
  private arrangeSniperTarget(): Bot | null {
    const g = this.g, p = g.p, w = g.world;
    const eyeY = p.pos.y + 0.9;
    let best: Bot | null = null, bd = 0;
    for (const b of g.bots) {
      if (b.team !== "pink" || b.state !== "alive" || b.inv > 0) continue;
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      if (d > 13 && d < 26 && w.clearLine(p.pos.x, eyeY, p.pos.z, b.pos.x, 0.9, b.pos.z) && d > bd) { bd = d; best = b; }
    }
    if (best) return best;
    // pull one in: a downed/gone baby respawns at a far spot with a clear line to the player
    const cands = g.bots.filter((b) => b.team === "pink" && b.state !== "alive");
    const pool = cands.length ? cands : g.bots.filter((b) => b.team === "pink" && b.state === "alive").sort((a, b) => b.pos.distanceTo(p.pos) - a.pos.distanceTo(p.pos)).slice(0, 1);
    const b = pool[0];
    if (!b) return null;
    const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    let spot: THREE.Vector3 | null = null;
    for (let i = 0; i < 80 && !spot; i++) {
      const a = (i % 2 ? 1 : -1) * Math.floor(i / 2) * 0.12, d = 14 + (i % 5) * 1.6;
      const x = p.pos.x + (fwd.x * Math.cos(a) - fwd.z * Math.sin(a)) * d, z = p.pos.z + (fwd.x * Math.sin(a) + fwd.z * Math.cos(a)) * d;
      if (Math.abs(x) > w.hx - 2 || Math.abs(z) > w.hz - 2 || w.blocked(x, z, 0.8)) continue;
      if (!w.clearLine(p.pos.x, eyeY, p.pos.z, x, 0.9, z)) continue;
      spot = new THREE.Vector3(x, 0, z);
    }
    if (!spot) return null;
    g.spawnBot(b, spot);
    b.inv = 0.2; b.reactT = 2; b.mode = "wander"; b.modeT = 2.5;
    b.goal.set(spot.x + (spot.x > 0 ? -2 : 2), 0, spot.z + 1.5);
    return b;
  }

  cmd(dt: number): Cmd {
    const g = this.g, p = g.p, c = emptyCmd();
    this.t += dt;
    const t = this.t;
    if (!p.alive) return c;
    const S = this.script;

    // ---------------------------------------------------------- director: pacing knobs
    if (S && g.mapId === "backyard") {
      g.noRegen = true; g.hurtScale = 0.6;
      if (t > 8 && !this.granted) { this.granted = true; g.grantStrike(); }
    } else if (S) {
      const pink = g.teamScore.pink;
      // guarantee the two payoffs on schedule even if the streaks do not line up
      if (t > 15.5 && !this.usedDrone && !p.ready4 && !p.ready5) g.grantDrone();
      if (t > 23 && this.usedDrone && !this.usedStrike && !p.ready5 && t > this.focusUntil) g.grantStrike();
      g.pinkBoost = clamp(1 + 0.7 * (this.pinkPace(t) - pink), 0.45, 4.5);
      // health curve: ~100 -> 70 at 10 s -> 45 at 20 s -> hover near 20 from 30 s
      const want = t < 10 ? 100 - 3 * t : t < 20 ? 70 - 2.5 * (t - 10) : t < 30 ? 45 - 2.1 * (t - 20) : 24;
      const err = p.hp - want;
      const finale = g.teamScore.blue >= 13 && pink < 10 && t < 41;
      const deficit = Math.max(0, this.pace(t) - g.teamScore.blue - 1.5);
      g.allyDmg = finale ? 0.04 : 0.8 * (1 + 0.35 * deficit);
      if (deficit > 0) g.pinkBoost = Math.max(0.3, g.pinkBoost * 0.5);
      g.noRegen = true;
      g.hurtScale = err > 6 ? 1.6 : err < -2 ? 0 : 0.8;
    }

    // ---------------------------------------------------------- streak call-ins (wait for a visible baby in front so the payoff is on camera)
    if (p.kills > this.lastKills && p.weapon === 2) this.sniperDone = true;
    this.lastKills = p.kills;
    if ((p.ready4 || p.ready5) && !g.drone && !g.strikeActive && t > this.focusUntil) {
      this.streakDelay += dt;
      let ok = this.streakDelay > 0.9;
      if (S && ok && !this.sniperCandidate) {
        // need a visible enemy 6-16 m ahead, else wait up to 3 s
        const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
        const seen = g.bots.some((b) => {
          if (b.team !== "pink" || b.state !== "alive") return false;
          const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, d = Math.hypot(dx, dz);
          return d > 5 && d < 16 && (dx * fwd.x + dz * fwd.z) / d > 0.8 && g.world.clearLine(p.pos.x, 0.9, p.pos.z, b.pos.x, 0.8, b.pos.z);
        });
        this.waitCall += dt;
        ok = seen || this.waitCall > 3;
      }
      if (ok) {
        c.streak = p.ready5 ? 5 : 4;
        if (S) { if (c.streak === 4) { this.usedDrone = true; g.streakGate = 999; } else { this.usedStrike = true; g.streakGate = 999; } }
        this.streakDelay = -1.2; this.waitCall = 0;
        if (c.streak === 4) this.focusUntil = t + 5; else { this.focusUntil = t + 4.2; this.strikeLookUntil = t + 4.2; }
      }
    }
    if (this.streakDelay < 0) this.streakDelay = Math.min(0, this.streakDelay + dt) || 0;

    // ---------------------------------------------------------- targets
    this.retargetT -= dt;
    if (this.retargetT <= 0 || !this.target || this.target.state !== "alive") {
      if (S && t < 1.5 && this.hook && this.hook.state === "alive") { this.target = this.hook; this.retargetT = 0.3; }
      else { this.target = this.pickTarget(); this.retargetT = 0.5; }
    }
    // scoped kill: pick (or arrange) a distant target once it's time
    if (S && !this.sniperDone && t > this.BEATS.snipeAt && (!this.sniperCandidate || this.sniperCandidate.state !== "alive")) {
      this.sniperCandidate = this.arrangeSniperTarget();
      this.snipeTry += 1;
      const sc = this.sniperCandidate;
      if (sc) { sc.force = { x: sc.pos.x, z: sc.pos.z, until: t + 9 }; this.snipeSince = t; }
      if (this.snipeTry > 6) this.sniperDone = true;
    }
    if (S && this.sniperCandidate && this.sniperCandidate.state === "alive" && t - this.snipeSince > 8) { this.sniperDone = true; this.sniperCandidate.force = null; }
    const sniping = S && !this.sniperDone && t > this.BEATS.snipeAt && this.sniperCandidate && this.sniperCandidate.state === "alive";
    if (sniping) this.target = this.sniperCandidate;
    const tg = this.target;
    if (tg !== this.lastTarget) { this.lastTarget = tg; this.acqT = 0; }
    this.acqT += dt;
    const camY = p.pos.y + 0.9;
    let dist = 99, vis = false;
    if (tg) {
      dist = Math.hypot(tg.pos.x - p.pos.x, tg.pos.z - p.pos.z);
      vis = g.world.clearLine(p.pos.x, camY, p.pos.z, tg.pos.x, 0.6, tg.pos.z);
    }
    // payoff focus (drone in flight / bottles falling)
    this.focus = null;
    if (g.drone) this.focus = g.drone.pos;
    else if (g.strikeActive && t < this.strikeLookUntil) this.focus = _f.set(g.strikeFocus.x, 2.2, g.strikeFocus.z);
    const watching = !!this.focus;

    // ---------------------------------------------------------- weapon choice
    this.weaponT -= dt;
    if (this.weaponT <= 0 && !g.vm.switching) {
      let want = 0;
      if (sniping && tg && vis) want = 2;
      else if (S) {
        want = tg && vis && dist > 6.5 && dist < 12 && ((t / 6) | 0) % 2 === 1 && !this.hook ? 1 : 0;
        if (watching) want = p.weapon;
      } else if (tg && vis) {
        if (!this.sniperDone && t > 4 && dist > 8) want = 2;
        else if (dist > 17) want = 2;
        else if (dist > 6.5 && dist < 11 && t > 20 && ((t / 7) | 0) % 2 === 0) want = 1;
        else want = 0;
      } else want = p.weapon === 2 ? 0 : p.weapon;
      if (S && !sniping && p.weapon === 2) want = 0;
      if (want !== p.weapon) { c.slot = want + 1; this.weaponT = 1.4; } else this.weaponT = 0.3;
    }
    const wd = WEAPONS[p.weapon];

    // ---------------------------------------------------------- movement (decided first so the camera can look where it walks)
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeDir = -this.strafeDir; this.strafeT = 0.9 + ((t * 7.3) % 1.7); }
    let wx = 0, wz = 0;
    const scoping = p.weapon === 2 && !!tg && vis && !!sniping;
    const lowHp = !S && p.hp < 35;
    const ahead = S ? g.teamScore.blue - this.pace(t) : 0;
    // rattle rush: a couple of close-range bonks (shows the melee on camera)
    const rushOk = !!tg && vis && !watching && !scoping && !sniping && p.weapon !== 2 && this.melees < 2 && !lowHp && !(this.hook && t < 2) && t > (this.melees === 0 ? 7 : 16) && dist < 8 && g.state === "playing";
    this.rushT = rushOk ? this.rushT + dt : 0;
    if (this.rushT > 3.5) { this.melees++; this.rushT = 0; }
    const rushing = rushOk && this.rushT > 0;
    const holdBack = S && (ahead > 3.5 || (g.teamScore.blue >= 14 && t < this.BEATS.winAt));
    if (watching) {
      // stand and enjoy the show, small sway
      wx = Math.cos(t * 1.7) * 0.25; wz = 0;
    } else if (tg) {
      const dx = tg.pos.x - p.pos.x, dz = tg.pos.z - p.pos.z, d = dist || 1;
      const nx = dx / d, nz = dz / d;
      if (rushing) { wx = nx; wz = nz; }
      else if (scoping) { wx = wz = 0; }
      else if (this.hook && t < 1.2) { wx = wz = 0; }
      else if (!vis || dist > 13) { wx = nx; wz = nz; }
      else if (dist < 4.5) { wx = -nx * 0.8 - nz * this.strafeDir * 0.4; wz = -nz * 0.8 + nx * this.strafeDir * 0.4; }
      else { wx = -nz * this.strafeDir; wz = nx * this.strafeDir; if (dist > 9) { wx += nx * 0.4; wz += nz * 0.4; } }
      if (!rushing && (lowHp || holdBack) && vis) {
        const cv = g.world.findCover(p.pos.x, p.pos.z, tg.pos.x, tg.pos.z, 10);
        if (cv) { const cx = cv.x - p.pos.x, cz = cv.z - p.pos.z, cd = Math.hypot(cx, cz) || 1; if (cd > 0.8) { wx = cx / cd; wz = cz / cd; } else { wx = wz = 0; } }
      }
    }
    // keep big props out of the frame: push away from anything within ~2.4 m
    if (S && !watching) {
      let rx = 0, rz = 0;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
        const h = g.world.raycast(p.pos.x, 0.5, p.pos.z, cx, 0, cz, 3.2, false);
        if (h) { const w = (3.2 - h.t) / 3.2; rx -= cx * w; rz -= cz * w; }
      }
      wx += rx * 3.2; wz += rz * 3.2;
    }
    const wl = Math.hypot(wx, wz);
    let sx = 0, sz = 0;
    if (wl > 0.05) {
      [sx, sz] = g.steer(p.pos.x, p.pos.z, wx / wl, wz / wl, this.strafeDir, 2.0);
      // convert to local
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      c.mz = clamp(-sy * sx - cy * sz, -1, 1);
      c.mx = clamp(cy * sx - sy * sz, -1, 1);
      const m = Math.hypot(c.mx, c.mz) || 1;
      const mag = Math.min(1, wl);
      c.mx = (c.mx / m) * mag; c.mz = (c.mz / m) * mag;
      c.sprint = ((!vis || dist > 14) && p.weapon !== 2 && c.mz > 0.5 && !lowHp) || (rushing && dist > 3.5 && c.mz > 0.5);
      this.moveYaw = yawTo(sx, sz);
    }

    // ---------------------------------------------------------- aim
    const scale = g.lookScale();
    let wantYaw = p.yaw, wantPitch = 0;
    let aimErr = 9;
    let aimingAtTarget = false;
    if (this.focus) {
      const dx = this.focus.x - p.pos.x, dz = this.focus.z - p.pos.z, hd = Math.hypot(dx, dz);
      wantYaw = yawTo(dx, dz);
      wantPitch = Math.atan2(this.focus.y - camY, Math.max(hd, 1));
    } else if (tg && (vis || !S)) {
      aimingAtTarget = true;
      const head = p.weapon === 2 && dist > 6;
      const ty = head ? 0.88 : 0.55;
      const lead = dist / wd.speed;
      const tx = tg.pos.x + tg.vx * lead, tz = tg.pos.z + tg.vz * lead;
      const dx = tx - p.pos.x, dz = tz - p.pos.z;
      const hd = Math.hypot(dx, dz);
      wantYaw = yawTo(dx, dz);
      const drop = 0.5 * wd.grav * (hd - 18) / (wd.speed * wd.speed);
      wantPitch = Math.atan2(ty - camY, hd) + drop;
      if (!vis) wantPitch = 0;
    } else if (S && wl > 0.05) {
      // no shot: look where we are heading, not through the wall
      wantYaw = this.moveYaw; wantPitch = -0.02;
      // never stare at a block/wall: lean the view toward the most open direction within +-70 deg
      let best = -1, bestYaw = wantYaw;
      for (let k = -6; k <= 6; k++) {
        const ya = this.moveYaw + k * 0.3;
        const h = g.world.raycast(p.pos.x, 0.9, p.pos.z, -Math.sin(ya), 0, -Math.cos(ya), 12, false);
        const open = (h ? h.t : 12) - Math.abs(k) * 0.3;
        if (open > best) { best = open; bestYaw = ya; }
      }
      wantYaw = bestYaw;
    } else wantYaw = this.goalYaw;
    const ey = wrapAngle(wantYaw - p.yaw), ep = wantPitch - p.pitch;
    aimErr = Math.hypot(ey * Math.cos(p.pitch), ep);
    const hooking = S && t < 1.0;
    const k = hooking ? 10 : S ? 5.5 : 9, maxW = hooking ? 6 : this.focus ? 2.6 : vis ? (S ? 4.6 : 7) : S ? 2.4 : 4;
    const ty = clamp(ey * k, -maxW, maxW), tp = clamp(ep * k, -maxW, maxW);
    const sm = 1 - Math.exp(-(S ? 9 : 13) * dt);
    this.avY += (ty - this.avY) * sm; this.avP += (tp - this.avP) * sm;
    c.dyaw = (this.avY * dt) / scale; c.dpitch = (this.avP * dt) / scale;
    if (!tg) this.goalYaw = yawTo(-p.pos.x, -p.pos.z);

    // stuck -> hop
    this.stuckT += dt;
    if (this.stuckT > 1) {
      if (wl > 0.05 && Math.hypot(p.pos.x - this.lastX, p.pos.z - this.lastZ) < 0.35) { c.jump = true; this.strafeDir = -this.strafeDir; this.strafeT = 1.2; }
      this.lastX = p.pos.x; this.lastZ = p.pos.z; this.stuckT = 0;
    }
    this.jumpT -= dt;
    if (this.jumpT <= 0) { this.jumpT = 6 + ((t * 3.7) % 4); if (vis && dist < 9 && p.weapon !== 2 && !S) c.jump = true; }

    // ---------------------------------------------------------- ADS + fire
    const aimHard = aimingAtTarget && tg && vis && (p.weapon === 2 ? dist > 5 : dist > 5.5) && !hooking;
    c.aim = !!aimHard && !c.sprint;
    if (scoping) this.scopedT = g.vm.ads > 0.9 ? this.scopedT + dt : 0; else this.scopedT = 0;
    const tol = (p.weapon === 2 ? 0.012 : 0.03) + 0.30 / Math.max(dist, 2) * 0.35;
    const ready = p.weapon === 2 ? g.vm.ads > 0.93 && (!S || this.scopedT > 0.8) : g.vm.ads > 0.6 || !c.aim;
    const acqOk = !S || hooking || this.acqT > 0.28;
    let allowFire = aimingAtTarget && !!tg && vis && aimErr < tol && ready && dist < 30 && !g.vm.switching && acqOk && !watching;
    if (S && holdBack && !(sniping && p.weapon === 2) && dist > 4.5) allowFire = false;
    if (S && g.teamScore.blue >= 13 && g.teamScore.pink < 10 && t < 41 && !(sniping && p.weapon === 2)) allowFire = false;
    if (rushing && dist < 4.5) allowFire = false;
    if (rushing && dist < 1.9 && aimErr < 0.5 && p.meleeCd <= 0 && !g.vm.meleeing && !g.vm.switching) { c.melee = true; this.melees++; this.rushT = 0; }
    if (allowFire) {
      if (wd.auto) c.fire = true;
      else { this.fireToggle = !this.fireToggle; c.fire = this.fireToggle; }
    } else this.fireToggle = false;
    // reload when low and not engaged closely
    if (p.ammo[p.weapon] <= wd.mag * 0.2 && (!vis || dist > 9) && p.reloadT < 0 && p.ammo[p.weapon] < wd.mag) c.reload = true;
    return c;
  }
}

const _f = new THREE.Vector3();
