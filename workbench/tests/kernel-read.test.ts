import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyCommands,
  boardContents,
  changesSince,
  CommandError,
  context,
  createRegistry,
  getMeta,
  listTypes,
  openWorkspaceDb,
  query,
  readObjects,
  setActivity,
  setMeta,
  setView,
  status,
  summarize,
  undo,
  type Actor,
  type Db,
  type Registry,
  type TypeSpec,
} from "../kernel/index.ts";

const human: Actor = { id: "hui", kind: "human" };
const agent: Actor = { id: "codex", kind: "agent" };

function manifest() {
  return {
    format: "sand-table-pack",
    formatVersion: 2,
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
        version: 1,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            blurb: { type: "string" },
            age: { type: "integer", minimum: 0 },
            traits: { type: "array", items: { type: "string" } },
          },
        },
        display: {
          material: "paper",
          defaultSize: { width: 200, height: 120 },
          summary: ["blurb", "age", "traits"],
        },
      },
    ],
    relationKinds: [
      {
        kind: "demo.link",
        title: "关联",
        inverseTitle: "被关联",
        allowsInferred: true,
      },
    ],
    templates: [{ id: "demo.blank", title: "空白", commands: [] }],
  };
}

type Scene = {
  db: Db;
  registry: Registry;
  close: () => void;
};

