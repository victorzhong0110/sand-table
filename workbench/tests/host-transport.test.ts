import test from "node:test";
import assert from "node:assert/strict";
import { installHostBridgeClient } from "../board/host-bridge-client.ts";
import { readInjectedBridge } from "../core/host-bridge.ts";
test("late cross-origin handshake, requests, actual response events, cancel and timeout", async () => {
  let listener: (e: any) => void = () => {},
    changes = 0;
  const sent: any[] = [];
  const scope = {
    addEventListener: (_: string, fn: any) => {
      listener = fn;
    },
    removeEventListener: () => {},
  };
  const parent = {
    postMessage: (data: any, origin: string) => sent.push({ data, origin }),
  };
  const client = installHostBridgeClient({
    scope,
    parent,
    timeoutMs: 20,
    onCapabilities: () => changes++,
  });
  const event = (
    data: any,
    source: any = parent,
    origin = "http://127.0.0.1:3000",
  ) => listener({ source, origin, data });
  const hello = {
    type: "sand-table:host-bridge",
    host: {
      host: "dsh",
      capabilities: { taskSubmit: true, eventStream: true },
    },
  };
  sent.length = 0;
  event(hello, {});
  assert.equal(changes, 0);
  event(hello);
  assert.equal(changes, 1);
  const bridge = readInjectedBridge(scope)!;
  const task = bridge.submitTask({
    boardId: "b",
    instruction: "hello",
    targets: [],
    contextVersion: 1,
  });
  assert.equal(sent[0].origin, "http://127.0.0.1:3000");
  event({
    type: "sand-table:submit-task-result",
    id: sent[0].data.id,
    taskId: "actual-id",
  });
  assert.equal((await task).taskId, "actual-id");
  const seen: any[] = [];
  bridge.subscribe((e) => seen.push(e));
  event({
    type: "sand-table:task-event",
    event: { taskId: "actual-id", state: "done" },
  });
  assert.equal(seen[0].state, "done");
  const cancel = bridge.cancelTask!("actual-id");
  assert.equal(sent[1].data.type, "sand-table:cancel-task");
  event({
    type: "sand-table:submit-task-result",
    id: sent[1].data.id,
    taskId: "actual-id",
  });
  await cancel;
  await assert.rejects(
    bridge.submitTask({
      boardId: "b",
      instruction: "timeout",
      targets: [],
      contextVersion: 1,
    }),
    /超时/,
  );
  client.dispose();
});
test("DSH keeps replies in the conversation and publishes only structured tool artifacts", async () => {
  const file = "../dsh-plugin/tasks.js";
  const { createTaskChannel } = await import(file);
  let onEvent: (s: any, e: any) => void = () => {},
    request: any,
    cancelled: any;
  const channel = createTaskChannel({
    get: () => ({
      prompt: async (r: any) => {
        request = r;
        return { accepted: true };
      },
      cancel: async (r: any) => {
        cancelled = r;
      },
    }),
    on: (_: string, fn: any) => {
      onEvent = fn;
      return () => {};
    },
  });
  const task = await channel.submit(
    { boardId: "board", instruction: "read", targets: [], contextVersion: 1 },
    { id: "session" },
  );
  assert.equal(task.taskId, request.requestId);
  onEvent({ id: "session" }, { type: "turn/start", data: { turn: 2 } });
  onEvent(
    { id: "session" },
    { type: "user/message", data: { source: { rpcId: request.requestId } } },
  );
  onEvent(
    { id: "session" },
    {
      type: "assistant/message",
      data: {
        turn: 1,
        message: { content: [{ type: "text", text: "unrelated" }] },
      },
    },
  );
  onEvent(
    { id: "session" },
    {
      type: "assistant/message",
      data: {
        turn: 2,
        message: { content: [{ type: "text", text: "actual response" }] },
      },
    },
  );
  const replyStatus = channel.status(task.taskId, { id: "session" });
  assert.deepEqual(
    replyStatus.events.map((event: any) => event.message),
    ["已提交给宿主会话", "AI 正在处理", "actual response"],
  );
  assert.deepEqual(
    replyStatus.events.flatMap((event: any) => event.results ?? []),
    [],
    "ordinary replies must not become board artifacts",
  );
  onEvent(
    { id: "session" },
    {
      type: "tool/result",
      seq: 4,
      data: {
        turn: 2,
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ kind: "dataset", rows: [["x"], [1]] }),
            },
          ],
        },
      },
    },
  );
  const status = channel.status(task.taskId, { id: "session" });
  assert.deepEqual(
    status.events.flatMap((e: any) => e.results ?? []),
    [
      {
        kind: "dataset",
        rows: [["x"], [1]],
        source: "DSH session / tool result 4",
      },
    ],
  );
  assert.equal(status.events[2].message, "actual response");
  assert.throws(() => channel.status(task.taskId, { id: "other" }), /找不到/);
  await channel.cancel(task.taskId, { id: "session" });
  assert.equal(cancelled.sessionId, "session");
  assert.equal(channel.status(task.taskId, { id: "session" }).state, "running");
  onEvent(
    { id: "session" },
    { type: "turn/end", data: { turn: 2, reason: { kind: "aborted" } } },
  );
  assert.equal(
    channel.status(task.taskId, { id: "session" }).state,
    "cancelled",
  );
  channel.dispose();
});

test("资源桥保留能力门控、父页校验与请求关联", async () => {
  let listener: (event: any) => void = () => {};
  const sent: any[] = [];
  const scope = {
    addEventListener: (_: string, fn: any) => {
      listener = fn;
    },
    removeEventListener: () => {},
  };
  const parent = { postMessage: (data: any) => sent.push(data) };
  const transport = installHostBridgeClient({ scope, parent, timeoutMs: 100 });
  const origin = "https://host.example";
  listener({
    source: parent,
    origin,
    data: {
      type: "sand-table:host-bridge",
      host: { host: "dsh", capabilities: { resourceRead: true } },
    },
  });
  const bridge = readInjectedBridge(scope)!;
  assert.equal(bridge.capabilities().resourceRead, true);
  const args = {
    objectId: "reference",
    expectedVersion: 2,
    workspaceId: "a",
    action: "read" as const,
  };
  const reading = bridge.resourceRequest!(args);
  const request = sent.at(-1);
  assert.deepEqual(request.request, args);
  listener({
    source: {},
    origin,
    data: {
      type: "sand-table:resource-result",
      id: request.id,
      result: "wrong",
    },
  });
  const value = {
    objectId: "reference",
    objectVersion: 2,
    value: { status: "provider_missing" },
  };
  listener({
    source: parent,
    origin,
    data: { type: "sand-table:resource-result", id: request.id, result: value },
  });
  assert.deepEqual(await reading, value);
  transport.dispose();
  const reconnected = installHostBridgeClient({
    scope,
    parent,
    timeoutMs: 100,
  });
  listener({
    source: parent,
    origin,
    data: {
      type: "sand-table:host-bridge",
      host: { host: "dsh", capabilities: { resourceRead: true } },
    },
  });
  const next = readInjectedBridge(scope)!.resourceRequest!(args);
  const nextRequest = sent.at(-1);
  assert.notEqual(nextRequest.id, request.id);
  listener({
    source: parent,
    origin,
    data: {
      type: "sand-table:resource-result",
      id: request.id,
      result: "old page reply",
    },
  });
  listener({
    source: parent,
    origin,
    data: {
      type: "sand-table:resource-result",
      id: nextRequest.id,
      result: value,
    },
  });
  assert.deepEqual(await next, value);
  reconnected.dispose();
});
