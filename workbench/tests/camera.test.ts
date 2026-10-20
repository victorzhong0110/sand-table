import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centerCamera,
  easeCamera,
  edgeVelocity,
} from "../board/camera-motion.ts";
test("camera easing accelerates and brakes without overshoot", () => {
  const samples = Array.from({ length: 101 }, (_, i) => easeCamera(i / 100));
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 1);
  assert.ok(
    samples.every((v, i) => v >= 0 && v <= 1 && (!i || v >= samples[i - 1])),
  );
  assert.ok(easeCamera(0.1) < 0.1);
  assert.ok(easeCamera(0.9) > 0.9);
});
test("centering honors occluded area, zoom and the world origin", () => {
  const r = { x: 4000, y: -800, width: 280, height: 180, pinned: false };
  for (const zoom of [0.25, 1, 2]) {
    const c = centerCamera({ x: 0, y: 0, zoom }, r, {
      left: 260,
      right: 1100,
      top: 120,
      bottom: 900,
    });
    assert.equal(c.zoom, zoom);
    assert.equal((r.x + r.width / 2) * zoom + c.x, 680);
    assert.equal((r.y + r.height / 2) * zoom + c.y + 36, 510);
  }
});
test("edge panning accelerates near edges, caps diagonal speed and stops outside", () => {
  assert.deepEqual(edgeVelocity(500, 300, 1000, 600, 600), { x: 0, y: 0 });
  assert.deepEqual(edgeVelocity(-1, 300, 1000, 600, 600), { x: 0, y: 0 });
  assert.ok(
    edgeVelocity(5, 300, 1000, 600, 600).x >
      edgeVelocity(30, 300, 1000, 600, 600).x,
  );
  assert.ok(edgeVelocity(995, 300, 1000, 600, 600).x < 0);
  const diagonal = edgeVelocity(0, 0, 1000, 600, 600);
  assert.ok(Math.hypot(diagonal.x, diagonal.y) <= 600.00001);
});
