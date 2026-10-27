import type { SplatTextures } from "./fx";
import { after, cancel, clock } from "./util";
import type { Team } from "./characters";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface MapDot { x: number; z: number; team: Team | "me"; alive: boolean }

export class Hud {
  root = $("hud");
  private hp = $("hp"); private hfill = $("hfill"); private health = $("health");
  private ammoN = $("ammo-n"); private ammoM = $("ammo-m"); private ammoBox = $("ammo");
  private wname = $("wname"); private wslots = $("wslots");
  private sBlue = $("s-blue"); private sPink = $("s-pink"); private timer = $("timer"); private limit = $("limit-n");
  private feedEl = $("feed"); private toastEl = $("toast"); private popups = $("popups"); private hitmark = $("hitmark");
  private dmg = $("dmg"); private cross = $("crosshair"); private scopeEl = $("scope"); private reloadHint = $("reload-hint");
  private st4 = $("st4"); private st5 = $("st5");
  private mm = $<HTMLCanvasElement>("minimap").getContext("2d")!;
  private hitT = 0;
  private popEl: HTMLElement | null = null; private popT = 0;
  private bannerUntil = -1;
  private cap = new URLSearchParams(location.search).get("cap") === "1";
  /** colour of the enemy team (damage splats) */
  foeColor = 0xffc04d; allyCss = "#4da3ff"; foeCss = "#ffc04d";
  private lastHp = -1; private lastAmmo = "";
  private tex: SplatTextures;
  constructor(tex: SplatTextures) { this.tex = tex; }

  show(v: boolean) { this.root.hidden = !v; }

  /** Team names + accent colours (CSS variables drive the score bar and killfeed). */
  setTeams(allyName: string, foeName: string, ally: { rgb: string; css: string; txt: string }, foe: { rgb: string; css: string; txt: string; hex: number }) {
    $("l-blue").textContent = allyName; $("l-pink").textContent = foeName;
    const st = document.documentElement.style;
    st.setProperty("--ally-rgb", ally.rgb); st.setProperty("--foe-rgb", foe.rgb);
    st.setProperty("--ally-txt", ally.txt); st.setProperty("--foe-txt", foe.txt);
    this.allyCss = ally.css; this.foeCss = foe.css; this.foeColor = foe.hex;
  }

  setHealth(hp: number, max = 100) {
    const v = Math.max(0, Math.round(hp));
    if (v === this.lastHp) return;
    this.lastHp = v;
    this.hp.textContent = String(v);
    this.hfill.style.width = `${Math.min(100, (v / max) * 100)}%`;
    const low = v <= max * 0.3 && v > 0;
    this.health.classList.toggle("low", low);
    this.dmg.classList.toggle("low", low);
  }
  setWeapon(i: number, name: string) {
    this.wname.textContent = name;
    [...this.wslots.children].forEach((c, k) => c.classList.toggle("on", k === i));
  }
  setAmmo(cur: number, mag: number, reloading: boolean) {
    const k = `${cur}/${mag}/${reloading}`;
    if (k === this.lastAmmo) return;
    this.lastAmmo = k;
    this.ammoN.textContent = reloading ? "..." : String(cur);
    this.ammoM.textContent = `/ ${mag}`;
    this.ammoBox.classList.toggle("empty", cur === 0);
    this.reloadHint.hidden = !(cur <= Math.max(1, mag * 0.2) && !reloading && !(this.root.hidden));
    this.reloadHint.innerHTML = cur === 0 ? "EMPTY! PRESS <kbd>R</kbd>" : "PRESS <kbd>R</kbd> TO RELOAD";
  }
  setScore(blue: number, pink: number, limit: number) {
    this.sBlue.textContent = String(blue); this.sPink.textContent = String(pink); this.limit.textContent = String(limit);
  }
  setTimer(sec: number) {
    const s = Math.max(0, Math.ceil(sec));
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    this.timer.classList.toggle("low", s <= 10);
  }
  setStreaks(r4: boolean, r5: boolean) {
    this.st4.classList.toggle("ready", r4); this.st5.classList.toggle("ready", r5);
  }
  setScoped(on: boolean) { this.scopeEl.hidden = !on; this.cross.classList.toggle("hidden", on); }
  setAds(on: boolean) { this.cross.classList.toggle("ads", on); }
  setSpread(px: number) { this.cross.style.setProperty("--cs", `${px.toFixed(1)}px`); }
  setFpsText(t: string) { const f = $("fps"); f.hidden = false; f.textContent = t; }

