export type Platform = "mac" | "windows";

export type ShortcutId =
  | "delete"
  | "undo"
  | "redo"
  | "select-all"
  | "duplicate-presentation"
  | "duplicate-object"
  | "copy"
  | "paste-reference"
  | "paste-clone"
  | "nudge"
  | "edit"
  | "escape"
  | "zoom-reset"
  | "zoom-in"
  | "zoom-out"
  | "help";

export type Chord = {
  key: string;
  command?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  macLabel: string;
  windowsLabel: string;
  behavior: string;
  /** 焦点在输入框、文本区域或可编辑区域时一律不生效。 */
  whenTyping: false;
  mac: Chord[];
  windows: Chord[];
};

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

function arrows(shift = false): Chord[] {
  return ARROWS.map((key) => (shift ? { key, shift: true } : { key }));
}

export const SHORTCUTS: Shortcut[] = [
  {
    id: "delete",
    macLabel: "Delete / Backspace",
    windowsLabel: "Delete / Backspace",
    behavior: "移除选中的展示，不删除对象",
    whenTyping: false,
    mac: [{ key: "Delete" }, { key: "Backspace" }],
    windows: [{ key: "Delete" }, { key: "Backspace" }],
  },
  {
    id: "undo",
    macLabel: "⌘Z",
    windowsLabel: "Ctrl+Z",
    behavior: "撤销",
    whenTyping: false,
    mac: [{ key: "z", command: true }],
    windows: [{ key: "z", command: true }],
  },
  {
    id: "redo",
    macLabel: "⇧⌘Z 或 ⌘Y",
    windowsLabel: "Ctrl+Shift+Z 或 Ctrl+Y",
    behavior: "重做",
    whenTyping: false,
    mac: [
      { key: "z", command: true, shift: true },
      { key: "y", command: true },
    ],
    windows: [
      { key: "z", command: true, shift: true },
      { key: "y", command: true },
    ],
  },
  {
    id: "select-all",
    macLabel: "⌘A",
    windowsLabel: "Ctrl+A",
    behavior: "选中当前白板全部展示",
    whenTyping: false,
    mac: [{ key: "a", command: true }],
    windows: [{ key: "a", command: true }],
  },
  {
    id: "duplicate-presentation",
    macLabel: "⌘D",
    windowsLabel: "Ctrl+D",
    behavior: "再放一份展示（同一对象，位置偏移 24px）",
    whenTyping: false,
    mac: [{ key: "d", command: true }],
    windows: [{ key: "d", command: true }],
  },
  {
    id: "duplicate-object",
    macLabel: "⇧⌘D",
    windowsLabel: "Ctrl+Shift+D",
    behavior:
      "复制出独立对象并放在旁边（偏移 24px）。复制对象内容，不复制内部白板。",
    whenTyping: false,
    mac: [{ key: "d", command: true, shift: true }],
    windows: [{ key: "d", command: true, shift: true }],
  },
  {
    id: "copy",
    macLabel: "⌘C",
    windowsLabel: "Ctrl+C",
    behavior: "复制选中展示。内部剪贴板记下对象和布局，系统剪贴板只写标题",
    whenTyping: false,
    mac: [{ key: "c", command: true }],
    windows: [{ key: "c", command: true }],
  },
  {
    id: "paste-reference",
    macLabel: "⌘V",
    windowsLabel: "Ctrl+V",
    behavior: "在指针附近粘贴为同一对象的新展示",
    whenTyping: false,
    mac: [{ key: "v", command: true }],
    windows: [{ key: "v", command: true }],
  },
  {
    id: "paste-clone",
    macLabel: "⇧⌘V",
    windowsLabel: "Ctrl+Shift+V",
    behavior: "粘贴为独立副本。复制对象内容，不复制内部白板。",
    whenTyping: false,
    mac: [{ key: "v", command: true, shift: true }],
    windows: [{ key: "v", command: true, shift: true }],
  },
  {
    id: "nudge",
    macLabel: "方向键 / ⇧方向键",
    windowsLabel: "方向键 / Shift+方向键",
    behavior: "移动 1px，按住 Shift 为 10px；停止按键 500ms 后作为一步写入",
    whenTyping: false,
    mac: [...arrows(), ...arrows(true)],
    windows: [...arrows(), ...arrows(true)],
  },
  {
    id: "edit",
    macLabel: "Enter",
    windowsLabel: "Enter",
    behavior: "编辑选中的组件",
    whenTyping: false,
    mac: [{ key: "Enter" }],
    windows: [{ key: "Enter" }],
  },
  {
    id: "escape",
    macLabel: "Escape",
    windowsLabel: "Escape",
    behavior: "退出编辑，再按一次取消选择",
    whenTyping: false,
    mac: [{ key: "Escape" }],
    windows: [{ key: "Escape" }],
  },
  {
    id: "zoom-reset",
    macLabel: "⌘0",
    windowsLabel: "Ctrl+0",
    behavior: "缩放复位",
    whenTyping: false,
    mac: [{ key: "0", command: true }],
    windows: [{ key: "0", command: true }],
  },
  {
    id: "zoom-in",
    macLabel: "⌘=",
    windowsLabel: "Ctrl+=",
    behavior: "放大",
    whenTyping: false,
    mac: [
      { key: "=", command: true },
      { key: "+", command: true, shift: true },
    ],
    windows: [
      { key: "=", command: true },
      { key: "+", command: true, shift: true },
    ],
  },
  {
    id: "zoom-out",
    macLabel: "⌘-",
    windowsLabel: "Ctrl+-",
    behavior: "缩小",
    whenTyping: false,
    mac: [
      { key: "-", command: true },
      { key: "_", command: true, shift: true },
    ],
    windows: [
      { key: "-", command: true },
      { key: "_", command: true, shift: true },
    ],
  },
  {
    id: "help",
    macLabel: "?",
    windowsLabel: "?",
    behavior: "打开快捷键说明",
    whenTyping: false,
    mac: [{ key: "?" }, { key: "?", shift: true }],
    windows: [{ key: "?" }, { key: "?", shift: true }],
  },
];

export type KeyInput = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  platform: Platform;
  typing: boolean;
};

export function detectPlatform(
  nav: { platform?: string; userAgent?: string } = globalThis.navigator ?? {},
): Platform {
  const text = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(text) ? "mac" : "windows";
}

export function shortcutChords(
  shortcut: Shortcut,
  platform: Platform,
): Chord[] {
  return platform === "mac" ? shortcut.mac : shortcut.windows;
}

export function resolveShortcut(input: KeyInput): ShortcutId | null {
  if (input.typing) return null;
  const mac = input.platform === "mac";
  const primary = mac ? Boolean(input.metaKey) : Boolean(input.ctrlKey);
  const foreign = mac ? Boolean(input.ctrlKey) : Boolean(input.metaKey);
  if (foreign) return null;
  const command = primary;
  const shift = Boolean(input.shiftKey);
  const alt = Boolean(input.altKey);
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  for (const shortcut of SHORTCUTS) {
    for (const chord of shortcutChords(shortcut, input.platform)) {
      const chordKey =
        chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
      if (chordKey !== key) continue;
      if (Boolean(chord.command) !== command) continue;
      if (Boolean(chord.shift) !== shift) continue;
      if (Boolean(chord.alt) !== alt) continue;
      return shortcut.id;
    }
  }
  return null;
}