function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), "sand-read-"));
  const db = openWorkspaceDb(join(dir, "workspace.db"), {
    create: true,
    workspaceId: "demo",
    title: "演示空间",
  });
  const registry = createRegistry();
  const close = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    applyCommands(db, registry, {
      actor: agent,
      intentId: "setup-pack",
      commands: [{ op: "pack.import", manifest: manifest() }],
    });
    return { db, registry, close };
  } catch (error) {
    close();
    throw error;
  }
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "sand-read-fresh-"));
  const db = openWorkspaceDb(join(dir, "workspace.db"), {
    create: true,
    workspaceId: "fresh",
    title: "新空间",
  });
  return {
    db,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("新库的状态包含首页白板、包列表和修订号 0", () => {
  const { db, close } = fresh();
  try {
    const homeId = getMeta(db, "home_board_id");
    const result = status(db, createRegistry());
    assert.equal(result.workspace.id, "fresh");
    assert.equal(result.workspace.title, "新空间");
    assert.equal(result.workspace.revision, 0);
    assert.equal(result.homeBoardId, homeId);
    assert.deepEqual(result.packs, []);
    assert.deepEqual(result.tips, [
      "Call sand_types before creating objects of a type you have not used.",
      "Call sand_context to see what the person is looking at.",
    ]);
    assert.equal(result.boards.length, 1);
    assert.equal(result.boards[0]?.id, homeId);
    assert.equal(result.boards[0]?.title, "首页");
    assert.equal(result.boards[0]?.presentations, 0);
  } finally {
    close();
  }
});

test("查询按白板、类型、文字和关系过滤，分页不重复，已删除的查不到", () => {
  const { db, registry, close } = scene();
  try {
    const made = applyCommands(db, registry, {
      actor: agent,
      intentId: "layout",
      commands: [
        {
          op: "object.create",
          ref: "board",
          type: "demo.board",
          title: "甲白板",
          data: {},
        },
        {
          op: "object.create",
          ref: "other",
          type: "demo.board",
          title: "乙白板",
          data: {},
        },
        {
          op: "object.create",
          ref: "lin",
          type: "demo.card",
          title: "林舟",
          data: { blurb: "住在海边" },
        },
        {
          op: "object.create",
          ref: "percent",
          type: "demo.card",
          title: "100%",
          data: {},
        },
        {
          op: "object.create",
          ref: "plain",
          type: "demo.card",
          title: "100",
          data: {},
        },
        {
          op: "object.create",
          ref: "score",
          type: "demo.card",
          title: "a_b",
          data: {},
        },
        {
          op: "object.create",
          ref: "wide",
          type: "demo.card",
          title: "aXb",
          data: {},
        },
        {
          op: "presentation.create",
          boardId: "@board",
          objectId: "@lin",
          x: 1,
          y: 2,
          width: 80,
          height: 40,
        },
        {
          op: "presentation.create",
          boardId: "@other",
          objectId: "@percent",
          x: 1,
          y: 2,
          width: 80,
          height: 40,
        },
        {
          op: "relation.create",
          kind: "demo.link",
          sourceId: "@lin",
          targetId: "@percent",
        },
      ],
    });
    const boardId = made.created.board!;
    const lin = made.created.lin!;
    const percent = made.created.percent!;
    const removed = applyCommands(db, registry, {
      actor: agent,
      intentId: "remove-one",
      commands: [
        { op: "object.create", type: "demo.card", title: "要删的", data: {} },
      ],
    });
    const removedId = removed.created["0"]!;
    applyCommands(db, registry, {
      actor: agent,
      intentId: "delete-one",
      commands: [{ op: "object.delete", id: removedId }],
    });

    const onBoard = query(db, registry, { boardId });
    assert.deepEqual(
      onBoard.rows.map((row) => row.id),
      [lin],
    );

    const cards = query(db, registry, { types: ["demo.card"], order: "title" });
    assert.ok(cards.rows.every((row) => row.type === "demo.card"));
    assert.ok(cards.rows.some((row) => row.id === lin));
    assert.equal(
      cards.rows.find((row) => row.id === removedId),
      undefined,
    );

    const chinese = query(db, registry, { text: "海边" });
    assert.deepEqual(
      chinese.rows.map((row) => row.id),
      [lin],
    );
    const percents = query(db, registry, { text: "%" });
    assert.deepEqual(
      percents.rows.map((row) => row.id),
      [percent],
    );
    const underscores = query(db, registry, { text: "_" });
    assert.deepEqual(
      underscores.rows.map((row) => row.id),
      [made.created.score!],
    );
    const folded = query(db, registry, { text: "axb" });
    assert.deepEqual(
      folded.rows.map((row) => row.id),
      [made.created.wide!],
    );

    const related = query(db, registry, {
      relatedTo: { id: lin, kind: "demo.link", direction: "out" },
    });
    assert.deepEqual(
      related.rows.map((row) => row.id),
      [percent],
    );

    const summary = cards.rows.find((row) => row.id === lin);
    assert.equal(summary?.summary, "住在海边");
    assert.equal(summary?.typeAvailable, true);

    const numbered = applyCommands(db, registry, {
      actor: agent,
      intentId: "age",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "数字",
          data: { age: 0 },
        },
        {
          op: "object.create",
          type: "demo.card",
          title: "列表",
          data: { traits: ["冷静", "慢"] },
        },
        {
          op: "object.create",
          type: "demo.card",
          title: "长摘要",
          data: {
            blurb: `## 海边 **很**静 [见](http://x.test) ${"字".repeat(180)}`,
          },
        },
      ],
    });
    const ageId = numbered.created["0"]!;
    const listId = numbered.created["1"]!;
    const longId = numbered.created["2"]!;
    const summarized = query(db, registry, { types: ["demo.card"], limit: 50 });
    assert.equal(summarized.rows.find((row) => row.id === ageId)?.summary, "0");
    assert.equal(
      summarized.rows.find((row) => row.id === listId)?.summary,
      "冷静、慢",
    );
    const longSummary = summarized.rows.find(
      (row) => row.id === longId,
    )?.summary;
    assert.equal(longSummary?.startsWith("海边 很静 见"), true);
    assert.equal(Array.from(longSummary ?? "").length, 160);

    const pageSize = 3;
    const first = query(db, registry, {
      types: ["demo.card"],
      order: "title",
      limit: pageSize,
    });
    assert.ok(first.nextCursor);
    const second = query(db, registry, {
      types: ["demo.card"],
      order: "title",
      limit: pageSize,
      cursor: first.nextCursor ?? undefined,
    });
    const all = query(db, registry, {
      types: ["demo.card"],
      order: "title",
      limit: 50,
    });
    const paged = [...first.rows, ...second.rows];
    const rest = all.rows.slice(pageSize);
    assert.deepEqual(
      second.rows.map((row) => row.id),
      rest.slice(0, pageSize).map((row) => row.id),
    );
    assert.equal(new Set(paged.map((row) => row.id)).size, paged.length);
    assert.deepEqual(
      paged.map((row) => row.id),
      all.rows.slice(0, paged.length).map((row) => row.id),
    );
    assert.equal(first.total, all.total);
    assert.equal(
      all.rows.some((row) => row.id === removedId),
      false,
    );
    const pages = [first];
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = query(db, registry, {
        types: ["demo.card"],
        order: "title",
        limit: pageSize,
        cursor,
      });
      pages.push(page);
      cursor = page.nextCursor;
    }
    const joined = pages.flatMap((page) => page.rows.map((row) => row.id));
    assert.deepEqual(
      joined,
      all.rows.map((row) => row.id),
    );
    assert.equal(new Set(joined).size, joined.length);
  } finally {
    close();
  }
});

