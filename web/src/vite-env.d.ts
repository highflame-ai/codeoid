/// <reference types="vite/client" />

/** Short git commit baked in at build time (vite `define` — see
 *  vite.config.ts). `typeof`-guard before use: plain vitest runs and other
 *  non-vite compiles don't substitute it. */
declare const __BUILD_COMMIT__: string;
