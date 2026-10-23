// v3 工具面的验收：任务卡 docs/kernel-v3/tasks/T20-tools-v3.md 的「验收」。
//
// 用 InMemoryTransport 把客户端和服务端接在一对内存传输上，
// 工作空间放在临时目录里，跑完就删。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServerV3 } from "../server/v3/server.ts";
import { basePack } from "../packs/base/index.ts";
import type { PackSpec } from "../kernel/index.ts";

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
