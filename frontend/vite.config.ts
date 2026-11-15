/// <reference types="vitest/config" />
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ── Pages ──
// One HTML entry per ported page. Each builds to the same URL the legacy page
// had (/settings.html), so nav links and bookmarks keep working while pages move
// over one at a time. Unported pages are still served from src/geotagger/web/.
const PAGES = ["settings"];

const BACKEND = `http://127.0.0.1:${process.env.GEOTAGGER_PORT ?? "8000"}`;

// In dev, Vite serves the ported pages and its own modules; everything else
// (the API, legacy pages, their scripts and CSS, thumbnails) goes to the FastAPI
// server. A regex key with a negative lookahead does that routing.
const VITE_OWNED = ["@", "src/", "node_modules/", ...PAGES.map((p) => `${p}\\.html(?:[?#]|$)`)];
const PROXY_ALL_ELSE = `^/(?!${VITE_OWNED.join("|")}).*`;

export default defineConfig({
  plugins: [react()],
  build: {
    // Inside the Python package so the wheel ships it; gitignored, built by `npm run build`.
    outDir: resolve(import.meta.dirname, "../src/geotagger/web_dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [PROXY_ALL_ELSE]: {
        target: BACKEND,
        changeOrigin: true,
        // RequestGuard rejects writes whose Origin doesn't match Host. The browser
        // sends Origin: http://localhost:5173, while changeOrigin points Host at the
        // backend, so align Origin with it. Dev-only: the dev server binds loopback.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", BACKEND);
          });
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
