import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const inject = [
  "tools",
  "loader",
  "diagram",
  "sessions",
  "sandTableComposition",
  "sandTableResources",
];
export function apply(ctx, config) {
  setImmediate(async () => {
    let report;
    try {
      await ctx.loader.await();
      for (let attempts = 0; ; attempts++) {
        try {
          await access(config.ready);
          break;
        } catch (error) {
          if (error.code !== "ENOENT" || attempts === 320) throw error;
        }
        await delay(100);
      }
      const listed = JSON.parse(
        await ctx.tools.get("sand_table_list_boards").execute({}),
      );
      const board = listed.boards[0];
      assert.ok(board);
      assert.ok(ctx.tools.get("sand_table_drawing_reference"));
      assert.ok(ctx.tools.get("sand_table_drawing_import"));
      const created = await ctx.tools.get("sand_table_edit_space").execute({
        boardId: board.boardId,
        revision: board.revision,
        operation: JSON.stringify({
          kind: "create",
          type: "text",
          title: "安装验证白板",
          data: { text: "已保存的验证便签" },
        }),
      });
      assert.ok(JSON.parse(created).created);
      const reopened = await ctx.tools
        .get("sand_table_read_board")
        .execute({ boardId: board.boardId });
      assert.ok(reopened.includes("安装验证白板"));
      const signal = new AbortController().signal;
      const session = ctx.sessions.create("sand-bundle-drawing", {
        meta: { cwd: config.cwd },
      });
      const execution = { agent: { session }, signal };
      const drawing = await ctx.tools.get("diagram_create").execute(
        {
          kind: "flow",
          title: "组合验证图稿",
          nodes: [{ id: "label", label: "原标签" }],
          edges: [],
        },
        execution,
      );
      const saved = await ctx.diagram.save(
        {
          id: drawing.diagramId,
          sessionId: session.header.id,
          expectedRevision: drawing.revision,
          scene: {
            elements: [
              {
                id: "label",
                type: "text",
                x: 5,
                y: 5,
                width: 90,
                height: 20,
                text: "随组合导出的标签",
              },
            ],
            appState: {},
            files: {},
          },
        },
        signal,
      );
      assert.equal(saved.ok, true);
      const { ref } = JSON.parse(
        await ctx.tools
          .get("sand_table_drawing_reference")
          .execute({ diagramId: drawing.diagramId }, execution),
      );
      const workbench = JSON.parse(
        await ctx.tools.get("sand_table_list_boards").execute({}),
      ).boards[0];
      await ctx.tools.get("sand_table_edit_space").execute({
        boardId: board.boardId,
        revision: workbench.revision,
        operation: JSON.stringify({
          commands: [
            {
              op: "object.create",
              ref: "drawing",
              title: "组合验证图稿",
              type: "base.resource_reference",
              data: { note: "" },
              source: { origin: "human", resource: ref },
            },
            {
              op: "presentation.create",
              boardId: board.boardId,
              objectId: "@drawing",
            },
          ],
        }),
      });
      const exported = await ctx.sandTableComposition.export("full", signal);
      const full = JSON.parse(exported);
      assert.equal(full.mode, "full");
      assert.deepEqual(
        full.resources.map((entry) => entry.exact),
        [ref],
      );
      assert.match(full.resources[0].text, /随组合导出的标签/);
      assert.equal(full.workspace.format, "sand-table-workspace");
      const references = JSON.parse(
        await ctx.sandTableComposition.export("references", signal),
      );
      assert.deepEqual(references.references[0].ref, ref);
      assert.equal(references.resources, undefined);
      const imported = await ctx.sandTableComposition.import(exported, signal);
      assert.notEqual(imported.workspaceId, full.workspace.workspace.id);
      assert.notEqual(imported.sessionId, session.header.id);
      const db = new DatabaseSync(
        join(config.workspaceDir, imported.workspaceId, "workspace.db"),
        { readOnly: true },
      );
      let restoredRef;
      try {
        const source = db
          .prepare("select source from objects where type = ?")
          .get("base.resource_reference");
        restoredRef = JSON.parse(source.source).resource;
        assert.notDeepEqual(restoredRef, ref);
      } finally {
        db.close();
      }
      const resolved = await ctx.sandTableResources.read(restoredRef);
      assert.equal(resolved.status, "available");
      assert.match(resolved.summary, /随组合导出的标签/);
      const reopenedCopy = await ctx.sandTableResources.open(restoredRef);
      assert.equal(reopenedCopy.status, "available");
      const copiedId = new URL(reopenedCopy.route.url).searchParams.get(
        "diagramId",
      );
      const editedCopy = JSON.parse(
        await ctx.tools.get("sand_table_drawing_replace_label").execute(
          {
            diagramId: copiedId,
            expectedRevision: restoredRef.revision,
            before: "随组合导出的标签",
            after: "独立图稿继续编辑",
          },
          { agent: { session: ctx.sessions.get(imported.sessionId) }, signal },
        ),
      );
      assert.equal(editedCopy.status, "available");
      assert.match(editedCopy.summary, /独立图稿继续编辑/);
      assert.equal(
        (await ctx.sandTableResources.read(ref)).summary,
        resolved.summary,
      );
      report = { ok: true };
    } catch (error) {
      report = { ok: false, error: String(error.stack ?? error) };
    }
    await writeFile(config.report, JSON.stringify(report));
  });
}
