import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createArtifactWriter } from "../../server/host/artifacts.ts";
import { boardNamespace } from "../../resources/board-provider.ts";
export const name = "sand-drawing-composition-probe";
export const inject = [
  "tools",
  "sessions",
  "sessionPersistence",
  "sandTableResources",
];
export async function apply(ctx, config) {
  const id = config.sessionId;
  const signal = new AbortController().signal;
  const read = (path) => readFile(path, "utf8").then(JSON.parse);
  const save = (path, data) => writeFile(path, JSON.stringify(data));
  let session, handle;
  try {
    if (config.phase !== "edit") {
      assert.equal(ctx.sessions.get(id), undefined);
      const refs = await read(config.refs);
      const readBack = await ctx.sandTableResources.read(refs.changed);
      const linked = JSON.parse(
        await ctx.tools.get("sand_table_read_object").execute(refs.link),
      );
      assert.deepEqual(linked.source.resource, refs.changed);
      if (config.phase === "disabled") {
        assert.equal(readBack.status, "provider_missing");
        assert.equal(linked.resource.value.status, "provider_missing");
        await save(config.report, { ok: true, referencePreserved: true });
        return;
      }
      const copy = await ctx.sandTableResources.read(refs.copy);
      assert.equal(readBack.status, "available");
      assert.match(readBack.summary, /Agent label/);
      assert.equal(copy.status, "available");
      assert.equal(copy.summary, readBack.summary);
      assert.equal(copy.revision, refs.copy.revision);
      await save(config.report, { ok: true, cold: true });
      return;
    }
    session = ctx.sessions.create(id, { meta: { cwd: config.cwd } });
    handle = await ctx.sessionPersistence.create(session.header);
    const exec = { agent: { session }, signal };
    const call = (name, input) => ctx.tools.get(name).execute(input, exec);
    const adapter = async (name, input) =>
      JSON.parse(await call("sand_table_drawing_" + name, input));
    const created = await call("diagram_create", {
      kind: "flow",
      title: "Composition diagram",
      nodes: [{ id: "start", label: "Generated label" }],
      edges: [],
    });
    const reference = await adapter("reference", {
      diagramId: created.diagramId,
    });
    const route = await ctx.sandTableResources.open(reference.ref);
    assert.equal(route.status, "available", JSON.stringify(route));
    const before = await ctx.sandTableResources.read(reference.ref);
    assert.match(before.summary, /Generated label/);
    await save(config.seed, { id, created, route });
    const gate = setInterval(async () => {
      try {
        await readFile(config.edited);
        const seen = await call("diagram_read", { id: created.diagramId });
        if (seen.revision === created.revision) return;
        clearInterval(gate);
        assert.match(seen.summary, /Browser label/);
        assert.notEqual(seen.revision, created.revision);
        const current = await adapter("reference", {
          diagramId: created.diagramId,
        });
        assert.equal(current.ref.revision, seen.revision);
        const stale = await ctx.sandTableResources.read(reference.ref);
        assert.equal(stale.status, "version_unavailable");
        const edited = await adapter("replace_label", {
          diagramId: created.diagramId,
          expectedRevision: seen.revision,
          before: "Browser label",
          after: "Agent label",
        });
        assert.equal(edited.status, "available", JSON.stringify(edited));
        const conflict = await adapter("replace_label", {
          diagramId: created.diagramId,
          expectedRevision: seen.revision,
          before: "Browser label",
          after: "Stale candidate",
        });
        assert.equal(conflict.status, "conflict");
        assert.equal(conflict.candidate.after, "Stale candidate");
        const artifact = await adapter("export", {
          diagramId: created.diagramId,
          revision: edited.revision,
        });
        assert.equal(artifact.status, "available", JSON.stringify(artifact));
        const imported = await adapter("import", { document: artifact.text });
        assert.equal(imported.status, "available");
        assert.notEqual(imported.ref.resourceId, edited.ref.resourceId);
        assert.equal(imported.summary, edited.summary);
        assert.equal(
          (await ctx.sandTableResources.open(imported.ref)).status,
          "available",
        );
        const child = ctx.sessions.fork(
          session,
          undefined,
          "sand-drawing-fork",
        );
        await assert.rejects(
          ctx.tools
            .get("sand_table_drawing_reference")
            .execute(
              { diagramId: created.diagramId },
              { agent: { session: child }, signal },
            ),
          /找不到/,
        );
        const disposable = await adapter("import", { document: artifact.text });
        const disposableRoute = await ctx.sandTableResources.open(
          disposable.ref,
        );
        const disposableId = new URL(
          disposableRoute.route.url,
        ).searchParams.get("diagramId");
        const deleted = await adapter("delete", {
          diagramId: disposableId,
          expectedRevision: disposable.revision,
        });
        assert.equal(deleted.ok, true, JSON.stringify(deleted));
        assert.equal(
          (await ctx.sandTableResources.read(disposable.ref)).status,
          "not_found",
        );
        const list = JSON.parse(await call("sand_table_list_boards"));
        const boardId = list.boards[0].boardId;
        const writer = createArtifactWriter(config.workspaceDir);
        const linked = writer.write(
          {
            workspaceId: "default",
            boardId,
            requestId: "drawing-verification",
            session: session.header,
            workspaceNamespace: boardNamespace(config.workspaceDir, "default"),
            targets: [],
          },
          {
            operationId: "f".repeat(64),
            seq: 1,
            artifact: {
              kind: "resource",
              title: "绘图验证",
              resource: edited.ref,
            },
          },
        );
        const link = { boardId, objectId: linked.created.artifact };
        const boardReference = JSON.parse(
          await call("sand_table_read_object", link),
        );
        assert.deepEqual(boardReference.source.resource, edited.ref);
        assert.equal(boardReference.resource.value.summary, edited.summary);
        await handle.flush();
        await handle.close();
        handle = undefined;
        await save(config.refs, {
          changed: edited.ref,
          copy: imported.ref,
          link,
        });
        await save(config.report, {
          ok: true,
          actualBrowserSave: true,
          agentCAS: true,
          staleRejected: true,
          exactExport: true,
          editableImport: true,
          independentFork: true,
          deletePreservesOriginal: true,
          whiteboardReference: true,
        });
      } catch (e) {
        if (e.code === "ENOENT") return;
        clearInterval(gate);
        await save(config.report, { ok: false, error: String(e.stack ?? e) });
      }
    }, 100);
    ctx.effect(() => async () => {
      clearInterval(gate);
      await handle?.close();
    });
  } catch (error) {
    await handle?.close();
    await save(config.report, {
      ok: false,
      error: String(error.stack ?? error),
    });
  }
}
