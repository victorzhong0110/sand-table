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
