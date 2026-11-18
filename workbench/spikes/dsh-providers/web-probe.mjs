import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export const name = "sand-table-web-probe";
export const inject = [
  "sessionController",
  "sessionProjections",
  "sessions",
  "tools",
  "commands",
  "web",
  "agentPresets",
  "tokenMeter",
  "webServer",
  "loader",
];

export function apply(ctx, config) {
  // Preset audits await Host activation, so they must run after this row returns.
  setImmediate(async () => {
    const checks = {};
    try {
      await ctx.loader.await();
      for (const method of [
        "create",
        "prompt",
        "cancel",
        "follow",
        "projections",
      ]) {
        assert.equal(
          typeof ctx.sessionController[method],
          "function",
          "sessionController." + method,
        );
      }
      checks.sessionController = true;
      assert.equal(typeof ctx.web.search, "function");
      assert.equal(typeof ctx.web.fetch, "function");
      checks.webSeam = true;
      const presets = await ctx.agentPresets.list();
      const standard = presets.find((preset) => preset.id === "standard");
      assert.ok(standard);
      assert.equal(standard.broken, undefined);
      checks.standardPreset = true;
      const compositions = ctx.agentPresets.inspectCompositions();
      checks.presetCompositions = compositions.length > 0;
      checks.tokenMeter = !!ctx.tokenMeter;
      const session = ctx.sessions.create("sand-table-context-probe", {
        meta: { cwd: config.workspace },
      });
      const contextKeys = Object.keys(
        ctx.sessionProjections.snapshot(session).values,
      ).filter((key) => key.startsWith("context"));
      for (const key of ["contextTimeline", "contextHeaders", "contextActivity"]) {
        assert.ok(contextKeys.includes(key), `dsh-context projection missing: ${key}`);
      }
      checks.contextHostProjections = true;
      checks.whiteboardTools = [
        "sand_table_list_boards",
        "sand_table_read_board",
        "sand_table_read_object",
        "sand_table_edit_space",
      ].every((name) => !!ctx.tools.get(name));
      assert.ok(checks.whiteboardTools);
      const listed = JSON.parse(
        await ctx.tools.get("sand_table_list_boards").execute({}),
      );
      assert.equal(listed.boards.length, 1);
      const board = listed.boards[0];
      await ctx.tools.get("sand_table_edit_space").execute({
        boardId: board.boardId,
        revision: board.revision,
        operation: JSON.stringify({
          kind: "create",
          type: "text",
          title: "DSH provider probe",
          data: { text: "Written through a real DSH tool" },
        }),
      });
      const readBack = await ctx.tools
        .get("sand_table_read_board")
        .execute({ boardId: board.boardId });
      assert.ok(readBack.includes("DSH provider probe"));
      checks.whiteboardReadWrite = true;
      const result = {
        ok: Object.values(checks).every(Boolean),
        checks,
        contextProjectionKeys: contextKeys,
      };
      await writeFile(
        config.reportPath,
        JSON.stringify(result, null, 2) + "\n",
      );
    } catch (error) {
      await writeFile(
        config.reportPath,
        JSON.stringify({ ok: false, checks, error: String(error) }, null, 2) +
          "\n",
      );
    }
  });
}
