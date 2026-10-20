// 工作空间存储层的测试。契约见 docs/architecture/workspace-kernel.zh-CN.md 第 4、5 节。
// 只用 node 内置模块；node --experimental-strip-types --test tests/workspace.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectExternalDependencies,
  migrate,
  nodeWorkspaceFileSystem,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceConflictError,
  WorkspaceCorruptError,
  WorkspaceIdError,
  WorkspaceStore,
  WorkspaceVersionError,
} from "../core/workspace.ts";
import type { TestContext } from "node:test";
import type {
  WorkspaceFile,
  WorkspaceFileSystem,
} from "../core/workspace.ts";

/** 每个用例一个临时目录，用例结束即清理。 */
const tempRoot = (t: TestContext): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sand-ws-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

const sampleWorkspace = (id: string, title = "Sample"): WorkspaceFile => ({
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  id,
  title,
  createdAt: 1000,
  updatedAt: 2000,
  revision: 3,
  contentRevision: 2,
  boards: [
    {
      id: "board-1",
      title: "主白板",
      revision: 4,
      contentRevision: 1,
      spaces: [{ id: "space-1", title: "空间" }],
      presentations: [
        {
          id: "p-1",
          spaceId: "space-1",
          type: "object",
          binding: { kind: "object", objectId: "obj-1" },
          title: "对象",
          data: {},
          rect: { x: 1, y: 2, width: 3, height: 4, pinned: false },
          updatedAt: 2000,
          author: "human",
        },
      ],
      views: { "view-1": { spaceId: "space-1" } },
      focusedViewId: "view-1",
      selection: ["obj-1"],
      placements: { "obj-1": { x: 10, y: 20 } },
      notes: { "obj-1": "一条便签" },
      groups: [],
      spaceLinks: [],
      assets: [],
      activities: [],
      guides: [],
      intents: [],
      proposals: [],
      validations: [],
    },
  ],
  objects: [
    {
      id: "obj-1",
      kind: "native",
      type: "note",
      typeVersion: 1,
      title: "第一条",
      body: "正文",
      data: { tags: ["a", "b"] },
      source: {
        origin: "imported",
        external: { kind: "file", uri: "/tmp/notes.md" },
      },
      version: 4,
      createdAt: 1000,
      updatedAt: 2000,
      author: "human",
    },
    {
      id: "obj-2",
      kind: "code",
      type: "symbol",
      typeVersion: 1,
      title: "第二条",
      version: 1,
      createdAt: 1000,
      updatedAt: 1000,
      author: "agent",
    },
  ],
  relations: [
    {
      id: "rel-1",
      source: "obj-1",
      target: "obj-2",
      kind: "支持",
      status: "confirmed",
      evidence: [{ kind: "git", uri: "git@example.com:org/repo" }],
      createdAt: 1500,
      author: "human",
    },
  ],
  resources: [
    {
      id: "res-1",
      kind: "url",
      uri: "https://example.com/paper",
      status: "valid",
    },
  ],
  activities: [
    {
      id: "act-1",
      actor: "agent-a",
      actorKind: "agent",
      state: "done",
      task: "整理资料",
      action: "读取",
      targetObjectIds: ["obj-1"],
      reportedAt: 1900,
      reportedBy: "agent-self-report",
    },
  ],
  history: {
    undo: [
      {
        id: "h-1",
        intentId: "intent-1",
        label: "编辑对象",
        at: 1800,
        author: "human",
        patch: {
          target: "object",
          id: "obj-1",
          before: "旧正文",
          after: "正文",
        },
      },
    ],
    redo: [],
  },
  audit: [
    {
      id: "a-1",
      at: 1850,
      actor: "agent-a",
      actorKind: "agent",
      action: "update-object",
      target: { kind: "object", id: "obj-1" },
    },
  ],
});

const readJson = (file: string): unknown =>
  JSON.parse(fs.readFileSync(file, "utf8"));

