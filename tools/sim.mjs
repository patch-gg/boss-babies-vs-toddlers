// Headless (no-render) sim of a capture run: prints the event timeline. usage: node tools/sim.mjs [base] [query] [seconds]
import { launch, openGame } from "./lib.mjs";
const base = process.argv[2] || "http://localhost:5173";
const query = process.argv[3] || "demo=1&cap=1&step=1&seed=7";
const secs = +(process.argv[4] || 50);
const b = await launch();
const page = await openGame(b, `${base}/?${query}`, { width: 960, height: 540 });
const out = await page.evaluate((secs) => {
  const g = window.game;
  const frames = Math.round(secs * 60);
  let endAt = -1;
  for (let i = 0; i < frames; i++) {
    g.step(1 / 60, false);
    if (g.state === "won" || g.state === "lost") { if (endAt < 0) endAt = i; if (i - endAt > 120) break; }
  }
  return { log: g.log, t: g.time, state: g.state, team: g.teamScore, kills: g.p.kills, hp: g.p.hp, audio: g.audioLog.length };
}, secs);
for (const e of out.log) console.log(JSON.stringify(e));
console.log("RESULT", JSON.stringify({ state: out.state, team: out.team, kills: out.kills, t: +out.t.toFixed(1), audio: out.audio }));
await b.close();
