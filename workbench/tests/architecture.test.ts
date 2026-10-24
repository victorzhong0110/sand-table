import ts from "typescript";
import { posix } from "node:path";
// 架构测试：把 v3 的目录边界和命名规则钉死，越界的改动在 CI 里直接失败。
//
// 规则出处：docs/kernel-v3/01-data-model.md §1（术语与禁用名词）、§9（V8），
// 以及 00-decisions.md K1（通用内核 + 包）。任务卡：docs/kernel-v3/tasks/T16-architecture-tests.md。
//
// 工具数量规则的出处：docs/kernel-v3/02-commands-and-tools.md §3.5，
// 任务卡：docs/kernel-v3/tasks/T20-tools-v3.md。
//
// 每条规则一个 test()，失败时列出违规的文件和行号。
// 检查函数只吃「文件列表」，所以既能扫真实仓库，也能用几段示例源码自检。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServerV3 } from "../server/server.ts";

/** workbench/ 目录：仓库里 v2 与 v3 并存的地方。 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

type SourceFile = {
  /** 相对 workbench/ 的路径，用 "/" 分隔。 */
  path: string;
  source: string;
};

type Violation = {
  file: string;
  line: number;
  message: string;
};

type Literal = { value: string; start: number; line: number };

type Scan = {
  /** 注释被空格替换后的源码：行数与原文一致，位置可换算。 */
  stripped: string;
  literals: Literal[];
};

/**
 * 扫一遍源码：抽出字符串字面量，并把注释替换成空格（保留换行，行号不变）。
 *
 * 字符串里的 "//" 不是注释（"https://…" 这类），所以要逐字符判断，
 * 不能直接用正则砍注释。
 */
function scan(source: string): Scan {
  const out: string[] = [];
  const literals: Literal[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let quote = "";
  while (i < n) {
    const c = source[i]!;
    if (quote) {
      if (c === "\\") {
        out.push(c, source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = "";
        out.push(c);
        i++;
        continue;
      }
      if (c === "\n") line++;
      out.push(c);
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      const startLine = line;
      let value = "";
      quote = c;
      out.push(c);
      i++;
      while (i < n) {
        const d = source[i]!;
        if (d === "\\") {
          value += source[i + 1] ?? "";
          out.push(d, source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (d === quote) {
          quote = "";
          out.push(d);
          i++;
          break;
        }
        if (d === "\n") line++;
        value += d;
        out.push(d);
        i++;
      }
      literals.push({ value, start, line: startLine });
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        if (source[i] === "\n") line++;
        i++;
      }
      out.push(" ", " ");
      i += 2;
      continue;
    }
    if (c === "\n") line++;
    out.push(c);
    i++;
  }
  return { stripped: out.join(""), literals };
}

/** 扫过的结果缓存起来：同一个文件被几条规则反复看。 */
const scans = new Map<SourceFile, Scan>();
function scanOf(file: SourceFile): Scan {
  let result = scans.get(file);
  if (!result) {
    result = scan(file.source);
    scans.set(file, result);
  }
  return result;
}

/** 位置换算成行号。 */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++)
    if (source[i] === "\n") line++;
  return line;
}

/** import 来源的三种写法：静态、副作用、动态。 */
const IMPORT_PATTERNS: RegExp[] = [
  /(?:^|[;{}()\n])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"`])([^'"`]+)\1/g,
  /(?:^|[;{}()\n])\s*import\s*(['"`])([^'"`]+)\1/g,
  /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
];

/**
 * 抽出文件里 import 的模块名。
 *
 * 在「去注释后」的源码上找：注释里写的 import 不算数。
 */
function importSpecifiers(file: SourceFile): { spec: string; line: number }[] {
  const ast = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { spec: string; line: number }[] = [];
  const add = (n: ts.Node | undefined) => {
    if (n && ts.isStringLiteralLike(n))
      found.push({
        spec: n.text,
        line: ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1,
      });
  };
  function visit(n: ts.Node) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n))
      add(n.moduleSpecifier);
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    )
      add(n.arguments[0]);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  return found;
}

