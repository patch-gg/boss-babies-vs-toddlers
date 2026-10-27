// Frame-stepped capture sharded over Modal GPU jobs (timmy gpu run).  Two commands:
//
//   node tools/modal_capture.mjs launch   --name nursery_16x9 --w 1920 --h 1080 --secs 45 [--map nursery] [--query "..."] [--shard 120] [--mode swift|gpu2|egl] [--gpu L4]
//   node tools/modal_capture.mjs assemble --name nursery_16x9
//
// launch: builds dist/ (unless --nobuild), zips it, and starts one detached job per shard of --shard frames
//         (job ids are written to renders/<name>/jobs.json and printed).
// assemble: waits for every shard (timmy gpu wait), concatenates the shard mp4s, renders the audio log locally
//         (stepping without screenshots is fast), muxes <name>_sfx.mp4 and writes <name>_contact.png (1 fps sheet).
// Query defaults to "demo=1&cap=1&step=1&seed=7[&map=<map>]"; add e.g. "&team=blue" through --query once the team param exists.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, openGame } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf("--" + k); return i >= 0 ? rest[i + 1] : d; };
const flag = (k) => rest.includes("--" + k);
const name = arg("name", "capture");
const W = +arg("w", 1920), H = +arg("h", 1080), secs = +arg("secs", 45);
const map = arg("map", "nursery");
const query = arg("query", `demo=1&cap=1&step=1&seed=7${map !== "nursery" ? "&map=" + map : ""}`);
const out = path.join(root, "renders", name);
const jobsFile = path.join(out, "jobs.json");
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", ...o });
fs.mkdirSync(out, { recursive: true });

async function launchJobs() {
  const total = Math.round(arg("frames", secs * 60));
  const shard = +arg("shard", 120);
  const mode = arg("mode", "swift"), gpu = arg("gpu", "L4");
  if (!flag("nobuild")) { const r = sh("npm", ["run", "build"], { cwd: root, stdio: "inherit" }); if (r.status) process.exit(1); }
  const zip = path.join(out, "dist.zip");
  fs.rmSync(zip, { force: true });
  const z = sh("python3", ["-c", `import shutil;shutil.make_archive(r"${zip.replace(/\.zip$/, "")}","zip",r"${root}","dist")`]);
  if (z.status) { console.error(z.stderr); process.exit(1); }
  const jobs = [];
  const starts = [];
  for (let s = 0; s < total; s += shard) starts.push(s);
  // a few concurrent submissions at a time (each submit call returns after ~1-2 min)
  const par = +arg("par", 6);
  let next = 0;
  async function lane() {
    while (next < starts.length) {
      const s = starts[next++], e = Math.min(total, s + shard), idx = jobs.length;
      const stills = arg("stills", "");
      const args = ["gpu", "run", path.join(root, "tools/gpu/shard.py"), "--gpu", gpu, "--timeout", arg("timeout", "25m"), "--pip", "playwright==1.64.1", "-i", zip, "--detach", "--json", "--",
        "--mode", mode, "--start", String(s), "--end", String(e), "--w", String(W), "--h", String(H), "--query", query, "--name", `${name}_${String(s).padStart(5, "0")}`];
      if (stills) args.push("--stills", stills);
      const text = await new Promise((res) => { let o = ""; const p = spawn("timmy", args); p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("close", () => res(o)); });
      const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (!m) { console.error(`shard ${s}: no job id in output:\n${text.slice(-400)}`); jobs.push({ start: s, end: e, id: null }); }
      else { jobs.push({ start: s, end: e, id: m[0] }); console.log(`shard ${s}-${e}: ${m[0]}`); }
      fs.writeFileSync(jobsFile, JSON.stringify({ name, W, H, total, query, jobs: jobs.sort((a, b) => a.start - b.start) }, null, 1));
    }
  }
  await Promise.all(Array.from({ length: Math.min(par, starts.length) }, lane));
  console.log(`${jobs.length} shard jobs launched (${total} frames, ${W}x${H}); ids in ${jobsFile}\nnext: node tools/modal_capture.mjs assemble --name ${name}`);
}

