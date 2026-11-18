import type { Board } from "../data-client/model.ts";
import type { HostTaskRequest } from "../data-client/objects.ts";

export type AIScope = "board" | "selection";
export type AITarget = { objectId: string; version: number; title: string };

export function aiTargets(
  board: Board,
  viewId: string,
  scope: AIScope,
): AITarget[] {
  const view = board.views[viewId];
  if (!view) throw Error("白板视角尚未就绪，请稍后再试。");
  const selected = new Set(view.selection);
  const instances = board.instances.filter(
    (item) =>
      item.spaceId === view.spaceId &&
      (scope === "board" || selected.has(item.id)),
  );
  if (
    scope === "selection" &&
    (!selected.size || instances.length !== selected.size)
  )
    throw Error("选区为空或已变化，请重新选中要讨论的组件。");
  const objects = new Map(
    board.contentObjects.map((object) => [object.id, object]),
  );
  const targets = new Map<string, AITarget>();
  for (const instance of instances) {
    const id = instance.binding?.objectId ?? instance.objectId;
    const object = id ? objects.get(id) : undefined;
    if (!object || !Number.isInteger(object.version) || object.version < 1)
      throw Error("部分组件的内容版本尚未读到，请刷新白板后再试。");
    targets.set(object.id, {
      objectId: object.id,
      version: object.version,
      title: object.title,
    });
  }
  if (targets.size > 200) throw Error("一次最多讨论 200 个对象，请缩小选区。");
  return [...targets.values()];
}

export function aiRequest(
  board: Board,
  viewId: string,
  scope: AIScope,
  text: string,
): HostTaskRequest {
  const instruction = text.trim();
  if (!instruction || instruction.length > 8000)
    throw Error("请填写 1–8000 字的请求。");
  const targets = aiTargets(board, viewId, scope);
  return {
    boardId: board.views[viewId].spaceId,
    instruction:
      instruction +
      "\n\n白板协作范围：" +
      JSON.stringify({ scope, viewId }) +
      "。请先读取当前白板及目标对象，核对请求中的版本，再通过已有白板工具完成请求。修改现有对象时保留版本检查；把推测明确标出。白板编排不授权修改外部源码或运行外部任务。",
    targets: targets.map(({ objectId, version }) => ({ objectId, version })),
    contextVersion: board.contentRevision,
  };
}
