import assert from "node:assert/strict";
import { test } from "node:test";
import { toCommands } from "../board/data-client/adapter.ts";
import {
  captureClipboard,
  clearClipboard,
  layoutAt,
  nudgeStillInWorkspace,
  planPaste,
  readClipboard,
  saveClipboard,
  syncWorkspace,
  workspaceChanged,
  type PlacedItem,
} from "../board/canvas/clipboard.ts";
import {
  SHORTCUTS,
  resolveShortcut,
  shortcutChords,
  type Chord,
  type KeyInput,
  type Platform,
} from "../board/canvas/keymap.ts";

function inputFor(platform: Platform, chord: Chord, typing: boolean): KeyInput {
  return {
    key: chord.key,
    platform,
    typing,
    metaKey: platform === "mac" && Boolean(chord.command),
    ctrlKey: platform === "windows" && Boolean(chord.command),
    shiftKey: Boolean(chord.shift),
    altKey: Boolean(chord.alt),
  };
}

for (const shortcut of SHORTCUTS) {
  assert.equal(shortcut.whenTyping, false);
  for (const platform of ["mac", "windows"] as const) {
    for (const chord of shortcutChords(shortcut, platform)) {
      const label = `${shortcut.id} ${platform} ${JSON.stringify(chord)}`;
      test(`${label} 解析到该行为`, () => {
        assert.equal(
          resolveShortcut(inputFor(platform, chord, false)),
          shortcut.id,
        );
      });
      test(`${label} 在输入框里不触发`, () => {
        assert.equal(resolveShortcut(inputFor(platform, chord, true)), null);
      });
    }
  }
}

test("Mac 不把 Ctrl 当成 ⌘，Windows 不把 Meta 当成 Ctrl", () => {
  assert.equal(
    resolveShortcut({
      key: "c",
      platform: "mac",
      typing: false,
      ctrlKey: true,
    }),
    null,
  );
  assert.equal(
    resolveShortcut({
      key: "c",
      platform: "windows",
      typing: false,
      metaKey: true,
    }),
    null,
  );
});

test("同一平台的快捷键互不重叠", () => {
  for (const platform of ["mac", "windows"] as const) {
    const seen = new Map<string, string>();
    for (const shortcut of SHORTCUTS) {
      for (const chord of shortcutChords(shortcut, platform)) {
        const token = JSON.stringify({
          key: chord.key,
          command: Boolean(chord.command),
          shift: Boolean(chord.shift),
          alt: Boolean(chord.alt),
        });
        assert.equal(seen.get(token), undefined, `${platform} ${token}`);
        seen.set(token, shortcut.id);
      }
    }
  }
});

function placed(objectId: string, x: number, y: number): PlacedItem {
  return {
    objectId,
    title: objectId,
    x,
    y,
    width: 280,
    height: 180,
    container: false,
  };
}

test("复制记下相对位置，粘贴时围绕指针展开", () => {
  const clipboard = captureClipboard("ws", [
    placed("a", 10, 30),
    placed("b", 40, 50),
  ]);
  assert.deepEqual(
    clipboard.items.map((item) => [item.objectId, item.dx, item.dy]),
    [
      ["a", 0, 0],
      ["b", 30, 20],
    ],
  );
  assert.deepEqual(
    layoutAt(clipboard.items, { x: 100, y: 200 }).map((item) => [
      item.x,
      item.y,
    ]),
    [
      [100, 200],
      [130, 220],
    ],
  );
});

test("换工作空间清空内部剪贴板", () => {
  clearClipboard();
  saveClipboard(captureClipboard("ws-a", [placed("a", 0, 0)]));
  assert.equal(syncWorkspace("ws-a"), "same");
  assert.ok(readClipboard());
  assert.equal(syncWorkspace("ws-b"), "cleared");
  assert.equal(readClipboard(), null);
});

test("首页白板编号相同也不算还在原来的工作空间", () => {
  assert.equal(workspaceChanged("ws-a", "ws-a"), false);
  assert.equal(workspaceChanged("", "ws-b"), false);
  assert.equal(workspaceChanged("ws-a", "ws-b"), true);
  clearClipboard();
  saveClipboard(captureClipboard("ws-a", [placed("home-board", 0, 0)]));
  if (workspaceChanged("ws-a", "ws-copy")) clearClipboard();
  assert.equal(readClipboard(), null);
});

test("方向键还没写回时，换了工作空间就不再写", () => {
  assert.equal(nudgeStillInWorkspace("ws-a", "ws-a"), true);
  assert.equal(nudgeStillInWorkspace("ws-a", "ws-copy"), false);
  assert.equal(nudgeStillInWorkspace("", "ws-copy"), true);
});

test("缺任何一个源对象就整批拒绝，引用和副本都一样", () => {
  const items = [
    { ...placed("a", 1, 2), x: 1, y: 2 },
    { ...placed("gone", 3, 4), x: 3, y: 4 },
  ];
  for (const mode of ["reference", "clone"] as const) {
    const planned = planPaste({
      mode,
      items,
      alive: new Set(["a"]),
    });
    assert.equal(planned.ok, false);
    if (!planned.ok) assert.match(planned.error, /源对象/);
  }
});

test("超过 200 条命令时拒绝，不拆批", () => {
  const items = Array.from({ length: 201 }, (_, index) =>
    placed(`o${index}`, index, 0),
  );
  const planned = planPaste({
    mode: "reference",
    items,
    alive: new Set(items.map((item) => item.objectId)),
  });
  assert.equal(planned.ok, false);
  if (!planned.ok) assert.match(planned.error, /200/);
});

test("粘贴引用只新建展示，粘贴副本先克隆再展示", () => {
  const ctx = {
    boardId: "board",
    objects: new Map(),
    presentations: new Map(),
  };
  const items = [
    {
      objectId: "a",
      x: 8,
      y: 12,
      width: 280,
      height: 180,
      appearance: { detail: "label" },
    },
    { objectId: "b", x: 32, y: 36, width: 200, height: 120 },
  ];
  assert.deepEqual(
    toCommands({ kind: "paste", mode: "reference", items }, ctx),
    [
      {
        op: "presentation.create",
        ref: "paste0",
        boardId: "board",
        objectId: "a",
        x: 8,
        y: 12,
        width: 280,
        height: 180,
        appearance: { detail: "label" },
      },
      {
        op: "presentation.create",
        ref: "paste1",
        boardId: "board",
        objectId: "b",
        x: 32,
        y: 36,
        width: 200,
        height: 120,
      },
    ],
  );
  assert.deepEqual(toCommands({ kind: "paste", mode: "clone", items }, ctx), [
    { op: "object.clone", id: "a", ref: "copy0" },
    {
      op: "presentation.create",
      ref: "paste0",
      boardId: "board",
      objectId: "@copy0",
      x: 8,
      y: 12,
      width: 280,
      height: 180,
      appearance: { detail: "label" },
    },
    { op: "object.clone", id: "b", ref: "copy1" },
    {
      op: "presentation.create",
      ref: "paste1",
      boardId: "board",
      objectId: "@copy1",
      x: 32,
      y: 36,
      width: 200,
      height: 120,
    },
  ]);
});
