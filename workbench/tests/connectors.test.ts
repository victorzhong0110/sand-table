// 连接器的测试：能力声明、拒绝行为，以及 Git 写入的确认链路。
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 3、6 节。
// 覆盖不变量：D3（文件夹连接器独立读普通目录）、D5（写入必须人确认且绑定
// 具体提案版本与摘要）、D6（范围外路径被拒绝）、D7（代码场景无回归）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { folderConnector } from "../connectors/folder.ts";
import {
  bind,
  createGitConnector,
  currentFile,
  digest,
} from "../connectors/git.ts";
import { registerConnectorTools } from "../connectors/tools.ts";
import {
  readThrough,
  verifyThrough,
  writeThrough,
  type ConnectorWritePlan,
  type ConnectorWriteRequest,
} from "../connectors/types.ts";
import { scan, sourceFor } from "../domains/code/indexer.ts";
import { createServer } from "../server/server.ts";

/** 一个临时 Git 仓库：提交一个文件，另一个文件留在工作树里。 */
const gitRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "sand-connector-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "a.ts"), "export function value(){return 1;}\n");
  writeFileSync(join(root, "b.ts"), "export function other(){return 1;}\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  return { root, git };
};

const proposal = { id: "p1", version: 3, digest: "digest-3" };
const accepted = {
  decision: "accepted" as const,
  version: 3,
  digest: "digest-3",
};

test("D3 文件夹连接器可以独立读取普通目录（不需要是 Git 仓库）", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-folder-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "note.md"), "# 标题\n");
    writeFileSync(join(root, "sub", "code.ts"), "export const x = 1;\n");
    const result = readThrough(folderConnector, {
      binding: { id: "f1", label: "普通目录", root },
      kind: "file",
    }) as { references: any[]; contents: any[]; omitted: string[] };
    assert.equal(result.references.length, 2, "两个文件都被读到了");
    assert.equal(result.contents.length, 2);
    const note = result.references.find((r) => r.uri === "note.md");
    assert.ok(note, "引用指向文件");
    assert.equal(note!.kind, "file");
    assert.match(note!.fingerprint, /^[0-9a-f]{64}$/, "引用带内容指纹");
    const content = result.contents.find((c) => c.id === "folder:sub/code.ts");
    assert.match(content!.text, /export const x/);
    assert.deepEqual(result.omitted, [], "没有省略就如实说没有");
    // 只读连接器的能力声明里没有写。
    const descriptor = folderConnector.descriptor();
    assert.deepEqual(descriptor.capabilities.read.kinds, ["file"]);
    assert.equal(descriptor.capabilities.write, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D4 只读连接器调用写入时被拒绝，并说明原因", () => {
  assert.throws(
    () =>
      writeThrough(folderConnector, {
        files: [{ path: "note.md", beforeHash: null, content: "x" }],
      }),
    /folder 连接器是只读的：不能写入外部文件。/,
  );
});

