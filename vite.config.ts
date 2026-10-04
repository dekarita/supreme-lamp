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
    "import.meta.env.VITE_BUILD_SHA": JSON.stringify(
      process.env.GITHUB_SHA?.slice(0, 7) || "dev"
    ),
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
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
    include: ["src/tests/smoke/**/*.test.ts", "src/tests/smoke/**/*.test.tsx"],
    css: false,
  },
});
