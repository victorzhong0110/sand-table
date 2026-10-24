// 类型版本迁移运行时的验收。
//
// 任务卡：docs/kernel-v3/tasks/T26-type-migrations.md
// 契约：docs/kernel-v3/05-delivery-contracts.md §3（T26 那段）
//
// 场景：一个内置包把自己的卡片类型从 v1 升到 v3，中间两步迁移。
// 旧对象读出来是新结构，库里还是旧结构；改过之后才落盘成新结构。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyCommands,
  boardContents,
  changesSince,
  CommandError,
  createRegistry,
  migrateData,
  openWorkspaceDb,
  PackSpecError,
  query,
  readObjects,
  redo,
  syncPacks,
  undo,
  type Actor,
  type Db,
  type ObjectRow,
  type Registry,
} from "../kernel/index.ts";

const KERNEL = fileURLToPath(new URL("../kernel/index.ts", import.meta.url));

const agent: Actor = { id: "codex", kind: "agent" };
const human: Actor = { id: "hui", kind: "human" };

type Migrate = (data: Record<string, unknown>) => Record<string, unknown>;
type Migration = { from: number; migrate: Migrate };

/** v1 的卡片：只有 name。 */
const V1_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" } },
};

/** v3 的卡片：name 改名成 label，多一个 n。 */
const V3_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    n: { type: "integer" },
  },
};

/** v1 → v2：补一个 n。 */
const toV2: Migrate = (data) => ({ name: data.name, n: 0 });
/** v2 → v3：name 改名成 label。 */
const toV3: Migrate = (data) => ({ label: data.name, n: data.n });

function demoPack(options: {
  cardVersion: number;
  cardSchema: Record<string, unknown>;
  cardSummary: string[];
  migrations?: Migration[];
}) {
  return {
    id: "demo",
    title: "演示",
    version: 1,
    types: [
      {
        type: "demo.board",
        title: "白板",
        description: "一块白板",
        icon: "board",
        version: 1,
        schema: { type: "object", additionalProperties: false, properties: {} },
        capabilities: { container: true },
        display: {
          material: "container",
          defaultSize: { width: 800, height: 600 },
        },
      },
      {
        type: "demo.card",
        title: "卡片",
        description: "一张卡片",
        icon: "note",
        version: options.cardVersion,
        schema: options.cardSchema,
        display: {
          material: "paper",
          defaultSize: { width: 200, height: 120 },
          summary: options.cardSummary,
        },
        ...(options.migrations ? { migrations: options.migrations } : {}),
      },
    ],
  };
}

/** 升级前的包：卡片是 v1，没有迁移函数。 */
const v1Pack = demoPack({
  cardVersion: 1,
  cardSchema: V1_SCHEMA,
  cardSummary: ["name"],
});

/** 升级后的包：卡片是 v3，两步迁移。 */
const v3Pack = demoPack({
  cardVersion: 3,
  cardSchema: V3_SCHEMA,
  cardSummary: ["label"],
  migrations: [
    { from: 1, migrate: toV2 },
    { from: 2, migrate: toV3 },
  ],
});

type Scene = {
  db: Db;
  registry: Registry;
  file: string;
  close: () => void;
};