test("create → save → load 往返不丢数据，ID 稳定", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root, { now: () => 5000 });

  const created = store.create({ id: "ws-roundtrip", title: "往返" });
  assert.equal(created.id, "ws-roundtrip");
  assert.equal(created.schemaVersion, WORKSPACE_SCHEMA_VERSION);
  // create() 是纯内存操作：未 save 前不落盘。
  assert.equal(fs.existsSync(path.join(root, "ws-roundtrip")), false);

  const populated = sampleWorkspace("ws-roundtrip", "往返");
  const saved = store.save(populated);
  assert.equal(saved.id, "ws-roundtrip");

  // 换一个实例模拟进程重启。
  const reloaded = new WorkspaceStore(root).load("ws-roundtrip");
  assert.equal(reloaded.recovered, false);
  assert.equal(reloaded.reason, undefined);
  assert.equal(reloaded.workspace.id, populated.id);
  assert.equal(reloaded.workspace.title, "往返");
  assert.deepEqual(reloaded.workspace.objects, populated.objects);
  assert.deepEqual(reloaded.workspace.relations, populated.relations);
  assert.deepEqual(reloaded.workspace.resources, populated.resources);
  assert.deepEqual(reloaded.workspace.activities, populated.activities);
  assert.deepEqual(reloaded.workspace.boards, populated.boards);
  assert.deepEqual(reloaded.workspace.history, populated.history);
  assert.deepEqual(reloaded.workspace.audit, populated.audit);
  assert.equal(reloaded.workspace.revision, 3);
  assert.equal(reloaded.workspace.contentRevision, 2);
  // 附件目录随工作空间建立。
  assert.equal(
    fs.existsSync(path.join(root, "ws-roundtrip", "attachments")),
    true,
  );
});

test("原子写：上一份保留为 .bak，目录里不留 .tmp", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  const first = store.save(sampleWorkspace("ws-atomic", "第一版"));
  const second = store.save({ ...first, title: "第二版", updatedAt: 3000 });

  const main = path.join(root, "ws-atomic", "workspace.json");
  const backup = path.join(root, "ws-atomic", "workspace.json.bak");
  assert.equal((readJson(main) as WorkspaceFile).title, "第二版");
  assert.equal((readJson(backup) as WorkspaceFile).title, "第一版");
  assert.equal(fs.existsSync(path.join(root, "ws-atomic", "workspace.json.tmp")), false);
  assert.equal(fs.existsSync(path.join(root, "ws-atomic", "workspace.json.bak.tmp")), false);
});

test("写失败：抛错、主文件内容不变、无半截文件、lastError 可观察", (t) => {
  const root = tempRoot(t);
  const main = path.join(root, "ws-fail", "workspace.json");

  const good = new WorkspaceStore(root);
  good.save(sampleWorkspace("ws-fail", "旧内容"));
  const before = fs.readFileSync(main, "utf8");

  const brokenFs: WorkspaceFileSystem = {
    ...nodeWorkspaceFileSystem,
    writeFileSync: () => {
      throw new Error("disk full");
    },
  };
  const broken = new WorkspaceStore(root, { fs: brokenFs });
  assert.throws(
    () => broken.save(sampleWorkspace("ws-fail", "新内容")),
    /disk full/,
  );
  // 主文件内容保持不变。
  assert.equal(fs.readFileSync(main, "utf8"), before);
  // 没有留下半截文件。
  assert.equal(fs.existsSync(`${main}.tmp`), false);
  assert.equal(fs.existsSync(`${main}.bak.tmp`), false);
  // 失败可观察：上层据此展示「保存失败」。
  assert.ok(broken.lastError);
  assert.equal(broken.lastError?.operation, "save");
  assert.equal(broken.lastError?.workspaceId, "ws-fail");
  assert.match(broken.lastError?.message ?? "", /disk full/);
});

test("写失败发生在 rename 阶段时主文件同样保持不变", (t) => {
  const root = tempRoot(t);
  const main = path.join(root, "ws-rename", "workspace.json");

  const good = new WorkspaceStore(root);
  good.save(sampleWorkspace("ws-rename", "旧内容"));
  const before = fs.readFileSync(main, "utf8");

  const brokenFs: WorkspaceFileSystem = {
    ...nodeWorkspaceFileSystem,
    renameSync: () => {
      throw new Error("rename failed");
    },
  };
  const broken = new WorkspaceStore(root, { fs: brokenFs });
  assert.throws(
    () => broken.save(sampleWorkspace("ws-rename", "新内容")),
    /rename failed/,
  );
  assert.equal(fs.readFileSync(main, "utf8"), before);
  assert.equal(fs.existsSync(`${main}.tmp`), false);
  assert.equal(fs.existsSync(`${main}.bak.tmp`), false);
  assert.match(broken.lastError?.message ?? "", /rename failed/);
});

test("主文件损坏时回退 .bak 并标记 recovered", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  const first = store.save(sampleWorkspace("ws-corrupt", "第一版"));
  store.save({ ...first, title: "第二版", updatedAt: 3000 });

  const main = path.join(root, "ws-corrupt", "workspace.json");
  fs.writeFileSync(main, "{ this is not json", "utf8");

  const loaded = store.load("ws-corrupt");
  assert.equal(loaded.recovered, true);
  assert.match(loaded.reason ?? "", /workspace\.json\.bak/);
  assert.equal(loaded.workspace.title, "第一版");
  assert.deepEqual(loaded.workspace.objects, first.objects);
});

