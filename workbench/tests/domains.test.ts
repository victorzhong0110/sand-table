// 领域包与注册表的测试：通用内核不认识领域语义，领域包提供词汇。
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 2、6 节。
// 覆盖不变量：D1（关掉代码包内核照常）、D2（没有仓库也能用）、
// D4（未声明的能力被拒绝）、D8（通用层不 import 代码索引实现）、
// D9（注册后类型/组件/关系/工具/模板都能查到）、D10（校验合并成一条清单）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardStore } from "../core/store.ts";
import { Spaces } from "../server/spaces.ts";
import { openView } from "../core/space-state.ts";
import { checkComponentData, defaultData } from "../core/spaces.ts";
import {
  checkDomainData,
  findComponentType,
  findObjectType,
  findRelationType,
  getDomainPack,
  listDomainPacks,
  listTemplates,
  registerDomainPack,
  resetDomainPacks,
} from "../core/domains.ts";
import { codePack, registerCodeDomain } from "../domains/code/index.ts";
import { folderConnector } from "../connectors/folder.ts";
import { writeThrough } from "../connectors/types.ts";
import { WorkspaceStore } from "../core/workspace.ts";
import { workspacePort } from "../core/persistence.ts";
import { createServer } from "../server/server.ts";

const workbench = fileURLToPath(new URL("../", import.meta.url));
const empty = { workspaces: [], objects: [], relations: [] };

test("D9 领域包注册后，类型、组件、关系、工具与模板都能被查到", () => {
  resetDomainPacks();
  registerCodeDomain();
  assert.ok(
    listDomainPacks().some((p) => p.id === "code"),
    "代码包在注册表里",
  );
  // 对象类型
  assert.equal(findObjectType("code")?.title, "代码片段");
  assert.equal(findObjectType("file")?.title, "源文件");
  assert.equal(findObjectType("symbol")?.title, "符号");
  // 组件类型：代码片段、差异比较、运行状态
  assert.equal(findComponentType("code")?.title, "代码片段");
  assert.equal(findComponentType("code-diff")?.title, "差异比较");
  assert.equal(findComponentType("code-run")?.title, "运行状态");
  // 关系类型
  assert.equal(findRelationType("contains")?.title, "包含");
  assert.equal(findRelationType("calls")?.allowsInferred, true);
  assert.equal(findRelationType("contains")?.allowsInferred, false);
  // 工具
  const pack = getDomainPack("code");
  assert.ok(pack, "能按 id 取到包");
  assert.ok((pack?.tools?.length ?? 0) >= 1, "包里声明了领域工具");
  assert.ok(
    pack?.tools?.every((t) => t.name && t.description && t.inputSchema),
    "每个工具都有名字、说明与参数结构",
  );
  // 模板
  const templates = listTemplates().filter((t) => t.packId === "code");
  assert.equal(templates.length, 2);
  assert.ok(
    templates.every((t) => t.template.objects.length > 0),
    "模板至少产出一个对象",
  );
  assert.ok(
    templates.every((t) =>
      (t.template.relations ?? []).every(
        (r) =>
          r.source < t.template.objects.length &&
          r.target < t.template.objects.length,
      ),
    ),
    "模板里的关系下标都指向真实对象",
  );
});

