/**
 * 界面还在用的旧工具名。
 *
 * 能对上现在的工具就转过去；没有对应能力的操作明确拒绝，
 * 不要再报成「不认识的旧操作」。
 */

export type BoardToolStep = {
  name: string;
  args: Record<string, unknown>;
};

export type LegacyTranslation =
  | { steps: BoardToolStep[]; refreshBoard: boolean; result: "last" | "ok" }
  | { unsupported: string };

export function translateLegacyTool(
  name: string,
  args: Record<string, unknown>,
): LegacyTranslation | undefined {
  if (name === "sand_import_repository") {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const workspaceId =
      typeof args.workspaceId === "string" ? args.workspaceId : "";
    if (path && workspaceId)
      return {
        unsupported: "请只填写仓库路径，或只选择一个已经导入的仓库。",
      };
    if (!path && !workspaceId)
      return {
        unsupported: "导入仓库要填写本机绝对路径。请写上路径后再试。",
      };
    return {
      steps: [
        {
          name: "app_edit",
          args: { commands: [{ op: "pack.enable", id: "code" }] },
        },
        {
          name: "code_repo",
          args: path
            ? { action: "import", path }
            : { action: "refresh", workspaceId },
        },
      ],
      refreshBoard: true,
      result: "ok",
    };
  }
  if (name === "sand_read_source") {
    const objectId = typeof args.objectId === "string" ? args.objectId : "";
    if (!objectId) return { unsupported: "读取源码要先选中一个代码对象。" };
    const startLine = args.startLine;
    return {
      steps: [
        {
          name: "code_repo",
          args: {
            action: "read_source",
            objectId,
            ...(typeof startLine === "number" ? { startLine } : {}),
          },
        },
      ],
      refreshBoard: false,
      result: "last",
    };
  }
  if (name === "sand_edit_view") {
    if (args.note !== undefined || args.guideFocus !== undefined)
      return {
        unsupported: "这一版还不能在这里保存备注或切换讲解。请直接改组件正文。",
      };
    if (Array.isArray(args.selection) && typeof args.viewId === "string")
      return {
        steps: [
          {
            name: "app_view",
            args: {
              action: "select",
              viewId: args.viewId,
              selection: args.selection,
            },
          },
        ],
        refreshBoard: true,
        result: "ok",
      };
    return { unsupported: "这一版还没有这个视角操作。请重新载入白板后再试。" };
  }
  return undefined;
}
