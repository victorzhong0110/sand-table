import { type Theme, contrastRatio } from "./tokens.ts";

export const PAPER_THEME: Theme = {
  name: "暖纸",
  base: "paper",
  colors: {
    background: "#f6f1e6",
    surface: "#fffdf7",
    ink: "#322f28",
    muted: "#777366",
    line: "#ddd5c4",
    accent: "#9b552f",
  },
  font: "system",
  fontSize: 14,
  lineHeight: 1.5,
  density: "comfortable",
  radius: 10,
  shadow: "soft",
  motion: { speed: 1, reduce: false },
};

export const MONO_THEME: Theme = {
  name: "黑白",
  base: "mono",
  colors: {
    background: "#f5f5f5",
    surface: "#ffffff",
    ink: "#191919",
    muted: "#737373",
    line: "#d9d9d9",
    accent: "#222222",
  },
  font: "system",
  fontSize: 14,
  lineHeight: 1.5,
  density: "comfortable",
  radius: 8,
  shadow: "soft",
  motion: { speed: 1, reduce: false },
};

export const THEME_PRESETS = {
  paper: PAPER_THEME,
  mono: MONO_THEME,
} as const;

export function presetOfBase(base: "paper" | "mono") {
  return structuredClone(THEME_PRESETS[base]);
}

export function presetContrastOk(theme: Theme) {
  return contrastRatio(theme.colors.ink, theme.colors.surface) >= 4.5;
}