async function renderAudio(total) {
  const b = await launch();
  const page = await openGame(b, `http://127.0.0.1:4173/?${query}`, { width: 640, height: 360 });
  const res = await page.evaluate(async ({ total }) => {
    const g = window.game;
    for (let i = 0; i < total; i++) g.step(1 / 60, false);
    const log = g.audioLog.slice();
    const [l, r] = await g.audio.renderLog(log, total / 60 + 1.5);
    const pcm = new Int16Array(l.length * 2);
    let peak = 0;
    for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    const k = peak > 0.95 ? 0.95 / peak : 1;
    for (let i = 0; i < l.length; i++) { pcm[2 * i] = Math.max(-1, Math.min(1, l[i] * k)) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, r[i] * k)) * 32767; }
    const u8 = new Uint8Array(pcm.buffer); let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { log, pcm: btoa(s), team: g.teamScore };
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

async function assemble() {
  const J = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
  const dl = path.join(out, "shards");
  fs.mkdirSync(dl, { recursive: true });
  // wait for every shard (each wait call is bounded; loop until done)
  for (const j of J.jobs) {
    if (!j.id) throw new Error(`shard ${j.start} has no job id; relaunch it`);
    const seg = path.join(dl, `${j.id}`);
    for (let tries = 0; tries < 60 && !fs.existsSync(path.join(seg, `${J.name}_${String(j.start).padStart(5, "0")}.mp4`)); tries++) {
      const r = sh("timmy", ["gpu", "wait", j.id, "--out", seg], { cwd: root });
      if (/failed|error/i.test(r.stdout + r.stderr) && !/still running/i.test(r.stdout + r.stderr)) console.error(`shard ${j.start}: ${(r.stdout + r.stderr).slice(-300)}`);
    }
  }
  const list = path.join(out, "concat.txt");
  fs.writeFileSync(list, J.jobs.map((j) => `file '${path.join(dl, j.id, `${J.name}_${String(j.start).padStart(5, "0")}.mp4`)}'`).join("\n"));
  const mp4 = path.join(out, name + ".mp4");
  let r = sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", mp4]);
  if (r.status) throw new Error(r.stderr);
  const base = "http://127.0.0.1:4173";
  try { await fetch(base); } catch { spawn("npx", ["vite", "preview", "--port", "4173", "--host", "127.0.0.1", "--strictPort"], { cwd: root, stdio: "ignore", detached: true }); for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 200)); } }
  const au = await renderAudio(J.total);
  fs.writeFileSync(path.join(out, "audio_log.json"), JSON.stringify(au.log));
  const wav = path.join(out, name + "_sfx.wav");
  wavFile(wav, au.pcm);
  const sfx = path.join(out, name + "_sfx.mp4");
  r = sh("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(J.total / 60), sfx]);
  if (r.status) throw new Error(r.stderr);
  const sheetW = W > H ? 480 : 270;
  const cols = W > H ? 5 : 8, rows = Math.ceil(J.total / 60 / cols);
  const sheet = path.join(out, name + "_contact.png");
  r = sh("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf", `fps=1,scale=${sheetW}:-1,tile=${cols}x${rows}`, "-frames:v", "1", sheet]);
  if (r.status) throw new Error(r.stderr);
  console.log(`done\n  ${sfx}\n  ${sheet}\n  audio events: ${au.log.length}, score blue ${au.team.blue} - pink ${au.team.pink}`);
}

if (cmd === "launch") await launchJobs();
else if (cmd === "assemble") await assemble();
else console.log("usage: node tools/modal_capture.mjs launch|assemble --name N [--w --h --secs --map --query --shard --mode --gpu --frames --stills]");
