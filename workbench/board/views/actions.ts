import type { TypeSpecView } from "./format.ts";

export type LinkedPlan =
  | {
      ok: true;
      commands: Record<string, unknown>[];
    }
  | {
      ok: false;
      error: string;
    };

/** 新建一个对象并连到当前对象。类型必须已启用；给了版本就先核对再写。 */
export function planLinkedComponent(input: {
  sourceId: string;
  sourceVersion?: number;
  expectedVersion?: number;
  type: string;
  title: string;
  relationKind: string;
  direction: "out" | "in";
  specs: ReadonlyMap<string, TypeSpecView>;
}): LinkedPlan {
  if (!input.specs.has(input.type))
    return {
      ok: false,
      error: `没有启用类型「${input.type}」。请先在设置里启用对应的包。`,
    };
  if (
    input.expectedVersion !== undefined &&
    input.sourceVersion !== undefined &&
    input.expectedVersion !== input.sourceVersion
  )
    return {
      ok: false,
      error: "这个对象刚被别人改过。请重新读取后再试。",
    };
  const ref = "linked";
  const sourceId = input.direction === "out" ? input.sourceId : `@${ref}`;
  const targetId = input.direction === "out" ? `@${ref}` : input.sourceId;
  return {
    ok: true,
    commands: [
      {
        op: "object.create",
        ref,
        type: input.type,
        title: input.title,
        data: {},
      },
      {
        op: "relation.create",
        kind: input.relationKind,
        sourceId,
        targetId,
        status: "confirmed",
      },
    ],
  };
}

export async function createLinkedComponent(
  call: (name: string, args?: Record<string, unknown>) => Promise<any>,
  input: {
    sourceId: string;
    expectedVersion?: number;
    type: string;
    title: string;
    relationKind: string;
    direction: "out" | "in";
    specs: ReadonlyMap<string, TypeSpecView>;
  },
): Promise<unknown> {
  let sourceVersion: number | undefined;
  if (input.expectedVersion !== undefined) {
    const fresh = await call("sand_read", { ids: [input.sourceId] });
    const row = (fresh?.objects ?? []).find(
      (item: { id?: string; version?: number }) => item?.id === input.sourceId,
    );
    sourceVersion = typeof row?.version === "number" ? row.version : undefined;
  }
  const plan = planLinkedComponent({ ...input, sourceVersion });
  if (!plan.ok) throw Error(plan.error);
  return call("sand_edit", { commands: plan.commands });
}

export async function openObjectPicker(
  call: (name: string, args?: Record<string, unknown>) => Promise<any>,
  filter: { text?: string; types?: string[] },
): Promise<{ id: string; title: string; type: string }[]> {
  const data = await call("sand_query", {
    ...(filter.text ? { text: filter.text } : {}),
    ...(filter.types?.length ? { types: filter.types } : {}),
    limit: 20,
  });
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return rows
    .filter((row: { id?: unknown }) => typeof row?.id === "string")
    .map((row: { id: string; title?: string; type?: string }) => ({
      id: row.id,
      title: row.title || "未命名",
      type: row.type || "",
    }));
}
