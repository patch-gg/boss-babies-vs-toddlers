// Shared helpers for the capture / sim tools: launch the Chrome that agent-browser ships with (software GL) via playwright-core.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.HOME || "/home/agent", ".agent-browser", "browsers");
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, d, "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // let playwright use its own download
}

export async function launch() {
  return chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"],
  });
}

export async function openGame(browser, url, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("[console]", m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.game && window.game.state !== undefined, null, { timeout: 60000 });
  await page.evaluate(() => window.game.audio.ready());
  return page;
}
