import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { consoleBoundary } from "./build-boundary.mjs";

export default defineConfig({
  plugins: [react(), consoleBoundary()],
  resolve: { alias: { "@dsl": fileURLToPath(new URL("../../packages/dsl/src", import.meta.url)), "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist/library",
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    rollupOptions: { external: (name) => /^(?:react|react-dom)(?:\/|$)/.test(name) },
  },
});
