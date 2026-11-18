import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createUserMessage,
  createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import { createTaskChannel } from "../../dsh-plugin/tasks.js";
import { createArtifactWriter } from "../../server/host/artifacts.ts";
import { boardNamespace } from "../../resources/board-provider.ts";
import {
  openWorkspace,
  getMeta,
  boardContents,
  createRegistry,
} from "../../kernel/index.ts";
import { builtinPacks } from "../../packs/index.ts";

export const name = "sand-table-workbench-recovery-probe";
export const inject = ["sessions", "sessionPersistence", "sessionProjections"];
const sessionId = "sand-table-workbench-recovery-probe";
export async function apply(ctx, config) {
  const report = { phase: config.phase, ok: false, checks: {} };
  const checks = report.checks;
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  const opened = openWorkspace(config.workspace, "boards", registry);
  const db = opened.db;
  const scope = {
    workspaceId: "boards",
    boardId: getMeta(db, "home_board_id"),
    workspaceNamespace: boardNamespace(config.workspace, "boards"),
  };
  const checkpoint = join(config.workspace, "workbench-recovery-check.json");
  const writer = createArtifactWriter(config.workspace);
  let prompts = 0;
  // Deterministic execution fixture. Session log, projection and persisted read are real DSH services.
  const controller = {
    async prompt() {
      prompts++;
      return { accepted: true };
    },
  };
  const channel = createTaskChannel(
    {
      get: (name) =>
        name === "sessionController" ? controller : ctx.get(name),
      on: (name, listener) => ctx.on(name, listener),
      logger: ctx.logger,
    },
    {
      records: { appendPluginRecord, pluginRecordOf },
      writer,
      resolveScope: async () => scope,
    },
  );

  let stored;
  try {
    await channel.ready;
    assert.ok(channel.enabled());
    if (config.phase === "write") {
      const session = ctx.sessions.create(sessionId, {
        meta: { cwd: config.workspace },
      });
      stored = await ctx.sessionPersistence.create(session.header);
      const request = {
        ...scope,
        requestId: randomUUID(),
        displayText: "生成报告",
        instruction: "生成报告",
        contextVersion: 0,
        targets: [],
      };
      const result = await channel.submit(request, { id: session.id });
      assert.equal(result.state, "queued");
      assert.equal(prompts, 1);
      session.append("turn/start", { turn: 1 });
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: request.instruction }],
          source: { kind: "user", rpcId: request.requestId },
        }),
        { surfaceOp: "append" },
      );
      session.append("step/start", { turn: 1, step: 1 });
      session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            source: { provider: "fixture", model: "fixture" },
            content: [
              { type: "text", text: "已生成报告" },
              {
                type: "tool-call",
                id: "call-real-log",
                name: "sand_table_publish_artifact",
                arguments: "{}",
              },
            ],
          }),
        },
        { surfaceOp: "append" },
      );
      session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: "call-real-log",
        name: "sand_table_publish_artifact",
        arguments: "{}",
      });
      session.append(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: "call-real-log",
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  protocol: "sand-table/artifact-v1",
                  artifact: {
                    kind: "note",
                    title: "恢复验证作品",
                    body: "DSH 宿主交付",
                  },
                }),
              },
            ],
          }),
        },
        { surfaceOp: "append" },
      );
      session.append("step/end", { turn: 1, step: 1 });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      let task;
      for (let j = 0; j < 150; j++) {
        task = await channel.get(result.taskId, { id: session.id });
        if (task.deliveries[0]?.state === "written") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(task.state, "done");
      assert.equal(
        task.deliveries[0]?.state,
        "written",
        JSON.stringify(task.deliveries),
      );
      const rows = boardContents(db, registry, scope.boardId).objects;
      assert.equal(rows.length, 1);
      const revision = getMeta(db, "revision");
      await stored.flush();
      await writeFile(
        checkpoint,
        JSON.stringify({
          session: task.session,
          requestId: request.requestId,
          objectId: rows[0].id,
          revision,
        }),
      );
      checks.durableBeforePrompt = true;
      checks.deliveryWithoutBrowser = true;
      checks.durableReceipt = true;
    } else {
      const marker = JSON.parse(await readFile(checkpoint, "utf8"));
      assert.equal(ctx.sessions.get(sessionId), undefined);
      const recovered = await channel.follow(scope, { id: sessionId });
      assert.deepEqual(recovered.session, marker.session);
      assert.equal(recovered.tasks.length, 1);
      assert.equal(recovered.tasks[0].taskId, marker.requestId);
      assert.equal(recovered.tasks[0].state, "done");
      assert.deepEqual(recovered.tasks[0].messages, ["已生成报告"]);
      assert.equal(recovered.tasks[0].deliveries[0].objectId, marker.objectId);
      assert.equal(getMeta(db, "revision"), marker.revision);
      assert.equal(
        boardContents(db, registry, scope.boardId).objects.length,
        1,
      );
      assert.equal(prompts, 0);
      checks.coldSessionIdentity = true;
      checks.coldTaskAndArtifact = true;
      checks.replayDoesNotExecuteOrWrite = true;
    }
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    await channel.dispose();
    await stored?.close();
    db.close();
  }
  await writeFile(config.reportPath, JSON.stringify(report, null, 2) + "\n");
}