/** 一个装着 v1 卡片包的工作空间。 */
function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), "sand-migrate-"));
  const file = join(dir, "workspace.db");
  const db = openWorkspaceDb(file, {
    create: true,
    workspaceId: "demo",
    title: "迁移演示",
  });
  const registry = createRegistry();
  registry.registerPack(v1Pack, "builtin");
  syncPacks(db, registry, agent);
  const close = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    return { db, registry, file, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** 建一张 v1 的卡片。 */
function createCard(db: Db, registry: Registry, title = "旧标题") {
  const result = applyCommands(db, registry, {
    actor: agent,
    intentId: "create-card",
    commands: [
      {
        op: "object.create",
        type: "demo.card",
        title,
        data: { name: "甲" },
      },
    ],
  });
  return result.created["0"]!;
}

/** 库里的那一行：迁移只在内存里做，这里能看到真实落盘的东西。 */
function stored(db: Db, id: string) {
  const row = db
    .prepare("SELECT type_version, data FROM objects WHERE id = ?")
    .get(id) as { type_version: number; data: string };
  return {
    typeVersion: Number(row.type_version),
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

test("旧对象读出来是新结构，库里还是旧结构", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(v3Pack, "builtin");
    const read = readObjects(db, registry, [id], {});
    assert.equal(read.objects.length, 1);
    const card = read.objects[0]!;
    assert.deepEqual(card.data, { label: "甲", n: 0 });
    assert.equal(card.typeVersion, 3);
    assert.equal(card.migrationError, undefined);
    assert.equal(card.typeAvailable, true);
    const row = stored(db, id);
    assert.equal(row.typeVersion, 1);
    assert.deepEqual(row.data, { name: "甲" });
  } finally {
    close();
  }
});

test("改一个字段就落盘成新结构，撤销后回到旧结构", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(v3Pack, "builtin");
    applyCommands(db, registry, {
      actor: agent,
      intentId: "edit-card",
      commands: [{ op: "object.update", id, set: { n: 7 } }],
    });
    const row = stored(db, id);
    assert.equal(row.typeVersion, 3);
    assert.deepEqual(row.data, { label: "甲", n: 7 });
    undo(db, agent);
    const back = stored(db, id);
    assert.equal(back.typeVersion, 1);
    assert.deepEqual(back.data, { name: "甲" });
    const read = readObjects(db, registry, [id], {});
    assert.deepEqual(read.objects[0]!.data, { label: "甲", n: 0 });
    assert.equal(read.objects[0]!.typeVersion, 3);
  } finally {
    close();
  }
});

test("缺少一步迁移：读出原数据并带原因，改数据被拒，改标题成功", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 3,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [{ from: 1, migrate: toV2 }],
      }),
      "builtin",
    );
    const read = readObjects(db, registry, [id], {});
    const card = read.objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.ok(card.migrationError, "缺一步迁移要有原因");
    assert.match(card.migrationError!, /缺少从版本 2 升到 3 的迁移函数/);
    assert.match(card.migrationError!, /仍是版本 1/);
    assert.equal(/停在版本/.test(card.migrationError!), false);
    assert.equal(card.typeAvailable, true, "迁移失败不改类型是否可用");
    assert.throws(
      () =>
        applyCommands(db, registry, {
          actor: agent,
          intentId: "edit-card",
          commands: [{ op: "object.update", id, set: { n: 7 } }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "INVALID_DATA");
        assert.match(error.message, /迁移失败/);
        assert.match(error.message, /缺少从版本 2 升到 3 的迁移函数/);
        return true;
      },
    );
    const row = stored(db, id);
    assert.equal(row.typeVersion, 1);
    assert.deepEqual(row.data, { name: "甲" });
    applyCommands(db, registry, {
      actor: agent,
      intentId: "rename-card",
      commands: [{ op: "object.update", id, title: "新标题" }],
    });
    const renamed = stored(db, id);
    assert.equal(renamed.typeVersion, 1, "只改标题时保留旧的类型版本");
    assert.deepEqual(renamed.data, { name: "甲" });
    assert.equal(
      readObjects(db, registry, [id], {}).objects[0]!.title,
      "新标题",
    );
  } finally {
    close();
  }
});

