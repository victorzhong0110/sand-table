// DSH 插件包的清单与语法检查。
//
// 契约见 docs/architecture/dsh-integration.zh-CN.md 的 X6（清单结构）与
// X7（两端代码语法可解析）。
//
// 这里**不启动 DSH**：本沙箱没有 DSH，装不了也跑不起来。
// 槽位注册和会话命令被宿主调到仍未验证。工具转调用假的 MCP 客户端核对。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const pluginDir = fileURLToPath(new URL("../dsh-plugin/", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(pluginDir, "package.json"), "utf8"),
) as Record<string, any>;

const readPlugin = (name: string) =>
  readFileSync(join(pluginDir, name), "utf8");

test("X6：清单声明 bundle 补丁与 Client 段", () => {
  assert.equal(manifest.name, "@sand-table/dsh-plugin");
  assert.equal(manifest.type, "module");
  assert.equal(typeof manifest.version, "string");
  assert.ok(manifest.version.length > 0);
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh?.client?.platform, "web");
  assert.equal(manifest.dsh?.client?.immediately, true);
  assert.ok(Array.isArray(manifest.dsh?.client?.inject));
  assert.ok(
    manifest.dsh.client.inject.length > 0,
    "Client 段要声明它依赖的客户端包",
  );
  assert.ok(
    typeof manifest.engines?.dsh === "string" &&
      manifest.engines.dsh.length > 0,
    "要声明支持的 DSH 版本区间",
  );
});

test("X6：exports 暴露 Host 半、Client 半、locale 与图标", () => {
  const exportsMap = manifest.exports as Record<string, string>;
  assert.equal(exportsMap["."], "./index.js");
  assert.equal(exportsMap["./client"], "./client.js");
  assert.equal(exportsMap["./locale/*.json"], "./locale/*.json");
  assert.equal(exportsMap["./icon"], "./icon.svg");
});

test("X6：files 列出要打包的全部文件，且都真实存在", () => {
  const files = manifest.files as string[];
  assert.ok(Array.isArray(files));
  for (const entry of [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
  ])
    assert.ok(files.includes(entry), `files 少了 ${entry}`);
  for (const entry of files) {
    if (entry.includes("*")) {
      const directory = entry.slice(0, entry.indexOf("*"));
      const pattern = entry.slice(entry.indexOf("*") + 1);
      const matches = existsSync(join(pluginDir, directory))
        ? readdirSync(join(pluginDir, directory)).filter((name) =>
            name.endsWith(pattern),
          )
        : [];
      assert.ok(matches.length > 0, `${entry} 没有匹配到文件`);
      continue;
    }
    assert.ok(existsSync(join(pluginDir, entry)), `files 里的 ${entry} 不存在`);
  }
});

test("X6：补丁层插入一行插件，行 id 与包名都唯一", () => {
  const patch = readPlugin("cordis.patch.yml");
  assert.ok(patch.trim().length > 0, "空补丁会让启动失败");
  assert.match(patch, /^\s*-\s*insert:/m);
  assert.match(patch, /id:\s*sand-table\b/);
  assert.match(patch, /name:\s*["']?@sand-table\/dsh-plugin["']?/);
  const ids = [...patch.matchAll(/^\s*id:\s*(\S+)/gm)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "补丁里的行 id 不能重复");
});

test("X6：locale 两种语言都带 meta.title 与 meta.description", () => {
  for (const locale of ["en", "zh"]) {
    const data = JSON.parse(readPlugin(`locale/${locale}.json`)) as Record<
      string,
      Record<string, string>
    >;
    assert.equal(typeof data.meta?.title, "string");
    assert.equal(typeof data.meta?.description, "string");
    assert.ok(data.meta.title.trim().length > 0, `${locale} 缺标题`);
    assert.ok(data.meta.description.trim().length > 0, `${locale} 缺描述`);
    assert.ok(
      !/my-decoration|My Decoration|示例|Example/i.test(
        `${data.meta.title}${data.meta.description}`,
      ),
      `${locale} 的文案还是模板文案`,
    );
  }
});

test("X6：图标存在、格式正确、体积在限制内", () => {
  const iconPath = join(pluginDir, "icon.svg");
  assert.ok(existsSync(iconPath));
  const icon = readFileSync(iconPath, "utf8");
  assert.match(icon, /<svg[\s>]/);
  assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!/<text[\s>]/i.test(icon), "插件图标只用几何图形，不带文字");
  const size = statSync(iconPath).size;
  assert.ok(size > 0 && size <= 256 * 1024, `图标体积 ${size} 字节超限`);
});

test("X7：Host 半与 Client 半的语法都能被 node 解析", () => {
  for (const file of ["index.js", "client.js", "tasks.js"]) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: pluginDir,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `${file} 语法有误：${result.stderr || result.stdout}`,
    );
  }
});

