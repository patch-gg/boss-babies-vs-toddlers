// Deterministic offline capture of the built game.
//   node tools/capture.mjs --name nursery_16x9 --w 1920 --h 1080 [--query "demo=1&cap=1&step=1&seed=7"] [--workers 3]
//        [--secs 45] [--tail 100] [--maxframes N] [--base http://127.0.0.1:4173] [--serve] [--from F --to F] [--skip-encode]
// Steps the sim 1/60 s per frame (window.game.step), screenshots every frame (DOM HUD included) to renders/<name>/frames/%05d.png,
// dumps audio_log.json, encodes <name>.mp4 (60 fps h264 crf16) and <name>_sfx.mp4 (SFX rendered at the logged sim times).
// Workers re-simulate from t=0 (cheap, no rendering) and only render/screenshot their own frame range, so frames are identical.
import { launch, openGame } from "./lib.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes("--" + k);
const name = arg("name", "run");
const W = +arg("w", 1920), H = +arg("h", 1080);
const query = arg("query", "demo=1&cap=1&step=1&seed=7");
const workers = +arg("workers", 3);
const secs = +arg("secs", 50);
const tail = +arg("tail", 100); // frames kept after the round ends (ROUND WON panel)
const maxFrames = +arg("maxframes", 0);
let base = arg("base", "http://127.0.0.1:4173");
const out = path.join(root, "renders", name), frames = path.join(out, "frames");
const DT = 1 / 60;

/** Headless pass: how many frames until the round ends (+tail), and the audio log. */
async function probe() {
  const b = await launch();
  const page = await openGame(b, `${base}/?${query}`, { width: 640, height: 360 });
  const r = await page.evaluate(({ secs, tail }) => {
    const g = window.game; let endAt = -1, n = 0;
    for (let i = 0; i < Math.round(secs * 60); i++) {
      g.step(1 / 60, false); n = i + 1;
      if ((g.state === "won" || g.state === "lost") && endAt < 0) endAt = i;
      if (endAt >= 0 && i - endAt >= tail) break;
    }
    return { n, endAt, state: g.state, team: g.teamScore, hp: Math.round(g.p.hp), log: g.log };
  }, { secs, tail });
  await b.close();
  return r;
}

async function worker(from, to) {
  const b = await launch();
  const page = await openGame(b, `${base}/?${query}`, { width: W, height: H });
  await page.evaluate(() => { document.body.style.cursor = "none"; });
  let t0 = Date.now();
  // fast-forward without rendering
  await page.evaluate((from) => { for (let i = 0; i < from; i++) window.game.step(1 / 60, false); }, from);
  for (let i = from; i < to; i++) {
    await page.evaluate(() => window.game.step(1 / 60, true));
    await page.screenshot({ path: path.join(frames, String(i + 1).padStart(5, "0") + ".png"), type: "png" });
    if ((i - from) % 60 === 59) console.log(`[w ${from}] ${i + 1 - from}/${to - from} frames, ${((i + 1 - from) / ((Date.now() - t0) / 1000)).toFixed(2)} fps`);
  }
  await b.close();
}

async function renderAudio(total) {
  const b = await launch();
  const page = await openGame(b, `${base}/?${query}`, { width: 640, height: 360 });
  const res = await page.evaluate(async ({ total }) => {
    const g = window.game;
    for (let i = 0; i < total; i++) g.step(1 / 60, false);
    const log = g.audioLog.slice();
    try {
      const secs = total / 60 + 1.5;
      const [l, r] = await g.audio.renderLog(log, secs);
      const pcm = new Int16Array(l.length * 2);
      let peak = 0;
      for (let i = 0; i < l.length; i++) { peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i])); }
      const k = peak > 0.95 ? 0.95 / peak : 1;
      for (let i = 0; i < l.length; i++) { pcm[2 * i] = Math.max(-1, Math.min(1, l[i] * k)) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, r[i] * k)) * 32767; }
      const u8 = new Uint8Array(pcm.buffer); let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { log, pcm: btoa(s), peak };
    } catch (e) { return { log, err: String(e) }; }
  }, { total });
  await b.close();
  return res;
}

function wavFile(file, pcmB64, sr = 48000) {
  const pcm = Buffer.from(pcmB64, "base64"), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

/** Fallback when the in-page audio render is unavailable: mix public/sfx files at the logged times with ffmpeg. */
function ffmpegMix(log, mp4, outFile, dur) {
  const dir = path.join(root, "public", "sfx");
  const ev = log.filter((e) => fs.existsSync(path.join(dir, e.name + ".mp3")));
  const inputs = [], filt = [];
  ev.forEach((e, i) => {
    inputs.push("-i", path.join(dir, e.name + ".mp3"));
    const ms = Math.round(e.t * 1000), r = e.rate || 1;
    filt.push(`[${i + 1}:a]asetrate=${Math.round(44100 * r)},aresample=44100,atempo=${(1 / r).toFixed(4)},volume=${e.gain},adelay=${ms}|${ms}[a${i}]`);
  });
  const mix = ev.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${ev.length}:normalize=0,alimiter=limit=0.95[m]`;
  const args = ["-y", "-i", mp4, ...inputs, "-filter_complex", filt.join(";") + ";" + mix, "-map", "0:v", "-map", "[m]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(dur), outFile];
  return spawnSync("ffmpeg", args, { stdio: "inherit" });
}

let server = null;
if (flag("serve")) {
  server = spawn("npx", ["vite", "preview", "--port", "4173", "--host", "127.0.0.1", "--strictPort"], { cwd: root, stdio: "ignore" });
  base = "http://127.0.0.1:4173";
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); }
}

const only = arg("from", null) !== null;
let total, info;
if (only) { total = +arg("to"); }
else {
  info = await probe();
  total = maxFrames ? Math.min(maxFrames, info.n) : info.n;
  console.log(`[probe] ${total} frames (${(total / 60).toFixed(1)} s), end at ${(info.endAt / 60).toFixed(1)} s, ${info.state}, score blue ${info.team.blue} - pink ${info.team.pink}, hp ${info.hp}`);
  fs.rmSync(frames, { recursive: true, force: true });
}
fs.mkdirSync(frames, { recursive: true });
const t0 = Date.now();
if (only) await worker(+arg("from"), total);
else {
  // interleaved chunks of 120 frames so every worker covers the whole timeline evenly
  const chunk = Math.ceil(total / workers);
  await Promise.all(Array.from({ length: workers }, (_, k) => worker(k * chunk, Math.min(total, (k + 1) * chunk))));
  console.log(`[frames] done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!flag("skip-encode")) {
    const mp4 = path.join(out, name + ".mp4");
    spawnSync("ffmpeg", ["-y", "-framerate", "60", "-i", path.join(frames, "%05d.png"), "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "inherit" });
    const au = await renderAudio(total);
    fs.writeFileSync(path.join(out, "audio_log.json"), JSON.stringify(au.log));
    const sfx = path.join(out, name + "_sfx.mp4");
    if (au.pcm) {
      const wav = path.join(out, name + "_sfx.wav");
      wavFile(wav, au.pcm);
      spawnSync("ffmpeg", ["-y", "-i", mp4, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(total / 60), sfx], { stdio: "inherit" });
    } else { console.warn("[audio] in-page render failed:", au.err, "- falling back to ffmpeg mix"); ffmpegMix(au.log, mp4, sfx, total / 60); }
    console.log(`[done] ${mp4}\n       ${sfx}  (score blue ${info.team.blue} - pink ${info.team.pink})`);
  }
}
server?.kill();
