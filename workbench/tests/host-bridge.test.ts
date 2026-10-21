// 宿主桥测试：入口显隐必须由宿主**真实能力**决定。
// 契约见 docs/architecture/dsh-integration.zh-CN.md 的 X1–X5。

import test from "node:test";
import assert from "node:assert/strict";
import {
  canShowTaskEntry,
  localBridge,
  mcpBridge,
  readInjectedBridge,
  resolveBridge,
  HOST_BRIDGE_KEY,
} from "../core/host-bridge.ts";
import type { HostTaskEvent, HostTaskRequest } from "../core/objects.ts";

const request: HostTaskRequest = {
  boardId: "board-1",
  instruction: "把这段结论整理成摘要",
  targets: [{ objectId: "obj-1", version: 3 }],
  contextVersion: 12,
};

test("独立模式没有任务执行通道，提交任务要明确报错", async () => {
  assert.equal(localBridge.capabilities().taskSubmit, false);
  assert.equal(canShowTaskEntry(localBridge), false);
  await assert.rejects(
    () => localBridge.submitTask(request),
    /没有可用的 Agent 宿主/,
  );
});

test("仅 MCP 接入不提供任务执行通道（MCP 不是任务执行通道）", async () => {
  assert.equal(mcpBridge.capabilities().taskSubmit, false);
  assert.equal(canShowTaskEntry(mcpBridge), false);
  await assert.rejects(() => mcpBridge.submitTask(request), /MCP/);
});

test("X1：没有注入宿主时读不到桥，也不报错", () => {
  assert.equal(readInjectedBridge({}), undefined);
  assert.equal(readInjectedBridge(undefined), undefined);
  assert.equal(readInjectedBridge(null), undefined);
  assert.equal(
    readInjectedBridge({ [HOST_BRIDGE_KEY]: "不是对象" }),
    undefined,
  );
  assert.equal(
    readInjectedBridge({ [HOST_BRIDGE_KEY]: { capabilities: {} } }),
    undefined,
    "缺 host 标识不算宿主",
  );
});

test("X2：宿主自报没有任务能力时，即使带了提交函数也不显示入口", async () => {
  const scope = {
    [HOST_BRIDGE_KEY]: {
      host: "dsh",
      capabilities: { taskSubmit: false, eventStream: true },
      submitTask: async () => ({ taskId: "t-1" }),
    },
  };
  const bridge = readInjectedBridge(scope);
  assert.ok(bridge);
  assert.equal(bridge.capabilities().taskSubmit, false);
  assert.equal(canShowTaskEntry(bridge), false);
  await assert.rejects(
    () => bridge.submitTask(request),
    /没有声明任务提交能力/,
  );
});

test("宿主声明能力但没提供提交入口时，要说清楚而不是静默", async () => {
  const scope = {
    [HOST_BRIDGE_KEY]: {
      host: "dsh",
      capabilities: { taskSubmit: true },
    },
  };
  const bridge = readInjectedBridge(scope);
  assert.ok(bridge);
  assert.equal(canShowTaskEntry(bridge), false);
  await assert.rejects(() => bridge.submitTask(request), /没有提供提交入口/);
});

test("X3：提交任务只带对象引用与版本，不带整份内容快照", async () => {
  let seen: HostTaskRequest | undefined;
  const scope = {
    [HOST_BRIDGE_KEY]: {
      host: "dsh",
      version: "0.1.0",
      capabilities: { taskSubmit: true, eventStream: true, contentRead: true },
      submitTask: async (r: HostTaskRequest) => {
        seen = r;
        return { taskId: "t-9" };
      },
    },
  };
  const bridge = readInjectedBridge(scope);
  assert.ok(bridge);
  const out = await bridge.submitTask(request);
  assert.equal(out.taskId, "t-9");
  assert.ok(seen);
  assert.equal(seen.targets.length, 1);
  assert.equal(seen.targets[0].objectId, "obj-1");
  assert.equal(seen.targets[0].version, 3);
  assert.equal(seen.contextVersion, 12);
  assert.equal(
    (seen as unknown as Record<string, unknown>).snapshot,
    undefined,
    "不能带整份快照",
  );
  assert.equal(
    (seen as unknown as Record<string, unknown>).content,
    undefined,
    "不能带整份内容",
  );
});

