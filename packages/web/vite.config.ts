import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: vite on :5173 proxies API/WS to the manifold server on :7777.
// Prod: `vite build` emits dist/, served directly by the manifold server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:7777", changeOrigin: false },
      "/ws": { target: "http://127.0.0.1:7777", changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