test("读取对象时截断长文字，偏移能续读，不存在的 id 记在 missing", () => {
  const { db, registry, close } = scene();
  try {
    const text = "一二三四五六七八九十";
    const made = applyCommands(db, registry, {
      actor: agent,
      intentId: "long",
      commands: [
        {
          op: "object.create",
          ref: "board",
          type: "demo.board",
          title: "白板",
          data: {},
        },
        {
          op: "object.create",
          ref: "card",
          type: "demo.card",
          title: "长文",
          data: { blurb: text, age: 4 },
        },
        {
          op: "object.create",
          ref: "other",
          type: "demo.card",
          title: "对方",
          data: {},
        },
        {
          op: "presentation.create",
          ref: "placed",
          boardId: "@board",
          objectId: "@card",
          x: 3,
          y: 4,
          width: 80,
          height: 40,
        },
        {
          op: "relation.create",
          kind: "demo.link",
          sourceId: "@card",
          targetId: "@other",
        },
      ],
    });
    const cardId = made.created.card!;
    const read = readObjects(db, registry, [cardId, "missing-id"], {
      textLimit: 4,
    });
    assert.deepEqual(read.missing, ["missing-id"]);
    assert.equal(read.objects.length, 1);
    const object = read.objects[0]!;
    assert.equal(object.data.blurb, "一二三四");
    assert.equal(object.data.age, 4);
    assert.deepEqual(object.truncated, [{ field: "blurb", totalLength: 10 }]);
    assert.equal(object.presentations.length, 1);
    assert.equal(object.presentations[0]?.boardTitle, "白板");
    assert.equal(object.relations.length, 1);
    assert.equal(object.relations[0]?.direction, "out");
    assert.equal(object.relations[0]?.otherId, made.created.other);
    assert.equal(object.relations[0]?.otherTitle, "对方");

    const rest = readObjects(db, registry, [cardId], {
      textLimit: 4,
      textOffset: { id: cardId, field: "blurb", offset: 4 },
      include: ["presentations"],
    });
    assert.equal(rest.objects[0]?.data.blurb, "五六七八");
    assert.deepEqual(rest.objects[0]?.truncated, [
      { field: "blurb", totalLength: 10 },
    ]);
    assert.equal(rest.objects[0]?.presentations.length, 1);
    assert.deepEqual(rest.objects[0]?.relations, []);

    const targets = applyCommands(db, registry, {
      actor: agent,
      intentId: "many",
      commands: Array.from({ length: 51 }, (_, index) => ({
        op: "object.create" as const,
        ref: `n${index}`,
        type: "demo.card",
        title: `关系${index}`,
        data: {},
      })),
    });
    applyCommands(db, registry, {
      actor: agent,
      intentId: "link-many",
      commands: Array.from({ length: 51 }, (_, index) => ({
        op: "relation.create" as const,
        kind: "demo.link",
        sourceId: cardId,
        targetId: targets.created[`n${index}`]!,
      })),
    });
    const capped = readObjects(db, registry, [cardId], {
      include: ["relations"],
    });
    assert.equal(capped.objects[0]?.relations.length, 50);
  } finally {
    close();
  }
});