test("X5：没有事件流时订阅是空操作，不伪造进度", () => {
  const scope = {
    [HOST_BRIDGE_KEY]: {
      host: "dsh",
      capabilities: { taskSubmit: true, eventStream: false },
    },
  };
  const bridge = readInjectedBridge(scope);
  assert.ok(bridge);
  const seen: HostTaskEvent[] = [];
  const off = bridge.subscribe((e) => seen.push(e));
  off();
  assert.equal(seen.length, 0);
});

test("有事件流时能收到事件，退订后不再收到", () => {
  const listeners: ((e: HostTaskEvent) => void)[] = [];
  const scope = {
    [HOST_BRIDGE_KEY]: {
      host: "dsh",
      capabilities: { taskSubmit: true, eventStream: true },
      subscribe: (listener: (e: HostTaskEvent) => void) => {
        listeners.push(listener);
        return () => {
          const at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
    },
  };
  const bridge = readInjectedBridge(scope);
  assert.ok(bridge);
  const seen: HostTaskEvent[] = [];
  const off = bridge.subscribe((e) => seen.push(e));
  for (const l of listeners)
    l({
      taskId: "t-1",
      state: "running",
      message: "正在整理",
      at: 1,
    });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, "running");
  off();
  assert.equal(listeners.length, 0);
});

test("resolveBridge 优先用宿主注入，没有才退回本地模式", () => {
  const empty = resolveBridge({}, "mcp");
  assert.equal(empty.host, "mcp");
  const injected = resolveBridge(
    {
      [HOST_BRIDGE_KEY]: {
        host: "dsh",
        capabilities: { taskSubmit: true },
        submitTask: async () => ({ taskId: "real" }),
      },
    },
    "mcp",
  );
  assert.equal(injected.host, "dsh");
  assert.equal(canShowTaskEntry(injected), true);
});

// ── 插件结果映射（#18 阶段 D）──

test("插件结果按种类映射到组件，认不出的走通用降级", async () => {
  const { mapHostResult } = await import("../core/host-bridge.ts");
  const paper = mapHostResult({
    kind: "document",
    title: "Attention Is All You Need",
    text: "摘要片段",
    resource: {
      uri: "file:///papers/a.pdf",
      fragment: "p.42",
      fingerprint: "sha256:test",
    },
    source: "DSH 插件：文献检索",
  });
  assert.equal(paper.type, "evidence");
  const citation = paper.data.citation as {
    uri: string;
    fragment?: string;
  };
  assert.equal(citation.uri, "file:///papers/a.pdf");
  assert.equal(citation.fragment, "p.42");
  assert.equal(paper.source, "DSH 插件：文献检索");

  const data = mapHostResult({
    kind: "dataset",
    title: "实验数据",
    rows: [
      ["轮次", "准确率"],
      ["1", "0.81"],
    ],
  });
  assert.equal(data.type, "table");
  assert.equal((data.data.rows as string[][]).length, 1);

  const file = mapHostResult({
    kind: "file",
    title: "报告.pdf",
    resource: { uri: "file:///out/report.pdf" },
  });
  assert.equal(file.type, "resource");
  assert.equal(file.data.resourceUri, "file:///out/report.pdf");
  assert.equal(
    file.data.url,
    "",
    "local paths are references, not unsafe browser links",
  );

  const other = mapHostResult({
    kind: "whatever",
    title: "一段话",
    text: "正文",
  });
  assert.equal(other.type, "text", "认不出的种类降级成基础组件");
  assert.equal(other.data.text, "正文");
});
