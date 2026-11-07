export type ThemeBase = "mono" | "paper";

export type ThemeColors = {
  background: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
};

export type Theme = {
  name: string;
  base: ThemeBase;
  colors: ThemeColors;
  font: "system" | "serif" | "mono";
  fontSize: number;
  lineHeight: number;
  density: "comfortable" | "compact";
  radius: number;
  shadow: "none" | "soft" | "strong";
  motion: { speed: number; reduce: boolean };
};

export const THEME_SETTING_KEY = "theme";

export function boardThemeSettingKey(boardId: string) {
  return `theme.board.${boardId}`;
}

export function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const normalized = hex.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return 0;
    const rgb = normalized
      .slice(1)
      .match(/../g)!
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function validateThemeField(
  path: string,
  value: unknown,
): string | null {
  switch (path) {
    case "name":
      if (typeof value !== "string" || !value.trim()) return "主题名称不能为空";
      if (value.length > 120) return "主题名称不能超过 120 个字";
      return null;
    case "base":
      return value === "mono" || value === "paper"
        ? null
        : "基础皮肤只能是 mono 或 paper";
    case "font":
      return value === "system" || value === "serif" || value === "mono"
        ? null
        : "字体只能是 system、serif 或 mono";
    case "fontSize":
      return typeof value === "number" && value >= 12 && value <= 20
        ? null
        : "字号须在 12–20 之间";
    case "lineHeight":
      return typeof value === "number" && value >= 1.3 && value <= 2
        ? null
        : "行距须在 1.3–2.0 之间";
    case "density":
      return value === "comfortable" || value === "compact"
        ? null
        : "密度只能是 comfortable 或 compact";
    case "radius":
      return typeof value === "number" && value >= 0 && value <= 20
        ? null
        : "圆角须在 0–20 之间";
    case "shadow":
      return value === "none" || value === "soft" || value === "strong"
        ? null
        : "阴影只能是 none、soft 或 strong";
    case "motion.speed":
      return typeof value === "number" && value >= 0.5 && value <= 2
        ? null
        : "动效速度须在 0.5–2 之间";
    case "motion.reduce":
      return typeof value === "boolean" ? null : "减少动效必须是布尔值";
    case "colors.background":
    case "colors.surface":
    case "colors.ink":
    case "colors.muted":
    case "colors.line":
    case "colors.accent":
      return typeof value === "string" && HEX.test(value)
        ? null
        : `${path} 必须是 #RRGGBB 格式的颜色`;
    default:
      return `未知字段：${path}`;
  }
}

export function validateTheme(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["主题必须是对象"];
  const record = value as Record<string, unknown>;
  const paths = [
    "name",
    "base",
    "font",
    "fontSize",
    "lineHeight",
    "density",
    "radius",
    "shadow",
    "motion.speed",
    "motion.reduce",
    "colors.background",
    "colors.surface",
    "colors.ink",
    "colors.muted",
    "colors.line",
    "colors.accent",
  ];
  const errors: string[] = [];
  for (const path of paths) {
    const parts = path.split(".");
    let current: unknown = record;
    for (const part of parts) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    const message = validateThemeField(path, current);
    if (message) errors.push(message);
  }
  return errors;
}

export function validateThemeImport(value: unknown): {
  ok: boolean;
  errors: string[];
  theme?: Theme;
} {
  const errors = validateTheme(value);
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], theme: value as Theme };
}

export function coerceTheme(value: unknown): Theme | null {
  const errors = validateTheme(value);
  if (!errors.length) return value as Theme;
  if (!value || typeof value !== "object") return null;
  const legacy = value as Record<string, unknown>;
  if (
    (legacy.base === "paper" || legacy.base === "mono") &&
    typeof legacy.background === "string"
  ) {
    return {
      name: String(legacy.name ?? (legacy.base === "mono" ? "黑白" : "暖纸")),
      base: legacy.base,
      colors: {
        background: String(legacy.background),
        surface: String(legacy.surface ?? legacy.background),
        ink: String(legacy.ink ?? "#191919"),
        muted: String(legacy.muted ?? "#737373"),
        line: String(legacy.line ?? "#d9d9d9"),
        accent: String(legacy.accent ?? "#222222"),
      },
      font:
        legacy.font === "serif" || legacy.font === "mono"
          ? legacy.font
          : "system",
      fontSize:
        typeof legacy.fontSize === "number"
          ? legacy.fontSize
          : typeof legacy.fontSize === "undefined"
            ? 14
            : 14,
      lineHeight:
        typeof legacy.lineHeight === "number" ? legacy.lineHeight : 1.5,
      density: legacy.density === "compact" ? "compact" : "comfortable",
      radius: typeof legacy.radius === "number" ? legacy.radius : 10,
      shadow:
        legacy.shadow === "none" ||
        legacy.shadow === "soft" ||
        legacy.shadow === "strong"
          ? legacy.shadow
          : "soft",
      motion: {
        speed:
          typeof legacy.motion === "object" &&
          legacy.motion &&
          typeof (legacy.motion as { speed?: unknown }).speed === "number"
            ? (legacy.motion as { speed: number }).speed
            : 1,
        reduce: Boolean(
          legacy.reduceMotion ??
          (typeof legacy.motion === "object" &&
            legacy.motion &&
            (legacy.motion as { reduce?: unknown }).reduce),
        ),
      },
    };
  }
  return null;
}

export function mergeThemes(workspace: Theme, override?: unknown): Theme {
  if (!override || typeof override !== "object") return workspace;
  const patch = override as Partial<Theme> & {
    colors?: Partial<ThemeColors>;
    motion?: Partial<Theme["motion"]>;
  };
  return {
    ...workspace,
    ...patch,
    colors: { ...workspace.colors, ...(patch.colors ?? {}) },
    motion: { ...workspace.motion, ...(patch.motion ?? {}) },
  };
}

export type ThemeOverridePatch = {
  name?: string;
  base?: ThemeBase;
  font?: Theme["font"];
  fontSize?: number;
  lineHeight?: number;
  density?: Theme["density"];
  radius?: number;
  shadow?: Theme["shadow"];
  colors?: Partial<ThemeColors>;
  motion?: Partial<Theme["motion"]>;
};

export function themeOverrideDiff(
  workspace: Theme,
  next: Theme,
): ThemeOverridePatch {
  const diff: ThemeOverridePatch = {};
  const scalarKeys = [
    "name",
    "base",
    "font",
    "fontSize",
    "lineHeight",
    "density",
    "radius",
    "shadow",
  ] as const;
  for (const key of scalarKeys) {
    if (next[key] !== workspace[key])
      (diff as Record<string, unknown>)[key] = next[key];
  }
  const colorDiff: Partial<ThemeColors> = {};
  for (const key of Object.keys(workspace.colors) as (keyof ThemeColors)[]) {
    if (next.colors[key] !== workspace.colors[key])
      colorDiff[key] = next.colors[key];
  }
  if (Object.keys(colorDiff).length) diff.colors = colorDiff;
  const motionDiff: Partial<Theme["motion"]> = {};
  if (next.motion.speed !== workspace.motion.speed)
    motionDiff.speed = next.motion.speed;
  if (next.motion.reduce !== workspace.motion.reduce)
    motionDiff.reduce = next.motion.reduce;
  if (Object.keys(motionDiff).length) diff.motion = motionDiff;
  return diff;
}
