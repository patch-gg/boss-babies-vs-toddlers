// Keyboard + mouse (pointer lock), touch (virtual stick / drag look / buttons) and Gamepad API, merged into one command per frame.

export interface Cmd {
  mx: number; // strafe right +
  mz: number; // forward +
  dyaw: number; // radians this frame, + = turn left (counter-clockwise)
  dpitch: number; // radians this frame, + = look up
  fire: boolean;
  aim: boolean;
  jump: boolean;
  sprint: boolean;
  reload: boolean; // pulse
  slot: number; // 0 none, 1..3 weapon slot (pulse)
  cycle: number; // -1, 0, 1 (pulse)
  streak: number; // 0, 4, 5 (pulse)
  start: boolean; // pulse: confirm / restart
  melee: boolean; // pulse: rattle bonk
}

export const emptyCmd = (): Cmd => ({
  mx: 0, mz: 0, dyaw: 0, dpitch: 0, fire: false, aim: false, jump: false, sprint: false, reload: false, slot: 0, cycle: 0, streak: 0, start: false, melee: false,
});

const SENS = 0.0023;
const PAD_LOOK = 3.1; // rad/s at full deflection

export class Input {
  locked = false;
  /** True if pointer lock is unavailable/refused: then mouse works unlocked. */
  noLock = false;
  usingTouch = false;
  usingPad = false;
  private keys = new Set<string>();
  private mouseDown = new Set<number>();
  private dx = 0;
  private dy = 0;
  private pulses = { reload: false, slot: 0, cycle: 0, streak: 0, start: false, melee: false };
  private lookTouch = -1;
  private lastLook = { x: 0, y: 0 };
  private stickTouch = -1;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private touchBtn = { fire: false, aim: false, jump: false };
  private padPrev: boolean[] = [];
  onGesture: () => void = () => {};

  private touchRoot: HTMLElement;

