// T22：代码包在 v3 上的导入、刷新和改动链路。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CommandError, type Actor } from "../kernel/index.ts";
import { spillText, TEXT_BLOB_LIMIT } from "../packs/code/blobs.ts";
import { digest } from "../packs/code/git.ts";
import { decideProposal } from "../packs/code/tools.ts";
import { createServerV3 } from "../server/v3/server.ts";

const HUMAN: Actor = { id: "human", kind: "human" };
const AGENT: Actor = { id: "agent", kind: "agent" };

async function open() {
  const root = mkdtempSync(join(tmpdir(), "sand-code-pack-"));
  const created = createServerV3({ workspaceRoot: root, workspaceId: "code" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "code-tester", version: "1" });
  await Promise.all([
    client.connect(clientTransport),
    created.server.connect(serverTransport),
  ]);
  const workspace = created.workspace();
  if (!workspace) throw new Error("工作空间没有打开");
  return {
    client,
    db: workspace.db,
    registry: created.registry,
    close: async () => {
      created.dispose();
      await client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[])[0]?.text;
  return {
    isError: Boolean(result.isError),
    text: text ?? "",
    data: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

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

function historyCount(entries: unknown) {
  return Array.isArray(entries) ? entries.length : 0;
}

function gitRepo(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  return { root: realpathSync(root), git };
}

test("导入和刷新代码索引：稳定编号、删除消失、不进历史", async () => {
  const session = await open();
  const repo = gitRepo("sand-code-index-");
  const other = repo.root + "-worktree";
  try {
    writeFileSync(join(repo.root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo.root, "b.ts"), "export const b = 1;\n");
    writeFileSync(
      join(repo.root, "index.ts"),
      "export function value(){return 1;}\n",
    );
    writeFileSync(
      join(repo.root, "long.md"),
      Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n"),
    );
    repo.git("add", ".");
    repo.git("commit", "-m", "fixture");
    const bindingId = digest(repo.root).slice(0, 16);
    const legacyId = `${bindingId}:a.ts`;
    const enabled = await call(session.client, "app_edit", {
      commands: [{ op: "pack.enable", id: "code" }],
    });
    assert.equal(enabled.isError, false, enabled.text);
    const now = Date.now();
    session.db
      .prepare(
        `INSERT INTO objects (
           id, type, type_version, title, data, source, version,
           created_at, created_by, updated_at, updated_by, rev
         ) VALUES (?, 'code.file', 1, 'a.ts', ?, ?, 1, ?, 'v2', ?, 'v2', 0)`,
      )
      .run(
        legacyId,
        JSON.stringify({ path: "a.ts" }),
        JSON.stringify({
          origin: "derived",
          external: {
            kind: "file",
            uri: `v2-code-entry:${legacyId}`,
            fragment: "a.ts",
          },
        }),
        now,
        now,
      );
    const before = await call(session.client, "sand_history", {
      action: "list",
    });
    const imported = await call(session.client, "code_repo", {
      action: "import",
      path: repo.root,
    });
    assert.equal(imported.isError, false, imported.text);
    const afterImport = await call(session.client, "sand_history", {
      action: "list",
    });
    assert.equal(
      historyCount(afterImport.data.entries),
      historyCount(before.data.entries),
      "导入索引不能产生历史",
    );
    const repositoryId = imported.data.repositoryId as string;
    assert.equal(repositoryId, `code:${bindingId}`);
    const files = await call(session.client, "sand_query", {
      types: ["code.file"],
      limit: 50,
    });
    assert.equal(files.isError, false, files.text);
    const rows = files.data.rows as { id: string; title: string }[];
    assert.ok(rows.some((row) => row.title === "b.ts"));
    assert.equal(
      rows.find((row) => row.title === "a.ts")?.id,
      legacyId,
      "刷新要复用旧编号",
    );
    assert.equal(
      rows.find((row) => row.title === "b.ts")?.id,
      `code:${bindingId}:b.ts`,
    );
    const symbols = await call(session.client, "sand_query", {
      types: ["code.symbol"],
      text: "value",
      limit: 50,
    });
    const symbol = (symbols.data.rows as { id: string; title: string }[]).find(
      (row) => row.title === "value",
    );
    assert.ok(symbol);
    assert.match(
      symbol.id,
      new RegExp(`^code:${bindingId}:index\\.ts#value:\\d+$`),
    );
    const symbolId = symbol.id;
    const long = rows.find((row) => row.title === "long.md");
    assert.ok(long);
    const first = await call(session.client, "code_repo", {
      action: "read_source",
      objectId: long.id,
    });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.data.nextLine, 121);
    const nextPage = await call(session.client, "code_repo", {
      action: "read_source",
      objectId: long.id,
      startLine: 121,
    });
    assert.equal(nextPage.isError, false, nextPage.text);
    assert.equal(nextPage.data.nextLine, null);
    assert.match(String(nextPage.data.text), /line 150$/);
    const excerpt = await call(session.client, "code_repo", {
      action: "read_source",
      objectId: symbolId,
    });
    assert.match(String(excerpt.data.text), /return 1/);
    writeFileSync(
      join(repo.root, "index.ts"),
      "export function value(){return 2;}\n",
    );
    const stale = await call(session.client, "code_repo", {
      action: "read_source",
      objectId: symbolId,
    });
    assert.equal(stale.isError, true, stale.text);
    assert.match(stale.text, /刷新索引/);
    unlinkSync(join(repo.root, "b.ts"));
    const refreshed = await call(session.client, "code_repo", {
      action: "refresh",
    });
    assert.equal(refreshed.isError, false, refreshed.text);
    const afterRefresh = await call(session.client, "sand_history", {
      action: "list",
    });
    assert.equal(
      historyCount(afterRefresh.data.entries),
      historyCount(before.data.entries),
      "刷新索引不能产生历史",
    );
    const left = await call(session.client, "sand_query", {
      types: ["code.file"],
      limit: 50,
    });
    const leftRows = left.data.rows as { id: string; title: string }[];
    assert.equal(
      leftRows.some((row) => row.title === "b.ts"),
      false,
      "已经消失的文件要软删除",
    );
    const again = await call(session.client, "code_repo", {
      action: "read_source",
      objectId: symbolId,
    });
    assert.equal(again.isError, false, again.text);
    assert.match(String(again.data.text), /return 2/);
    const symbolsAfter = await call(session.client, "sand_query", {
      types: ["code.symbol"],
      text: "value",
      limit: 50,
    });
    assert.equal(
      (symbolsAfter.data.rows as { id: string }[]).find((row) =>
        row.id.includes("#value:"),
      )?.id,
      symbolId,
    );
    writeFileSync(join(repo.root, "b.ts"), "export const b = 1;\n");
    repo.git("add", "b.ts");
    const restored = await call(session.client, "code_repo", {
      action: "refresh",
    });
    assert.equal(restored.isError, false, restored.text);
    const back = await call(session.client, "sand_query", {
      types: ["code.file"],
      limit: 50,
    });
    assert.equal(
      (back.data.rows as { id: string; title: string }[]).find(
        (row) => row.title === "b.ts",
      )?.id,
      `code:${bindingId}:b.ts`,
    );
    const current = await call(session.client, "sand_status");
    const badPath = await call(session.client, "code_change", {
      action: "create_intent",
      boardId: current.data.homeBoardId,
      revision: (current.data.workspace as { revision: number }).revision,
      request: "越界",
      allowedFiles: [{ workspaceId: repositoryId, path: "../secret" }],
    });
    assert.equal(badPath.isError, true);
    assert.match(badPath.text, /路径/);
    symlinkSync(join(repo.root, "a.ts"), join(repo.root, "link.ts"));
    const status = await call(session.client, "sand_status");
    const revision = (status.data.workspace as { revision: number }).revision;
    const boardId = status.data.homeBoardId as string;
    const intent = await call(session.client, "code_change", {
      action: "create_intent",
      boardId,
      revision,
      request: "读取符号链接",
      allowedFiles: [{ workspaceId: repositoryId, path: "link.ts" }],
    });
    assert.equal(intent.isError, false, intent.text);
    const linked = await call(session.client, "code_change", {
      action: "read_target",
      intentId: intent.data.id,
      workspaceId: repositoryId,
      path: "link.ts",
    });
    assert.equal(linked.isError, true);
    assert.match(linked.text, /符号链接/);
    repo.git("worktree", "add", "-b", "other", other);
    const otherRepo = await call(session.client, "code_repo", {
      action: "import",
      path: other,
    });
    assert.equal(otherRepo.isError, false, otherRepo.text);
    assert.notEqual(otherRepo.data.repositoryId, repositoryId);
  } finally {
    await session.close();
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("改动链路：人批准、模型不能批准、摘要被改后失效、核对一致与不一致", async () => {
  const session = await open();
  const repo = gitRepo("sand-code-change-");
  try {
    writeFileSync(join(repo.root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo.root, "b.ts"), "export const b = 1;\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "fixture");
    const enabled = await call(session.client, "app_edit", {
      commands: [{ op: "pack.enable", id: "code" }],
    });
    assert.equal(enabled.isError, false, enabled.text);
    const imported = await call(session.client, "code_repo", {
      action: "import",
      path: repo.root,
    });
    assert.equal(imported.isError, false, imported.text);
    const repositoryId = imported.data.repositoryId as string;
    const status = await call(session.client, "sand_status");
    const boardId = status.data.homeBoardId as string;
    const revision = (status.data.workspace as { revision: number }).revision;
    const beforeHistory = await call(session.client, "sand_history", {
      action: "list",
    });
    const intent = await call(session.client, "code_change", {
      action: "create_intent",
      boardId,
      revision,
      request: "把两个导出改成 2",
      allowedFiles: ["a.ts", "b.ts"].map((path) => ({
        workspaceId: repositoryId,
        path,
      })),
    });
    assert.equal(intent.isError, false, intent.text);
    const afterIntent = await call(session.client, "sand_history", {
      action: "list",
    });
    assert.ok(
      historyCount(afterIntent.data.entries) >
        historyCount(beforeHistory.data.entries),
      "意图要进历史",
    );
    const hash = (path: string) =>
      digest(readFileSync(join(repo.root, path), "utf8"));
    const published = await call(session.client, "code_change", {
      action: "publish_proposal",
      intentId: intent.data.id,
      intentVersion: intent.data.version,
      agentId: "unit host",
      title: "两个值",
      explanation: "测试提案",
      testPlan: "看导出的值",
      files: [
        {
          workspaceId: repositoryId,
          path: "a.ts",
          beforeHash: hash("a.ts"),
          after: "export const a = 2;\n",
        },
        {
          workspaceId: repositoryId,
          path: "b.ts",
          beforeHash: hash("b.ts"),
          after: "export const b = 2;\n",
        },
      ],
    });
    assert.equal(published.isError, false, published.text);
    assert.equal(
      readFileSync(join(repo.root, "a.ts"), "utf8"),
      "export const a = 1;\n",
    );
    const proposalId = published.data.id as string;
    const version = published.data.version as number;
    const proposalDigest = published.data.digest as string;
    assert.throws(
      () =>
        decideProposal(session.db, session.registry, AGENT, {
          proposalId,
          decision: "approve",
          digest: proposalDigest,
        }),
      (error: unknown) =>
        error instanceof CommandError && error.code === "FORBIDDEN",
    );
    const refused = await call(session.client, "code_decide", {
      proposalId,
      decision: "approve",
      digest: "wrong-digest",
    });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /FORBIDDEN|摘要/);
    const approved = decideProposal(session.db, session.registry, HUMAN, {
      proposalId,
      decision: "approve",
      digest: proposalDigest,
    });
    assert.equal(approved.decision, "accepted");
    const prepared = await call(session.client, "code_change", {
      action: "prepare_apply",
      proposalId,
      version,
      digest: proposalDigest,
    });
    assert.equal(prepared.isError, false, prepared.text);
    assert.equal(prepared.data.ready, true);
    const approvedFile = await call(session.client, "code_change", {
      action: "read_approved_file",
      proposalId,
      version,
      digest: proposalDigest,
      fileIndex: 0,
    });
    assert.equal(approvedFile.isError, false, approvedFile.text);
    assert.equal(approvedFile.data.after, "export const a = 2;\n");
    writeFileSync(join(repo.root, "a.ts"), "export const a = 2;\n");
    const partial = await call(session.client, "code_change", {
      action: "verify",
      proposalId,
    });
    assert.equal(partial.isError, false, partial.text);
    assert.equal(partial.data.state, "partial");
    writeFileSync(join(repo.root, "b.ts"), "export const b = 2;\n");
    const matched = await call(session.client, "code_change", {
      action: "verify",
      proposalId,
    });
    assert.equal(matched.isError, false, matched.text);
    assert.equal(matched.data.state, "matches");
    writeFileSync(join(repo.root, "outside.md"), "unexpected");
    const diverged = await call(session.client, "code_change", {
      action: "verify",
      proposalId,
    });
    assert.equal(diverged.data.state, "diverged");
    assert.ok(
      (diverged.data.outsideChanges as { path: string }[]).some(
        (file) => file.path === "outside.md",
      ),
    );
    unlinkSync(join(repo.root, "outside.md"));
    const read = await call(session.client, "sand_read", { ids: [proposalId] });
    const objectVersion = (read.data.objects as { version: number }[])[0]
      ?.version;
    const edited = await call(session.client, "sand_edit", {
      commands: [
        {
          op: "object.update",
          id: proposalId,
          expectedVersion: objectVersion,
          set: { explanation: "批准之后又改了说明" },
        },
      ],
    });
    assert.equal(edited.isError, false, edited.text);
    assert.throws(
      () =>
        decideProposal(session.db, session.registry, HUMAN, {
          proposalId,
          decision: "approve",
          digest: proposalDigest,
        }),
      (error: unknown) =>
        error instanceof CommandError && error.code === "INVALID_DATA",
    );
    chmodSync(join(repo.root, "a.ts"), 0o755);
    const mode = await call(session.client, "code_change", {
      action: "verify",
      proposalId,
    });
    assert.equal(mode.data.state, "diverged");
  } finally {
    await session.close();
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("启用代码包后模型多两个工具，停用后恢复", async () => {
  const session = await open();
  try {
    const before = await modelTools(session.client);
    assert.equal(before.includes("code_repo"), false);
    assert.equal(before.includes("code_change"), false);
    const enabled = await call(session.client, "app_edit", {
      commands: [{ op: "pack.enable", id: "code" }],
    });
    assert.equal(enabled.isError, false, enabled.text);
    const after = await modelTools(session.client);
    assert.deepEqual(
      after.filter((name) => !before.includes(name)),
      ["code_change", "code_repo"],
    );
    assert.equal(after.length, before.length + 2);
    const listed = await session.client.listTools();
    const decide = listed.tools.find((tool) => tool.name === "code_decide");
    assert.ok(decide, "启用后界面要能看到 code_decide");
    const visibility = (
      decide._meta as { ui?: { visibility?: string[] } } | undefined
    )?.ui?.visibility;
    assert.deepEqual(visibility, ["app"]);
    assert.equal(after.includes("code_decide"), false);
    const disabled = await call(session.client, "app_edit", {
      commands: [{ op: "pack.disable", id: "code" }],
    });
    assert.equal(disabled.isError, false, disabled.text);
    const restored = await modelTools(session.client);
    assert.deepEqual(restored, before);
  } finally {
    await session.close();
  }
});

test("超过 1 MB 的基线文本写入 blobs 并以 sha256 引用", async () => {
  const session = await open();
  try {
    const text = "a".repeat(TEXT_BLOB_LIMIT + 1);
    const stored = spillText(session.db, text);
    assert.equal(typeof stored, "object");
    if (typeof stored === "string") return;
    assert.equal(stored.bytes, TEXT_BLOB_LIMIT + 1);
    assert.match(stored.blob, /^[0-9a-f]{64}$/);
    const validated = session.registry.validateData("code.proposal", {
      files: [
        {
          workspaceId: "repo",
          path: "a.ts",
          before: stored,
          after: null,
        },
      ],
    });
    assert.equal(validated.ok, true, JSON.stringify(validated));
    assert.equal(spillText(session.db, "short"), "short");
  } finally {
    await session.close();
  }
});

test(
  "外部仓库可以导入出 code.file",
  { skip: !process.env.SAND_EXTERNAL_REPO },
  async () => {
    const session = await open();
    try {
      const enabled = await call(session.client, "app_edit", {
        commands: [{ op: "pack.enable", id: "code" }],
      });
      assert.equal(enabled.isError, false, enabled.text);
      const imported = await call(session.client, "code_repo", {
        action: "import",
        path: process.env.SAND_EXTERNAL_REPO,
      });
      assert.equal(imported.isError, false, imported.text);
      const files = await call(session.client, "sand_query", {
        types: ["code.file"],
        limit: 50,
      });
      assert.ok(Number(files.data.total) > 0);
    } finally {
      await session.close();
    }
  },
);

test(
  "外部 Python 仓库能索引到 snapshot_download",
  { skip: !process.env.SAND_PYTHON_REPO },
  async () => {
    const session = await open();
    try {
      const enabled = await call(session.client, "app_edit", {
        commands: [{ op: "pack.enable", id: "code" }],
      });
      assert.equal(enabled.isError, false, enabled.text);
      const imported = await call(session.client, "code_repo", {
        action: "import",
        path: process.env.SAND_PYTHON_REPO,
      });
      assert.equal(imported.isError, false, imported.text);
      const found = await call(session.client, "sand_query", {
        types: ["code.symbol"],
        text: "snapshot_download",
        limit: 50,
      });
      assert.ok(Number(found.data.total) > 0);
    } finally {
      await session.close();
    }
  },
);