/** 相对路径解析：把 "./x.ts"、"../y/z.ts" 变成相对 workbench/ 的路径。 */
function resolveRelative(fromPath: string, spec: string): string {
  const result = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  return /\.[cm]?[jt]sx?$/.test(result) ? result : result + ".ts";
}

/** 内核里的领域词：内核只提供机制，内容类型归包。 */
const DOMAIN_WORDS = [
  "novel",
  "research",
  "character",
  "chapter",
  "hypothesis",
  "repository",
];

/** v2 的名词：v3 里换了名字，不许再出现。 */
const V2_NAMES = [
  "Space",
  "SpaceLink",
  "ComponentInstance",
  "Projection",
  "placements",
];

/** SQL 写语句：只能出现在内核里（V8）。 */
const SQL_WRITE_PATTERNS: [string, RegExp][] = [
  ["INSERT INTO", /\binsert\s+(?:or\s+\w+\s+)?into\b/i],
  ["UPDATE … SET", /\bupdate\b[^;]*\bset\b/i],
  ["DELETE FROM", /\bdelete\s+from\b/i],
  ["REPLACE INTO", /\breplace\s+into\b/i],
];

/** 在源码里找整词出现的地方（区分大小写）。 */
function findWords(
  file: SourceFile,
  words: string[],
): { word: string; line: number }[] {
  const { stripped } = scanOf(file);
  const hits: { word: string; line: number }[] = [];
  for (const word of words) {
    const pattern = new RegExp(`\\b${word}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)))
      hits.push({ word, line: lineAt(stripped, match.index) });
  }
  return hits;
}

const isKernel = (file: SourceFile) => file.path.startsWith("kernel/");
const isLegacy = (file: SourceFile) => file.path.startsWith("kernel/legacy/");
const isPack = (file: SourceFile) => file.path.startsWith("packs/");
const isTest = (file: SourceFile) => file.path.startsWith("tests/");

/** 规则 1：内核只依赖自己。 */
function checkKernelImports(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter(isKernel)) {
    for (const { spec, line } of importSpecifiers(file)) {
      if (spec.startsWith("node:")) continue;
      if (spec === "ajv" || spec.startsWith("ajv/")) continue;
      if (
        spec.startsWith(".") &&
        resolveRelative(file.path, spec).startsWith("kernel/")
      )
        continue;
      violations.push({
        file: file.path,
        line,
        message: `内核只能依赖自己（node:*、ajv、./ 开头的相对路径），这里导入了 ${spec}`,
      });
    }
  }
  return violations;
}

/**
 * 代码包要解析 TypeScript，并用 zod 描述工具参数。
 * 科研包用同一份 zod 描述工具参数，并用钉死版本的 pdfjs-dist 读 PDF。
 * 这些依赖的版本钉在 workbench/package.json，不向其他包放开。
 */
function packDependencyAllowed(pack: string, spec: string): boolean {
  const allowed: Record<string, string[]> = {
    code: ["typescript", "zod"],
    research: ["zod", "pdfjs-dist"],
  };
  return (allowed[pack] ?? []).some(
    (name) => spec === name || spec.startsWith(`${name}/`),
  );
}

/** 规则 2：包只依赖内核。 */
function checkPackImports(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter(isPack)) {
    const segments = file.path.split("/");
    const pack = segments[1] ?? "";
    /* packs/index.ts 是内置包清单：它要把各个包收在一起，所以允许它导入
       同级的包目录。包与包之间仍然不能互相导入。 */
    const isList = segments.length === 2;
    for (const { spec, line } of importSpecifiers(file)) {
      if (!spec.startsWith(".")) {
        if (!spec.startsWith("node:") && !packDependencyAllowed(pack, spec))
          violations.push({
            file: file.path,
            line,
            message: `包的第三方依赖未被允许：${spec}`,
          });
        continue;
      }
      const resolved = resolveRelative(file.path, spec);
      if (resolved === "kernel/index.ts") continue;
      if (resolved.startsWith(`packs/${pack}/`)) continue;
      if (isList && resolved.startsWith("packs/")) continue;
      violations.push({
        file: file.path,
        line,
        message: `包只能依赖内核（kernel/index.ts）或本包内部，这里导入了 ${spec}`,
      });
    }
  }
  return violations;
}

/** 规则 3：SQL 写语句只在内核。 */
function checkSqlWrites(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter((f) => !isKernel(f) && !isTest(f))) {
    for (const literal of scanOf(file).literals) {
      for (const [label, pattern] of SQL_WRITE_PATTERNS)
        if (pattern.test(literal.value))
          violations.push({
            file: file.path,
            line: literal.line,
            message: `SQL 写语句（${label}）只能出现在 kernel/ 里`,
          });
    }
  }
  return violations;
}

/** 规则 4：内核没有领域词。 */
function checkDomainWords(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter((f) => isKernel(f) && !isLegacy(f)))
    for (const { word, line } of findWords(file, DOMAIN_WORDS))
      violations.push({
        file: file.path,
        line,
        message: `内核里不该出现领域词「${word}」：内容类型归包管`,
      });
  return violations;
}

/** 规则 5：禁用 v2 名词。 */
function checkV2Names(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter(
    (f) => (isKernel(f) && !isLegacy(f)) || isPack(f),
  ))
    for (const { word, line } of findWords(file, V2_NAMES))
      violations.push({
        file: file.path,
        line,
        message: `v3 里不用 v2 名词「${word}」`,
      });
  return violations;
}

/** 规则 6：只从入口导入内核。 */
function checkKernelEntry(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter((f) => !isKernel(f) && !isTest(f)))
    for (const { spec, line } of importSpecifiers(file)) {
      if (!spec.startsWith(".")) continue;
      const resolved = resolveRelative(file.path, spec);
      if (!resolved.startsWith("kernel/")) continue;
      if (resolved === "kernel/index.ts") continue;
      violations.push({
        file: file.path,
        line,
        message: `内核只从入口导入，这里直接导入了 ${spec}`,
      });
    }
  return violations;
}

/** 递归读 workbench/ 下的 .ts 文件。 */
function listSourceFiles(
  dir = ROOT,
  root = ROOT,
  out: SourceFile[] = [],
): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "artifacts"].includes(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, root, out);
    else if (/\.[cm]?tsx?$/.test(entry.name))
      out.push({
        path: relative(root, full).split(sep).join("/"),
        source: readFileSync(full, "utf8"),
      });
  }
  return out;
}

const files = listSourceFiles();

/** 失败时把违规的文件和行号列出来。 */
function assertClean(violations: Violation[]) {
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.message}`),
    [],
  );
}

