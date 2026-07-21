import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";
import { parseChangelog } from "./src/lib/release";

const root = path.resolve(__dirname, "..");
const appVersion = (() => {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || "v0.1.0";
  } catch {
    return "v0.1.0";
  }
})();
const appReleases = (() => {
  try {
    return parseChangelog(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  } catch {
    return [];
  }
})();

const apiProxy = {
  target: process.env.OPENBOARD_API_TARGET || "http://127.0.0.1:8790",
  changeOrigin: true,
  ws: true,
  headers: process.env.OPENBOARD_TOKEN
    ? { Authorization: `Bearer ${process.env.OPENBOARD_TOKEN}` }
    : undefined,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_RELEASES__: JSON.stringify(appReleases),
  },
  build: {
    outDir: process.env.OPENBOARD_WEB_OUT_DIR || "dist",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxy,
    },
  },
  preview: {
    port: 5173,
    proxy: { "/api": apiProxy },
  },
});
