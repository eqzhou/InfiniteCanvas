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
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "openboard-storage-mode-marker",
      transformIndexHtml(html) {
        return html.replace(
          "<head>",
          `<head>\n    <meta name="openboard-storage-mode" content="database" />`,
        );
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_RELEASES__: JSON.stringify(appReleases),
  },
  build: {
    outDir: process.env.OPENBOARD_WEB_OUT_DIR || "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/") || id.includes("node_modules/scheduler")) {
            return "react";
          }
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules/lucide-react")) return "icons";
          if (
            id.includes("node_modules/react-markdown") ||
            id.includes("node_modules/remark-gfm") ||
            id.includes("node_modules/mdast") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/unified") ||
            id.includes("node_modules/hast") ||
            id.includes("node_modules/unist")
          ) {
            return "markdown";
          }
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-router", "zustand"],
  },
  server: {
    port: 5173,
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/pages/HomePage.tsx",
        "./src/components/canvas/BoardCanvas.tsx",
      ],
    },
    proxy: {
      "/api": apiProxy,
    },
  },
  preview: {
    port: 5173,
    proxy: { "/api": apiProxy },
  },
});