test("类型升了版却没写迁移函数：读出原数据并带原因，改数据被拒，改标题成功", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    // 包把卡片的版本从 1 加到 2，却忘了补 migrations。
    registry.registerPack(
      demoPack({
        cardVersion: 2,
        cardSchema: V1_SCHEMA,
        cardSummary: ["name"],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1, "迁移没成功时不许谎报版本");
    assert.ok(card.migrationError, "没写迁移函数也要有原因");
    assert.match(card.migrationError!, /缺少从版本 1 升到 2 的迁移函数/);
    assert.throws(
      () =>
        applyCommands(db, registry, {
          actor: agent,
          intentId: "edit-card",
          commands: [{ op: "object.update", id, set: { name: "乙" } }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "INVALID_DATA");
        assert.match(error.message, /缺少从版本 1 升到 2 的迁移函数/);
        return true;
      },
    );
    const row = stored(db, id);
    assert.equal(row.typeVersion, 1);
    assert.deepEqual(row.data, { name: "甲" }, "改数据被拒后原数据不许动");
    applyCommands(db, registry, {
      actor: agent,
      intentId: "rename-card",
      commands: [{ op: "object.update", id, title: "新标题" }],
    });
    const renamed = stored(db, id);
    assert.equal(renamed.typeVersion, 1, "只改标题时保留旧的类型版本");
    assert.deepEqual(renamed.data, { name: "甲" });
    assert.equal(
      readObjects(db, registry, [id], {}).objects[0]!.title,
      "新标题",
    );
  } finally {
    close();
  }
});

test("迁移函数抛错：原数据不变，改数据被拒，改标题成功", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 3,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          { from: 1, migrate: toV2 },
          {
            from: 2,
            migrate: () => {
              throw new Error("转换炸了");
            },
          },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.match(card.migrationError!, /迁移函数抛错：转换炸了/);
    assert.match(card.migrationError!, /仍是版本 1/);
    assert.equal(
      /停在版本/.test(card.migrationError!),
      false,
      "中间步骤失败时不能说数据停在那一版",
    );
    assert.throws(
      () =>
        applyCommands(db, registry, {
          actor: agent,
          intentId: "edit-card",
          commands: [{ op: "object.update", id, set: { n: 7 } }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "INVALID_DATA");
        return true;
      },
    );
    const row = stored(db, id);
    assert.equal(row.typeVersion, 1);
    assert.deepEqual(row.data, { name: "甲" });
    applyCommands(db, registry, {
      actor: agent,
      intentId: "rename-card",
      commands: [{ op: "object.update", id, title: "新标题" }],
    });
    assert.equal(stored(db, id).typeVersion, 1);
  } finally {
    close();
  }
});

test("迁移函数返回的不是对象：原数据不变", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 3,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          { from: 1, migrate: toV2 },
          {
            from: 2,
            migrate: () => "不是对象" as unknown as Record<string, unknown>,
          },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.match(card.migrationError!, /结果不是普通对象/);
    assert.match(card.migrationError!, /仍是版本 1/);
    assert.throws(
      () =>
        applyCommands(db, registry, {
          actor: agent,
          intentId: "edit-card",
          commands: [{ op: "object.update", id, set: { n: 7 } }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "INVALID_DATA");
        return true;
      },
    );
    assert.deepEqual(stored(db, id).data, { name: "甲" });
  } finally {
    close();
  }
});

test("迁移函数返回 Date：原数据不变", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 2,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          {
            from: 1,
            migrate: () => new Date(0) as unknown as Record<string, unknown>,
          },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.match(card.migrationError!, /结果不是普通对象/);
    assert.deepEqual(stored(db, id).data, { name: "甲" });
  } finally {
    close();
  }
});

test("迁移结果不能原样保存成 JSON：原数据不变", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 2,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          {
            from: 1,
            migrate: (data) =>
              ({
                label: data.name,
                n: 0,
                when: new Date(0),
              }) as Record<string, unknown>,
          },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.match(card.migrationError!, /无法原样保存成 JSON/);
    assert.throws(
      () =>
        applyCommands(db, registry, {
          actor: agent,
          intentId: "edit-card",
          commands: [{ op: "object.update", id, set: { n: 7 } }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.code, "INVALID_DATA");
        assert.match(error.message, /无法原样保存成 JSON/);
        return true;
      },
    );
    assert.deepEqual(stored(db, id).data, { name: "甲" });
  } finally {
    close();
  }
});

test("迁移结果超过 1 MB：原数据不变", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 2,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          {
            from: 1,
            migrate: (data) => ({
              label: data.name,
              n: 0,
              pad: "x".repeat(1024 * 1024),
            }),
          },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.match(card.migrationError!, /超过 1 MB/);
    assert.equal(/不符合/.test(card.migrationError!), false);
    assert.deepEqual(stored(db, id).data, { name: "甲" });
  } finally {
    close();
  }
});

