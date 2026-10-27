// Screenshot specific sim times: node tools/shots.mjs <outdir> <w> <h> "<query>" t1,t2,... 
import { launch, openGame } from "./lib.mjs";
import fs from "node:fs";
const [out, w, h, query, times] = process.argv.slice(2);
const base = process.env.BASE || "http://127.0.0.1:4173";
fs.mkdirSync(out, { recursive: true });
const b = await launch();
const page = await openGame(b, `${base}/?${query}`, { width: +w, height: +h });
await page.evaluate(() => { document.body.style.cursor = "none"; });
let cur = 0;
for (const t of times.split(",").map(Number)) {
  const target = Math.round(t * 60);
  await page.evaluate(({ n }) => { for (let i = 0; i < n - 1; i++) window.game.step(1 / 60, false); window.game.step(1 / 60, true); }, { n: target - cur });
  cur = target;
  await page.screenshot({ path: `${out}/t${t.toFixed(2)}.png` });
}
console.log(JSON.stringify(await page.evaluate(() => ({ t: window.game.time, team: window.game.teamScore }))));
await b.close();