test("白板内容只含这块板上的展示、对象，以及两端都在板上的关系", () => {
  const { db, registry, close } = scene();
  try {
    const made = applyCommands(db, registry, {
      actor: agent,
      intentId: "boards",
      commands: [
        {
          op: "object.create",
          ref: "a",
          type: "demo.board",
          title: "甲",
          data: {},
        },
        {
          op: "object.create",
          ref: "b",
          type: "demo.board",
          title: "乙",
          data: {},
        },
        {
          op: "object.create",
          ref: "one",
          type: "demo.card",
          title: "一",
          data: {},
        },
        {
          op: "object.create",
          ref: "two",
          type: "demo.card",
          title: "二",
          data: {},
        },
        {
          op: "object.create",
          ref: "three",
          type: "demo.card",
          title: "三",
          data: {},
        },
        {
          op: "presentation.create",
          boardId: "@a",
          objectId: "@one",
          x: 1,
          y: 1,
          width: 40,
          height: 40,
        },
        {
          op: "presentation.create",
          boardId: "@a",
          objectId: "@two",
          x: 2,
          y: 2,
          width: 40,
          height: 40,
        },
        {
          op: "presentation.create",
          boardId: "@b",
          objectId: "@three",
          x: 3,
          y: 3,
          width: 40,
          height: 40,
        },
        {
          op: "presentation.create",
          boardId: "@b",
          objectId: "@one",
          x: 4,
          y: 4,
          width: 40,
          height: 40,
        },
        {
          op: "relation.create",
          kind: "demo.link",
          sourceId: "@one",
          targetId: "@two",
        },
        {
          op: "relation.create",
          kind: "demo.link",
          sourceId: "@one",
          targetId: "@three",
        },
        { op: "setting.set", key: "demo.theme", value: { mode: "夜" } },
      ],
    });
    const contents = boardContents(db, registry, made.created.a!);
    assert.equal(contents.revision, Number(getMeta(db, "revision")));
    assert.equal(contents.board.id, made.created.a);
    assert.equal(contents.board.title, "甲");
    assert.equal(contents.presentations.length, 2);
    assert.deepEqual(
      contents.objects.map((item) => item.id).sort(),
      [made.created.one, made.created.two].sort(),
    );
    assert.equal(contents.relations.length, 1);
    assert.equal(contents.relations[0]?.sourceId, made.created.one);
    assert.equal(contents.relations[0]?.targetId, made.created.two);
    assert.ok(contents.objects.every((item) => item.rev <= contents.revision));
    assert.deepEqual(
      contents.settings.find((item) => item.key === "demo.theme")?.value,
      { mode: "夜" },
    );
    assert.equal(
      contents.packs.find((item) => item.id === "demo")?.enabled,
      true,
    );
  } finally {
    close();
  }
});

