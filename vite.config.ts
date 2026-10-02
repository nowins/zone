import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

const releaseLinks: Record<string, string> = {};
for (const key of ["website", "support", "privacy", "download"]) {
  const value = process.env[`VITE_ZONE_${key.toUpperCase()}_URL`];
  if (!value) continue;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw Error(`发布链接必须使用 HTTPS：${key}`);
  releaseLinks[key] = url.href;
}
let buildId = "local";
try { buildId = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* Source archives may not contain Git metadata. */ }

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __ZONE_BUILD_ID__: JSON.stringify(buildId), __ZONE_RELEASE_LINKS__: JSON.stringify(releaseLinks) },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    // Tauri owns Rust watching. Native linker outputs may be locked on Windows.
    watch: { ignored: ["**/src-tauri/**", "**/.tmp/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
