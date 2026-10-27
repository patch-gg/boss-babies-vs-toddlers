import "./style.css";
import { Game } from "./game";
import { loadToddlerModels } from "./characters";
import type { MapId } from "./world";

const q = new URLSearchParams(location.search);
const seedParam = q.get("seed");
const demo = q.get("demo") === "1" || q.get("demo") === "true";
const map: MapId = q.get("map") === "nursery" ? "nursery" : "backyard";
const cap = q.get("cap") === "1";
const team = q.get("team") === "toddlers" ? "toddlers" : "boss";
const step = cap && q.get("step") === "1";
const seed = seedParam !== null ? parseInt(seedParam, 10) || 1 : (Math.random() * 1e9) | 0;

async function boot() {
  try { await loadToddlerModels(); } catch { /* procedural fallback */ }
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const game = new Game(canvas, { seed, demo, map, team, fps: q.has("fps"), fixed: seedParam !== null, cap, step });
  if (q.has("touch")) document.body.classList.add("force-touch");
  (window as unknown as { game: Game }).game = game;
}
boot();
