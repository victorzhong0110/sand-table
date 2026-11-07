import type { CSSProperties } from "react";
import type { Theme } from "./tokens.ts";

const FONT_STACK = {
  system: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  serif: "Georgia,serif",
  mono: "ui-monospace,monospace",
} as const;

const SHADOW = {
  none: "none",
  soft: "0 3px 12px color-mix(in srgb, var(--ink) 8%, transparent)",
  strong: "0 8px 28px color-mix(in srgb, var(--ink) 14%, transparent)",
} as const;

export function themeStyle(
  theme: Theme,
  reducedMotion: boolean,
): CSSProperties {
  const baseMs = Math.round(
    180 / Math.max(0.5, Math.min(2, theme.motion.speed)),
  );
  const motionMs = theme.motion.reduce || reducedMotion ? 0 : baseMs;
  return {
    "--bg": theme.colors.background,
    "--surface": theme.colors.surface,
    "--ink": theme.colors.ink,
    "--muted": theme.colors.muted,
    "--line": theme.colors.line,
    "--accent": theme.colors.accent,
    "--soft": theme.colors.background,
    "--radius": `${theme.radius}px`,
    "--font-size": `${theme.fontSize}px`,
    "--line-height": String(theme.lineHeight),
    "--shadow-soft": SHADOW[theme.shadow],
    "--motion-duration": `${motionMs}ms`,
    fontFamily: FONT_STACK[theme.font],
    fontSize: `${theme.fontSize}px`,
    lineHeight: theme.lineHeight,
    background: theme.colors.background,
    color: theme.colors.ink,
  } as CSSProperties;
}

export function themeClassName(theme: Theme) {
  return [
    theme.base,
    theme.density === "compact" ? "compact" : "",
    theme.motion.reduce ? "reduce-motion" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function systemPrefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