test("内核只依赖自己", () => {
  assertClean(checkKernelImports(files));
});

test("包只依赖内核", () => {
  assertClean(checkPackImports(files));
});

test("SQL 写语句只在内核", () => {
  assertClean(checkSqlWrites(files));
});

test("内核没有领域词", () => {
  assertClean(checkDomainWords(files));
});

test("禁用 v2 名词", () => {
  assertClean(checkV2Names(files));
});

test("只从入口导入内核", () => {
  assertClean(checkKernelEntry(files));
});

// —— 工具数量规则：docs/kernel-v3/02-commands-and-tools.md §3.5 ——

/** 只启用 base 时，模型能看到的工具个数。 */
const CORE_TOOL_COUNT = 8;
/** 每个领域包最多带来的工具个数。 */
const PACK_TOOL_LIMIT = 2;
/** 领域包的个数（novel、research、code）。 */
const DOMAIN_PACK_COUNT = 3;
/** 文件夹连接器带来的工具个数。 */
const FOLDER_TOOL_COUNT = 1;

/** 起一个临时工作空间，把客户端接上去。 */
async function connectTools() {
  const root = mkdtempSync(join(tmpdir(), "sand-arch-tools-"));
  const created = createServerV3({ workspaceRoot: root, workspaceId: "arch" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "arch-tester", version: "1" });
  await Promise.all([
    client.connect(clientTransport),
    created.server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      created.dispose();
      await client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 模型能看到的工具：visibility 缺省或含 model，且没有被停用。 */
async function modelVisibleTools(client: Client) {
  const listed = await client.listTools();
  return listed.tools
    .filter((tool) => {
      const visibility = (
        tool._meta as { ui?: { visibility?: string[] } } | undefined
      )?.ui?.visibility;
      return !visibility || visibility.includes("model");
    })
    .map((tool) => tool.name);
}

test("只启用 base 时，模型可见工具正好 8 个", async () => {
  const session = await connectTools();
  try {
    const changed = await session.client.callTool({
      name: "app_edit",
      arguments: {
        commands: ["novel", "research", "code"].map((id) => ({
          op: "pack.disable",
          id,
        })),
      },
    });
    assert.equal(changed.isError, undefined);
    const names = await modelVisibleTools(session.client);
    assert.equal(
      names.length,
      CORE_TOOL_COUNT,
      `模型可见工具是 ${names.join("、")}`,
    );
  } finally {
    await session.close();
  }
});

test("启用全部内置包时，模型可见工具不超过 8 + 2 × 3 + 1", async () => {
  const session = await connectTools();
  try {
    const changed = await session.client.callTool({
      name: "app_edit",
      arguments: {
        commands: [
          { op: "pack.enable", id: "novel" },
          { op: "pack.enable", id: "research" },
          { op: "pack.enable", id: "code" },
        ],
      },
    });
    assert.equal(changed.isError, undefined);
    const names = await modelVisibleTools(session.client);
    const limit =
      CORE_TOOL_COUNT + PACK_TOOL_LIMIT * DOMAIN_PACK_COUNT + FOLDER_TOOL_COUNT;
    assert.ok(
      names.length <= limit,
      `模型可见工具 ${names.length} 个，超过上限 ${limit}：${names.join("、")}`,
    );
  } finally {
    await session.close();
  }
});

// —— 自检：检查函数本身要能找出问题，也不能被注释和字符串骗到 ——

const sample = (path: string, source: string): SourceFile => ({
  path,
  source,
});

test("自检：内核导入 v2 代码会被抓住", () => {
  const violations = checkKernelImports([
    sample("kernel/sample.ts", 'import { store } from "../core/store.ts";'),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.line, 1);
  assert.ok(violations[0]?.message.includes("../core/store.ts"));
});

test("自检：node:、ajv 和 ./ 相对路径都放行", () => {
  assert.deepEqual(
    checkKernelImports([
      sample(
        "kernel/sample.ts",
        [
          'import { DatabaseSync } from "node:sqlite";',
          'import Ajv from "ajv";',
          'import { newId } from "./ids.ts";',
        ].join("\n"),
      ),
    ]),
    [],
  );
});

test("自检：包不能依赖别的包或 v2 目录", () => {
  const violations = checkPackImports([
    sample("packs/novel/item.ts", 'import { x } from "../other/item.ts";'),
    sample("packs/novel/y.ts", 'import { z } from "../../core/store.ts";'),
  ]);
  assert.equal(violations.length, 2);
  assert.deepEqual(
    checkPackImports([
      sample("packs/novel/item.ts", 'import { x } from "./types.ts";'),
      sample("packs/novel/y.ts", 'import { z } from "../../kernel/index.ts";'),
    ]),
    [],
  );
});

test("自检：内置包清单能收各个包，包之间仍然不能互相导入", () => {
  assert.deepEqual(
    checkPackImports([
      sample("packs/index.ts", 'import { a } from "./base/index.ts";'),
      sample("packs/index.ts", 'import { b } from "../kernel/index.ts";'),
    ]),
    [],
  );
  assert.equal(
    checkPackImports([
      sample("packs/index.ts", 'import { c } from "../core/store.ts";'),
    ]).length,
    1,
  );
  assert.equal(
    checkPackImports([
      sample("packs/novel/index.ts", 'import { d } from "../base/index.ts";'),
    ]).length,
    1,
  );
});

test("自检：内核外的 SQL 写语句会被抓住，注释里的不算", () => {
  const violations = checkSqlWrites([
    sample("server/write.ts", 'const sql = "INSERT INTO objects VALUES (1)";'),
    sample(
      "server/ok.ts",
      '// 以前的实现里有 DELETE FROM objects，现在不写了。\nconst sql = "SELECT 1";',
    ),
  ]);
  assert.equal(violations.length, 1);
  assert.ok(violations[0]?.message.includes("INSERT INTO"));
});

test("自检：领域词在注释里不误报，在代码和字符串里会被抓住", () => {
  assert.deepEqual(
    checkDomainWords([
      sample(
        "kernel/sample.ts",
        "// 这里只讲机制：novel、research 都不该出现在内核。\nconst x = 1;",
      ),
    ]),
    [],
  );
  const hits = checkDomainWords([
    sample("kernel/sample.ts", 'const kind = "novel.character";'),
  ]);
  assert.equal(hits.length, 2);
  assert.ok(hits[0]?.message.includes("novel"));
  assert.ok(hits[1]?.message.includes("character"));
  assert.equal(hits[0]?.line, 1);
});

test("自检：v2 名词会被抓住，legacy 目录不算", () => {
  const hits = checkV2Names([
    sample("kernel/sample.ts", "type Space = { id: string };"),
  ]);
  assert.equal(hits.length, 1);
  assert.deepEqual(
    checkV2Names([
      sample("kernel/legacy/import-v2.ts", "const space: Space = read();"),
    ]),
    [],
  );
});

test("自检：内核只能从入口导入", () => {
  const violations = checkKernelEntry([
    sample(
      "server/use.ts",
      'import { openWorkspaceDb } from "../kernel/db.ts";',
    ),
  ]);
  assert.equal(violations.length, 1);
  assert.deepEqual(
    checkKernelEntry([
      sample(
        "server/use.ts",
        'import { openWorkspaceDb } from "../kernel/index.ts";',
      ),
    ]),
    [],
  );
});

test("自检：注释里的 // 不是注释结束，字符串里的网址不能被砍掉", () => {
  const source =
    'const url = "https://example.com/a"; // 真的注释\nconst b = 1;';
  const { stripped, literals } = scan(source);
  assert.ok(stripped.includes("https://example.com/a"));
  assert.ok(!stripped.includes("真的注释"));
  assert.equal(literals.length, 1);
  assert.equal(literals[0]?.value, "https://example.com/a");
});

test("路径归一化及真实 import 的补充边界", () => {
  const f = (path: string, source: string) => ({ path, source });
  for (const source of [
    'import "./../core/store.ts";',
    'const x=require("../core/store.ts");',
    'export {x} from "../core/store.ts";',
  ])
    assert.ok(checkKernelImports([f("kernel/demo.ts", source)]).length);
  assert.equal(
    checkKernelImports([f("kernel/sub/demo.ts", 'import "../db.ts";')]).length,
    0,
  );
  assert.ok(
    checkKernelImports([f("kernel/demo.ts", 'import "ajv-unapproved";')])
      .length,
  );
  assert.equal(
    checkKernelImports([
      f("kernel/demo.ts", 'const text=`import "../core/store.ts"`;'),
    ]).length,
    0,
  );
  assert.ok(
    checkKernelEntry([
      f("board/demo.tsx", 'import {x} from "../kernel/db.ts";const y=<div/>;'),
    ]).length,
  );
  assert.ok(
    checkPackImports([f("packs/demo/index.ts", 'import "unapproved";')]).length,
  );
  assert.ok(
    checkPackImports([f("packs/novel/index.ts", 'import { z } from "zod";')])
      .length,
    "只有代码包可以依赖 zod",
  );
  assert.equal(
    checkPackImports([
      f("packs/code/indexer.ts", 'import ts from "typescript";'),
    ]).length,
    0,
  );
  assert.ok(
    checkSqlWrites([
      f("server/a.ts", 'const q="INSERT OR REPLACE INTO x VALUES (1)";'),
    ]).length,
  );
});
