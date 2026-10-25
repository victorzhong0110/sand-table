export const NAV_ITEMS = [
  { id: "boards", label: "白板", icon: "board" },
  { id: "components", label: "组件", icon: "arrange" },
  { id: "history", label: "历史", icon: "history" },
  { id: "settings", label: "设置", icon: "comparison" },
  { id: "help", label: "帮助", icon: "help" },
] as const;

export type NavId = (typeof NAV_ITEMS)[number]["id"];

export const SHELL_PANEL_KEY = "sand.shell.panel";
export const SHELL_WIDTH_KEY = "sand.shell.width";
export const PANEL_WIDTH_DEFAULT = 224;
export const PANEL_WIDTH_MIN = 200;
export const PANEL_WIDTH_MAX = 480;

const NAV_IDS = new Set<string>(NAV_ITEMS.map((item) => item.id));

export function readShellPanel(): NavId | null {
  try {
    const raw = localStorage.getItem(SHELL_PANEL_KEY);
    if (raw === null) return "components";
    if (raw === "") return null;
    if (NAV_IDS.has(raw)) return raw as NavId;
  } catch {
    /* 浏览器不允许本地存储时，这次打开仍从组件面板开始。 */
  }
  return "components";
}

export function writeShellPanel(id: NavId | null) {
  try {
    localStorage.setItem(SHELL_PANEL_KEY, id ?? "");
  } catch {
    /* 存不下就只留在这次打开里。 */
  }
}

export function readShellWidth(): number {
  try {
    const width = Number(localStorage.getItem(SHELL_WIDTH_KEY));
    if (Number.isFinite(width))
      return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, width));
  } catch {
    /* 同上。 */
  }
  return PANEL_WIDTH_DEFAULT;
}

export function writeShellWidth(width: number) {
  try {
    localStorage.setItem(SHELL_WIDTH_KEY, String(width));
  } catch {
    /* 同上。 */
  }
}

export function clampShellWidth(width: number) {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, width));
}

/**
 * 浮动层挡住的画布区域，交给遮挡感知定位。
 * 左边距 16、面板宽度、再留 16，和左栏实际占位一致。
 * 右侧检查器沿用原来的 332，避免定位中心偏移。
 */
export function shellOcclusion(input: {
  panelWidth: number | null;
  inspectorRight: boolean;
  contextLeft: boolean;
}): { left: number; top: number; right: number; bottom: number } {
  const fromPanel = input.panelWidth == null ? 16 : 16 + input.panelWidth + 16;
  const fromContext = input.contextLeft ? 332 : 16;
  return {
    left: Math.max(fromPanel, fromContext),
    right: input.inspectorRight ? 332 : 16,
    top: 120,
    bottom: 60,
  };
}
