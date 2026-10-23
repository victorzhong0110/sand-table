// 打包前整理工作台：把运行期需要的源码、前端产物与依赖放进 .stage/workbench。
// electron-builder 把它整体搬进 resources/workbench，桌面版从那里启动本地工作台。

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const workbench = join(repoRoot, "workbench");
const stage = join(desktopRoot, ".stage", "workbench");

// 运行期需要的目录。board/ 是前端源码，已经构建进 dist/，留一份便于排查。
const runtimeDirs = [
  "board",
  "connectors",
  "core",
  "domains",
  "dsh-plugin",
  "kernel",
  "local",
  "server",
  "dist",
];
const runtimeFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(workbench)) fail(`找不到工作台目录：${workbench}`);
for (const file of ["dist/board.html", "dist/host.js"]) {
  if (!existsSync(join(workbench, file)))
    fail(
      `工作台还没构建：缺少 ${file}。请先在 workbench/ 目录执行 npm run build。`,
    );
}

rmSync(join(desktopRoot, ".stage"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const dir of runtimeDirs)
  cpSync(join(workbench, dir), join(stage, dir), { recursive: true });
for (const file of runtimeFiles) {
  const from = join(workbench, file);
  if (existsSync(from)) cpSync(from, join(stage, file));
}

// 只装运行期依赖：TypeScript 是 domains/code/indexer.ts 的运行期依赖，
// 因此它留在 dependencies 里，--omit=dev 不会漏掉它。
// --omit=optional 去掉平台相关的原生包（pdfjs-dist 的 canvas 后端只用于
// 把页面渲染成图，这里只取文本与指纹，用不上；交叉打包时它们还是错平台的）。
console.log("正在安装工作台的运行期依赖…");
const install = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  [
    "ci",
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ],
  { cwd: stage, stdio: "inherit", shell: process.platform === "win32" },
);
if (install.status !== 0) fail("工作台运行期依赖安装失败。");

// pdfjs-dist 里大部分体积是 sourcemap 和工作台根本没引用的现代版构建。
// connectors/pdf.ts 只用 legacy/build/pdf.mjs，worker 也在同一个目录里，
// 所以 build/、types/、web/ 与全部 .map 都可以去掉。
const pdfjs = join(stage, "node_modules", "pdfjs-dist");
if (existsSync(pdfjs)) {
  for (const dir of ["build", "types", "web"])
    rmSync(join(pdfjs, dir), { recursive: true, force: true });
  for (const file of readdirSync(pdfjs, { recursive: true })) {
    if (file.endsWith(".map")) rmSync(join(pdfjs, file), { force: true });
  }
}

// 记录这次整理的内容，便于核对产物。
const manifest = {
  builtFrom: workbench,
  dirs: runtimeDirs,
  files: runtimeFiles,
  dependencies: Object.keys(
    JSON.parse(readFileSync(join(stage, "package.json"), "utf8"))
      .dependencies ?? {},
  ),
};
writeFileSync(
  join(desktopRoot, ".stage", "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`工作台已整理到 ${stage}`);
