import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrawingProvider } from "../resources/providers/drawing.ts";

test("保存竞争时重新读取当前版本并保留标签候选", async () => {
  const session = { id: "session", createdAt: 7, cwd: "/fixture" };
  const original = {
    id: "5eacb44b-106b-4a1f-bd71-12aaafff96ab",
    sessionId: session.id,
    sessionFingerprint: session,
    title: "图稿",
    revision: "initial",
    sourceSpec: { nodes: [{ label: "原始标签" }] },
    scene: {
      elements: [{ type: "text", text: "人工编辑" }],
      appState: {},
      files: {},
    },
  };
  const latest = { ...original, revision: "concurrent" };
  let reads = 0;
  const drawing = createDrawingProvider({
    namespace: "profile",
    async get() {
      return {
        ok: true,
        value: { diagram: ++reads === 1 ? original : latest },
      };
    },
    async save() {
      return { ok: false, error: { code: "version-conflict" } };
    },
    getOrigin: () => "http://127.0.0.1:4173",
  });
  const result = await drawing.replaceLabel(
    session,
    {
      diagramId: original.id,
      expectedRevision: original.revision,
      before: "人工编辑",
      after: "新候选",
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "conflict");
  assert.equal(result.current?.status, "available");
  assert.equal(result.current.revision, "concurrent");
  assert.deepEqual(result.candidate, { before: "人工编辑", after: "新候选" });
  assert.equal(reads, 2);
});
