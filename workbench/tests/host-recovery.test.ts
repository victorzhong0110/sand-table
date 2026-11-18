import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  applyCommands,
  applyDelivery,
  boardContents,
  createRegistry,
  getMeta,
  importWorkspaceBundle,
  exportWorkspaceBundle,
  openWorkspace,
  undo,
} from "../kernel/index.ts";
import { builtinPacks } from "../packs/index.ts";
import { boardNamespace } from "../resources/board-provider.ts";
import { createArtifactWriter } from "../server/host/artifacts.ts";
import { dshWorkbenchFixture, emitArtifact } from "./fixtures/dsh-workbench.ts";

const plugin = "../dsh-plugin/tasks.js";
const actor = { kind: "human" as const, id: "human" };
const agent = { id: "session" };

function setup(cleanup: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "sand-host-recovery-"));
  cleanup.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  const { db } = openWorkspace(root, "main", registry);
  cleanup.after(() => db.close());
  const boardId = getMeta(db, "home_board_id")!;
  const scope = {
    workspaceId: "main",
    boardId,
    workspaceNamespace: boardNamespace(root, "main"),
  };
  const request = {
    ...scope,
    requestId: randomUUID(),
    instruction: "整理实验结果",
    displayText: "整理实验结果",
    contextVersion: 1,
    targets: [],
  };
  return {
    root,
    registry,
    db,
    boardId,
    scope,
    request,
    writer: createArtifactWriter(root),
  };
}

test("交付回执与作品同事务，跨连接去重，撤销及导出不复制宿主回执", (t) => {
  const s = setup(t);
  const key = "a".repeat(64);
  const batch = {
    actor,
    commands: [
      {
        op: "object.create" as const,
        type: "base.note",
        ref: "artifact",
        title: "作品",
      },
      {
        op: "presentation.create" as const,
        boardId: s.boardId,
        objectId: "@artifact",
      },
    ],
  };
  assert.throws(
    () =>
      applyDelivery(s.db, s.registry, key, {
        ...batch,
        commands: [
          batch.commands[0],
          {
            op: "presentation.create",
            boardId: "missing",
            objectId: "@artifact",
          },
        ],
      }),
    /白板|对象/,
  );
  assert.equal(s.writer.receipt(s.scope, key), undefined);
  assert.equal(boardContents(s.db, s.registry, s.boardId).objects.length, 0);
  const result = applyDelivery(s.db, s.registry, key, batch);
  const other = openWorkspace(s.root, "main", s.registry).db;
  try {
    assert.deepEqual(applyDelivery(other, s.registry, key, batch), result);
    assert.throws(
      () => applyDelivery(other, s.registry, key, { ...batch, label: "异参" }),
      /同一交付编号/,
    );
    assert.equal(getMeta(other, "revision"), String(result.revision));
  } finally {
    other.close();
  }
  undo(s.db, actor);
  assert.deepEqual(applyDelivery(s.db, s.registry, key, batch), result);
  assert.equal(boardContents(s.db, s.registry, s.boardId).objects.length, 0);
  const exported = exportWorkspaceBundle(s.db);
  const imported = importWorkspaceBundle(s.root, s.registry, exported.json);
  assert.equal(
    s.writer.receipt(
      {
        workspaceId: imported.workspaceId,
        boardId: s.boardId,
        workspaceNamespace: boardNamespace(s.root, imported.workspaceId),
      },
      key,
    ),
    undefined,
  );
});

