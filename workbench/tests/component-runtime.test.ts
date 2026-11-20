import assert from "node:assert/strict";
import { test } from "node:test";
import { componentResourceUri } from "../core/component-resources.ts";
import { createComponentRuntime } from "../board/runtime/resources.ts";

test("资源加载器仅接受构建清单并允许失败后重试", async () => {
  const requests: string[] = [];
  const runtime = createComponentRuntime(async (uri) => {
    requests.push(uri);
    return { contents: [{ uri, mimeType: "text/html", text: "bad" }] };
  });
  assert.throws(() => componentResourceUri("constructor" as never), /未注册/);
  assert.throws(
    () => runtime.loadComponentResource("../board" as never),
    /未注册/,
  );
  await assert.rejects(
    runtime.loadComponentResource("pdf-api"),
    /宿主暂时不能提供/,
  );
  await assert.rejects(
    runtime.loadComponentResource("pdf-api"),
    /宿主暂时不能提供/,
  );
  assert.deepEqual(requests, [
    "ui://sand-table/chunks/pdf-api.js",
    "ui://sand-table/chunks/pdf-api.js",
  ]);
  runtime.dispose();
});

test("工作空间切换取消合并的组件请求且忽略迟到脚本", async () => {
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let requestCount = 0;
  const runtime = createComponentRuntime((uri, active) => {
    requestCount++;
    signal = active;
    return new Promise((resolve) => {
      finish = () =>
        resolve({
          contents: [{ uri, mimeType: "text/javascript", text: "unexpected" }],
        });
    });
  });
  const first = runtime.loadComponentResource("pdf-worker");
  const next = runtime.loadComponentResource("pdf-worker");
  assert.equal(first, next);
  assert.equal(requestCount, 1);
  runtime.dispose();
  assert.equal(signal?.aborted, true);
  finish?.();
  await assert.rejects(first, { name: "AbortError" });
  assert.throws(() => runtime.loadComponentResource("pdf-worker"), {
    name: "AbortError",
  });
});

test("只在所有调用者都离开后取消底层读取，新请求独立重试", async () => {
  const reads: { signal: AbortSignal; finish: () => void }[] = [];
  const runtime = createComponentRuntime(
    (uri, signal) =>
      new Promise((resolve) => {
        reads.push({
          signal,
          finish: () =>
            resolve({
              contents: [
                { uri, mimeType: "text/javascript", text: "old script" },
              ],
            }),
        });
      }),
  );
  const a = new AbortController(),
    b = new AbortController();
  const first = runtime.loadComponentResource("pdf-api", a.signal);
  const second = runtime.loadComponentResource("pdf-api", b.signal);
  assert.equal(reads.length, 1);
  a.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(reads[0].signal.aborted, false);
  b.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(reads[0].signal.aborted, true);

  const retry = runtime.loadComponentResource("pdf-api");
  assert.equal(reads.length, 2);
  reads[0].finish();
  await new Promise(setImmediate);
  assert.equal(runtime.loadComponentResource("pdf-api"), retry);
  runtime.dispose();
  reads[1].finish();
  await assert.rejects(retry, { name: "AbortError" });
});
