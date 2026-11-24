import type { MediaCrop } from "../../kernel/index.ts";

type Point = { x: number; y: number };

export function cropFromPoints(
  first: Point,
  last: Point,
): MediaCrop | undefined {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = Math.min(clamp(first.x), clamp(last.x));
  const y = Math.min(clamp(first.y), clamp(last.y));
  const w = Math.max(clamp(first.x), clamp(last.x)) - x;
  const h = Math.max(clamp(first.y), clamp(last.y)) - y;
  if (w > 0.005 && h > 0.005) return { x, y, w, h };
}
