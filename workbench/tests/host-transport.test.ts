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