test("增量只含中间修订号之后的行和墓碑，地板抬高后要求整板重读", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor: agent,
      intentId: "create-two",
      commands: [
        {
          op: "object.create",
          ref: "a",
          type: "demo.card",
          title: "甲",
          data: {},
        },
        {
          op: "object.create",
          ref: "b",
          type: "demo.card",
          title: "乙",
          data: {},
        },
      ],
    });
    const middle = created.revision;
    applyCommands(db, registry, {
      actor: agent,
      intentId: "rename",
      commands: [
        { op: "object.update", id: created.created.a!, title: "甲改" },
      ],
    });
    applyCommands(db, registry, {
      actor: agent,
      intentId: "drop",
      commands: [{ op: "object.delete", id: created.created.b! }],
    });
    const delta = changesSince(db, registry, middle);
    assert.equal("reset" in delta, false);
    if ("reset" in delta) return;
    assert.equal(delta.revision, Number(getMeta(db, "revision")));
    assert.deepEqual(
      delta.objects.map((item) => ({
        id: item.id,
        title: item.title,
        deleted: item.deleted,
      })),
      [
        { id: created.created.a, title: "甲改", deleted: false },
        { id: created.created.b, title: "乙", deleted: true },
      ],
    );
    assert.deepEqual(delta.presentations, []);
    assert.deepEqual(delta.relations, []);
    assert.deepEqual(delta.settings, []);
    assert.deepEqual(delta.packs, []);
    assert.ok(
      delta.objects.every(
        (item) => item.rev > middle && item.rev <= delta.revision,
      ),
    );
    setMeta(db, "tombstone_floor", String(delta.revision + 1));
    const reset = changesSince(db, registry, middle);
    assert.deepEqual(reset, { reset: true, revision: delta.revision });
  } finally {
    close();
  }
});

test("设置和组件包的全量读取与墓碑来自同一次修订号快照", () => {
  const { db, registry, close } = scene();
  try {
    const boardId = applyCommands(db, registry, {
      actor: agent,
      intentId: "board",
      commands: [
        { op: "object.create", type: "demo.board", title: "板", data: {} },
      ],
    }).created["0"]!;
    const beforeSetting = Number(getMeta(db, "revision"));
    applyCommands(db, registry, {
      actor: human,
      intentId: "theme",
      commands: [{ op: "setting.set", key: "demo.flag", value: { on: true } }],
    });
    const loaded = boardContents(db, registry, boardId);
    assert.equal(loaded.revision, Number(getMeta(db, "revision")));
    assert.deepEqual(
      loaded.settings.find((item) => item.key === "demo.flag")?.value,
      { on: true },
    );
    assert.equal(
      loaded.packs.some((item) => item.id === "demo"),
      true,
    );
    const sinceCreate = changesSince(db, registry, 0);
    assert.equal("reset" in sinceCreate, false);
    if ("reset" in sinceCreate) return;
    assert.equal(
      sinceCreate.settings.some(
        (item) => item.key === "demo.flag" && !item.deleted,
      ),
      true,
    );
    assert.equal(
      sinceCreate.packs.some((item) => item.id === "demo" && !item.deleted),
      true,
    );
    assert.ok(
      sinceCreate.objects.every((item) => item.rev <= sinceCreate.revision),
    );
    undo(db, human);
    const undone = changesSince(db, registry, beforeSetting);
    assert.equal("reset" in undone, false);
    if ("reset" in undone) return;
    assert.equal(
      undone.settings.find((item) => item.key === "demo.flag")?.deleted,
      true,
    );
    assert.equal(
      boardContents(db, registry, boardId).settings.some(
        (item) => item.key === "demo.flag",
      ),
      false,
    );
    const removedAt = Number(getMeta(db, "revision"));
    applyCommands(db, registry, {
      actor: agent,
      intentId: "drop-pack",
      commands: [{ op: "pack.remove", id: "demo" }],
    });
    const packs = changesSince(db, registry, removedAt);
    assert.equal("reset" in packs, false);
    if ("reset" in packs) return;
    assert.equal(packs.packs.find((item) => item.id === "demo")?.deleted, true);
    assert.equal(
      boardContents(db, registry, boardId).packs.some(
        (item) => item.id === "demo",
      ),
      false,
    );
  } finally {
    close();
  }
});

