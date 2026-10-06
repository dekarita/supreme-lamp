import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

// [F41 §1] Build integration: the dashboard ships as a SINGLE-FILE build
// (all JS/CSS inlined into ui/dist/index.html). Rationale: payloads/ghrdp-server.ps1
// serves the app behind the dash-token gate at /v2; one file = one gated route,
// tailnet-offline safe, and identical to the F38 ui.html deployment model.
// Fonts are INLINED as data URIs (assetsInlineLimit) - v1 parity: the single
// html file is tailnet-offline complete; no server font route is involved.
const buildSha = process.env.VITE_BUILD_SHA || "dev";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    viteSingleFile({ removeViteModuleLoader: true }),
    {
      // index.html carries the F38 regression id "ghrdpBuild" meta; stamp it.
      name: "ghrdp-build-stamp",
      transformIndexHtml(html: string) {
        return html.replace(/__BUILD_SHA__/g, buildSha);
      },
    },
  ],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    // [F77 §2.4] the footer badge's 7-char stamp. build-ui.yml exports
    // VITE_BUILD_SHA=$GITHUB_SHA (and main.yml's fallback build does the same);
    // reading GITHUB_SHA directly keeps a plain `GITHUB_SHA=… vite build` honest.
    // Missing -> "dev", so an un-stamped bundle is visible as such, not silent.
    "import.meta.env.VITE_BUILD_SHA": JSON.stringify(
      (process.env.VITE_BUILD_SHA || process.env.GITHUB_SHA || "dev").slice(0, 7)
    ),
    // [F92 §6.1] the FULL sha for /api/f92-selftest?frontendSha= - the server
    // compares full shas, a 7-char prefix would collide across force-pushes.
    "import.meta.env.VITE_GIT_SHA": JSON.stringify(
      process.env.VITE_BUILD_SHA || process.env.GITHUB_SHA || "dev"
    ),
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  // [F79] Arena HTTPS previews use relative API URLs; proxy to the mock API
  // on the server, never to localhost in the user's browser.
  server: {
    host: "0.0.0.0",
    allowedHosts: [".e2b.app"],
    proxy: {
      "/api": "http://127.0.0.1:7331",
      "/diag": "http://127.0.0.1:7331",
    },
  },
  preview: { host: "0.0.0.0", allowedHosts: [".e2b.app"] },
  build: {
    outDir: "ui/dist",
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/tests/smoke/**/*.test.ts", "src/tests/smoke/**/*.test.tsx", "tests/f79-*.test.ts", "tests/f79-*.test.tsx", "tests/f84-*.test.ts", "tests/f84-*.test.tsx", "tests/f87-*.test.ts", "tests/f87-*.test.tsx", "tests/f99-*.test.ts", "tests/f99-*.test.tsx"],
    css: false,
  },
});
