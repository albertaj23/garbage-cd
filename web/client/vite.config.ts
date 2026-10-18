/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const controller = "http://127.0.0.1:4177";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: controller,
        changeOrigin: true,
        configure: (proxy) => {
          // The controller only accepts same-origin requests; the dev server is a different origin.
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        }
      }
    }
  },
  build: { outDir: "dist", sourcemap: true },
  test: { environment: "jsdom", globals: false, include: ["test/**/*.test.tsx", "test/**/*.test.ts"] }
});
