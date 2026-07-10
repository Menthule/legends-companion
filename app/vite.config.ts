import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// Tauri expects a fixed dev port; `tauri dev` sets TAURI_* env vars.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  base: "./",
  // Single source of truth for the displayed app version: injected from
  // package.json at build time so it can never drift from the real release
  // (package.json, Cargo.toml, and tauri.conf.json are bumped together).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: false,
  },
});
