// v3 工具面的验收：任务卡 docs/kernel-v3/tasks/T20-tools-v3.md 的「验收」。
//
// 用 InMemoryTransport 把客户端和服务端接在一对内存传输上，
// 工作空间放在临时目录里，跑完就删。

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createRegistry,
  getMeta,
  openWorkspace,
  type PackSpec,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";
import { createServerV3 } from "../server/server.ts";
import { connectionConfig } from "../local/config.ts";
import { bridgeEntry } from "../local/service.ts";
import { basePack } from "../packs/base/index.ts";

const CORE_TOOLS = [
  "sand_activity",
  "sand_context",
  "sand_edit",
  "sand_history",
  "sand_query",
  "sand_read",
  "sand_status",
  "sand_types",
];

const APP_TOOLS = [
  "app_activity",
  "app_asset",
  "app_board",
  "app_changes",
  "app_edit",
  "app_history",
  "app_pack",
  "app_view",
  "app_workspace",
];

/** 起一个临时工作空间，接上客户端。 */
async function open(workspaceId = "test", packs?: PackSpec[]) {
  const root = mkdtempSync(join(tmpdir(), "sand-tools-v3-"));
  const created = createServerV3({
    workspaceRoot: root,
    workspaceId,
    ...(packs ? { packs } : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-tester", version: "1" });
  await Promise.all([
    client.connect(clientTransport),
    created.server.connect(serverTransport),
  ]);
  return {
    root,
    client,
    /** 工作空间数据库：造数据用。 */
    db: () => created.workspace()!.db,
    close: async () => {
      created.dispose();
      await client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 调一个工具，返回解析后的 JSON。 */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[])[0]?.text;
  return {
    result,
    isError: Boolean(result.isError),
    text: text ?? "",
    data: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** 模型能看到的工具：visibility 缺省或含 model，且没被停用。 */
async function modelTools(client: Client) {
  const listed = await client.listTools();
  return listed.tools
    .filter((tool) => {
      const visibility = (
        tool._meta as { ui?: { visibility?: string[] } } | undefined
      )?.ui?.visibility;
      return !visibility || visibility.includes("model");
    })
    .map((tool) => tool.name)
    .sort();
}

/** agent_reads 表里的每一行。没写过就返回空数组。 */
function readAgentReads(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): { rows: number; seqs: number[] } {
  const rows = db
    .prepare("SELECT actor, history_seq FROM agent_reads ORDER BY actor")
    .all() as { actor: string; history_seq: number }[];
  return {
    rows: rows.length,
    seqs: rows.map((row) => Number(row.history_seq)),
  };
}

test("停用领域包后，模型可见的工具正好 8 个", async () => {
  const session = await open();
  try {
    const disabled = await call(session.client, "app_edit", {
      commands: [
        { op: "pack.disable", id: "novel" },
        { op: "pack.disable", id: "research" },
      ],
    });
    assert.equal(disabled.isError, false, disabled.text);
    assert.deepEqual(await modelTools(session.client), CORE_TOOLS);
  } finally {
    await session.close();
  }
});

test("界面专用工具都在，且 visibility 是 app", async () => {
  const session = await open();
  try {
    const listed = await session.client.listTools();
    for (const name of APP_TOOLS) {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, `少了界面专用工具 ${name}`);
      const visibility = (
        tool._meta as { ui?: { visibility?: string[] } } | undefined
      )?.ui?.visibility;
      assert.deepEqual(visibility, ["app"], `${name} 应当只给界面用`);
    }
    assert.equal(
      listed.tools.some((tool) => tool.name === "code_decide"),
      false,
      "code_decide 由代码包注册，这张卡不管",
    );
  } finally {
    await session.close();
  }
});

test("完整流程：状态、类型、写入、查询、读回、撤销、重做", async () => {
  const session = await open();
  try {
    const client = session.client;
    const state = await call(client, "sand_status");
    assert.equal(state.isError, false, state.text);
    const homeBoardId = state.data.homeBoardId as string;
    assert.ok(homeBoardId, "要有首页白板");

    const types = await call(client, "sand_types", {
      types: ["base.note"],
    });
    assert.equal(types.isError, false, types.text);
    const declared = types.data.types as { type: string; schema: unknown }[];
    assert.equal(declared[0]?.type, "base.note");

    const created = await call(client, "sand_edit", {
      commands: [
        {
          op: "object.create",
          ref: "note",
          type: "base.note",
          title: "测试便签",
          data: { body: "便签正文" },
        },
        {
          op: "presentation.create",
          boardId: homeBoardId,
          objectId: "@note",
        },
      ],
    });
    assert.equal(created.isError, false, created.text);

    const found = await call(client, "sand_query", { text: "测试便签" });
    assert.equal(found.isError, false, found.text);
    const rows = found.data.rows as { id: string; type: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.type, "base.note");

    const read = await call(client, "sand_read", { ids: [rows[0]!.id] });
    assert.equal(read.isError, false, read.text);
    const objects = read.data.objects as {
      id: string;
      data: Record<string, unknown>;
      presentations: { boardId: string }[];
    }[];
    assert.equal(objects[0]?.data.body, "便签正文");
    assert.equal(objects[0]?.presentations[0]?.boardId, homeBoardId);

    const undone = await call(client, "sand_history", { action: "undo" });
    assert.equal(undone.isError, false, undone.text);
    const afterUndo = await call(client, "sand_query", { text: "测试便签" });
    assert.equal(
      (afterUndo.data.rows as unknown[]).length,
      0,
      "撤销之后应当找不到",
    );

    const redone = await call(client, "sand_history", { action: "redo" });
    assert.equal(redone.isError, false, redone.text);
    const afterRedo = await call(client, "sand_query", { text: "测试便签" });
    assert.equal(
      (afterRedo.data.rows as unknown[]).length,
      1,
      "重做之后又能找到",
    );
  } finally {
    await session.close();
  }
});

test("模型输出不超过 4 KB", async () => {
  const session = await open();
  try {
    const client = session.client;
    const body = "长".repeat(400);
    for (let round = 0; round < 2; round++) {
      const commands = [];
      for (let i = 0; i < 150; i++)
        commands.push({
          op: "object.create",
          type: "base.note",
          title: `便签 ${round * 150 + i}`,
          data: { body },
        });
      const written = await call(client, "sand_edit", { commands });
      assert.equal(written.isError, false, written.text);
    }
    const state = await call(client, "sand_status");
    assert.ok(
      Buffer.byteLength(state.text, "utf8") < 4096,
      `sand_status 有 ${Buffer.byteLength(state.text, "utf8")} 字节`,
    );
    const query = await call(client, "sand_query", { text: "便签" });
    assert.ok(
      Buffer.byteLength(query.text, "utf8") < 4096,
      `sand_query 有 ${Buffer.byteLength(query.text, "utf8")} 字节`,
    );
  } finally {
    await session.close();
  }
});

test("写不存在的类型，报错带错误码和下一步提示", async () => {
  const session = await open();
  try {
    const failed = await call(session.client, "sand_edit", {
      commands: [
        { op: "object.create", type: "no.such.type", title: "不存在的类型" },
      ],
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.data.code, "UNKNOWN_TYPE");
    assert.ok(
      typeof failed.data.hint === "string" && failed.data.hint.length > 0,
      "提示不能空",
    );
  } finally {
    await session.close();
  }
});

test("模型写入记成 agent，人的写入记成 human", async () => {
  const session = await open();
  try {
    const client = session.client;
    const byAgent = await call(client, "sand_edit", {
      commands: [{ op: "object.create", type: "base.note", title: "模型写的" }],
    });
    assert.equal(byAgent.isError, false, byAgent.text);
    const byHuman = await call(client, "app_edit", {
      commands: [{ op: "object.create", type: "base.note", title: "人写的" }],
    });
    assert.equal(byHuman.isError, false, byHuman.text);

    const history = await call(client, "sand_history", { action: "list" });
    const entries = history.data.entries as {
      actorKind: string;
      label: string;
    }[];
    assert.ok(
      entries.some((entry) => entry.actorKind === "agent"),
      "模型的写入要记成 agent",
    );
    assert.ok(
      entries.some((entry) => entry.actorKind === "human"),
      "人的写入要记成 human",
    );

    const context = await call(client, "sand_context");
    assert.equal(context.isError, false, context.text);
    const edits = context.data.recentHumanEdits as { label: string }[];
    assert.equal(edits.length, 1, "只该报人的那一次改动");
    assert.match(edits[0]!.label, /人写的/);
  } finally {
    await session.close();
  }
});

test("app_changes 只给指定修订号之后的改动", async () => {
  const session = await open();
  try {
    const client = session.client;
    const first = await call(client, "sand_edit", {
      commands: [{ op: "object.create", type: "base.note", title: "第一次" }],
    });
    assert.equal(first.isError, false, first.text);
    const revision = first.data.revision as number;
    const second = await call(client, "sand_edit", {
      commands: [{ op: "object.create", type: "base.note", title: "第二次" }],
    });
    assert.equal(second.isError, false, second.text);

    const changes = await call(client, "app_changes", { since: revision });
    assert.equal(changes.isError, false, changes.text);
    const data = changes.result._meta as
      { data?: { objects?: { title: string }[] } } | undefined;
    const objects = data?.data?.objects ?? [];
    assert.equal(objects.length, 1, "增量里只有第二次的改动");
    assert.equal(objects[0]?.title, "第二次");
  } finally {
    await session.close();
  }
});

test("app_workspace 能新建、切换、改名、删除", async () => {
  const session = await open("first");
  try {
    const client = session.client;
    const listed = await call(client, "app_workspace", { action: "list" });
    assert.equal(listed.isError, false, listed.text);
    assert.equal(
      (listed.data.workspaces as { id: string }[]).length,
      1,
      "起手只有一个工作空间",
    );

    const created = await call(client, "app_workspace", {
      action: "create",
      id: "second",
      title: "第二个",
    });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.data.id, "second");

    const renamed = await call(client, "app_workspace", {
      action: "rename",
      id: "second",
      title: "改过的名字",
    });
    assert.equal(renamed.isError, false, renamed.text);
    assert.equal(renamed.data.title, "改过的名字");

    const switched = await call(client, "app_workspace", {
      action: "switch",
      id: "second",
    });
    assert.equal(switched.isError, false, switched.text);
    assert.equal(switched.data.id, "second");

    const refused = await call(client, "app_workspace", {
      action: "delete",
      id: "second",
    });
    assert.equal(refused.isError, true, "当前工作空间不能删");
    assert.equal(refused.data.code, "FORBIDDEN");

    const back = await call(client, "app_workspace", {
      action: "switch",
      id: "first",
    });
    assert.equal(back.isError, false, back.text);
    const deleted = await call(client, "app_workspace", {
      action: "delete",
      id: "second",
    });
    assert.equal(deleted.isError, false, deleted.text);

    const after = await call(client, "app_workspace", { action: "list" });
    assert.equal(
      (after.data.workspaces as { id: string }[]).length,
      1,
      "删掉之后只剩一个",
    );
  } finally {
    await session.close();
  }
});

test("导入后的工作空间列表用目录名，不用库里的旧编号", async () => {
  const session = await open("current");
  try {
    const registry = createRegistry();
    for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
    mkdirSync(join(session.root, "imported"), { recursive: true });
    copyFileSync(
      join("tests/fixtures/v2/full.json"),
      join(session.root, "imported", "workspace.json"),
    );
    const opened = openWorkspace(session.root, "imported", registry);
    assert.equal(getMeta(opened.db, "workspace_id"), "demo-workspace");
    opened.db.close();

    const listed = await call(session.client, "app_workspace", {
      action: "list",
    });
    assert.equal(listed.isError, false, listed.text);
    const rows = listed.data.workspaces as {
      id: string;
      title: string;
      current: boolean;
    }[];
    const imported = rows.find((row) => row.title === "示例工作空间");
    assert.ok(imported, JSON.stringify(rows));
    assert.equal(imported.id, "imported");
    assert.equal(imported.current, false);
    assert.equal(
      rows.find((row) => row.current)?.id,
      "current",
      "当前项用的是打开时的目录名",
    );

    const renamed = await call(session.client, "app_workspace", {
      action: "rename",
      id: "imported",
      title: "改名成功",
    });
    assert.equal(renamed.isError, false, renamed.text);

    const wrong = await call(session.client, "app_workspace", {
      action: "rename",
      id: "demo-workspace",
      title: "不该打到这个名字",
    });
    assert.equal(wrong.isError, true);
    assert.equal(wrong.data.code, "NOT_FOUND");
  } finally {
    await session.close();
  }
});

test("包停用时它的工具也跟着停用", async () => {
  /* 内置包现在都不注册工具，用一个演示包验证启停。 */
  const demo: PackSpec = {
    id: "demo",
    title: "演示包",
    version: 1,
    registerTools: (registrar) => {
      registrar.tool("demo_ping", "演示包的工具。", {}, () => ({ ok: true }));
    },
  };
  const session = await open("test", [basePack, demo]);
  try {
    const client = session.client;
    const before = await client.listTools();
    assert.ok(
      before.tools.some((tool) => tool.name === "demo_ping"),
      "启用的包，它的工具在列表里",
    );

    const disabled = await call(client, "app_edit", {
      commands: [{ op: "pack.disable", id: "demo" }],
    });
    assert.equal(disabled.isError, false, disabled.text);
    const after = await client.listTools();
    assert.equal(
      after.tools.some((tool) => tool.name === "demo_ping"),
      false,
      "包停了，它的工具也要从列表里消失",
    );

    const enabled = await call(client, "app_edit", {
      commands: [{ op: "pack.enable", id: "demo" }],
    });
    assert.equal(enabled.isError, false, enabled.text);
    const restored = await client.listTools();
    assert.ok(
      restored.tools.some((tool) => tool.name === "demo_ping"),
      "包重新启用，工具也要回来",
    );
  } finally {
    await session.close();
  }
});

test("撤销或重做之后，包工具的启停跟数据库一致", async () => {
  const demo: PackSpec = {
    id: "demo",
    title: "演示包",
    version: 1,
    registerTools: (registrar) => {
      registrar.tool("demo_ping", "演示包的工具。", {}, () => ({ ok: true }));
    },
  };
  const session = await open("test", [basePack, demo]);
  try {
    const client = session.client;
    const listed = async () =>
      (await client.listTools()).tools.some(
        (tool) => tool.name === "demo_ping",
      );

    const disabled = await call(client, "app_edit", {
      commands: [{ op: "pack.disable", id: "demo" }],
    });
    assert.equal(disabled.isError, false, disabled.text);
    assert.equal(await listed(), false, "包停了，工具不在列表里");

    const undone = await call(client, "sand_history", { action: "undo" });
    assert.equal(undone.isError, false, undone.text);
    assert.equal(await listed(), true, "撤销之后包恢复启用，工具也要回来");

    const redone = await call(client, "sand_history", { action: "redo" });
    assert.equal(redone.isError, false, redone.text);
    assert.equal(await listed(), false, "重做之后包又停用，工具也要停");

    const undoneByApp = await call(client, "app_history", { action: "undo" });
    assert.equal(undoneByApp.isError, false, undoneByApp.text);
    assert.equal(await listed(), true, "界面撤销之后，工具也要回来");
  } finally {
    await session.close();
  }
});

test("工作空间编号越界或不合规时拒绝，目录一个都不动", async () => {
  const session = await open("first");
  try {
    const client = session.client;
    const created = await call(client, "app_workspace", {
      action: "create",
      id: "second",
    });
    assert.equal(created.isError, false, created.text);

    for (const id of [".", "..", "../backup", "../../outside"]) {
      for (const action of ["delete", "switch", "rename"] as const) {
        const failed = await call(client, "app_workspace", {
          action,
          id,
          ...(action === "rename" ? { title: "改过的名字" } : {}),
        });
        assert.equal(failed.isError, true, `${action}「${id}」必须被拒`);
        assert.equal(
          failed.data.code,
          "FORBIDDEN",
          `${action}「${id}」的错误码`,
        );
      }
    }

    const malformed = await call(client, "app_workspace", {
      action: "create",
      id: "带空格的编号",
    });
    assert.equal(malformed.isError, true, "不合规的编号要被拒");
    assert.equal(malformed.data.code, "INVALID_DATA");

    assert.ok(existsSync(session.root), "工作空间根目录还在");
    assert.ok(
      existsSync(join(session.root, "first", "workspace.db")),
      "当前工作空间还在",
    );
    assert.ok(
      existsSync(join(session.root, "second", "workspace.db")),
      "另一个工作空间还在",
    );
    const listed = await call(client, "app_workspace", { action: "list" });
    assert.equal(
      (listed.data.workspaces as unknown[]).length,
      2,
      "两个工作空间都还在",
    );
  } finally {
    await session.close();
  }
});

test("默认生成的 MCP 条目指向桥接，不另加环境变量", () => {
  const sessionFile = join(tmpdir(), "sand-tools-v3-session.json");
  const entry = bridgeEntry(undefined, sessionFile);
  assert.equal(entry.env, undefined);

  const config = connectionConfig(sessionFile, entry);
  const parsed = JSON.parse(config.json) as {
    mcpServers: Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    >;
  };
  const server = parsed.mcpServers["sand-table"];
  assert.ok(server, "配置里要有 sand-table 这一条");
  assert.equal(server.env, undefined);
  assert.ok(server.args.includes("--session-file"), "桥接命令要指明会话文件");
  assert.doesNotMatch(config.codex, /--env/);
  assert.doesNotMatch(config.toml, /\[mcp_servers\.sand-table\.env\]/);
});

test("自定义 MCP 条目保留自己的环境变量", () => {
  const entry = bridgeEntry(
    {
      command: "/app/sand-table",
      args: ["--mcp"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
    join(tmpdir(), "sand-tools-v3-session.json"),
  );
  assert.deepEqual(entry.env, {
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal(entry.command, "/app/sand-table");
  assert.deepEqual(entry.args, ["--mcp"]);
});

test("没有绑定文件夹时，自定义条目原样返回", () => {
  const custom = { command: "/app/sand-table", args: ["--mcp"] };
  assert.equal(bridgeEntry(custom, "/tmp/session.json"), custom);
});

// —— T74：app_activity、app_view 的 boardId、类型元数据、过期响应隔离 ——

test("app_activity 列出未过期的活动，最多 100 条，读取不推进 agent_reads", async () => {
  const session = await open();
  try {
    const client = session.client;
    // 先让一个 Agent 报两条活动：模型工具写的是 agent 的活动。
    const first = await call(client, "sand_activity", {
      state: "running",
      task: "在整理人物",
      action: "读第 1 章",
      objectIds: [],
    });
    assert.equal(first.isError, false, first.text);
    const second = await call(client, "sand_activity", {
      state: "waiting",
      task: "在等资料",
      action: "翻档案",
    });
    assert.equal(second.isError, false, second.text);

    const listed = await call(client, "app_activity", { action: "list" });
    assert.equal(listed.isError, false, listed.text);
    const activities = listed.data.activities as {
      actor: string;
      state: string;
      task: string;
    }[];
    assert.equal(activities.length, 1, "同一个 Agent 只留最新一条");
    assert.equal(activities[0]?.state, "waiting");
    assert.equal(activities[0]?.task, "在等资料");
    assert.equal(listed.data.truncated, false);
    assert.equal(typeof listed.data.revision, "number");
    assert.equal(listed.data.workspaceId, "test");

    // 读取活动不能推进 Agent 的读取游标。
    // 先让 sand_context 走一遍（它本来就会写游标），再读活动，
    // 游标不能被带着往前走。
    const context = await call(client, "sand_context");
    assert.equal(context.isError, false, context.text);
    const before = readAgentReads(session.db());
    assert.ok(before && before.rows > 0, "sand_context 写下了读取游标");

    const again = await call(client, "app_activity", { action: "list" });
    assert.equal(again.isError, false, again.text);
    const after = readAgentReads(session.db());
    assert.deepEqual(after, before, "读活动不动 agent_reads");
  } finally {
    await session.close();
  }
});

test("app_activity 一次至多 100 条，多的报截断，过期的活动消失", async () => {
  const session = await open();
  try {
    const client = session.client;
    // 直接写库造 120 条活动：模型工具一次只能写一个 Agent。
    const db = session.db();
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO activities (actor, state, task, action, board_id, object_ids, reported_at, expires_at)
       VALUES (?, 'running', ?, '干活', NULL, '[]', ?, ?)`,
    );
    for (let i = 0; i < 120; i++)
      insert.run(`agent-${i}`, `任务 ${i}`, now + i, now + 60_000);
    // 再写一条过期的：过期的活动不该出现在列表里。
    insert.run("agent-expired", "早该没了", now - 1000, now - 1);

    const listed = await call(client, "app_activity", { action: "list" });
    assert.equal(listed.isError, false, listed.text);
    const activities = listed.data.activities as { actor: string }[];
    assert.equal(activities.length, 100, "一次至多 100 条");
    assert.equal(listed.data.truncated, true, "多的要报截断");
    assert.equal(
      activities.some((item) => item.actor === "agent-expired"),
      false,
      "过期的活动消失",
    );
    assert.equal(
      activities.filter((item) => item.actor.startsWith("agent-")).length,
      100,
    );
  } finally {
    await session.close();
  }
});

test("app_view get 给出导航栈，select 和 camera 能带上白板编号", async () => {
  const session = await open();
  try {
    const client = session.client;
    const state = await call(client, "sand_status");
    const homeBoardId = state.data.homeBoardId as string;

    // 第一次直接 select：带上白板编号，不用先 navigate 登记一次。
    const selected = await call(client, "app_view", {
      action: "select",
      viewId: "v1",
      boardId: homeBoardId,
      selection: [],
    });
    assert.equal(selected.isError, false, selected.text);
    assert.equal(selected.data.workspaceId, "test");

    const camera = await call(client, "app_view", {
      action: "camera",
      viewId: "v1",
      boardId: homeBoardId,
      camera: { x: 10, y: 20, zoom: 2 },
    });
    assert.equal(camera.isError, false, camera.text);

    const view = await call(client, "app_view", {
      action: "get",
      viewId: "v1",
    });
    assert.equal(view.isError, false, view.text);
    assert.equal(
      (view.data.board as { id: string }).id,
      homeBoardId,
      "视角在白板上",
    );
    assert.deepEqual(view.data.camera, { x: 10, y: 20, zoom: 2 });
    assert.deepEqual(view.data.navStack, [], "还没有进过子白板");
    assert.equal(typeof view.data.revision, "number");
    assert.equal(view.data.workspaceId, "test");

    // 进了子白板之后，nav_stack 要能读回来。
    const navigated = await call(client, "app_view", {
      action: "navigate",
      viewId: "v1",
      boardId: homeBoardId,
      navStack: [{ boardId: homeBoardId, camera: { x: 0, y: 0, zoom: 1 } }],
    });
    assert.equal(navigated.isError, false, navigated.text);
    const after = await call(client, "app_view", {
      action: "get",
      viewId: "v1",
    });
    const navStack = after.data.navStack as unknown[];
    assert.equal(navStack.length, 1, "导航栈读回来了");
  } finally {
    await session.close();
  }
});

test("sand_types 的精简列表带上工具箱要的 icon、capabilities 和 presets", async () => {
  const session = await open();
  try {
    const client = session.client;
    const types = await call(client, "sand_types");
    assert.equal(types.isError, false, types.text);
    const list = types.data.types as {
      type: string;
      icon: string;
      capabilities: { container?: boolean; cover?: boolean };
      presets: { key: string; title: string }[];
    }[];
    const board = list.find((item) => item.type === "base.board");
    assert.ok(board, "有 base.board");
    assert.equal(typeof board!.icon, "string");
    assert.ok(board!.icon.length > 0, "图标名不能空");
    assert.equal(board!.capabilities.container, true);
    assert.ok(Array.isArray(board!.presets), "预填条目是个列表");
    const note = list.find((item) => item.type === "base.note");
    assert.equal(note!.capabilities.container, undefined, "没声明的能力不出现");
    const kinds = types.data.relationKinds as {
      kind: string;
      sourceTypes?: string[];
      targetTypes?: string[];
    }[];
    const participates = kinds.find(
      (item) => item.kind === "novel.participates",
    );
    assert.deepEqual(participates?.sourceTypes, ["novel.event"]);
    assert.deepEqual(participates?.targetTypes, ["novel.character"]);
    const related = kinds.find((item) => item.kind === "base.related");
    assert.equal(
      related?.sourceTypes,
      undefined,
      "没有端点限制的关系不带 sourceTypes",
    );
  } finally {
    await session.close();
  }
});

test("旧工作空间的读请求被拒：不能把旧板增量合进新库", async () => {
  const session = await open();
  try {
    const client = session.client;
    const ok = await call(client, "app_changes", {
      since: 0,
      workspaceId: "test",
    });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.workspaceId, "test");

    const stale = await call(client, "app_changes", {
      since: 0,
      workspaceId: "上一个工作空间",
    });
    assert.equal(stale.isError, true, "工作空间对不上就不给数据");
    assert.equal(stale.data.code, "INVALID_DATA");
    assert.match(String(stale.data.message), /工作空间/);

    const board = await call(client, "app_board", {
      boardId: (await call(client, "sand_status")).data.homeBoardId as string,
      workspaceId: "上一个工作空间",
    });
    assert.equal(board.isError, true, "app_board 同样要拒");
  } finally {
    await session.close();
  }
});

test("运行状态不进作品历史：视角和活动写完，历史还是空的", async () => {
  const session = await open();
  try {
    const client = session.client;
    const homeBoardId = (await call(client, "sand_status")).data
      .homeBoardId as string;

    const selected = await call(client, "app_view", {
      action: "select",
      viewId: "v1",
      boardId: homeBoardId,
      selection: [],
    });
    assert.equal(selected.isError, false, selected.text);
    const activity = await call(client, "sand_activity", {
      state: "running",
      task: "在写东西",
      action: "读文档",
    });
    assert.equal(activity.isError, false, activity.text);

    const history = await call(client, "sand_history", { action: "list" });
    assert.equal(history.isError, false, history.text);
    assert.equal(
      (history.data.entries as unknown[]).length,
      0,
      "视角和活动是运行状态，不进作品历史",
    );

    // 作品写入照旧进历史。
    const written = await call(client, "app_edit", {
      commands: [{ op: "object.create", type: "base.note", title: "一条便签" }],
    });
    assert.equal(written.isError, false, written.text);
    const after = await call(client, "sand_history", { action: "list" });
    assert.equal(
      (after.data.entries as unknown[]).length,
      1,
      "作品写入才是历史里的一步",
    );
  } finally {
    await session.close();
  }
});

test("框内坐标说不准：sand_status 里带着要人工确认的提示；健康的库不带", async () => {
  const session = await open();
  try {
    const client = session.client;
    const healthy = await call(client, "sand_status");
    assert.equal(healthy.isError, false, healthy.text);
    const clean = healthy.data.frameCoords as {
      state: string;
      count: number;
      message: string;
    };
    assert.equal(clean.state, "ok", "新建的工作空间是健康的");
    assert.equal(clean.count, 0);
    assert.match(clean.message, /相对父框/);
    assert.doesNotMatch(clean.message, /导入器/, "新建的库不是导入器写的");
    assert.equal(
      (healthy.data.tips as string[]).some((tip) => tip.includes("人工确认")),
      false,
      "健康的库不带人工确认的提示",
    );

    // 造一个「有框内展示但没有坐标标记」的库。
    const homeBoardId = healthy.data.homeBoardId as string;
    const written = await call(client, "app_edit", {
      commands: [
        {
          op: "object.create",
          ref: "outer",
          type: "base.note",
          title: "外框",
        },
        {
          op: "object.create",
          ref: "inner",
          type: "base.note",
          title: "框里的",
        },
        {
          op: "presentation.create",
          ref: "outerView",
          boardId: homeBoardId,
          objectId: "@outer",
        },
        {
          op: "presentation.create",
          boardId: homeBoardId,
          objectId: "@inner",
          parentId: "@outerView",
        },
      ],
    });
    assert.equal(written.isError, false, written.text);
    session.db().prepare("DELETE FROM meta WHERE key = 'frame_coords'").run();

    const review = await call(client, "sand_status");
    assert.equal(review.isError, false, review.text);
    const state = review.data.frameCoords as {
      state: string;
      count: number;
      message: string;
    };
    assert.equal(state.state, "needs-review", "坐标说不准时要人来确认");
    assert.equal(state.count, 1, "一个框内展示要确认");
    assert.match(state.message, /人工确认/);
    const tips = review.data.tips as string[];
    assert.equal(
      tips.some((tip) => tip.includes("人工确认")),
      true,
      "提示里也要看得见要人工确认",
    );
  } finally {
    await session.close();
  }
});