test("D5 Git 写入必须经人确认，且确认绑定具体提案版本与摘要", async () => {
  const { root } = gitRepo();
  try {
    const bindings = bind([`unit=${root}`]);
    const connector = createGitConnector(bindings);
    const descriptor = connector.descriptor();
    assert.equal(descriptor.capabilities.write?.requiresConfirmation, true);
    assert.equal(descriptor.capabilities.write?.externalScope, "仓库工作树");
    assert.deepEqual(descriptor.capabilities.write?.kinds, ["file"]);
    const before = currentFile(bindings, {
      workspaceId: bindings[0].id,
      path: "a.ts",
    });
    const files = [
      {
        path: "a.ts",
        workspaceId: bindings[0].id,
        beforeHash: before.hash,
        content: "export function value(){return 2;}\n",
      },
    ];
    // 跳过确认直接写：拒绝。
    await assert.rejects(
      async () => writeThrough(connector, { files, proposal }),
      /写入未获人确认/,
    );
    // 人确认了别的版本：拒绝。
    await assert.rejects(
      async () =>
        writeThrough(connector, {
          files,
          proposal,
          confirmation: { decision: "accepted", version: 2, digest: "other" },
        }),
      /确认绑定的提案版本与摘要和当前提案不一致/,
    );
    // 人明确拒绝：拒绝。
    await assert.rejects(
      async () =>
        writeThrough(connector, {
          files,
          proposal,
          confirmation: {
            decision: "rejected",
            version: 3,
            digest: "digest-3",
          },
        }),
      /只有「accepted」才能写入/,
    );
    // 确认绑定了具体版本与摘要：通过。
    const plan = (await writeThrough(connector, {
      files,
      proposal,
      confirmation: accepted,
    })) as ConnectorWritePlan;
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].path, "a.ts");
    assert.equal(
      plan.files[0].afterHash,
      digest("export function value(){return 2;}\n"),
    );
    assert.equal(
      plan.files[0].beforeHash,
      before.hash,
      "绑定的是提案针对的那一版",
    );
    assert.ok(plan.baseline.length, "写之前记下了工作树基线");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D5 内容指纹：文件变了就不能再按旧提案写", async () => {
  const { root } = gitRepo();
  try {
    const bindings = bind([`unit=${root}`]);
    const connector = createGitConnector(bindings);
    const before = currentFile(bindings, {
      workspaceId: bindings[0].id,
      path: "a.ts",
    });
    // 提案针对的是这一版。
    const files = [
      {
        path: "a.ts",
        workspaceId: bindings[0].id,
        beforeHash: before.hash,
        content: "export function value(){return 2;}\n",
      },
    ];
    // 别人先改了文件。
    writeFileSync(join(root, "a.ts"), "export function value(){return 3;}\n");
    await assert.rejects(
      async () =>
        writeThrough(connector, { files, proposal, confirmation: accepted }),
      /内容已变化/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D6 范围外路径检查仍然有效", async () => {
  const { root } = gitRepo();
  try {
    const bindings = bind([`unit=${root}`]);
    const connector = createGitConnector(bindings);
    const before = currentFile(bindings, {
      workspaceId: bindings[0].id,
      path: "a.ts",
    });
    const files = [
      {
        path: "a.ts",
        workspaceId: bindings[0].id,
        beforeHash: before.hash,
        content: "export function value(){return 2;}\n",
      },
    ];
    // 不在声明的范围里：拒绝。
    await assert.rejects(
      async () =>
        writeThrough(connector, {
          files,
          scope: ["some-other-workspace"],
          proposal,
          confirmation: accepted,
        }),
      /范围外路径/,
    );
    // 路径逃出工作树：拒绝。
    await assert.rejects(
      async () =>
        writeThrough(connector, {
          files: [
            {
              path: "../outside.ts",
              workspaceId: bindings[0].id,
              beforeHash: null,
              content: "x",
            },
          ],
          proposal,
          confirmation: accepted,
        }),
      /Path must stay inside the configured worktree/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7 索引、引用、内容指纹与实际范围核对没有回归", async () => {
  const { root } = gitRepo();
  try {
    const bindings = bind([`unit=${root}`]);
    // 索引
    const projection = scan(bindings);
    const file = projection.objects.find((o) => o.kind === "file");
    const symbol = projection.objects.find((o) => o.kind === "symbol");
    assert.ok(file && symbol, "文件与符号都被索引");
    assert.equal(projection.workspaces.length, 1);
    assert.equal(projection.workspaces[0].files, 2);
    // 引用
    const excerpt = sourceFor(bindings, symbol!);
    assert.match(excerpt.text, /export function value/);
    assert.equal(excerpt.reference.hash, symbol!.source!.hash);
    // 内容指纹：文件变了，引用失效。
    writeFileSync(join(root, "a.ts"), "export function value(){return 9;}\n");
    assert.throws(() => sourceFor(bindings, symbol!), /changed/);

    // 确认链路 → 宿主写入 → 实际内容与范围核对
    const connector = createGitConnector(bindings);
    const before = currentFile(bindings, {
      workspaceId: bindings[0].id,
      path: "a.ts",
    });
    const request: ConnectorWriteRequest = {
      files: [
        {
          path: "a.ts",
          workspaceId: bindings[0].id,
          beforeHash: before.hash,
          content: "export function value(){return 2;}\n",
        },
      ],
      proposal,
      confirmation: accepted,
    };
    const plan = (await writeThrough(connector, request)) as ConnectorWritePlan;
    // 宿主写入。
    writeFileSync(join(root, "a.ts"), "export function value(){return 2;}\n");
    const matched = await verifyThrough(connector, {
      ...request,
      baseline: plan.baseline,
    });
    assert.equal(matched.state, "matches", "目标文件已经是目标内容");
    assert.equal(matched.files[0].state, "after");
    // 范围之外被动过：diverged，不是「大概对」。
    writeFileSync(join(root, "b.ts"), "export function other(){return 2;}\n");
    const diverged = await verifyThrough(connector, {
      ...request,
      baseline: plan.baseline,
    });
    assert.equal(diverged.state, "diverged");
    assert.ok(diverged.outsideChanges.includes("b.ts"), "范围外的改动被点出来");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git 连接器声明读能力，没有绑定仓库时说清不可用", () => {
  const connector = createGitConnector([]);
  const descriptor = connector.descriptor();
  assert.deepEqual(descriptor.capabilities.read.kinds, ["file", "git"]);
  assert.equal(descriptor.available, false);
  assert.match(descriptor.unavailableReason ?? "", /没有绑定任何仓库/);
  assert.throws(
    () =>
      readThrough(connector, {
        kind: "file",
      }) as unknown,
    /没有绑定仓库/,
  );
  // 没声明的读种类被拒绝。
  assert.throws(
    () => readThrough(connector, { kind: "pdf" }),
    /未声明读取种类/,
  );
});

test("Git 连接器读工作树：引用带指纹，内容只读", () => {
  const { root } = gitRepo();
  try {
    const bindings = bind([`unit=${root}`]);
    const connector = createGitConnector(bindings);
    const result = readThrough(connector, { kind: "file" }) as {
      references: any[];
      contents: any[];
      status: Record<string, unknown>;
    };
    assert.equal(result.references.length, 2);
    assert.ok(
      result.references.every((r) => /^[0-9a-f]{64}$/.test(r.fingerprint)),
      "每个引用都带内容指纹",
    );
    assert.match(result.status.head as string, /^[0-9a-f]{40}$/);
    assert.equal(result.status.branch, "master");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("连接器工具按能力声明注册：没声明的种类调用时被拒", async () => {
  const root = mkdtempSync(join(tmpdir(), "sand-folder-tool-"));
  try {
    writeFileSync(join(root, "note.md"), "# 标题\n");
    const tools: Record<string, (a: any) => any> = {};
    registerConnectorTools(
      (name, _description, shape, fn) => {
        tools[name] = (a) => fn(a);
      },
      [folderConnector],
    );
    assert.ok(tools.sand_read_folder, "文件夹连接器注册了读工具");
    const read = tools.sand_read_folder({ kind: "file", root });
    const contents = read.contents as { id: string; text: string }[];
    assert.equal(contents.length, 1);
    assert.match(contents[0].text, /标题/);
    // 没声明的读种类：拒绝。
    assert.throws(
      () => tools.sand_read_folder({ kind: "pdf", root }),
      /未声明读取种类/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D11 MCP 工具清单没有静默变化", async () => {
  const { server, dispose } = createServer([]);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-snapshot", version: "1" });
  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    // 搬迁前后的工具名必须一模一样：改名要写兼容说明，不能静默改。
    assert.deepEqual(names, [
      "sand_attach_asset",
      "sand_create_intent",
      "sand_decide_proposal",
      "sand_edit_space",
      "sand_edit_view",
      "sand_end_board",
      "sand_explain",
      "sand_export_component_pack",
      "sand_find_objects",
      "sand_focus",
      "sand_history",
      "sand_import_component_pack",
      "sand_import_repository",
      "sand_list_boards",
      "sand_list_component_packs",
      "sand_list_objects",
      "sand_open_board",
      "sand_open_view",
      "sand_prepare_apply",
      "sand_publish_guide",
      "sand_publish_proposal",
      "sand_read_approved_file",
      "sand_read_arrangement",
      "sand_read_asset",
      "sand_read_board",
      "sand_read_component",
      "sand_read_context",
      "sand_read_intent_arrangement",
      "sand_read_intents",
      "sand_read_object",
      "sand_read_proposal",
      "sand_read_source",
      "sand_read_spaces",
      "sand_read_target",
      "sand_redo",
      "sand_refresh_board",
      "sand_remove_component_pack",
      "sand_rename_board",
      "sand_report_activity",
      "sand_report_space_activity",
      "sand_report_validation",
      "sand_undo",
      "sand_undo_to",
      "sand_verify_proposal",
      "sand_workspace_status",
    ]);
    // 仓库导入工具的入参没有变。
    const importTool = tools.tools.find(
      (t) => t.name === "sand_import_repository",
    );
    assert.deepEqual(
      Object.keys(importTool!.inputSchema.properties ?? {}).sort(),
      ["boardId", "path", "revision", "viewId", "workspaceId"],
    );
  } finally {
    await client.close();
    dispose();
  }
});