test("上下文第一次返回上次之后的人工修改，第二次为空", () => {
  const { db, registry, close } = scene();
  try {
    const made = applyCommands(db, registry, {
      actor: agent,
      intentId: "seed",
      commands: [
        {
          op: "object.create",
          ref: "board",
          type: "demo.board",
          title: "主白板",
          data: {},
        },
        {
          op: "object.create",
          ref: "card",
          type: "demo.card",
          title: "原稿",
          data: {},
        },
        {
          op: "presentation.create",
          ref: "placed",
          boardId: "@board",
          objectId: "@card",
          x: 1,
          y: 1,
          width: 40,
          height: 40,
        },
      ],
    });
    const cardId = made.created.card!;
    applyCommands(db, registry, {
      actor: human,
      intentId: "human-1",
      commands: [{ op: "object.update", id: cardId, title: "第一改" }],
    });
    applyCommands(db, registry, {
      actor: human,
      intentId: "human-2",
      commands: [{ op: "object.update", id: cardId, title: "第二改" }],
    });
    applyCommands(db, registry, {
      actor: agent,
      intentId: "agent-1",
      commands: [{ op: "object.update", id: cardId, title: "代理改" }],
    });
    setView(
      db,
      {
        viewId: "view-1",
        boardId: made.created.board,
        camera: { x: 2, y: 3, zoom: 1 },
        selection: [made.created.placed!],
        navStack: [],
      },
      Date.now(),
    );
    const now = Date.now();
    setActivity(
      db,
      { id: "other", kind: "agent" },
      {
        state: "running",
        task: "在看旁边",
        action: "读",
        objectIds: [cardId, "missing"],
        boardId: made.created.board,
      },
      now,
    );
    setActivity(
      db,
      agent,
      { state: "running", task: "自己的", action: "写" },
      now,
    );
    setActivity(
      db,
      { id: "old", kind: "agent" },
      { state: "running", task: "过期了", action: "等" },
      now - 11 * 60 * 1000,
    );
    const first = context(db, agent, "view-1");
    assert.equal(first.board?.id, made.created.board);
    assert.equal(first.board?.title, "主白板");
    assert.equal(first.selection.length, 1);
    assert.equal(first.selection[0]?.objectId, cardId);
    assert.equal(first.selection[0]?.type, "demo.card");
    assert.equal(first.selection[0]?.title, "代理改");
    assert.equal(first.recentHumanEdits.length, 2);
    assert.ok(
      first.recentHumanEdits.every((item) => item.objectIds.includes(cardId)),
    );
    assert.deepEqual(
      first.otherAgents.map((item) => item.actor),
      ["other"],
    );
    assert.equal(first.revision, Number(getMeta(db, "revision")));
    const stored = db
      .prepare("SELECT object_ids FROM activities WHERE actor = 'other'")
      .get() as { object_ids: string };
    assert.deepEqual(JSON.parse(stored.object_ids), [cardId]);
    const second = context(db, agent, "view-1");
    assert.deepEqual(second.recentHumanEdits, []);
    const seq = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM history")
      .get() as {
      seq: number;
    };
    const read = db
      .prepare("SELECT history_seq FROM agent_reads WHERE actor = ?")
      .get(agent.id) as { history_seq: number };
    assert.equal(Number(read.history_seq), Number(seq.seq));
  } finally {
    close();
  }
});

test("停用组件包后类型不可用，对象仍能查到和读到", () => {
  const { db, registry, close } = scene();
  try {
    const created = applyCommands(db, registry, {
      actor: agent,
      intentId: "card",
      commands: [
        {
          op: "object.create",
          type: "demo.card",
          title: "还在",
          data: { age: 2 },
        },
      ],
    });
    const cardId = created.created["0"]!;
    const before = listTypes(db, registry);
    assert.equal("relationKinds" in before, true);
    if (!("relationKinds" in before)) return;
    assert.equal(
      before.types.find((item) => item.type === "demo.card")?.container,
      false,
    );
    assert.equal(
      before.relationKinds.some((item) => item.kind === "demo.link"),
      true,
    );
    const full = listTypes(db, registry, { types: ["demo.card"] });
    assert.equal("relationKinds" in full, false);
    if ("relationKinds" in full) return;
    assert.equal(full.types[0]?.type, "demo.card");
    assert.equal(full.types[0]?.schema.type, "object");
    applyCommands(db, registry, {
      actor: agent,
      intentId: "disable",
      commands: [{ op: "pack.disable", id: "demo" }],
    });
    const listed = listTypes(db, registry);
    if (!("relationKinds" in listed)) return;
    assert.equal(
      listed.types.some((item) => item.type === "demo.card"),
      false,
    );
    const found = query(db, registry, { types: ["demo.card"] });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0]?.id, cardId);
    assert.equal(found.rows[0]?.typeAvailable, false);
    const read = readObjects(db, registry, [cardId], {});
    assert.equal(read.objects[0]?.typeAvailable, false);
    assert.equal(read.objects[0]?.title, "还在");
    assert.equal(read.missing.length, 0);
  } finally {
    close();
  }
});

