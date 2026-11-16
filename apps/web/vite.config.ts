import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

const apiOrigin = process.env.OTTERTRAIL_API_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // The API serves these on the instance's own origin; the dev server forwards them.
    proxy: {
      "/api": apiOrigin,
      "/t.js": apiOrigin,
    },
  },
  test: {
    environment: "node",
  },
});
