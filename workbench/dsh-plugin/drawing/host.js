import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createDrawingProvider } from "../../resources/providers/drawing.ts";

export function registerDrawing(ctx, registry, defineTool) {
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["diagram", "profileContext", "webServer"], (host) => {
    const namespace = createHash("sha256")
      .update(realpathSync(host.profileContext.dir))
      .digest("hex");
    const drawing = createDrawingProvider({
      namespace,
      get: (args, signal) => host.diagram.get(args, signal),
      getOrigin: () => host.webServer.getOrigin(),
      save: (args, signal) => host.diagram.save(args, signal),
      ...(typeof host.diagram.removeDiagram === "function"
        ? {
            remove: (session, id, revision, signal) =>
              host.diagram.removeDiagram(session, id, revision, signal),
          }
        : {}),
      ...(typeof host.diagram.importDiagram === "function"
        ? {
            load: (session, input, signal) =>
              host.diagram.importDiagram(session, input, signal),
          }
        : {}),
    });
    host.effect(
      () => registry.register(drawing.provider),
      "sand-table: drawing provider",
    );
    const requiredText = { type: "string", required: true };
    const definitions = [
      {
        name: "sand_table_drawing_reference",
        description:
          "读取当前 DSH 会话的图稿引用，把 ref 作为 resource 交给 sand_table_publish_artifact 可生成白板引用卡。",
        parameters: { diagramId: requiredText },
        run: (session, args, signal) =>
          drawing.reference(session, args.diagramId, signal),
      },
      {
        name: "sand_table_drawing_replace_label",
        description:
          "替换当前会话中已保存图稿的一个唯一文本标签。先用 diagram_read 取得 revision，冲突时保留原图和候选文字。",
        parameters: {
          diagramId: requiredText,
          expectedRevision: requiredText,
          before: requiredText,
          after: requiredText,
        },
        run: (session, args, signal) =>
          drawing.replaceLabel(session, args, signal),
      },
      {
        name: "sand_table_drawing_export",
        description: "读取当前会话图稿的精确版本并导出可编辑文件。",
        parameters: { diagramId: requiredText, revision: requiredText },
        async run(session, args, signal) {
          const { ref } = await drawing.reference(
            session,
            args.diagramId,
            signal,
          );
          return registry.export({ ...ref, revision: args.revision });
        },
      },
    ];
    if (typeof host.diagram.importDiagram === "function")
      definitions.push({
        name: "sand_table_drawing_import",
        description:
          "将白板导出的图稿作为当前会话的独立可编辑副本。仅在用户明确要求导入或复制时调用。",
        parameters: { document: requiredText },
        run: (session, args, signal) =>
          drawing.importDocument(session, args.document, signal),
      });
    if (typeof host.diagram.removeDiagram === "function") {
      const deleteTool = "sand_table_drawing_delete";
      host.on("tools/pre-execute", async (execution, next) => {
        const decision = await next();
        if (execution.name !== deleteTool || decision.kind !== "allow")
          return decision;
        return {
          kind: "ask",
          reason: "Permanently delete a drawing at its specified revision.",
          displayReason: {
            en: "Permanently delete the drawing?",
            "zh-CN": "永久删除图稿？白板引用将保留。",
          },
        };
      });
      definitions.push({
        name: deleteTool,
        description:
          "永久删除当前会话内图稿的指定版本。必须先得到用户明确确认；白板引用保留。",
        parameters: { diagramId: requiredText, expectedRevision: requiredText },
        async run(session, args, signal) {
          await drawing.reference(session, args.diagramId, signal);
          return host.diagram.removeDiagram(
            session,
            args.diagramId,
            args.expectedRevision,
            signal,
          );
        },
      });
    }
    host.effect(() => {
      const disposers = definitions.map(({ run, ...definition }) =>
        host.tools.register(
          defineTool({
            ...definition,
            output: {
              schema: { type: "string" },
              render: (_, value) => [{ type: "text", text: value }],
            },
            async execute(args, execution) {
              const session = execution.agent?.session?.header;
              if (!session) throw Error("请在当前 DSH 会话内处理图稿。");
              return JSON.stringify(await run(session, args, execution.signal));
            },
          }),
        ),
      );
      return () => disposers.reverse().forEach((dispose) => dispose());
    }, "sand-table: drawing tools");
  });
}