  constructor(canvas: HTMLElement, touchRoot: HTMLElement) {
    this.touchRoot = touchRoot;
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.mouseDown.clear();
    });
    document.addEventListener("pointerlockerror", () => { this.noLock = true; });
    document.addEventListener("mousemove", (e) => {
      if (this.locked || this.noLock) { this.dx += e.movementX; this.dy += e.movementY; }
    });
    window.addEventListener("mousedown", (e) => {
      this.onGesture(); this.mouseDown.add(e.button);
      if (e.button === 1) { e.preventDefault(); this.pulses.melee = true; } // middle (wheel) click = rattle bonk, no autoscroll
    });
    window.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    window.addEventListener("mouseup", (e) => this.mouseDown.delete(e.button));
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => { this.keys.clear(); this.mouseDown.clear(); });
    window.addEventListener("wheel", (e) => { if (this.locked) this.pulses.cycle += e.deltaY > 0 ? 1 : -1; }, { passive: true });
    window.addEventListener("keydown", (e) => {
      this.onGesture();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "KeyR") this.pulses.reload = true;
      if (e.code === "Digit1") this.pulses.slot = 1;
      if (e.code === "Digit2") this.pulses.slot = 2;
      if (e.code === "Digit3") this.pulses.slot = 3;
      if (e.code === "Digit4") this.pulses.streak = 4;
      if (e.code === "Digit5") this.pulses.streak = 5;
      if (e.code === "KeyV") this.pulses.melee = true;
      if (e.code === "KeyQ") this.pulses.cycle = -1;
      if (e.code === "Enter" || e.code === "Space") this.pulses.start = true;
      if (["Space", "ArrowUp", "ArrowDown", "Tab"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    this.setupTouch();
  }

  private setupTouch() {
    const root = this.touchRoot;
    const coarse = window.matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).has("touch");
    if (coarse) { this.usingTouch = true; root.hidden = false; }
    const base = root.querySelector<HTMLElement>("#stick-base")!;
    const knob = root.querySelector<HTMLElement>("#stick-knob")!;
    const R = 56;
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.usingTouch = true; root.hidden = false;
      this.onGesture();
      if ((e.target as HTMLElement).closest(".tbtn")) return;
      if (e.clientX < innerWidth * 0.45 && this.stickTouch < 0) {
        this.stickTouch = e.pointerId;
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        base.style.display = "block";
        base.style.left = `${e.clientX - R}px`; base.style.top = `${e.clientY - R}px`;
        knob.style.transform = "translate(0,0)";
      } else if (this.lookTouch < 0 && e.clientX >= innerWidth * 0.45) {
        this.lookTouch = e.pointerId;
        this.lastLook = { x: e.clientX, y: e.clientY };
      }
    });
    window.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.stickTouch) {
        let x = (e.clientX - this.stickOrigin.x) / R, y = (e.clientY - this.stickOrigin.y) / R;
        const l = Math.hypot(x, y);
        if (l > 1) { x /= l; y /= l; }
        this.stick = { x, y };
        knob.style.transform = `translate(${x * R * 0.7}px, ${y * R * 0.7}px)`;
      } else if (e.pointerId === this.lookTouch) {
        this.dx += (e.clientX - this.lastLook.x) * 1.6;
        this.dy += (e.clientY - this.lastLook.y) * 1.6;
        this.lastLook = { x: e.clientX, y: e.clientY };
      }
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.stickTouch) { this.stickTouch = -1; this.stick = { x: 0, y: 0 }; base.style.display = "none"; }
      if (e.pointerId === this.lookTouch) this.lookTouch = -1;
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    const hold = (id: string, key: "fire" | "aim" | "jump") => {
      const el = root.querySelector<HTMLElement>(id)!;
      el.addEventListener("pointerdown", (e) => { this.touchBtn[key] = true; el.setPointerCapture(e.pointerId); e.preventDefault(); });
      const off = () => (this.touchBtn[key] = false);
      el.addEventListener("pointerup", off); el.addEventListener("pointercancel", off);
    };
    hold("#tb-fire", "fire"); hold("#tb-aim", "aim"); hold("#tb-jump", "jump");
    const tap = (id: string, fn: () => void) => root.querySelector(id)!.addEventListener("pointerdown", (e) => { fn(); e.preventDefault(); });
    tap("#tb-reload", () => (this.pulses.reload = true));
    tap("#tb-swap", () => (this.pulses.cycle = 1));
    tap("#tb-melee", () => (this.pulses.melee = true));
    tap("#tb-s4", () => (this.pulses.streak = 4));
    tap("#tb-s5", () => (this.pulses.streak = 5));
  }

  private padBtn(pad: Gamepad, i: number) {
    return !!pad.buttons[i]?.pressed;
  }

  /** Programmatic press (used by menu buttons). */
  pulseStart() { this.pulses.start = true; }

  poll(dt: number): Cmd {
    const c = emptyCmd();
    const k = this.keys;
    c.mx = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    c.mz = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    c.sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    c.jump = k.has("Space");
    c.fire = this.mouseDown.has(0) && (this.locked || this.usingTouch || this.noLock);
    c.aim = this.mouseDown.has(2);
    c.dyaw = -Math.max(-250, Math.min(250, this.dx)) * SENS;
    c.dpitch = -Math.max(-250, Math.min(250, this.dy)) * SENS;
    this.dx = this.dy = 0;
    // touch
    if (this.usingTouch) {
      c.mx += this.stick.x; c.mz -= this.stick.y;
      if (Math.hypot(this.stick.x, this.stick.y) > 0.95) c.sprint = true;
      c.fire ||= this.touchBtn.fire; c.aim ||= this.touchBtn.aim; c.jump ||= this.touchBtn.jump;
    }
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : v);
      const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0), rx = dz(pad.axes[2] ?? 0), ry = dz(pad.axes[3] ?? 0);
      if (lx || ly || rx || ry || pad.buttons.some((b) => b.pressed)) this.usingPad = true;
      c.mx += lx; c.mz -= ly;
      c.dyaw -= Math.sign(rx) * rx * rx * PAD_LOOK * dt;
      c.dpitch -= Math.sign(ry) * ry * ry * PAD_LOOK * 0.75 * dt;
      c.fire ||= (pad.buttons[7]?.value ?? 0) > 0.3;
      c.aim ||= (pad.buttons[6]?.value ?? 0) > 0.3;
      c.jump ||= this.padBtn(pad, 0);
      c.sprint ||= this.padBtn(pad, 10) || Math.hypot(lx, ly) > 0.97;
      const edge = (i: number) => { const p = this.padBtn(pad, i); const was = this.padPrev[i]; this.padPrev[i] = p; return p && !was; };
      if (edge(2)) c.reload = true;
      if (edge(3) || edge(5)) c.cycle = 1;
      if (edge(4)) c.cycle = -1;
      if (edge(12)) c.streak = 4;
      if (edge(15)) c.streak = 5;
      if (edge(9) || edge(0)) c.start = true;
      if (edge(11)) c.melee = true; // R3
    }
    const m = Math.hypot(c.mx, c.mz);
    if (m > 1) { c.mx /= m; c.mz /= m; }
    c.reload ||= this.pulses.reload;
    c.slot = this.pulses.slot;
    c.cycle = c.cycle || this.pulses.cycle;
    c.streak = c.streak || this.pulses.streak;
    c.start ||= this.pulses.start;
    c.melee ||= this.pulses.melee;
    this.pulses = { reload: false, slot: 0, cycle: 0, streak: 0, start: false, melee: false };
    c.cycle = Math.max(-1, Math.min(1, c.cycle));
    return c;
  }
}
