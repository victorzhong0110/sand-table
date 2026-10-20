import type { Camera, Rect } from "../core/spaces.ts";
export function easeCamera(t: number) {
  const p = Math.max(0, Math.min(1, t));
  return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
}
export function centerCamera(
  camera: Camera,
  rect: Rect,
  area: { left: number; top: number; right: number; bottom: number },
  originY = 36,
): Camera {
  return {
    ...camera,
    x: (area.left + area.right) / 2 - (rect.x + rect.width / 2) * camera.zoom,
    y:
      (area.top + area.bottom) / 2 -
      originY -
      (rect.y + rect.height / 2) * camera.zoom,
  };
}
export function edgeVelocity(
  x: number,
  y: number,
  width: number,
  height: number,
  speed: number,
  band = 48,
) {
  if (x < 0 || y < 0 || x > width || y > height) return { x: 0, y: 0 };
  const axis = (p: number, size: number) =>
    p < band
      ? ((band - p) / band) ** 2
      : p > size - band
        ? -(((p - size + band) / band) ** 2)
        : 0;
  let vx = axis(x, width),
    vy = axis(y, height);
  const length = Math.max(1, Math.hypot(vx, vy));
  return { x: (vx * speed) / length, y: (vy * speed) / length };
}
