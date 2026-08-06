import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwind from "@tailwindcss/vite";

// Build stamp: the daemon serves web/dist as-is, so a stale dist is invisible
// from the browser — it looks exactly like the source it predates. Baking the
// git commit in at build time (surfaced in the help modal) makes served-UI
// drift diagnosable at a glance instead of via a source dig.
const buildCommit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  plugins: [solid(), tailwind()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  server: {
    port: 5173,
    strictPort: true,
    // ZeroID's /oauth2/token doesn't emit CORS headers, so the browser
    // blocks cross-origin POSTs from :5173 → :8899. Proxying through
    // Vite makes the request same-origin from the browser's POV.
    //
    // Daemon WebSocket on :7400 is unaffected — WebSocket upgrades
    // bypass CORS preflight and we connect to it directly.
    proxy: {
      "/oauth2": {
        target:
          (process.env.VITE_ZEROID_URL as string | undefined) ??
          "http://localhost:8899",
        changeOrigin: true,
      },
      "/.well-known": {
        target:
          (process.env.VITE_ZEROID_URL as string | undefined) ??
          "http://localhost:8899",
        changeOrigin: true,
      },
      // ZeroID admin endpoints (e.g. /api/v1/agents/register) — same
      // CORS dodge as /oauth2. Production deploys should put auth in
      // front of these.
      "/api/v1": {
        target:
          (process.env.VITE_ZEROID_URL as string | undefined) ??
          "http://localhost:8899",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  optimizeDeps: {
    // micromark / unified pull in `debug`, which ships CJS with default
    // export semantics that need Vite's CJS-ESM bridge to be handled
    // correctly. Without this entry, the dev server fails with:
    //   SyntaxError: ... 'debug/src/browser.js' does not provide an
    //   export named 'default' (at create-tokenizer.js)
    // The production build via Rollup is fine without it; this only
    // affects `vite dev` pre-bundling.
    include: [
      // Vite's CJS-ESM interop needs an explicit hint for these — they
      // ship as CommonJS with default-export semantics that Vite's
      // pre-bundler doesn't auto-shim, leading to "does not provide an
      // export named 'default'" runtime errors.
      "debug",
      "extend",
      "bail",
      "ccount",
      "decode-named-character-reference",
      "is-plain-obj",
      "trough",
      "inline-style-parser",
      "property-information",
      "space-separated-tokens",
      "comma-separated-tokens",
      "remark-gfm",
      "remark-parse",
      "remark-rehype",
      "unified",
      "vfile",
      "vfile-message",
    ],
  },
  ssr: {
    // Defensive — in case any plugin spins up SSR-style transforms.
    noExternal: ["solid-markdown"],
  },
});