test("摘要去掉强调和代码围栏，保留标识符里的下划线", () => {
  const spec: TypeSpec = {
    type: "demo.card",
    title: "卡片",
    description: "一张卡片",
    icon: "note",
    version: 1,
    schema: { type: "object", additionalProperties: false },
    display: {
      material: "paper",
      defaultSize: { width: 200, height: 120 },
      summary: ["blurb"],
    },
  };
  assert.equal(
    summarize(
      spec,
      { blurb: "see_the_sea 和 _斜体_，还有 obj.__init__()" },
      "",
    ),
    "see_the_sea 和 斜体，还有 obj.__init__()",
  );
  assert.equal(
    summarize(spec, { blurb: "使用 ```ref``` 引用" }, ""),
    "使用 ```ref``` 引用",
  );
  assert.equal(
    summarize(spec, { blurb: "```\n**不要去掉**\n```" }, ""),
    "**不要去掉**",
  );
  assert.equal(summarize(spec, { blurb: "`a_b_c`" }, ""), "a_b_c");
});

test("活动对象超过 30 个时拒绝，过期时间按状态计算", () => {
  const { db, registry, close } = scene();
  try {
    const made = applyCommands(db, registry, {
      actor: agent,
      intentId: "one",
      commands: [
        { op: "object.create", type: "demo.card", title: "一", data: {} },
      ],
    });
    const id = made.created["0"]!;
    const now = 5_000;
    setActivity(
      db,
      agent,
      {
        state: "done",
        task: "做完了",
        action: "收尾",
        objectIds: [id, "missing"],
      },
      now,
    );
    const done = db
      .prepare(
        "SELECT object_ids, reported_at, expires_at FROM activities WHERE actor = ?",
      )
      .get(agent.id) as {
      object_ids: string;
      reported_at: number;
      expires_at: number;
    };
    assert.deepEqual(JSON.parse(done.object_ids), [id]);
    assert.equal(
      Number(done.expires_at) - Number(done.reported_at),
      2 * 60 * 1000,
    );

    setActivity(
      db,
      { id: "other", kind: "agent" },
      { state: "running", task: "还在做", action: "读" },
      now,
    );
    const running = db
      .prepare("SELECT expires_at, reported_at FROM activities WHERE actor = ?")
      .get("other") as { expires_at: number; reported_at: number };
    assert.equal(
      Number(running.expires_at) - Number(running.reported_at),
      10 * 60 * 1000,
    );

    assert.throws(
      () =>
        setActivity(
          db,
          agent,
          {
            state: "running",
            task: "太多",
            action: "看",
            objectIds: Array.from({ length: 31 }, () => id),
          },
          now + 1,
        ),
      (error: unknown) =>
        error instanceof CommandError &&
        error.code === "LIMIT" &&
        error.message.includes("30"),
    );
    const kept = db
      .prepare("SELECT task, reported_at FROM activities WHERE actor = ?")
      .get(agent.id) as { task: string; reported_at: number };
    assert.equal(kept.task, "做完了");
    assert.equal(Number(kept.reported_at), now);

    assert.throws(
      () =>
        setActivity(
          db,
          agent,
          {
            state: "running",
            task: "坏",
            action: "看",
            objectIds: "不是列表" as unknown as string[],
          },
          now + 2,
        ),
      (error: unknown) =>
        error instanceof CommandError && error.code === "INVALID_DATA",
    );
  } finally {
    close();
  }
});