test("迁移函数改了入参：库里的原数据不受影响", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 3,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          {
            from: 1,
            migrate: (data) => {
              data.name = "被改坏了";
              return { name: data.name, n: 0 };
            },
          },
          { from: 2, migrate: toV3 },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { label: "被改坏了", n: 0 });
    assert.equal(card.typeVersion, 3);
    const row = stored(db, id);
    assert.equal(row.typeVersion, 1);
    assert.deepEqual(row.data, { name: "甲" });
  } finally {
    close();
  }
});

test("迁移函数拿到的是深拷贝", () => {
  const registry = createRegistry();
  let input: Record<string, unknown> | null = null;
  registry.registerPack(
    demoPack({
      cardVersion: 2,
      cardSchema: V1_SCHEMA,
      cardSummary: ["name"],
      migrations: [
        {
          from: 1,
          migrate: (data) => {
            input = data;
            const meta = data.meta as { k: number };
            meta.k = 9;
            data.name = "改坏了";
            return { name: data.name };
          },
        },
      ],
    }),
    "builtin",
  );
  const row: ObjectRow = {
    id: "card-1",
    type: "demo.card",
    typeVersion: 1,
    title: "卡片",
    data: { name: "甲", meta: { k: 1 } },
    source: null,
    version: 1,
    createdAt: 0,
    createdBy: "codex",
    updatedAt: 0,
    updatedBy: "codex",
    rev: 1,
    deleted: false,
  };
  const result = migrateData(registry, row);
  assert.deepEqual(
    row.data,
    { name: "甲", meta: { k: 1 } },
    "内核手里的原数据没有被改",
  );
  assert.deepEqual(result.data, { name: "改坏了" });
  assert.equal(result.typeVersion, 2);
  assert.equal(result.error, undefined);
  assert.notEqual(input, row.data, "迁移函数拿到的不是内核那一份数据");
  assert.notEqual(result.data, input, "返回的是保存用的副本");
});

test("未来版本不降级", () => {
  const { db, registry, close } = scene();
  try {
    // 先用更高的版本建对象，再换上旧的包：数据比当前版本还新。
    registry.registerPack(
      demoPack({
        cardVersion: 5,
        cardSchema: V1_SCHEMA,
        cardSummary: ["name"],
      }),
      "builtin",
    );
    const id = createCard(db, registry);
    assert.equal(stored(db, id).typeVersion, 5);
    registry.registerPack(v3Pack, "builtin");
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" }, "比当前版本还新的数据不降级");
    assert.equal(card.typeVersion, 5);
    assert.equal(card.migrationError, undefined);
  } finally {
    close();
  }
});

test("迁移后的数据不符合当前 Schema：读出原数据并带原因", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(
      demoPack({
        cardVersion: 3,
        cardSchema: V3_SCHEMA,
        cardSummary: ["label"],
        migrations: [
          { from: 1, migrate: toV2 },
          { from: 2, migrate: (data) => ({ label: 42, n: data.n }) },
        ],
      }),
      "builtin",
    );
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { name: "甲" });
    assert.equal(card.typeVersion, 1);
    assert.match(card.migrationError!, /迁移后的数据不符合/);
  } finally {
    close();
  }
});

test("摘要、整块白板和增量都用迁移后的数据", () => {
  const { db, registry, close } = scene();
  try {
    const boardId = applyCommands(db, registry, {
      actor: agent,
      intentId: "make-board",
      commands: [
        { op: "object.create", type: "demo.board", title: "板", data: {} },
      ],
    }).created["0"]!;
    const id = createCard(db, registry);
    applyCommands(db, registry, {
      actor: agent,
      intentId: "place-card",
      commands: [
        { op: "presentation.create", boardId, objectId: id, x: 1, y: 1 },
      ],
    });
    registry.registerPack(v3Pack, "builtin");
    const rows = query(db, registry, { types: ["demo.card"] }).rows;
    const row = rows[0]!;
    assert.equal(row.summary, "甲", "摘要要用迁移后的字段");
    assert.equal(row.typeVersion, 3);
    const contents = boardContents(db, registry, boardId);
    const card = contents.objects.find((item) => item.id === id)!;
    assert.deepEqual(card.data, { label: "甲", n: 0 });
    assert.equal(card.typeVersion, 3);
    const delta = changesSince(db, registry, 0);
    assert.equal("reset" in delta, false);
    if ("reset" in delta) return;
    const changed = delta.objects.find((item) => item.id === id)!;
    assert.deepEqual(changed.data, { label: "甲", n: 0 });
    assert.equal(changed.typeVersion, 3);
    assert.equal(stored(db, id).typeVersion, 1, "读不改库");
  } finally {
    close();
  }
});

