import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// This checkout builds to dist/. Point RESEARCHOS_STATIC_DIR at
// llm-research-os/src/llm_research_os/web/static when that control plane
// should serve this bundle. The local API only accepts its own loopback
// origin, so the page is opened from `researchos web serve`, not from Vite.
// tsconfig sets `"types": []`, so Node's `process` is read without @types/node.
const outDir = staticOutDir();

function staticOutDir(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const configured = env?.RESEARCHOS_STATIC_DIR;
  return configured !== undefined && configured !== "" ? configured : "dist";
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    // A single bundle keeps the wheel small and the server's asset map trivial.
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