  feed(killer: string, victim: string, kt: Team, vt: Team, me: boolean, head: boolean, melee = false) {
    const li = document.createElement("li");
    if (me) li.classList.add("me");
    const verb = melee
      ? `<svg class="rattle-ico" viewBox="0 0 32 32"><path d="M26 26l-7-7" stroke="#8cc63f" stroke-width="3" stroke-linecap="round"/><circle cx="25" cy="25" r="3.2" fill="none" stroke="#7fb02a" stroke-width="2"/><circle cx="12" cy="12" r="10" fill="#ff7a1a"/><circle cx="12" cy="12" r="6.2" fill="#ffd400"/><path d="M7 10a6.2 6.2 0 0 1 6-4.8 6 6 0 0 0-5 7z" fill="#8cc63f"/></svg><b class="rattled">RATTLED</b>`
      : `<span>splatted${head ? " (HEAD)" : ""}</span>`;
    li.innerHTML = `<span class="${kt}">${killer}</span>${verb}<span class="${vt}">${victim}</span>`;
    this.feedEl.appendChild(li);
    while (this.feedEl.children.length > 5) this.feedEl.firstChild!.remove();
    after(4200, () => li.classList.add("out"));
    after(4900, () => li.remove());
  }

  toast(title: string, sub = "") {
    this.toastEl.querySelector("b")!.textContent = title;
    this.toastEl.querySelector("span")!.textContent = sub;
    this.toastEl.classList.remove("show");
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add("show");
    this.bannerUntil = clock.t + 2.6;
  }
  /** True while a killstreak / event banner is on screen. */
  bannerOn() { return clock.t < this.bannerUntil; }

  /** One crosshair popup at a time, below the crosshair, short fade. Plain hits show nothing (the hit marker does that). */
  popup(text: string, kind: "hit" | "kill" | "head" = "hit") {
    if (kind === "hit") return;
    if (this.popEl) { this.popEl.remove(); cancel(this.popT); }
    const d = document.createElement("div");
    d.className = `pop ${kind}`;
    d.textContent = text;
    this.popups.appendChild(d);
    this.popEl = d;
    this.popT = after(750, () => { d.remove(); if (this.popEl === d) this.popEl = null; });
  }

  hitMarker(kill: boolean) {
    this.hitmark.classList.add("on");
    this.hitmark.classList.toggle("kill", kill);
    cancel(this.hitT);
    this.hitT = after(kill ? 260 : 110, () => this.hitmark.classList.remove("on"));
  }

  /** angle: 0 = shooter in front, + = to the right. */
  damage(angle: number, colorIdx: number) {
    const d = document.createElement("div");
    d.className = "dsplat";
    void colorIdx;
    // enemy fire reads as the pink team's colour: soft pastel pink
    d.style.backgroundImage = `url(${this.tex.url(this.foeColor, (Math.random() * 4) | 0)})`;
    let x = 50 + Math.sin(angle) * 42, y = 50 - Math.cos(angle) * 40;
    if (this.cap) { // keep the top-left corner (logo watermark) clear
      const w = window.innerWidth, h = window.innerHeight;
      if (x * w / 100 < 320 && y * h / 100 < 320) { x = 320 / w * 100; }
    }
    d.style.left = `calc(${x}% - 15vmin)`; d.style.top = `calc(${y}% - 15vmin)`;
    d.style.setProperty("--rot", `${Math.random() * 360}deg`);
    this.dmg.appendChild(d);
    after(3300, () => d.remove());
    this.dmg.style.setProperty("--v", "0.8");
    after(120, () => this.dmg.style.setProperty("--v", "0"));
  }

  /** Minimap: player-centred, rotated so up = forward. */
  minimap(yaw: number, px: number, pz: number, hx: number, hz: number, rects: number[][], dots: MapDot[]) {
    const g = this.mm, S = 300, c = S / 2, scale = S / 44;
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath(); g.arc(c, c, c, 0, 7); g.clip();
    g.fillStyle = "rgba(30,40,80,0.55)"; g.fillRect(0, 0, S, S);
    g.translate(c, c);
    g.rotate(yaw);
    g.translate(-px * scale, -pz * scale);
    g.fillStyle = "rgba(255,255,255,0.12)"; g.fillRect(-hx * scale, -hz * scale, hx * 2 * scale, hz * 2 * scale);
    g.strokeStyle = "rgba(255,255,255,0.8)"; g.lineWidth = 3; g.strokeRect(-hx * scale, -hz * scale, hx * 2 * scale, hz * 2 * scale);
    g.fillStyle = "rgba(210,220,255,0.5)";
    for (const [x, z, w, d] of rects) g.fillRect((x - w / 2) * scale, (z - d / 2) * scale, w * scale, d * scale);
    for (const d of dots) {
      if (!d.alive || d.team === "me") continue;
      g.fillStyle = d.team === "pink" ? this.foeCss : this.allyCss;
      g.strokeStyle = "#fff"; g.lineWidth = 2;
      g.beginPath(); g.arc(d.x * scale, d.z * scale, 8, 0, 7); g.fill(); g.stroke();
    }
    g.restore();
    // player arrow
    g.fillStyle = "#ffe14d"; g.strokeStyle = "#333"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(c, c - 14); g.lineTo(c + 10, c + 10); g.lineTo(c, c + 4); g.lineTo(c - 10, c + 10); g.closePath(); g.fill(); g.stroke();
  }
}