test("主文件与备份都损坏时抛 WorkspaceCorruptError，绝不返回空工作空间", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(sampleWorkspace("ws-broken", "唯一版本"));

  const dir = path.join(root, "ws-broken");
  fs.writeFileSync(path.join(dir, "workspace.json"), "not json at all", "utf8");
  fs.writeFileSync(path.join(dir, "workspace.json.bak"), "also broken", "utf8");

  assert.throws(() => store.load("ws-broken"), WorkspaceCorruptError);
  assert.ok(store.lastError);
  assert.equal(store.lastError?.operation, "load");
});

test("未来 schemaVersion 抛错而不是被丢弃", () => {
  const future = { ...sampleWorkspace("ws-future"), schemaVersion: 99 };
  assert.throws(() => migrate(future), WorkspaceVersionError);
  assert.throws(() => migrate(future), /newer than the supported version/);
});

test("读取未来版本的工作空间文件时拒绝回退，不返回空工作空间", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(sampleWorkspace("ws-future"));
  const main = path.join(root, "ws-future", "workspace.json");
  const future = { ...sampleWorkspace("ws-future"), schemaVersion: 99 };
  fs.writeFileSync(main, JSON.stringify(future), "utf8");
  assert.throws(() => store.load("ws-future"), WorkspaceVersionError);
});

test("旧版本文件被逐级迁移到当前版本", () => {
  const legacy = {
    id: "ws-legacy",
    title: "旧格式",
    createdAt: 10,
    updatedAt: 20,
    revision: 7,
    board: { id: "board-legacy", title: "旧白板", revision: 1 },
    objects: [
      {
        id: "obj-legacy",
        kind: "native",
        type: "note",
        title: "旧对象",
        version: 2,
        createdAt: 10,
        updatedAt: 20,
        author: "human",
      },
    ],
    relations: [],
  };
  const migrated = migrate(legacy);
  assert.equal(migrated.schemaVersion, WORKSPACE_SCHEMA_VERSION);
  assert.equal(migrated.id, "ws-legacy");
  assert.equal(migrated.boards.length, 1);
  assert.equal(migrated.boards[0].id, "board-legacy");
  assert.equal(migrated.objects.length, 1);
  assert.equal(migrated.objects[0].typeVersion, 1);
  assert.deepEqual(migrated.history, { undo: [], redo: [] });
  assert.deepEqual(migrated.audit, []);

  // 迁移是幂等的：再次迁移得到同样结果。
  assert.deepEqual(migrate(migrated), migrated);
});

test("非法结构不会被当成空工作空间", () => {
  assert.throws(() => migrate(null), WorkspaceCorruptError);
  assert.throws(() => migrate([]), WorkspaceCorruptError);
  assert.throws(() => migrate("nope"), WorkspaceCorruptError);
  assert.throws(() => migrate({ title: "没有 id" }), WorkspaceCorruptError);
});

test("导出导入往返：对象、关系与外部依赖清单一致", (t) => {
  const root = tempRoot(t);
  const otherRoot = tempRoot(t);
  const store = new WorkspaceStore(root);
  const workspace = sampleWorkspace("ws-export");
  store.save(workspace);

  const bundleJson = store.exportBundle("ws-export");
  const bundle = JSON.parse(bundleJson);
  assert.equal(bundle.format, "sand-table-workspace-bundle");
  assert.equal(bundle.workspace.id, "ws-export");
  assert.equal(bundle.externalDependencies.length, 3);
  assert.deepEqual(
    bundle.externalDependencies.map((d: { uri: string }) => d.uri).sort(),
    ["/tmp/notes.md", "git@example.com:org/repo", "https://example.com/paper"],
  );

  const other = new WorkspaceStore(otherRoot);
  const imported = other.importBundle(bundleJson);
  assert.equal(imported.id, "ws-export");
  assert.deepEqual(imported.objects, workspace.objects);
  assert.deepEqual(imported.relations, workspace.relations);
  assert.deepEqual(imported.resources, workspace.resources);
  assert.deepEqual(imported.activities, workspace.activities);
  assert.deepEqual(imported.history, workspace.history);
  assert.deepEqual(imported.audit, workspace.audit);

  // 导入后的工作空间重新导出，外部依赖清单必须一致。
  const reexported = JSON.parse(other.exportBundle("ws-export"));
  assert.deepEqual(
    reexported.externalDependencies,
    bundle.externalDependencies,
  );
  assert.deepEqual(
    collectExternalDependencies(imported),
    bundle.externalDependencies,
  );
});

test("导入同 ID 的工作空间抛冲突错误，不静默覆盖", (t) => {
  const root = tempRoot(t);
  const otherRoot = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(sampleWorkspace("ws-dup", "原始"));
  const bundleJson = store.exportBundle("ws-dup");

  const other = new WorkspaceStore(otherRoot);
  other.importBundle(bundleJson);
  const main = path.join(otherRoot, "ws-dup", "workspace.json");
  const before = fs.readFileSync(main, "utf8");

  assert.throws(() => other.importBundle(bundleJson), WorkspaceConflictError);
  // 冲突时既有文件内容不变。
  assert.equal(fs.readFileSync(main, "utf8"), before);
  assert.match(other.lastError?.message ?? "", /already exists/);
});

