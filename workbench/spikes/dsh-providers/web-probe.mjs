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
      assert.ok(contextKeys.length > 0);
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
      const tasks = ctx.get("sandTableTasks");
      await tasks.ready;
      assert.equal(tasks.enabled(), true);
      assert.equal(typeof tasks.follow, "function");
      checks.workbenchTaskService = true;

      const resources = ctx.get("sandTableResources");
      assert.equal(typeof resources?.register, "function");
      const external = {
        providerId: "verification",
        namespace: "isolated-workspace",
        resourceId: "fixture",
        revision: "fixed-1",
      };
      const provider = {
        describe: () => ({
          providerId: external.providerId,
          namespace: external.namespace,
          title: "Fixture resource provider; not a drawing plugin",
          capabilities: { read: true },
          idempotency: "none",
        }),
        read: (ref) => ({
          status: "available",
          ref,
          revision: "fixed-1",
          title: "Host resource",
          summary: "Fixture content stays with this provider",
          capabilities: { read: true },
        }),
      };
      const disposeProvider = ctx.effect(
        () => resources.register(provider),
        "probe: fixture resource",
      );
      const currentBoard = JSON.parse(
        await ctx.tools.get("sand_table_list_boards").execute({}),
      ).boards[0];
      const resourceWrite = JSON.parse(
        await ctx.tools.get("sand_table_edit_space").execute({
          boardId: board.boardId,
          revision: currentBoard.revision,
          operation: JSON.stringify({
            commands: [
              {
                op: "object.create",
                ref: "resource",
                type: "base.resource_reference",
                title: "Host resource reference",
                data: { note: "Local explanation only" },
                source: { origin: "human", resource: external },
              },
              {
                op: "presentation.create",
                boardId: board.boardId,
                objectId: "@resource",
              },
            ],
          }),
        }),
      );
      const resourceId = resourceWrite.created.resource;
      const readResource = async () =>
        JSON.parse(
          await ctx.tools
            .get("sand_table_read_object")
            .execute({ boardId: board.boardId, objectId: resourceId }),
        );
      const resolved = await readResource();
      assert.equal(resolved.resource.value.status, "available");
      assert.equal(resolved.resource.value.revision, "fixed-1");
      assert.deepEqual(resolved.source.resource, external);
      assert.deepEqual(resolved.data, { note: "Local explanation only" });
      disposeProvider();
      assert.equal(
        (await readResource()).resource.value.status,
        "provider_missing",
      );
      ctx.effect(
        () => resources.register(provider),
        "probe: reinstall fixture resource",
      );
      assert.equal((await readResource()).resource.value.status, "available");
      checks.nativeResourceRegistration = true;
      checks.resourceUnloadReinstall = true;
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
