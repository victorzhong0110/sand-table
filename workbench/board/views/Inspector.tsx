import type { Board } from "../data-client/model.ts";
import type { ComponentInstance } from "../data-client/spaces.ts";
import { TypeCatalogProvider } from "./catalog.tsx";
import { GenericForm } from "./GenericForm.tsx";

/** 侧边属性：选中的展示用通用表单编辑。 */
export function Inspector({
  board,
  viewId,
  call,
  operate,
  onOpenSettings,
  onOpenLink,
}: {
  board: Board;
  viewId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  operate: (op: any) => Promise<any>;
  onOpenSettings?: () => void;
  onOpenLink?: (url: string) => void;
}) {
  return (
    <TypeCatalogProvider call={call} revision={board.revision}>
      <InspectorBody
        board={board}
        viewId={viewId}
        call={call}
        operate={operate}
        onOpenSettings={onOpenSettings}
        onOpenLink={onOpenLink}
      />
    </TypeCatalogProvider>
  );
}

function InspectorBody({
  board,
  viewId,
  call,
  operate,
  onOpenSettings,
  onOpenLink,
}: {
  board: Board;
  viewId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  operate: (op: any) => Promise<any>;
  onOpenSettings?: () => void;
  onOpenLink?: (url: string) => void;
}) {
  const view = board.views[viewId];
  const selected = (view?.selection ?? [])
    .map((id) => board.instances.find((item) => item.id === id))
    .filter((item): item is ComponentInstance => Boolean(item));
  if (!selected.length) return null;
  return (
    <section>
      <h3>选中组件</h3>
      {selected.map((instance) => (
        <div key={instance.id}>
          <GenericForm
            instance={instance}
            board={board}
            call={call}
            operate={operate}
            onOpenSettings={onOpenSettings}
            onOpenLink={onOpenLink}
          />
          <button
            type="button"
            onClick={() =>
              void operate({
                kind: "place",
                items: [
                  {
                    id: instance.id,
                    rect: { ...instance.rect, pinned: !instance.rect.pinned },
                  },
                ],
              })
            }
          >
            {instance.rect.pinned ? "取消固定" : "固定位置"}
          </button>
        </div>
      ))}
    </section>
  );
}
