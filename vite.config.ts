import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3210",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (req, incoming) => {
            if (incoming.headers.origin === "http://127.0.0.1:5173")
              req.setHeader("Origin", "http://127.0.0.1:3210");
          });
        },
      },
    },
  },
});