test("D10 领域校验与基础校验合并成一条错误清单", () => {
  resetDomainPacks();
  registerCodeDomain();
  // 基础规则（URL）与领域规则（差异比较的 before）同时成立：
  // 一次抛出，合并成一条清单。
  let message = "";
  try {
    checkComponentData("code-diff", {
      url: "javascript:alert(1)",
      before: 42,
    });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.match(message, /Resource URL must use HTTP\(S\)/, "基础规则在清单里");
  assert.match(
    message,
    /领域规则：差异比较的 before 必须是字符串。/,
    "领域规则带前缀，也在清单里",
  );
  assert.equal(
    message.split("\n").length,
    2,
    "两条错误合并成一条清单，不是两次抛出",
  );
  // 只有领域规则时，清单里也只有领域规则。
  assert.throws(
    () => checkComponentData("code", { text: 123 }),
    /领域规则：代码片段的 text 必须是字符串。/,
  );
  // 没登记领域规则时，领域校验不存在，基础校验照旧。
  resetDomainPacks();
  assert.deepEqual(checkDomainData("code-diff", { before: 42 }), []);
  assert.throws(
    () => checkComponentData("chart", { kind: "bar", points: "no" }),
    /points must be an array/,
  );
});

test("D10 领域包提供默认载荷，内置清单没有的类型也有", () => {
  resetDomainPacks();
  assert.deepEqual(defaultData("code-diff"), {}, "没有领域包就没有默认载荷");
  registerCodeDomain();
  assert.deepEqual(defaultData("code-diff"), {
    path: "",
    before: "",
    after: "",
  });
  assert.deepEqual(defaultData("code-run"), {
    command: "",
    state: "unknown",
    output: "",
  });
  // 内置原生类型不受影响。
  assert.deepEqual(defaultData("text"), { text: "" });
});

test("D1 关掉代码包与 Git 连接器，通用内核仍可启动、建对象、编辑、保存、重开", async () => {
  resetDomainPacks();
  const root = mkdtempSync(join(tmpdir(), "sand-domain-"));
  try {
    const store = new BoardStore();
    store.attachPersistence(workspacePort(new WorkspaceStore(root)), "default");
    const spaces = new Spaces(store);
    const opened = store.open(empty, "空白工作区");
    openView(store.get(opened.id), "view-a");
    const op = (operation: any) =>
      spaces.update(
        opened.id,
        store.get(opened.id).revision,
        "view-a",
        operation,
        "human",
      );
    op({ kind: "create", type: "text", title: "林澈", data: { text: "一稿" } });
    const objectId = store.get(opened.id).contentObjects[0].id;
    op({
      kind: "update",
      instanceId: store.get(opened.id).instances[0].id,
      data: { text: "二稿" },
      expectedVersion: 1,
    });
    await store.flushSave();
    assert.ok(!store.lastSaveError, "保存没有失败");

    // 重启：同一个工作空间读回来
    const restarted = new BoardStore();
    restarted.attachPersistence(
      workspacePort(new WorkspaceStore(root)),
      "default",
    );
    const reopened = restarted.open(empty, "空白工作区");
    const restored = restarted.get(reopened.id);
    assert.equal(restored.contentObjects.length, 1, "内容还在");
    assert.equal(restored.contentObjects[0].data!.text, "二稿", "编辑也在");
    assert.ok(objectId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D2 不配置任何仓库，白板仍可正常使用", () => {
  resetDomainPacks();
  const { store, dispose } = createServer([]);
  try {
    const opened = store.open(empty, "空白工作区");
    const spaces = new Spaces(store);
    openView(store.get(opened.id), "view-a");
    spaces.update(
      opened.id,
      store.get(opened.id).revision,
      "view-a",
      {
        kind: "create",
        type: "text",
        title: "没有仓库也能写",
        data: { text: "内容" },
      },
      "human",
    );
    const b = store.get(opened.id);
    assert.equal(b.contentObjects.length, 1);
    assert.equal(b.workspaces.length, 0, "没有绑定任何工作区");
  } finally {
    dispose();
  }
});

test("D4 未声明的能力被拒绝并说明原因", () => {
  const descriptor = folderConnector.descriptor();
  assert.equal(
    descriptor.capabilities.write,
    undefined,
    "只读连接器不声明写能力",
  );
  assert.deepEqual(descriptor.capabilities.read.kinds, ["file"]);
  assert.throws(
    () =>
      writeThrough(folderConnector, {
        files: [{ path: "a.txt", beforeHash: null, content: "x" }],
      }),
    /只读/,
  );
  assert.throws(
    () =>
      writeThrough(folderConnector, {
        files: [{ path: "a.txt", beforeHash: null, content: "x" }],
      }),
    /folder 连接器是只读的：不能写入外部文件。/,
  );
});

test("D8 通用层不 import 代码索引实现", () => {
  /** 允许 import 代码领域与连接器的接线模块：只有这几处是接线，不是通用逻辑。 */
  const wiring = new Set([
    "server/server.ts", // 组合根：注册工具、接上索引器与连接器
    "server/main.ts", // 进程入口：把命令行参数绑成仓库
    "server/changes.ts", // 变更协议：意图→提案→确认→核对，绑定 Git 工作树
  ]);
  const sources = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(join(workbench, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(workbench, rel)).isDirectory())
        out.push(...sources(rel));
      else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
    }
    return out;
  };
  const specifiers = (source: string): string[] => [
    ...[...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1],
    ),
  ];
  const offenders: string[] = [];
  for (const rel of [...sources("core"), ...sources("server")]) {
    const file = join(workbench, rel);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(file, "..", spec);
      const inDomains = target.startsWith(join(workbench, "domains") + sep);
      const inConnectors = target.startsWith(
        join(workbench, "connectors") + sep,
      );
      if (!inDomains && !inConnectors) continue;
      // core/ 一律不许；server/ 只有接线模块可以。
      if (rel.startsWith("core/") || !wiring.has(rel))
        offenders.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "通用层不得 import 代码索引实现或连接器：" + offenders.join("；"),
  );
  // 连接器不依赖领域包：连接器是更下面的一层。
  const connectorOffenders: string[] = [];
  for (const rel of sources("connectors")) {
    const file = join(workbench, rel);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(file, "..", spec);
      if (target.startsWith(join(workbench, "domains") + sep))
        connectorOffenders.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(
    connectorOffenders,
    [],
    "连接器不得 import 领域包：" + connectorOffenders.join("；"),
  );
  // 领域包可以依赖连接器（代码索引要读文件），但反向不行。
  const relativeTo = (from: string, to: string) =>
    relative(join(workbench, from), join(workbench, to));
  assert.ok(relativeTo("domains/code/indexer.ts", "connectors/types.ts"));
});

test("注册表拒绝没有 id 或 version 的包", () => {
  resetDomainPacks();
  assert.throws(
    () => registerDomainPack({ id: "", title: "x", version: 1 }),
    /非空 id/,
  );
  assert.throws(
    () =>
      registerDomainPack({
        id: "bad",
        title: "x",
        version: Number.NaN,
      }),
    /version/,
  );
  assert.throws(
    () =>
      registerDomainPack({
        id: "bad",
        title: "x",
        version: 1,
        objectTypes: [
          { type: "a", title: "A" },
          { type: "a", title: "A2" },
        ],
      }),
    /重复声明/,
  );
  // 代码包本身是合法的。
  registerDomainPack(codePack);
  assert.equal(getDomainPack("code")?.version, 1);
});