test("list 跳过损坏文件并报告，剩余工作空间照常列出", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(sampleWorkspace("ws-good", "好的"));
  store.save(sampleWorkspace("ws-bad", "坏的"));
  fs.writeFileSync(
    path.join(root, "ws-bad", "workspace.json"),
    "corrupted",
    "utf8",
  );

  const listed = store.list();
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.workspaces[0].id, "ws-good");
  assert.equal(listed.workspaces[0].title, "好的");
  assert.equal(listed.workspaces[0].createdAt, 1000);
  assert.equal(listed.workspaces[0].updatedAt, 2000);
  assert.equal(listed.workspaces[0].schemaVersion, WORKSPACE_SCHEMA_VERSION);
  assert.equal(listed.errors.length, 1);
  assert.equal(listed.errors[0].id, "ws-bad");
  assert.match(listed.errors[0].reason, /unreadable/);
});

test("list 在 root 不存在时返回空列表而不是崩掉", (t) => {
  const root = path.join(tempRoot(t), "not-created");
  const listed = new WorkspaceStore(root).list();
  assert.deepEqual(listed.workspaces, []);
  assert.deepEqual(listed.errors, []);
});

test("list 在 root 不是目录时报告错误而不是崩掉", (t) => {
  const root = path.join(tempRoot(t), "root-is-a-file");
  fs.writeFileSync(root, "not a directory", "utf8");
  const listed = new WorkspaceStore(root).list();
  assert.deepEqual(listed.workspaces, []);
  assert.equal(listed.errors.length, 1);
  assert.match(listed.errors[0].reason, /unreadable/);
});

test("非法工作空间 ID 被拒绝，不能越出 root 目录", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  for (const id of ["../escape", "a/b", ".hidden", "", ".."]) {
    assert.throws(() => store.load(id), WorkspaceIdError, `id ${id} 应被拒绝`);
    assert.throws(() => store.save({ ...sampleWorkspace("x"), id }), WorkspaceIdError);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(root), "escape")), false);
});

test("残留的 .tmp 文件不会被当成权威文件", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(sampleWorkspace("ws-tmp", "权威内容"));
  fs.writeFileSync(
    path.join(root, "ws-tmp", "workspace.json.tmp"),
    JSON.stringify({ ...sampleWorkspace("ws-tmp"), title: "半截内容" }),
    "utf8",
  );

  const loaded = store.load("ws-tmp");
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.workspace.title, "权威内容");
  assert.equal(store.list().workspaces.length, 1);
});

test("附件位于 <root>/<id>/attachments，可按需内联进导出包", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  store.save(sampleWorkspace("ws-attach"));
  const dir = path.join(root, "ws-attach", "attachments");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello", "utf8");

  const listed = JSON.parse(store.exportBundle("ws-attach"));
  assert.equal(listed.attachments.length, 1);
  assert.equal(listed.attachments[0].name, "a.txt");
  assert.equal(listed.attachments[0].bytes, 5);
  assert.equal(listed.attachments[0].dataBase64, undefined);

  const inlined = JSON.parse(
    store.exportBundle("ws-attach", { inlineAttachments: true }),
  );
  assert.equal(
    Buffer.from(inlined.attachments[0].dataBase64, "base64").toString("utf8"),
    "hello",
  );
});

test("共享类型里的可选字段（spaceActivities / theme / objectId / batch）不被丢弃", (t) => {
  const root = tempRoot(t);
  const store = new WorkspaceStore(root);
  const workspace = sampleWorkspace("ws-seam");
  workspace.boards[0].spaceActivities = [{ id: "sa-1" }];
  workspace.boards[0].theme = { base: "paper" };
  workspace.boards[0].spaces = [
    { id: "space-1", title: "空间", objectId: "obj-1" },
  ];
  workspace.history.undo.push({
    id: "h-2",
    intentId: "intent-2",
    label: "批量改动",
    at: 1900,
    author: "agent",
    patch: { target: "batch", id: "batch-1", before: null, after: null },
  });

  store.save(workspace);
  const loaded = store.load("ws-seam").workspace;
  assert.deepEqual(loaded.boards[0].spaceActivities, [{ id: "sa-1" }]);
  assert.deepEqual(loaded.boards[0].theme, { base: "paper" });
  assert.equal(loaded.boards[0].spaces[0].objectId, "obj-1");
  assert.equal(loaded.history.undo[1].patch.target, "batch");
});