test("X7：Client 半用惰性工厂注册，工厂 id 等于包名", () => {
  const client = readPlugin("client.js");
  assert.match(client, /__ModuleLoader__\.load\(/);
  assert.match(
    client,
    new RegExp(`id:\\s*["']${manifest.name}["']`),
    "工厂 id 必须等于包名",
  );
  assert.match(client, /slots\.inject\(/);
  assert.match(client, /slots\.register\(/);
  assert.doesNotMatch(
    client,
    /document\.body\.appendChild/,
    "不能往 body 追加第二个应用",
  );
});

test("X7：Host 半导出 apply，并且不 import 宿主包", () => {
  const host = readPlugin("index.js");
  assert.match(host, /export function apply\(/);
  const specifiers = [...host.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0, "Host 半要 import node 内置模块");
  for (const specifier of specifiers)
    assert.ok(
      specifier.startsWith("node:") || specifier === "./tasks.js",
      `运行时代码不 import ${specifier}（不引宿主包、不引第三方包）`,
    );
});

test("对外工具名不变", () => {
  const host = readPlugin("index.js");
  for (const name of [
    "sand_table_list_boards",
    "sand_table_read_board",
    "sand_table_read_object",
    "sand_table_edit_space",
  ])
    assert.match(host, new RegExp(`name: "${name}"`));
});

type PluginOperations = {
  listBoards: () => Promise<{ boards: Record<string, unknown>[] }>;
  readBoard: (
    boardId?: string,
    offset?: number,
  ) => Promise<Record<string, unknown>>;
  readObject: (
    boardId?: string,
    objectId?: string,
  ) => Promise<Record<string, unknown>>;
  editSpace: (args: Record<string, unknown>) => Promise<unknown>;
};

async function loadPlugin() {
  const href = pathToFileURL(join(pluginDir, "index.js")).href;
  return (await import(href)) as {
    createOperations: (
      mcp: {
        callTool: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      },
      kernel?: string,
    ) => PluginOperations;
  };
}

function recorded(
  plugin: Awaited<ReturnType<typeof loadPlugin>>,
  kernel: string | undefined,
  reply: (name: string, args: Record<string, unknown>) => unknown,
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const ops = plugin.createOperations(
    {
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return reply(name, args);
      },
    },
    kernel,
  );
  return { calls, ops };
}

function statusReply(revision: number, boards: unknown[] = []) {
  return {
    structuredContent: {
      data: { workspace: { revision }, boards },
    },
  };
}

test("SAND_KERNEL=v3 时四个操作转调 v3 工具", async () => {
  const plugin = await loadPlugin();
  const listed = recorded(plugin, "v3", () =>
    statusReply(2, [{ id: "home", title: "首页", presentations: 3 }]),
  );
  const boards = await listed.ops.listBoards();
  assert.deepEqual(
    listed.calls.map((call) => call.name),
    ["sand_status"],
  );
  assert.deepEqual(boards.boards, [
    {
      boardId: "home",
      id: "home",
      title: "首页",
      revision: 2,
      objectCount: 3,
    },
  ]);

  const empty = recorded(plugin, "v3", () => statusReply(1, []));
  assert.deepEqual((await empty.ops.listBoards()).boards, []);
  assert.deepEqual(
    empty.calls.map((call) => call.name),
    ["sand_status"],
  );

  const board = recorded(plugin, "v3", () => ({
    structuredContent: {
      data: {
        rows: [{ id: "n1", title: "便签" }],
        total: 4,
        nextCursor: "x",
      },
    },
  }));
  const page = await board.ops.readBoard("board-1", 50);
  assert.deepEqual(board.calls, [
    {
      name: "sand_query",
      args: {
        boardId: "board-1",
        cursor: Buffer.from("50").toString("base64url"),
      },
    },
  ]);
  assert.equal((page.objects as unknown[]).length, 1);
  assert.equal(page.total, 4);

  const object = recorded(plugin, "v3", () => ({
    structuredContent: {
      data: { objects: [{ id: "n1", title: "便签", type: "base.note" }] },
    },
  }));
  const read = await object.ops.readObject("board-1", "n1");
  assert.deepEqual(object.calls, [
    { name: "sand_read", args: { ids: ["n1"] } },
  ]);
  assert.equal(read.boardId, "board-1");
  assert.equal(read.id, "n1");

  const created = recorded(plugin, "v3", (name) =>
    name === "sand_status"
      ? statusReply(4)
      : { structuredContent: { data: { ok: true } } },
  );
  await created.ops.editSpace({
    boardId: "board-1",
    viewId: "view-1",
    revision: 4,
    operation: JSON.stringify({
      kind: "create",
      type: "text",
      title: "便签",
      data: { text: "你好" },
      rect: { x: 10, y: 20, width: 280, height: 180, pinned: true },
    }),
  });
  assert.deepEqual(
    created.calls.map((call) => call.name),
    ["sand_status", "sand_edit"],
  );
  assert.deepEqual(created.calls[1]?.args.commands, [
    {
      op: "object.create",
      ref: "created",
      type: "base.note",
      title: "便签",
      data: { body: "你好" },
    },
    {
      op: "presentation.create",
      boardId: "board-1",
      objectId: "@created",
      x: 10,
      y: 20,
      width: 280,
      height: 180,
      locked: true,
    },
  ]);

  const selected = recorded(plugin, "v3", (name) =>
    name === "sand_status"
      ? statusReply(4)
      : { structuredContent: { data: { ok: true } } },
  );
  await selected.ops.editSpace({
    boardId: "board-1",
    viewId: "view-1",
    revision: 4,
    operation: JSON.stringify({ kind: "select", ids: ["p1"] }),
  });
  assert.deepEqual(selected.calls[1], {
    name: "app_view",
    args: {
      action: "select",
      viewId: "view-1",
      boardId: "board-1",
      selection: ["p1"],
    },
  });

  const undone = recorded(plugin, "v3", (name) =>
    name === "sand_status"
      ? statusReply(4)
      : { structuredContent: { data: { ok: true } } },
  );
  await undone.ops.editSpace({
    boardId: "board-1",
    viewId: "view-1",
    revision: 4,
    operation: JSON.stringify({ kind: "undo" }),
  });
  assert.deepEqual(undone.calls[1], {
    name: "sand_history",
    args: { action: "undo" },
  });

  const related = recorded(plugin, "v3", (name) =>
    name === "sand_status"
      ? statusReply(4)
      : { structuredContent: { data: { ok: true } } },
  );
  await related.ops.editSpace({
    boardId: "board-1",
    viewId: "view-1",
    revision: 4,
    operation: JSON.stringify({
      kind: "relate",
      source: "a",
      target: "b",
      relation: "supports",
      status: "confirmed",
      basis: "实验",
    }),
  });
  const relateCommands = related.calls[1]?.args.commands as {
    kind: string;
    basis: string;
  }[];
  assert.equal(relateCommands[0]?.kind, "base.supports");
  assert.equal(relateCommands[0]?.basis, "实验");

  const updated = recorded(plugin, "v3", (name) => {
    if (name === "sand_status") return statusReply(4);
    if (name === "app_board")
      return {
        structuredContent: { data: { revision: 4 } },
        _meta: {
          data: {
            presentations: [{ id: "p1", objectId: "o1" }],
            objects: [{ id: "o1", type: "base.note" }],
          },
        },
      };
    return { structuredContent: { data: { ok: true } } };
  });
  await updated.ops.editSpace({
    boardId: "board-1",
    viewId: "view-1",
    revision: 4,
    operation: JSON.stringify({
      kind: "update",
      instanceId: "p1",
      title: "新标题",
      data: { text: "正文" },
    }),
  });
  assert.deepEqual(
    updated.calls.map((call) => call.name),
    ["sand_status", "app_board", "sand_edit"],
  );
  assert.deepEqual(updated.calls[2]?.args.commands, [
    {
      op: "object.update",
      id: "o1",
      title: "新标题",
      set: { body: "正文" },
    },
  ]);

  const stale = recorded(plugin, "v3", () => statusReply(1));
  await assert.rejects(
    () =>
      stale.ops.editSpace({
        boardId: "board-1",
        viewId: "view-1",
        revision: 4,
        operation: JSON.stringify({ kind: "undo" }),
      }),
    /已经变了/,
  );
  assert.deepEqual(
    stale.calls.map((call) => call.name),
    ["sand_status"],
  );
});

test("内核不是 v3 时仍调用 v2 工具", async () => {
  const plugin = await loadPlugin();
  let listed = 0;
  const calls: string[] = [];
  const ops = plugin.createOperations(
    {
      async callTool(name: string) {
        calls.push(name);
        if (name === "sand_list_boards") {
          listed += 1;
          return {
            structuredContent: {
              data: { boards: listed === 1 ? [] : [{ id: "b" }] },
            },
          };
        }
        return { structuredContent: { data: { id: "n1" } } };
      },
    },
    "v2",
  );
  const boards = await ops.listBoards();
  assert.deepEqual(calls, [
    "sand_list_boards",
    "sand_open_board",
    "sand_list_boards",
  ]);
  assert.equal(boards.boards.length, 1);
  await ops.readObject("board-1", "n1");
  assert.equal(calls.at(-1), "sand_read_object");
});
