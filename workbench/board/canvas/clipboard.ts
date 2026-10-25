export const DUPLICATE_OFFSET = 24;
export const COMMAND_LIMIT = 200;

export const EMPTY_CLIPBOARD_MESSAGE =
  "内部剪贴板是空的。请先选中展示，再复制。";
export const TOO_MANY_MESSAGE = "一次最多写入 200 条命令。请缩小选择后再试。";
export const CLONE_SCOPE_MESSAGE = "复制对象内容，不复制内部白板。";
export const OTHER_WORKSPACE_MESSAGE =
  "已经换了工作空间，内部剪贴板已清空。请在当前工作空间里重新复制。";

export type ClipboardAppearance = {
  detail?: "full" | "label" | "icon";
  accent?: string;
  coverBlob?: string;
};

export type ClipboardItem = {
  objectId: string;
  title: string;
  dx: number;
  dy: number;
  width: number;
  height: number;
  appearance?: ClipboardAppearance;
  container: boolean;
};

export type PageClipboard = {
  workspaceId: string;
  items: ClipboardItem[];
};

export type PlacedItem = {
  objectId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  appearance?: ClipboardAppearance;
  container: boolean;
};

export type PasteItem = PlacedItem;

export type PasteMode = "reference" | "clone";

export type PlanPaste =
  { ok: true; items: PasteItem[] } | { ok: false; error: string };

let current: PageClipboard | null = null;

export function readClipboard(): PageClipboard | null {
  return current;
}

export function clearClipboard(): void {
  current = null;
}

export function saveClipboard(value: PageClipboard): void {
  current = value;
}

/** 工作空间变了就丢掉内部剪贴板。系统剪贴板不动。 */
export function syncWorkspace(workspaceId: string): "set" | "same" | "cleared" {
  if (!current) return "set";
  if (current.workspaceId === workspaceId) return "same";
  current = null;
  return "cleared";
}

export function missingSourceMessage(mode: PasteMode): string {
  if (mode === "clone")
    return "这些展示的源对象已经不在了。请先撤销删除把源对象恢复回来，或使用工作空间导入。这次不会去复制一个已经不存在的对象。";
  return "这些展示的源对象已经不在了。请先撤销删除把源对象恢复回来，或使用工作空间导入。这次不会改成独立副本。";
}

export function clipboardPlainText(items: { title: string }[]): string {
  return items.map((item) => item.title.trim() || "未命名").join("\n");
}

export function captureClipboard(
  workspaceId: string,
  placed: PlacedItem[],
): PageClipboard {
  const originX = Math.min(...placed.map((item) => item.x));
  const originY = Math.min(...placed.map((item) => item.y));
  return {
    workspaceId,
    items: placed.map((item) => ({
      objectId: item.objectId,
      title: item.title,
      dx: item.x - originX,
      dy: item.y - originY,
      width: item.width,
      height: item.height,
      ...(item.appearance ? { appearance: item.appearance } : {}),
      container: item.container,
    })),
  };
}

export function layoutAt(
  items: ClipboardItem[],
  origin: { x: number; y: number },
): PasteItem[] {
  return items.map((item) => ({
    objectId: item.objectId,
    title: item.title,
    x: origin.x + item.dx,
    y: origin.y + item.dy,
    width: item.width,
    height: item.height,
    ...(item.appearance ? { appearance: item.appearance } : {}),
    container: item.container,
  }));
}

export function layoutOffset(items: PlacedItem[], offset: number): PasteItem[] {
  return items.map((item) => ({
    objectId: item.objectId,
    title: item.title,
    x: item.x + offset,
    y: item.y + offset,
    width: item.width,
    height: item.height,
    ...(item.appearance ? { appearance: item.appearance } : {}),
    container: item.container,
  }));
}

/** 缺任何一个源对象就整批拒绝，不返回可写入的子集。 */
export function planPaste(input: {
  mode: PasteMode;
  items: PasteItem[];
  alive: ReadonlySet<string>;
}): PlanPaste {
  if (!input.items.length) return { ok: false, error: EMPTY_CLIPBOARD_MESSAGE };
  const per = input.mode === "clone" ? 2 : 1;
  if (input.items.length * per > COMMAND_LIMIT)
    return { ok: false, error: TOO_MANY_MESSAGE };
  if (input.items.some((item) => !input.alive.has(item.objectId)))
    return { ok: false, error: missingSourceMessage(input.mode) };
  return { ok: true, items: input.items };
}
