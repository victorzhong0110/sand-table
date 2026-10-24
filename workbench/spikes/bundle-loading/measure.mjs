import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as esbuild } from "esbuild";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { execFileSync } from "node:child_process";
import {
  fileSize,
  helloPdf,
  packageMeta,
  readHelloPdf,
  repoRoot,
  spikeRoot,
  workbenchRoot,
} from "./lib.mjs";

function reactAlias() {
  const reactDir = join(workbenchRoot, "node_modules/react");
  const reactDomDir = join(workbenchRoot, "node_modules/react-dom");
  return [
    { find: /^react$/, replacement: reactDir },
    { find: /^react\/jsx-runtime$/, replacement: join(reactDir, "jsx-runtime") },
    {
      find: /^react\/jsx-dev-runtime$/,
      replacement: join(reactDir, "jsx-dev-runtime"),
    },
    { find: /^react-dom$/, replacement: reactDomDir },
    { find: /^react-dom\/client$/, replacement: join(reactDomDir, "client") },
  ];
}

function readText(path) {
  return readFileSync(path, "utf8");
}

async function bundleIife(entry, outfile) {
  await esbuild({
    absWorkingDir: workbenchRoot,
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    legalComments: "none",
    outfile,
    logLevel: "warning",
  });
  const code = readText(outfile);
  if (code.includes("import.meta")) {
    throw new Error(`${outfile} 仍含 import.meta，不能作为经典脚本注入`);
  }
  return fileSize(outfile);
}

async function buildPage(htmlName, outDir) {
  mkdirSync(outDir, { recursive: true });
  await build({
    root: workbenchRoot,
    configFile: false,
    plugins: [react(), viteSingleFile()],
    resolve: {
      alias: reactAlias(),
      dedupe: ["react", "react-dom"],
    },
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: join(spikeRoot, "entries", htmlName),
      },
    },
    logLevel: "warn",
  });
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) found.push(full);
    }
  };
  walk(outDir);
  if (found.length !== 1) throw new Error(`期望一份 html，实际 ${found.length}`);
  return found[0];
}

function runHostBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(workbenchRoot, "scripts/build-host.ts"),
      ],
      { cwd: workbenchRoot, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`build-host 退出 ${code}`));
    });
  });
}

export async function measure() {
  process.chdir(workbenchRoot);
  const pdfBytes = helloPdf();
  const nodePdf = await readHelloPdf(pdfBytes);
  if (nodePdf.pages !== 1 || !nodePdf.text.includes("Hello")) {
    throw new Error(`PDF 夹具读不到 Hello：${JSON.stringify(nodePdf)}`);
  }

  const dir = mkdtempSync(join(tmpdir(), "sand-t41-"));
  const workerPath = join(dir, "pdf-worker.js");
  const runnerPath = join(dir, "pdf-runner.js");
  const pdfWorker = await bundleIife(
    join(spikeRoot, "entries/pdf-worker-entry.js"),
    workerPath,
  );
  const pdfRunner = await bundleIife(
    join(spikeRoot, "entries/pdf-runner-entry.js"),
    runnerPath,
  );

  console.log("构建当前 board.html");
  await build({
    root: workbenchRoot,
    configFile: join(workbenchRoot, "vite.config.ts"),
    logLevel: "warn",
  });
  const current = fileSize(join(workbenchRoot, "dist/board.html"));
  if (readText(join(workbenchRoot, "dist/board.html")).includes("react-flow__node")) {
    throw new Error("当前 board.html 已含 React Flow，测量口径不再成立");
  }

  console.log("构建接入 React Flow 后的 board.html");
  const withFlowPath = await buildPage("with-flow.html", join(dir, "with-flow"));
  const withFlow = fileSize(withFlowPath);
  if (!readText(withFlowPath).includes("react-flow__node")) {
    throw new Error("接入构建没有留下 React Flow");
  }
  const flowOnly = fileSize(await buildPage("flow-only.html", join(dir, "flow-only")));
  const flowNamespace = fileSize(
    await buildPage("flow-namespace.html", join(dir, "flow-namespace")),
  );
  const reactShell = fileSize(
    await buildPage("react-shell.html", join(dir, "react-shell")),
  );
  if (withFlow.gzip - current.gzip > flowOnly.gzip) {
    throw new Error(
      `接入增量 gzip ${withFlow.gzip - current.gzip} 大于独立包 ${flowOnly.gzip}，react 可能打了两份`,
    );
  }

  console.log("构建 host.js");
  await runHostBuild();

  const workbenchPackage = JSON.parse(
    readText(join(workbenchRoot, "package.json")),
  );
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
    node: process.version,
    gzip: "node:zlib gzipSync 默认级别 6",
    versions: {
      react: packageMeta(join(workbenchRoot, "node_modules/react/package.json")),
      vite: packageMeta(join(workbenchRoot, "node_modules/vite/package.json")),
      vitePluginSinglefile: packageMeta(
        join(workbenchRoot, "node_modules/vite-plugin-singlefile/package.json"),
      ),
      xyflow: packageMeta(
        join(spikeRoot, "node_modules/@xyflow/react/package.json"),
      ),
      pdfjs: packageMeta(
        join(workbenchRoot, "node_modules/pdfjs-dist/package.json"),
      ),
      extApps: packageMeta(
        join(
          workbenchRoot,
          "node_modules/@modelcontextprotocol/ext-apps/package.json",
        ),
      ),
      esbuild: workbenchPackage.devDependencies.esbuild,
      playwright: workbenchPackage.devDependencies.playwright,
    },
    board: {
      current: { ...current, file: "workbench/dist/board.html" },
      withReactFlow: { ...withFlow, file: "with-flow.html" },
      delta: {
        raw: withFlow.raw - current.raw,
        gzip: withFlow.gzip - current.gzip,
      },
      note: "with-flow 是在当前白板入口上额外引用下列符号后，用同一套 vite-plugin-singlefile 打出的文件。T30 尚未进入 main，这不是那条分支的产物。",
    },
    isolated: {
      reactShell: { ...reactShell, file: "react-shell.html" },
      flowSurface: { ...flowOnly, file: "flow-only.html" },
      flowNamespace: { ...flowNamespace, file: "flow-namespace.html" },
      note: "这三份是单独入口，不是主包增量。它们摇掉的 React 代码不一样，不能相减。",
    },
    pdf: {
      publishedApi: fileSize(
        join(workbenchRoot, "node_modules/pdfjs-dist/build/pdf.min.mjs"),
      ),
      publishedWorker: fileSize(
        join(workbenchRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
      ),
      chunkApi: { ...pdfRunner, file: "pdf-runner.js" },
      chunkWorker: { ...pdfWorker, file: "pdf-worker.js" },
      nodeText: nodePdf.text,
    },
    imports: [
      "ReactFlow",
      "ReactFlowProvider",
      "Handle",
      "NodeResizer",
      "addEdge",
      "applyNodeChanges",
      "applyEdgeChanges",
      "useNodesState",
      "useEdgesState",
      "@xyflow/react/dist/style.css",
    ],
    artifacts: { workerPath, runnerPath, pdfB64: pdfBytes.toString("base64") },
  };
}
