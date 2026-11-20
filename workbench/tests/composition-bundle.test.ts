import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  exportComposition,
  importComposition,
} from "../dsh-plugin/bundle/composition.ts";
import { createResourceRegistry } from "../resources/registry.ts";

const ref = {
  providerId: "drawing",
  namespace: "active",
  resourceId: "diagram",
};
const workspace = (revision?: string) =>
  JSON.stringify({
    format: "sand-table-workspace",
    formatVersion: 3,
    workspace: { id: "source" },
    objects: ["first", "second"].map((id) => ({
      id,
      source: { resource: { ...ref, revision } },
    })),
    external: [],
  });

test("组合导出冻结当前图稿的精确版本，并去重共享引用", async () => {
  const registry = createResourceRegistry();
  const releases: string[] = [];
  registry.register({
    describe: () => ({
      ...ref,
      title: "图",
      capabilities: { read: true, export: true },
      idempotency: "none",
    }),
    read: (input) =>
      input.revision && input.revision !== "latest"
        ? {
            status: "version_unavailable",
            ref: input,
            reason: "旧版本已不存在",
          }
        : {
            status: "available",
            ref: input,
            revision: "latest",
            title: "图",
            summary: "摘要",
            capabilities: { read: true },
          },
    async export(input) {
      releases.push(input.revision!);
      return {
        status: "available",
        ref: input,
        revision: "latest",
        mediaType: "text/plain",
        text: "Graph",
      };
    },
  });
  const data = JSON.parse(
    await exportComposition(workspace(), registry, "full"),
  );
  assert.deepEqual(releases, ["latest"]);
  assert.equal(data.workspace.workspace.id, "source");
  assert.equal(data.resources.length, 1);
  assert.deepEqual(data.resources[0].objectIds, ["first", "second"]);
  assert.equal(data.resources[0].exact.revision, "latest");
  assert.equal(data.resources[0].sha256.length, 64);
  await assert.rejects(
    exportComposition(workspace("obsolete"), registry, "full"),
    /旧版本已不存在/,
  );
});

test("插件缺失时完整模式失败，显式引用清单保留绑定", async () => {
  const registry = createResourceRegistry();
  await assert.rejects(
    exportComposition(workspace(), registry, "full"),
    /资源插件尚未加载/,
  );
  const manifest = JSON.parse(
    await exportComposition(workspace(), registry, "references"),
  );
  assert.equal(manifest.mode, "references");
  assert.deepEqual(manifest.references[0].ref, ref);
  assert.equal(manifest.workspace, undefined);
  assert.equal(manifest.resources, undefined);
});

test("组合导入将共享引用映射到一个新副本，存盘失败时清理图稿", async () => {
  const signal = new AbortController().signal;
  const file = JSON.stringify({
    format: "sand-table-workspace-composition",
    version: 1,
    mode: "full",
    workspace: JSON.parse(workspace("fixed")),
    resources: [
      {
        ref: { ...ref, revision: "fixed" },
        exact: { ...ref, revision: "fixed" },
        objectIds: ["first", "second"],
        mediaType: "text/plain",
        text: "Graph",
        sha256: createHash("sha256").update("Graph").digest("hex"),
      },
    ],
  });
  const target = {
    ...ref,
    namespace: "installed",
    resourceId: "copy",
    revision: "new",
  };
  let imported = 0,
    discarded = 0;
  const registry = createResourceRegistry();
  registry.register({
    describe: () => ({
      ...target,
      title: "图",
      capabilities: { read: true },
      idempotency: "none",
    }),
    read: (ref) => ({ status: "not_found", ref, reason: "测试" }),
    async restore({ text }) {
      assert.equal(text, "Graph");
      imported++;
      return {
        ref: target,
        async discard() {
          discarded++;
        },
      };
    },
  });
  const owner = async () => ({ id: "live", createdAt: 0 });
  await assert.rejects(
    importComposition(
      file.replace('"text":"Graph"', '"text":"Altered"'),
      registry,
      owner,
      JSON.parse,
      signal,
    ),
    /文件校验值/,
  );
  assert.equal(imported, 0);
  const restored = await importComposition(
    file,
    registry,
    owner,
    JSON.parse,
    signal,
  );
  assert.deepEqual(
    restored.objects.map(
      (object: { source: { resource: unknown } }) => object.source.resource,
    ),
    [target, target],
  );
  assert.equal(imported, 1);
  assert.equal(discarded, 0);
  await assert.rejects(
    importComposition(
      file,
      registry,
      owner,
      () => {
        throw Error("保存失败");
      },
      signal,
    ),
    /保存失败/,
  );
  assert.equal(imported, 2);
  assert.equal(discarded, 1);
});
