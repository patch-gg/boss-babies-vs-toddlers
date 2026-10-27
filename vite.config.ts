import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    // Three.js alone is ~500 kB minified (~130 kB gzipped); don't warn about it.
    chunkSizeWarningLimit: 800,
  },
});
