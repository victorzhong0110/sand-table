import type { BindingsResult } from "../../kernel/index.ts";

export type Participant = { id: string; title: string };
export type ContextCall = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<any>;

export async function readParticipants(
  call: ContextCall,
  workspaceId: string | undefined,
  objectId: string,
): Promise<Participant[]> {
  const result: BindingsResult = await call("app_bindings", {
    action: "read",
    workspaceId,
    objectId,
    slot: "participants",
    fields: [],
    limit: 200,
  });
  if (result.nextCursor) throw Error("参与对象上限为 200。");
  return result.items
    .filter((item) => !item.unavailable)
    .map(({ id, title }) => ({ id, title: title || "未命名" }));
}
