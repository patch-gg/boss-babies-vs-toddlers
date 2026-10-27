# Babies vs Babies

A browser first-person shooter where you are a toddler in a giant playroom. Pick a side on the team-select screen: **Boss Babies** (little black suits, blue accent) or **Toddlers** (diapers, amber accent). You and two teammates wear your side's outfit; five opponents wear the other. Cartoon only: baby-food splats, crying, a big powder poof when someone goes down, a baby-rattle bonk, and funny toddler voice lines. Built with **Vite + TypeScript + Three.js**.

First team to **15 splats** (or the most after **90 s**) wins.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also on the LAN, for phones)
npm run build      # type-check + production build into dist/
npm run preview
```

## URL parameters

| Param | Effect |
|---|---|
| `?demo=1` | Autopilot plays a full round: ADS, a sniper kill, both killstreak call-ins, a round win. No input needed. |
| `?map=nursery` | Start on the Nursery map (default `backyard`). |
| `?team=boss` or `?team=toddlers` | Pre-select your side (default Boss Babies). With `demo=1` or `cap=1` the team and map menus are skipped. |
| `?seed=N` | Deterministic run (seeded RNG and a fixed 60 Hz simulation step). |
| `?fps` | Frame-rate counter. |
| `?touch` | Force the on-screen touch controls. |

`window.game` exposes `start(map?)`, `state` (`menu | playing | won | lost`), `score` (your splats), `teamScore`, `timeLeft`, `fastForward(seconds)` (simulate without rendering, handy for tests) and `paused`.

## Controls

| Input | Action |
|---|---|
| WASD / left stick | Move |
| Mouse / right stick / drag right side of the screen | Look (click the game to capture the pointer) |
| Left click / RT / FIRE button | Fire |
| Right click / LT / AIM button | Aim down sights (the sniper opens a full-screen scope) |
| Middle click / V / R3 / BONK button | Rattle bonk: a 0.45 s swing with a short lunge, one-hit splat on an enemy within 2.2 m in front |
| 1 / 2 / 3, mouse wheel, bumpers | Splat Blaster (auto), Pacifier Pistol (semi), Binky-Scope (sniper) |
| R | Reload |
| Space | Hop |
| Shift | Sprint |
| 4 | Diaper Drone (3 splats in a row): a flying diaper that homes in and goes pop |
| 5 | Bottle Strike (5 splats in a row): giant baby bottles rain down with explosions and powder puffs |
| Esc | Release the mouse / pause |

Menus: click or tap a card, `1` / `2` or arrows + Enter, or gamepad stick / D-pad + A (B = back).

Gamepad: sticks, triggers, A hop, R3 rattle, X reload, bumpers swap weapon, D-pad up = drone, D-pad right = strike, Start = confirm.

## Maps

Both maps are about 1.5x the original footprint with extra cover (the HUD minimap shows the layout).

- **Nursery**: wood floor, alphabet-block stacks, play mat, crib, toy box, slide, teddy bear, rainbow, sunlit windows.
- **Backyard**: two levels. A ~3 m raised deck with a playhouse, railings and cover blocks sits above a lower yard (sandbox, kiddie pool, swing set, toy vehicles, a wagon under the deck, hedges, flower pots, balls, picket fence). Two ramps (west side to the lawn, east side toward the pool) connect them; you walk up and can drop off the edges. Bots route through the ramps and fight across the levels. In `demo` / `cap` mode everything stays on the ground so the director script is unchanged.

Health: you have **150 HP** (bots 100). Opponents show a small billboard health bar (green to yellow to orange, outlined in their team colour) when damaged or within about 25 m; it is hidden in the sniper scope.

The world is scaled to a toddler: eye height is 0.9 m, everything else is huge.

## Models

Four rigged Meshy characters ship in `public/models/`: `baby_suit_blue.glb`, `baby_suit_pink.glb`, `baby_diaper_blue.glb`, `baby_diaper_pink.glb` (0.7 to 0.9 MB each, about 25k triangles, 1024 px webp texture, meshopt-compressed, clips `idle`, `walk`, `run`). `src/characters.ts` loads them with `GLTFLoader` + `MeshoptDecoder`, clones per bot with `SkeletonUtils.clone`, runs one `AnimationMixer` per bot and blends idle/walk/run by speed. The blaster is parented to the right-hand bone, the downed state (plop sit, wobble, tears, WAAH bubble), cry, poof and respawn are procedural on top of the rig, and the head sphere is the headshot hitbox. If a GLB fails to load the procedural toddler is used as a fallback. The first-person hand is a chubby baby hand coming out of a black suit sleeve with a white cuff.

Source models live in `gen/3d/<variant>/{rigged_character,walking,running}.glb`. The optimiser (gltf-transform: weld, simplify, resample, prune, dedup, webp 1024, meshopt) copies the walk and run clips onto the rigged document, drops normal/roughness textures and writes `public/models/baby_<variant>.glb`. Do not quantize POSITION on these skinned meshes (the rig is authored in cm bone space and the geometry is in metres); only NORMAL and TEXCOORD_0 are quantized. Model height comes from the geometry bounding box and is scaled to `TODDLER_HEIGHT` (1.15 m).

## Sound

All sounds have a WebAudio synth fallback, so the game is never silent. Real samples live in `public/sfx/<name>.mp3` and override the synth when present: `blaster_pop`, `splat_hit`, `sniper`, `poof`, `baby_cry`, `giggle`, announcer lines `vo_*`, and the toddler voices `baby_mama1-4`, `baby_scream_sfx`, `baby_peekaboo`, `baby_uhoh`, `baby_booboo`, `baby_giggle2`, `baby_nightnight`, `baby_myturn`, `baby_gimme`, `baby_nofair`, `baby_bottle`. Baby voice rules (`voice()` in `src/game.ts`): when you kill an opponent the victim's Mama/scream line always plays; teammate kills and deaths play a voice only 1 time in 3 (seeded fx RNG); hit reactions play only for hits you land, with a ~1.5 s cooldown; baby voices never overlap (a short queue drops low-priority lines). The rattle uses `public/sfx/rattle.mp3` (synth fallback built in). Gun SFX are unchanged, distance-spatialised, and every sound is written to `audioLog` so captures include it. The source pack is in `gen/sfx_pack/`. There is no in-game music.

## Capture tool (launch video renders)

`?cap=1` hides debug chrome and applies capture HUD layouts (landscape and portrait, with the top-left 200x200 px kept empty). `?step=1` stops the real-time loop so `window.game.step(dt, render)` advances the sim one frame at a time, which makes runs fully deterministic with `?seed=N`. With `?demo=1&cap=1` the autopilot also acts as a director (hook kill, strafing fight, one or two rattle bonks, scoped kill, Diaper Drone, Bottle Strike, close win, pink scoring about 10 to 12).

```bash
npm run build && npx vite preview --port 4173 &
node tools/capture.mjs --name nursery_16x9 --w 1920 --h 1080 --workers 3
node tools/capture.mjs --name nursery_9x16 --w 1080 --h 1920 --workers 3
node tools/capture.mjs --name backyard_16x9 --w 1920 --h 1080 --workers 3 --query "demo=1&cap=1&step=1&seed=7&map=backyard" --secs 15 --maxframes 900
node tools/shots.mjs /tmp/shots 1920 1080 "demo=1&cap=1&step=1&seed=7" 0.4,0.8,16.5   # stills at sim times
node tools/sim.mjs http://127.0.0.1:4173 "demo=1&cap=1&step=1&seed=7" 55              # headless event timeline
```

Local software GL is far too slow for 1080p in the workstation (10 to 25 s per frame), so full renders are sharded over Modal with `tools/modal_capture.mjs` (about 0.9 s per frame per L4 shard with SwiftShader, about $0.08 per 120-frame shard; real GPU WebGL does not start in the Modal sandbox):

```bash
node tools/modal_capture.mjs launch   --name nursery_16x9 --w 1920 --h 1080 --secs 48 --shard 120   # detached shard jobs, ids in renders/<name>/jobs.json
node tools/modal_capture.mjs assemble --name nursery_16x9   # waits, concatenates, renders audio locally, writes <name>_sfx.mp4 and <name>_contact.png
```

Workers re-simulate from t=0 and render interleaved frame ranges; the audio is rendered offline from `audioLog`. Output lands in `renders/<name>/` (`<name>.mp4`, `<name>_sfx.mp4`, `audio_log.json`).

## Layout

```
index.html          HUD, menu, pause and result overlays, touch controls
src/main.ts         URL params, boot
src/game.ts         game loop, player, bots (team deathmatch), projectiles, killstreaks, round logic
src/autopilot.ts    ?demo=1 player AI with eased aiming
src/world.ts        both maps, collision and raycasts
src/characters.ts   Boss Baby GLB loader/animation + procedural fallback toddler
src/weapons.ts      weapon stats and models
src/viewmodel.ts    first-person gun/hand rendering, recoil, sway, reload
src/fx.ts           splat textures, instanced particles, decals
src/hud.ts          COD-style HUD (minimap, feed, popups, hit markers, damage splats)
src/input.ts        keyboard/mouse, touch, gamepad
src/audio.ts        WebAudio synth + sample pack
```

## Notes

Slack thread: `slack:C0CCKNAPRCG:1793041276.864119`.

## Deploy

`timmy deploy preview` builds and uploads a preview deployment (`timmy deploy status` prints the URL). Production goes through `timmy deploy promote`, which needs a human approval.
