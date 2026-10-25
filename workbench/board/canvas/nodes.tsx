import {
  Handle,
  NodeResizeControl,
  Position,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ComponentRenderer } from "../ComponentRenderer.tsx";
import { Icon } from "../Icon.tsx";
import { peekContent } from "../data-client/content.ts";
import type { Board } from "../data-client/model.ts";
import {
  componentTypes,
  material,
  type ComponentInstance,
} from "../data-client/spaces.ts";

export type CardNodeData = { objectId: string };
export type CardNodeType = FlowNode<CardNodeData, "card">;

export type InlineEdit = {
  id: string;
  field: "title" | "text";
  value: string;
  baseTitle: string;
  baseData: Record<string, unknown>;
  version?: number;
};

export type CanvasApi = {
  board: Board;
  editing?: InlineEdit;
  editBox: RefObject<HTMLTextAreaElement | null>;
  composing: RefObject<boolean>;
  pendingCaret: RefObject<{ start: number; end: number } | null>;
  routeIds: Set<string>;
  focusedGuide: Board["guides"][number] | undefined;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  onOpenLink: (url: string) => void;
  navigate: (spaceId: string, presentationId?: string) => void;
  operate: (op: any) => Promise<any>;
  beginEdit: (
    instance: ComponentInstance,
    caret: { start: number; end: number },
  ) => void;
  changeEdit: (value: string) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  markResizing: (id: string, active: boolean) => void;
  commitResize: (
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => void;
};

const CanvasApiContext = createContext<CanvasApi | null>(null);

export function CanvasApiProvider({
  value,
  children,
}: {
  value: CanvasApi;
  children: ReactNode;
}) {
  return (
    <CanvasApiContext.Provider value={value}>
      {children}
    </CanvasApiContext.Provider>
  );
}

function useCanvasApi(): CanvasApi {
  const api = useContext(CanvasApiContext);
  if (!api) throw Error("画布节点必须放在画布里。");
  return api;
}

const growsWithContent =
  typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

export const editField = (type: string): "title" | "text" =>
  ["text", "heading", "code"].includes(type) ? "text" : "title";

function editHost(card: HTMLElement, field: "title" | "text") {
  if (!card.classList.contains("detail-full"))
    return card.querySelector<HTMLElement>(".collapsed-title");
  if (field === "text")
    return card.querySelector<HTMLElement>(
      ".component-text, .component-heading, pre",
    );
  return card.querySelector<HTMLElement>(":scope > strong");
}

function textOffset(root: HTMLElement, node: globalThis.Node, offset: number) {
  if (node !== root && !root.contains(node)) return null;
  const range = document.createRange();
  range.setStart(root, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

function caretFromPoint(x: number, y: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

export function readCaret(
  host: HTMLElement,
  value: string,
  x: number,
  y: number,
) {
  const shown = (host.textContent ?? "").replace(/\r\n/g, "\n");
  const atEnd = { start: value.length, end: value.length };
  if (shown !== value.replace(/\r\n/g, "\n")) return atEnd;
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const start = textOffset(host, range.startContainer, range.startOffset);
    const end = textOffset(host, range.endContainer, range.endOffset);
    if (start !== null && end !== null)
      return { start: Math.min(start, end), end: Math.max(start, end) };
  }
  const point = caretFromPoint(x, y);
  if (point) {
    const offset = textOffset(host, point.node, point.offset);
    if (offset !== null) return { start: offset, end: offset };
  }
  return atEnd;
}

function inlineEditClass(
  type: string,
  field: "title" | "text",
  detail: string | undefined,
) {
  const base = "nodrag nowheel nopan";
  if (detail && detail !== "full") return `${base} inline-edit collapsed-title`;
  if (field === "title") return `${base} inline-edit is-title`;
  if (type === "heading") return `${base} inline-edit component-heading`;
  if (type === "code") return `${base} inline-edit component-code`;
  return `${base} inline-edit component-text`;
}

function inlineEditPlaceholder(
  type: string,
  field: "title" | "text",
  title: string,
) {
  if (field !== "text") return undefined;
  if (type === "code") return "尚未提供代码片段";
  if (type === "heading") return title;
  if (type === "text") return "写点什么…";
  return undefined;
}

function fitInlineEdit(el: HTMLTextAreaElement, keepCaret: boolean) {
  if (el.classList.contains("collapsed-title")) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const scroll = el.scrollTop;
  el.style.overflow = "hidden";
  el.style.height = "auto";
  const content = el.scrollHeight;
  const card = el.closest("article");
  let height = content;
  if (card instanceof HTMLElement) {
    const pad = Number.parseFloat(getComputedStyle(card).paddingBottom) || 0;
    const margin = Number.parseFloat(getComputedStyle(el).marginBottom) || 0;
    let top = 0;
    let node: HTMLElement | null = el;
    let reached = false;
    while (node && node !== card) {
      top += node.offsetTop;
      const parent: Element | null = node.offsetParent;
      if (!(parent instanceof HTMLElement)) break;
      node = parent;
      if (node === card) reached = true;
    }
    const room = card.clientHeight - top - pad - margin;
    if (reached && room > 0) height = Math.min(content, room);
  }
  el.style.height = `${height}px`;
  el.style.overflow = content > height + 1 ? "auto" : "hidden";
  if (keepCaret && start !== null && end !== null) {
    el.setSelectionRange(start, end);
    el.scrollTop = scroll;
  }
}

function quietControls(root: HTMLElement) {
  for (const node of root.querySelectorAll(
    "input, textarea, select, button, a, [contenteditable='true']",
  ))
    node.classList.add("nodrag", "nowheel", "nopan");
}

export function CardNode({ id, selected, data }: NodeProps<CardNodeType>) {
  const api = useCanvasApi();
  const article = useRef<HTMLElement>(null);
  const instance = api.board.instances.find((item) => item.id === id);
  useLayoutEffect(() => {
    if (article.current) quietControls(article.current);
  });
  useLayoutEffect(() => {
    const el = api.editBox.current;
    if (!el || api.editing?.id !== id) return;
    if (!growsWithContent) fitInlineEdit(el, !api.composing.current);
    const caret = api.pendingCaret.current;
    if (!caret || api.composing.current) return;
    api.pendingCaret.current = null;
    const end = el.value.length;
    const start = Math.min(Math.max(caret.start, 0), end);
    const finish = Math.min(Math.max(caret.end, start), end);
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, finish);
  }, [api, id]);
  if (!instance) return null;
  const resolved = peekContent(instance, api.board.contentObjects);
  const detail = instance.appearance?.detail;
  const expanded = !detail || detail === "full";
  const editingHere = api.editing?.id === instance.id ? api.editing : undefined;
  const editor = editingHere ? (
    <textarea
      ref={api.editBox}
      className={inlineEditClass(instance.type, editingHere.field, detail)}
      placeholder={inlineEditPlaceholder(
        instance.type,
        editingHere.field,
        resolved.title,
      )}
      aria-label={
        editingHere.field === "title" ? "就地编辑标题" : "就地编辑内容"
      }
      value={editingHere.value}
      rows={1}
      spellCheck={false}
      autoFocus
      onCompositionStart={() => {
        api.composing.current = true;
      }}
      onCompositionEnd={() => {
        api.composing.current = false;
        if (api.editBox.current && !growsWithContent)
          fitInlineEdit(api.editBox.current, true);
      }}
      onChange={(event) => api.changeEdit(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key === "Process") return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          api.commitEdit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          api.cancelEdit();
        }
      }}
      onBlur={() => api.commitEdit()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  ) : null;
  const guide = api.focusedGuide;
  const onRoute = Boolean(
    instance.objectId && api.routeIds.has(instance.objectId),
  );
  return (
    <article
      ref={article}
      tabIndex={0}
      role="button"
      aria-label={resolved.title}
      data-object-id={data.objectId}
      data-instance-id={instance.id}
      className={`card component-card material-${material(instance.type)} detail-${detail || "full"} ${selected ? "selected" : ""} ${guide && instance.objectId && !onRoute ? "dimmed" : ""} ${editingHere ? "editing" : ""}`}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, a, input, textarea, select")) return;
        event.stopPropagation();
        if (instance.type === "board" || instance.type === "space-link") {
          api.navigate(
            String(instance.data.spaceId ?? instance.objectId ?? ""),
            instance.id,
          );
          return;
        }
        const field = editField(instance.type);
        const content = peekContent(instance, api.board.contentObjects);
        const value =
          field === "text" ? String(content.data.text ?? "") : content.title;
        const host = editHost(event.currentTarget, field);
        api.beginEdit(
          instance,
          host
            ? readCaret(host, value, event.clientX, event.clientY)
            : { start: value.length, end: value.length },
        );
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="nodrag"
        aria-label="接到这里"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="nodrag"
        aria-label="拖出关系"
      />
      {api.board.spaceActivities
        ?.filter((activity) => activity.instanceIds.includes(instance.id))
        .slice(0, 1)
        .map((activity) => (
          <span
            className="spatial-activity"
            key={activity.agentId}
            title={activity.task + " · " + activity.action + " · Agent 自报"}
          >
            ●{" "}
            {activity.stale
              ? "最后已知"
              : activity.state === "running"
                ? "处理中"
                : activity.state === "done"
                  ? "已完成"
                  : "等待"}{" "}
            · {activity.agentId}
          </span>
        ))}
      {instance.rect.pinned && <span className="pin-badge">已固定</span>}
      {guide && onRoute && (
        <span className="step-badge">
          步骤{" "}
          {guide.steps
            .flatMap((step, index) =>
              instance.objectId && step.objectIds.includes(instance.objectId)
                ? [index + 1]
                : [],
            )
            .join("、")}
        </span>
      )}
      <div className="component-chrome">
        <span
          className="component-symbol"
          title={
            componentTypes.find((item) => item.type === instance.type)?.title
          }
        >
          <Icon
            name={
              componentTypes.some((item) => item.type === instance.type)
                ? instance.type === "space-link" || instance.type === "object"
                  ? "board"
                  : instance.type
                : instance.appearance?.icon || "board"
            }
            size={20}
          />
        </span>
        {!expanded &&
          (editor ??
            (detail !== "icon" && (
              <strong className="collapsed-title">{resolved.title}</strong>
            )))}
        <button
          className="detail-toggle nodrag nowheel nopan"
          aria-label={`切换 ${resolved.title} 展开层级`}
          title="完整界面 → 图标和标题 → 仅图标"
          onClick={(event) => {
            event.stopPropagation();
            void api.operate({
              kind: "update",
              instanceId: instance.id,
              appearance: {
                detail:
                  instance.appearance?.detail === "icon"
                    ? "full"
                    : instance.appearance?.detail === "label"
                      ? "icon"
                      : "label",
              },
            });
          }}
        >
          <Icon name="board" size={14} />
        </button>
      </div>
      {expanded && (
        <ComponentRenderer
          instance={instance}
          board={api.board}
          call={api.call}
          onNavigate={(spaceId, presentationId) =>
            api.navigate(spaceId, presentationId)
          }
          onOpenLink={api.onOpenLink}
          editor={editor ?? undefined}
          editingField={editingHere?.field}
        />
      )}
      {selected && !instance.rect.pinned && expanded && (
        <NodeResizeControl
          position="bottom-right"
          className="resize-handle"
          minWidth={120}
          minHeight={70}
          maxWidth={2000}
          maxHeight={1600}
          onResizeStart={() => api.markResizing(instance.id, true)}
          onResizeEnd={(_event, params) => {
            api.markResizing(instance.id, false);
            api.commitResize(instance.id, {
              x: params.x,
              y: params.y,
              width: params.width,
              height: params.height,
            });
          }}
        >
          ↘
        </NodeResizeControl>
      )}
    </article>
  );
}
