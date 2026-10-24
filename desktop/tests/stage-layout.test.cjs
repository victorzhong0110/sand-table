// 打包清单要盖住运行期真正用到的目录与依赖。
//
// 背景：desktop/scripts/prepare-assets.mjs 按一份手写的清单把工作台
// 拷进 .stage/workbench，electron-builder 再把它整体搬进 resources/workbench。
// 这份清单和代码里的 import 是两处独立的东西，少拷一个目录、
// 或者少装一个包，打包出来的桌面版就起不来本地工作台。
// 而且报错只在子进程的 stderr 里，冒烟脚本看不到
// （桌面主进程的日志在打包后的 Windows GUI 程序里没有控制台，落不到 stdout），
// 表现只是「窗口停在加载页」。
//
// 2026-10-24 实测：kernel v3 的工具面（PR #76）让 server/main.ts 与
// local/bridge.ts 开始 import server/v3/server.ts，而它 import packs/index.ts；
// 清单里没有 packs/，于是便携冒烟从「窗口停在加载页」开始红，一直红到今天。
//
// 做法：按相对 import 把运行期入口的文件闭包算出来，再核对这份闭包涉及的
// 每个顶层目录都在清单里、每个裸包都在 dependencies 里。
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

/**
 * 把文件里真正的 import / export-from 规格取出来。
 *
 * 不能用「哪里出现 from / import 就抓一处」的粗办法：源码里有
 * `className="pack-import"`、`operation, "human-import"` 这种把关键字
 * 藏在标识符里的字符串，还有注释里的 “... from "..."”。
 * 粗办法会把它们当成依赖名，把守护自己弄红。
 *
 * 做法：先去注释，再要求关键字出现在语句开头（行首或 ; { } ( 之后），
 * 最后还要看规格本身像不像一个包名。
 */
function importSpecifiers(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const patterns = [
    /(?:^|[;{}()\n])\s*import\s+(?:type\s+)?[\s\S]{0,400}?\bfrom\s*["']([^"'\n]+)["']/g,
    /(?:^|[;{}()\n])\s*import\s*["']([^"'\n]+)["']/g,
    /(?:^|[;{}()\n])\s*export\s+[\s\S]{0,400}?\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  const found = [];
  for (const pattern of patterns)
    for (const match of withoutComments.matchAll(pattern))
      found.push(match[1]);
  return found;
}

/** 像不像一个包名（而不是一段源码）。 */
function looksLikePackage(spec) {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(
    spec,
  );
}

/**
 * 从 import 规格取出包名。子路径也算同一个包：
 * `@modelcontextprotocol/ext-apps/server` 少了，本地工作台起不来；
 * `pdfjs-dist/legacy/build/pdf.mjs` 少了，打开 PDF 才会失败。
 * 这两段都对不上「整段就是包名」，不能因此跳过。
 */
function packageName(spec) {
  if (spec.startsWith(".") || spec.startsWith("node:")) return;
  const name = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  return looksLikePackage(name) ? name : undefined;
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
    for (const spec of importSpecifiers(source)) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelative(file, spec);
      if (!target) {
        unresolved.push(`${relative} -> ${spec}`);
        continue;
      }
      stack.push(path.relative(workbench, target));
    }
  }
  return { files: seen, unresolved };
}

/** 运行期闭包里用到的裸包（不是相对路径，也不是 node: 内置）。 */
function runtimePackages() {
  const used = new Set();
  for (const relative of runtimeClosure().files) {
    const file = path.join(workbench, relative);
    if (!existsSync(file)) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      const name = packageName(spec);
      if (name) used.add(name);
    }
  }
  return used;
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
    `运行期闭包只算出 ${files.size} 个文件，解析多半没匹配上`,
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

test("子路径 import 也要算到包名上", () => {
  const used = runtimePackages();
  const subpaths = [];
  for (const relative of runtimeClosure().files) {
    const file = path.join(workbench, relative);
    if (!existsSync(file)) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const nested = spec.startsWith("@")
        ? spec.split("/").length > 2
        : spec.includes("/");
      if (nested) subpaths.push(spec);
    }
  }
  assert.ok(
    subpaths.length > 0,
    "运行期没有子路径 import，这条守护没在守东西",
  );
  const missing = [];
  for (const spec of subpaths) {
    const name = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : spec.split("/")[0];
    if (!used.has(name)) missing.push(`${spec} → ${name}`);
  }
  assert.deepEqual(
    missing,
    [],
    `这些子路径 import 没有算进包名：${missing.join(", ")}`,
  );
});

test("运行期用到的包都得在 dependencies 里（打包时 --omit=dev）", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(workbench, "package.json"), "utf8"),
  );
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const used = runtimePackages();

  assert.ok(used.size > 0, "一个包都没解析出来，正则多半没匹配上");
  // 不在 dependencies 里的都要挡住：既包括只在 devDependencies 里的
  //（--omit=dev 会把它从包里去掉），也包括两个清单里都没有的
  //（那只是碰巧被某个传递依赖带进来，干净的 npm ci 不保证装它）。
  const missing = [...used].filter((name) => !dependencies.has(name));
  assert.deepEqual(
    missing,
    [],
    `这些包运行期要 import，但不在 dependencies 里：${missing.join(", ")}（打包时 npm ci --omit=dev 不保证装得上）`,
  );
});