test("撤销重做之后再读，读到的仍是迁移后的结构", () => {
  const { db, registry, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(v3Pack, "builtin");
    applyCommands(db, registry, {
      actor: agent,
      intentId: "edit-card",
      commands: [{ op: "object.update", id, set: { n: 7 } }],
    });
    undo(db, agent);
    assert.deepEqual(stored(db, id).data, { name: "甲" });
    assert.equal(stored(db, id).typeVersion, 1);
    assert.deepEqual(readObjects(db, registry, [id], {}).objects[0]!.data, {
      label: "甲",
      n: 0,
    });
    redo(db, agent);
    assert.deepEqual(stored(db, id).data, { label: "甲", n: 7 });
    assert.equal(stored(db, id).typeVersion, 3);
    const card = readObjects(db, registry, [id], {}).objects[0]!;
    assert.deepEqual(card.data, { label: "甲", n: 7 });
    assert.equal(card.typeVersion, 3);
  } finally {
    close();
  }
});

test("另一个进程增量读到的也是迁移后的数据", async () => {
  const { db, registry, file, close } = scene();
  try {
    const id = createCard(db, registry);
    registry.registerPack(v3Pack, "builtin");
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childSource,
      ],
      {
        env: { ...process.env, SAND_DB: file, SAND_SINCE: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });
    assert.equal(code, 0, `子进程没跑成功：${stderr}`);
    const changes = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      objects: { id: string; data: unknown; typeVersion: number }[];
    };
    const card = changes.objects.find((item) => item.id === id)!;
    assert.deepEqual(card.data, { label: "甲", n: 0 });
    assert.equal(card.typeVersion, 3);
  } finally {
    close();
  }
});

test("数据包不能带迁移函数", () => {
  assert.throws(
    () =>
      createRegistry().registerPack(
        {
          format: "sand-table-pack",
          formatVersion: 2,
          ...v3Pack,
        },
        "data",
      ),
    (error: unknown) => {
      assert.ok(error instanceof PackSpecError);
      assert.ok(
        error.problems.some(
          (problem) =>
            problem.path === "/types/1/migrations" &&
            problem.message === "数据包的类型不能带迁移函数。",
        ),
        JSON.stringify(error.problems),
      );
      return true;
    },
  );
});

/** 子进程：打开同一个库，增量读一次。 */
const childSource = `
import { createRegistry, openWorkspaceDb, changesSince } from ${JSON.stringify(KERNEL)};
const registry = createRegistry();
registry.registerPack(
  {
    id: "demo",
    title: "演示",
    version: 1,
    types: [
      {
        type: "demo.card",
        title: "卡片",
        description: "一张卡片",
        icon: "note",
        version: 3,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string" }, n: { type: "integer" } },
        },
        display: {
          material: "paper",
          defaultSize: { width: 200, height: 120 },
          summary: ["label"],
        },
        migrations: [
          { from: 1, migrate: (data) => ({ name: data.name, n: 0 }) },
          { from: 2, migrate: (data) => ({ label: data.name, n: data.n }) },
        ],
      },
    ],
  },
  "builtin",
);
const db = openWorkspaceDb(process.env.SAND_DB, { create: false });
const changes = changesSince(db, registry, Number(process.env.SAND_SINCE));
console.log(JSON.stringify(changes));
db.close();
`;
