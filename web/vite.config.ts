import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

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
