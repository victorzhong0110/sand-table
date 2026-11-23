import { useEffect, useRef, useState } from "react";
import type {
  Command,
  CommandResult,
  ObjectRow,
  PresentationRow,
  TypeSpec,
} from "../../kernel/index.ts";
import { createBindings, type BindingSession } from "./bindings.ts";
import type { TypeSpecView } from "./format.ts";
import { timelineFields } from "../timeline/fields.ts";
import { customView, useViewRuntime, type ViewProps } from "./registry.tsx";
import { openObjectPicker, planLinkedComponent } from "./actions.ts";
import { useTypeCatalog } from "./catalog.tsx";

export function CustomView({
  objectId,
  presentationId,
  spec,
}: {
  objectId: string;
  presentationId: string;
  spec: TypeSpecView;
}) {
  const runtime = useViewRuntime();
  const catalog = useTypeCatalog();
  const [active, setActive] = useState<{
    objectId: string;
    workspaceId: string;
    session: BindingSession;
  }>();
  const callRef = useRef(runtime?.call);
  callRef.current = runtime?.call;
  const store = runtime?.store;
  const workspaceId = store?.workspaceId;
  const slotKey = JSON.stringify(spec.relationSlots ?? []);
  useEffect(() => {
    if (!store || !workspaceId) return;
    const bindings = createBindings(
      store,
      (name, args) => {
        if (!callRef.current) throw Error("尚未连接工作空间。 ");
        return callRef.current(name, args);
      },
      objectId,
      JSON.parse(slotKey),
    );
    setActive({ objectId, workspaceId, session: bindings });
    return () => bindings.dispose();
  }, [store, workspaceId, objectId, slotKey]);
  const View = customView(spec.display?.view);
  const object = store?.cache.objects.get(objectId);
  const presentation = store?.cache.presentations.get(presentationId);
  if (
    !View ||
    !runtime ||
    !workspaceId ||
    !active ||
    active.objectId !== objectId ||
    active.workspaceId !== workspaceId ||
    !object ||
    !presentation
  )
    return null;
  const dispatch = async (
    commands: Command[],
    options?: { intentId?: string },
  ): Promise<CommandResult> => {
    if (
      !commands.length ||
      commands.some(
        (command) => command.op !== "object.update" || command.id !== objectId,
      )
    )
      throw Error("组件只能修改自己的内容。请通过白板操作其他对象。 ");
    if (runtime.store.workspaceId !== workspaceId)
      throw Error("工作空间已切换，请重新打开组件。 ");
    return runtime.call("app_edit", {
      workspaceId,
      commands,
      ...(options?.intentId ? { intentId: options.intentId } : {}),
    });
  };
  const requireActive = () => {
    if (
      runtime.store.workspaceId !== workspaceId ||
      runtime.store.cache.objects.get(objectId)?.deleted !== false ||
      runtime.store.cache.boardId !== presentation.boardId
    )
      throw Error("组件已离开当前工作空间，请重新打开。");
  };
  const requireSlot = (key: string) => {
    requireActive();
    const slot = spec.relationSlots?.find(({ key: id }) => id === key);
    if (!slot) throw Error("组件没有声明这个关系槽。");
    return slot;
  };
  const actions: ViewProps["actions"] = {
    async focusObject(slot, targetId) {
      const result = await active.session.read(slot, { ids: [targetId] });
      requireActive();
      if (
        !result.items.some((item) => item.id === targetId && !item.unavailable)
      )
        throw Error("这个绑定的来源无法打开。");
      if (!runtime.focusObject) throw Error("请在画布里打开这个组件。");
      await runtime.focusObject(targetId);
    },
    async openObjectPicker(key, text) {
      const slot = requireSlot(key);
      const matches = await openObjectPicker(runtime.call, {
        text,
        types: slot.targetTypes,
      });
      requireActive();
      return matches;
    },
    async createLinkedComponent(key, input) {
      const slot = requireSlot(key);
      if (object.migrationError || !catalog.specs.has(object.type))
        throw Error("当前组件是只读的。");
      if (slot.targetTypes?.length && !slot.targetTypes.includes(input.type))
        throw Error("目标类型不符合这个关系槽的声明。");
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
        throw Error("请提供创建时看到的组件版本。");
      const plan = planLinkedComponent({
        ...input,
        sourceId: objectId,
        sourceVersion: object.version,
        relationKind: slot.kind,
        direction: slot.direction,
        specs: catalog.specs,
      });
      if (!plan.ok) throw Error(plan.error);
      return runtime.call("app_edit", { workspaceId, commands: plan.commands });
    },
  };
  const graph =
    object.type === "base.relation_graph"
      ? {
          read: active.session.readGraph,
          subscribe: active.session.subscribeGraph,
          async locate(id: string) {
            requireActive();
            const result = await active.session.readGraph(true);
            requireActive();
            const node = result.nodes.find((item) => item.id === id);
            if (!node) throw Error("该对象已不在关系图范围内。");
            return (await runtime.focusObject?.(id)) ? null : node;
          },
          async addCenter(id: string) {
            requireActive();
            if (object.migrationError || !catalog.specs.has(object.type))
              throw Error("当前关系图是只读的。");
            const result = await active.session.readGraph(true);
            requireActive();
            const node = result.nodes.find((item) => item.id === id);
            if (!node) throw Error("该对象已不在关系图范围内。");
            if (node.depth === 0) return;
            await runtime.call("app_edit", {
              workspaceId,
              commands: [
                {
                  op: "relation.create",
                  kind: "base.graph_focus",
                  sourceId: objectId,
                  targetId: id,
                  expectedSourceVersion: object.version,
                  expectedTargetVersion: node.version,
                },
              ],
            });
          },
        }
      : undefined;
  return (
    <View
      workspaceId={workspaceId}
      object={object as unknown as ObjectRow}
      spec={spec as TypeSpec}
      presentation={presentation as PresentationRow}
      detail={(presentation.appearance.detail ?? "full") as ViewPropsDetail}
      readOnly={Boolean(object.migrationError)}
      dispatch={dispatch}
      bindings={active.session}
      actions={actions}
      graph={graph}
      timeline={
        object.type === "base.timeline"
          ? {
              async addFromBoard(dimension) {
                requireActive();
                if (object.migrationError) throw Error("当前时间轴是只读的。");
                const { items, nextCursor } = await active.session.read(
                  "items",
                  { limit: 200 },
                );
                requireActive();
                if (nextCursor)
                  throw Error("时间轴最多加入 200 个条目，请先移除一部分。");
                const linked = new Set(items.map(({ id }) => id));
                const candidates = new Set(
                  [...runtime.store.cache.presentations.values()]
                    .filter(
                      (row) =>
                        row.boardId === presentation.boardId && !row.deleted,
                    )
                    .map(({ objectId }) => objectId),
                );
                const commands: Command[] = [];
                for (const id of candidates) {
                  const row = runtime.store.cache.objects.get(id);
                  if (!row || row.deleted || id === objectId || linked.has(id))
                    continue;
                  const fields = timelineFields(catalog.specs.get(row.type));
                  if (
                    !fields.some(
                      ({ field, kind }) =>
                        !dimension ||
                        (field === dimension.field && kind === dimension.kind),
                    )
                  )
                    continue;
                  commands.push({
                    op: "relation.create",
                    kind: "base.timeline_item",
                    sourceId: objectId,
                    targetId: id,
                    expectedSourceVersion: object.version,
                    expectedTargetVersion: row.version,
                  });
                }
                if (items.length + commands.length > 200)
                  throw Error("时间轴最多加入 200 个条目，请先移除一部分。");
                if (commands.length)
                  await runtime.call("app_edit", { workspaceId, commands });
                return commands.length;
              },
            }
          : undefined
      }
      tableFiles={
        object.type === "base.table"
          ? {
              async create(title, table) {
                requireActive();
                if (object.migrationError) throw Error("当前表格是只读的。");
                const result: CommandResult = await runtime.call("app_edit", {
                  workspaceId,
                  commands: [
                    {
                      op: "object.create",
                      ref: "imported",
                      type: "base.table",
                      title,
                      data: table,
                    },
                    {
                      op: "presentation.create",
                      objectId: "@imported",
                      boardId: presentation.boardId,
                    },
                  ],
                });
                const id = result.created.imported;
                if (id) void runtime.focusObject?.(id).catch(() => {});
              },
              download: runtime.downloadFile,
            }
          : undefined
      }
    />
  );
}
type ViewPropsDetail = "full" | "label" | "icon";
