// 打包清单要盖住运行期真正用到的目录。
//
// 背景：desktop/scripts/prepare-assets.mjs 按一份手写的目录清单把工作台
// 拷进 .stage/workbench，electron-builder 再把它整体搬进 resources/workbench。
// 这份清单和代码里的 import 是两处独立的东西，少拷一个目录，
// 打包出来的桌面版起不来本地工作台，而且报错只在子进程的 stderr 里，
// 冒烟脚本看不到（桌面主进程的日志在 Windows 上没有控制台，落不到 stdout）。
//
// 2026-10-24 实测：kernel v3 的工具面（PR #76）让 server/main.ts 与
// local/bridge.ts 开始 import server/v3/server.ts，而它 import packs/index.ts；
// 清单里没有 packs/，于是便携冒烟从「窗口停在加载页」开始红，
// 一直红到今天。
//
// 做法：按相对 import 把运行期入口的文件闭包算出来，
// 再核对这份闭包涉及的每个顶层目录都在清单里。
// 清单改了就重新算一次——不用等人去踩。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const workbench = path.join(repoRoot, "workbench");

/** 桌面版真正会起的几个入口。 */
const RUNTIME_ENTRIES = [
  "local/main.ts", // 桌面主进程起的本地工作台
  "local/bridge.ts", // MCP 桥接
  "server/main.ts", // v2 的 MCP server 入口
  "server/v3/server.ts", // v3 的 MCP server 入口
];

/**
 * 从 prepare-assets.mjs 里把清单读出来。
 *
 * 读源码而不是 import 那个脚本：import 它就会真的去跑 npm ci。
 * 读不到就大声失败——宁可红，也不要悄悄放过。
 */
function readLayout() {
  const source = readFileSync(
    path.join(desktopRoot, "scripts", "prepare-assets.mjs"),
    "utf8",
  );
  const read = (name) => {
    const match = source.match(
      new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`),
    );
    assert.ok(match, `prepare-assets.mjs 里找不到 ${name} 这份清单`);
    const items = [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(items.length > 0, `${name} 解析出来是空的`);
    return items;
  };
  return { dirs: read("runtimeDirs"), files: read("runtimeFiles") };
}

/** 相对 import 指向的文件：补上可能的扩展名。 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];
  return candidates.find((c) => existsSync(c) && !c.endsWith(path.sep));
}

/** 运行期入口的相对 import 闭包（只跟工作台内部的相对 import）。 */
function runtimeClosure() {
  const importPattern =
    /(?:from|import|import\()\s*["'](\.[^"']+)["']/g;
  const seen = new Set();
  const unresolved = [];
  const stack = RUNTIME_ENTRIES.slice();
  while (stack.length) {
    const relative = stack.pop();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const file = path.join(workbench, relative);
    if (!existsSync(file)) {
      unresolved.push(relative);
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const target = resolveRelative(file, match[1]);
      if (!target) {
        unresolved.push(`${relative} -> ${match[1]}`);
        continue;
      }
      stack.push(path.relative(workbench, target));
    }
  }
  return { files: seen, unresolved };
}

test("打包清单盖住了运行期 import 到的每个目录", () => {
  const layout = readLayout();
  const { files, unresolved } = runtimeClosure();

  assert.deepEqual(
    unresolved,
    [],
    "运行期入口里有解析不了的 import（清单外的路径？）",
  );
  assert.ok(
    files.size > 20,
    `运行期闭包只算出 ${files.size} 个文件，正则多半没匹配上`,
  );

  const dirs = new Set();
  for (const relative of files) {
    const top = relative.split(path.sep)[0];
    if (relative.includes(path.sep)) dirs.add(top);
  }

  const missing = [...dirs].filter((dir) => !layout.dirs.includes(dir));
  assert.deepEqual(
    missing,
    [],
    `这些目录运行期会 import 到，但打包清单里没有：${missing.join(", ")}`,
  );
});

test("v3 的工具面要能进包（packs/ 是内核的领域包）", () => {
  const layout = readLayout();
  assert.ok(
    layout.dirs.includes("packs"),
    "server/v3/server.ts import 了 packs/index.ts，清单里必须带上 packs/",
  );
  const { files } = runtimeClosure();
  assert.ok(
    files.has(path.join("packs", "index.ts")),
    "运行期闭包里没有 packs/index.ts，核对用的入口可能变了",
  );
});

test("运行期用到的包都得在 dependencies 里（打包时 --omit=dev）", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(workbench, "package.json"), "utf8"),
  );
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
  const importPattern = /(?:from|import|import\()\s*["']([^"']+)["']/g;

  const used = new Set();
  for (const relative of runtimeClosure().files) {
    const file = path.join(workbench, relative);
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(importPattern)) {
      const spec = match[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      used.add(name);
    }
  }

  assert.ok(used.size > 0, "一个包都没解析出来，正则多半没匹配上");
  const dropped = [...used].filter(
    (name) => !dependencies.has(name) && devDependencies.has(name),
  );
  assert.deepEqual(
    dropped,
    [],
    `这些包运行期要 import，但只在 devDependencies 里：${dropped.join(", ")}（--omit=dev 会把它们从包里去掉）`,
  );
});
