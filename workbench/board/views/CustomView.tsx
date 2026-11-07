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
import { customView, useViewRuntime } from "./registry.tsx";

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
  return (
    <View
      object={object as unknown as ObjectRow}
      spec={spec as TypeSpec}
      presentation={presentation as PresentationRow}
      detail={(presentation.appearance.detail ?? "full") as ViewPropsDetail}
      readOnly={Boolean(object.migrationError)}
      dispatch={dispatch}
      bindings={active.session}
    />
  );
}
type ViewPropsDetail = "full" | "label" | "icon";
