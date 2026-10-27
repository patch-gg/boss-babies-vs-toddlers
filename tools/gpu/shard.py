import argparse, os, sys, subprocess, time, zipfile, json, shutil, glob
ap = argparse.ArgumentParser()
ap.add_argument("--w", type=int, default=1920); ap.add_argument("--h", type=int, default=1080)
ap.add_argument("--query", default="demo=1&cap=1&step=1&seed=7")
ap.add_argument("--start", type=int, default=0); ap.add_argument("--end", type=int, default=120)
ap.add_argument("--mode", default="probe")   # probe | gpu | egl | swift
ap.add_argument("--name", default="shard")
ap.add_argument("--noserve", action="store_true")
ap.add_argument("--stills", default="")      # comma separated absolute frame indexes to also save as png
a = ap.parse_args()
INP = os.environ.get("TIMMY_INPUTS", "."); OUT = os.environ.get("TIMMY_OUT", "out"); os.makedirs(OUT, exist_ok=True)
def sh(cmd, **k):
    print("$", cmd, flush=True); return subprocess.run(cmd, shell=True, **k)
t0 = time.time()
if not a.noserve: sh("nvidia-smi -L; ls /usr/share/vulkan/icd.d /etc/vulkan/icd.d 2>&1 | head; nproc; free -g | head -2")
r = None if a.noserve else sh(f"python -m playwright install --with-deps chromium > {OUT}/install.log 2>&1; tail -3 {OUT}/install.log")
print("install s", round(time.time() - t0), flush=True)
if not a.noserve: zipfile.ZipFile(os.path.join(INP, "dist.zip")).extractall("site")
srv = None if a.noserve else subprocess.Popen([sys.executable, "-m", "http.server", "8000", "--directory", "site/dist", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5 if not a.noserve else 0)
from playwright.sync_api import sync_playwright
FLAGS = {
  "gpu": ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"],
  "gpu2": ["--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE", "--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--in-process-gpu", "--no-sandbox"],
  "gpu3": ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--in-process-gpu", "--no-sandbox"],
  "gpu4": ["--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE", "--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--no-sandbox", "--ozone-platform=headless"],
  "egl": ["--use-gl=egl", "--ignore-gpu-blocklist", "--enable-gpu", "--no-sandbox"],
  "swift": ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
}
COMMON = ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"]
def open_page(p, mode, w, h):
    print("launching", mode, flush=True)
    b = p.chromium.launch(channel="chromium", headless=True, args=FLAGS[mode] + COMMON)
    ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("[pageerror]", e, flush=True))
    print("goto", flush=True)
    page.goto(f"http://127.0.0.1:8000/?{a.query}")
    page.wait_for_function("window.game && window.game.state !== undefined", timeout=90000)
    page.evaluate("window.game.audio.ready()")
    page.evaluate("document.body.style.cursor='none'")
    return b, page
def renderer(page):
    return page.evaluate("""() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; }""")
def run_range(mode, start, end, w, h, mp4=None, log_every=60, stills=()):
    with sync_playwright() as p:
        b, page = open_page(p, mode, w, h)
        print("renderer:", renderer(page), flush=True)
        ts = time.time()
        page.evaluate("(n) => { for (let i = 0; i < n; i++) window.game.step(1/60, false); }", start)
        print("fast-forward s", round(time.time() - ts, 1), flush=True)
        ff = None
        if mp4:
            ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "60", "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p", "-g", "30", mp4], stdin=subprocess.PIPE)
        ts = time.time(); n = 0
        for i in range(start, end):
            page.evaluate("window.game.step(1/60, true)")
            png = page.screenshot(type="png")
            if ff: ff.stdin.write(png)
            if i in stills:
                os.makedirs(f"{OUT}/stills", exist_ok=True); open(f"{OUT}/stills/{i:05d}.png", "wb").write(png)
            n += 1
            if n % log_every == 0 or n <= 3: print(f"frame {i} n={n} {(time.time() - ts) / n * 1000:.0f} ms/frame avg", flush=True)
        if ff: ff.stdin.close(); ff.wait()
        b.close()
        return (time.time() - ts) / max(n, 1)
if a.mode == "probe":
    res = {}
    for m in ["gpu2", "gpu3", "gpu4"]:
        print("=== probe mode", m, flush=True)
        try:
            r = subprocess.run([sys.executable, __file__, "--mode", m, "--start", "600", "--end", "608", "--w", str(a.w), "--h", str(a.h), "--name", "probe_" + m, "--noserve"], timeout=100)
            res[m] = r.returncode
        except subprocess.TimeoutExpired:
            print("mode", m, "TIMED OUT", flush=True); res[m] = "timeout"
    print("PROBE RESULT", json.dumps(res), flush=True)
    json.dump(res, open(f"{OUT}/probe.json", "w"))
else:
    stills = {int(x) for x in a.stills.split(",") if x}
    s = run_range(a.mode, a.start, a.end, a.w, a.h, mp4=f"{OUT}/{a.name}.mp4", stills=stills)
    print("DONE s/frame", s, "total s", round(time.time() - t0), flush=True)
if srv: srv.terminate()