test("请求回执丢失后按 DSH 日志查证，不重发或把普通回复写成作品", async (t) => {
  const s = setup(t),
    fixture = dshWorkbenchFixture();
  const { createTaskChannel } = await import(plugin);
  let prompts = 0,
    cancelled = 0;
  const ctx = fixture.ctx({
    async prompt() {
      prompts++;
      throw Error("admission response lost");
    },
    async cancel() {
      cancelled++;
      return { accepted: true };
    },
  });
  const options = {
    records: fixture.records,
    writer: s.writer,
    resolveScope: async () => s.scope,
  };
  let channel = createTaskChannel(ctx, options);
  const first = await channel.submit(s.request, agent);
  assert.equal(first.state, "waiting");
  assert.equal(prompts, 1);
  await channel.dispose();
  fixture.detach(agent.id);
  channel = createTaskChannel(ctx, options);
  t.after(() => channel.dispose());
  assert.equal(
    (await channel.follow(s.scope, agent)).tasks[0].state,
    "waiting",
  );
  const restored = fixture.attach(agent.id);
  assert.equal((await channel.submit(s.request, agent)).taskId, first.taskId);
  assert.equal(prompts, 1);
  await assert.rejects(
    channel.submit({ ...s.request, instruction: "另一指令" }, agent),
    /同一请求编号/,
  );
  const emit = (type: string, data: unknown) =>
    fixture.emit(type, data, restored);
  emit("turn/start", { turn: 1 });
  emit("user/message", {
    source: { kind: "user", rpcId: s.request.requestId },
  });
  emit("assistant/message", {
    turn: 1,
    message: { content: [{ type: "text", text: "这是普通回复" }] },
  });
  emitArtifact(
    fixture,
    1,
    { kind: "note", title: "外部工具 JSON", body: "不得自动落板" },
    { toolName: "web_search", session: restored },
  );
  assert.equal((await channel.get(first.taskId, agent)).state, "running");
  await channel.cancel(first.taskId, agent);
  assert.equal(cancelled, 1);
  assert.equal((await channel.get(first.taskId, agent)).state, "running");
  emit("turn/end", { turn: 1, reason: { kind: "aborted" } });
  emit("assistant/message", {
    turn: 1,
    message: { content: [{ type: "text", text: "迟到" }] },
  });
  const saved = await channel.get(first.taskId, agent);
  assert.equal(saved.state, "cancelled");
  assert.deepEqual(saved.messages, ["这是普通回复"]);
  assert.deepEqual(saved.deliveries, []);
  assert.equal(boardContents(s.db, s.registry, s.boardId).objects.length, 0);
  assert.equal(
    (await channel.follow({ ...s.scope, workspaceId: "elsewhere" }, agent))
      .tasks.length,
    0,
  );
  const reused = fixture.attach("another-session", 42);
  await fixture.flush(reused);
  await assert.rejects(channel.get(first.taskId, { id: reused.id }), /找不到/);
});

test("产物落库前后断开均可对账，重放不写库，并发人工编辑保留候选", async (t) => {
  const s = setup(t),
    fixture = dshWorkbenchFixture();
  const { createTaskChannel } = await import(plugin);
  const original = applyCommands(s.db, s.registry, {
    actor,
    commands: [
      {
        op: "object.create",
        ref: "original",
        type: "base.note",
        data: { body: "提交时" },
      },
      { op: "presentation.create", objectId: "@original", boardId: s.boardId },
    ],
  }).created.original;
  const request = {
    ...s.request,
    targets: [{ objectId: original, version: 1 }],
  };
  const ctx = fixture.ctx({ prompt: async () => ({ accepted: true }) });
  let writes = 0;
  const options = {
    records: fixture.records,
    resolveScope: async () => s.scope,
    writer: {
      ...s.writer,
      write(...args: Parameters<typeof s.writer.write>) {
        writes++;
        if (writes === 1) throw Error("在落库前失去连接");
        const result = s.writer.write(...args);
        if (writes === 2) throw Error("已落库，回执丢失");
        return result;
      },
    },
  };
  let channel = createTaskChannel(ctx, options);
  const { taskId } = await channel.submit(request, agent);
  applyCommands(s.db, s.registry, {
    actor,
    commands: [
      {
        op: "object.update",
        id: original,
        expectedVersion: 1,
        set: { body: "人工并发修改" },
      },
    ],
  });
  fixture.emit("turn/start", { turn: 2 });
  fixture.emit("user/message", {
    source: { kind: "user", rpcId: request.requestId },
  });
  emitArtifact(fixture, 2, {
    kind: "note",
    title: "候选",
    body: "建议正文",
    candidateFor: { objectId: original, version: 1 },
  });
  fixture.emit("turn/end", { turn: 2, reason: { kind: "completed" } });
  for (
    let i = 0;
    i < 50 && !(await channel.get(taskId, agent)).deliveries[0]?.reason;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await channel.get(taskId, agent)).state, "done");
  assert.equal(writes, 1);
  await channel.dispose();
  fixture.detach(agent.id);
  const before = getMeta(s.db, "revision");
  channel = createTaskChannel(ctx, options);
  t.after(() => channel.dispose());
  assert.equal(
    (await channel.get(taskId, agent)).deliveries[0].state,
    "pending",
  );
  assert.equal(getMeta(s.db, "revision"), before);
  fixture.attach(agent.id);
  await channel.reconcile(taskId, agent);
  assert.equal(writes, 2);
  const after = getMeta(s.db, "revision");
  assert.equal(
    (await channel.reconcile(taskId, agent)).deliveries[0].state,
    "written",
  );
  assert.equal(getMeta(s.db, "revision"), after);
  assert.equal(writes, 2);
  const rows = boardContents(s.db, s.registry, s.boardId).objects;
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.id === original)?.data.body,
    "人工并发修改",
  );
  assert.ok(rows.some((row) => row.title === "待确认 · 候选"));
});
