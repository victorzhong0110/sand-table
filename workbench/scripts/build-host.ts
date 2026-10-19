import { build } from "vite";
await build({
  configFile: false,
  logLevel: "error",
  build: {
    emptyOutDir: false,
    lib: {
      entry: "local/client.ts",
      formats: ["iife"],
      name: "SandTableHost",
      fileName: () => "host.js",
    },
    outDir: "dist",
  },
});
