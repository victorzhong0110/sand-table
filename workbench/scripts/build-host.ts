import { build } from "vite";
import { build as bundle } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { COMPONENT_RESOURCES } from "../core/component-resources.ts";
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

const sizes: Record<string, { bytes: number; gzip: number }> = {};
async function checkSize(file: string, bytes: number, gzip: number) {
  const contents = await readFile(file);
  const compressed = gzipSync(contents).length;
  sizes[file] = { bytes: contents.length, gzip: compressed };
  if (contents.length > bytes || compressed > gzip)
    throw Error(
      `组件体积超限：${file} → ${contents.length} 字节，gzip ${compressed} 字节。`,
    );
}

await checkSize("dist/board.html", 1_100_000, 320_000);
for (const [name, entry] of Object.entries(COMPONENT_RESOURCES)) {
  const outfile = `dist/chunks/${entry.file}`;
  await bundle({
    entryPoints: [`scripts/entries/${name}.js`],
    outfile,
    platform: "browser",
    bundle: true,
    format: "iife",
    minify: true,
    logLevel: "error",
  });
  await checkSize(outfile, 1_600_000, 450_000);
}
await writeFile(
  "dist/component-sizes.json",
  JSON.stringify(sizes, null, 2) + "\n",
);
