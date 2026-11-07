import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCommands,
  createRegistry,
  openWorkspace,
} from "../kernel/index.ts";
import { basePack } from "../packs/base/index.ts";
import {
  boardThemeSettingKey,
  coerceTheme,
  mergeThemes,
  validateThemeField,
  validateThemeImport,
  contrastRatio,
  THEME_SETTING_KEY,
} from "../board/theme/tokens.ts";
import {
  MONO_THEME,
  PAPER_THEME,
  presetContrastOk,
} from "../board/theme/presets.ts";
import { toBoard } from "../board/data-client/adapter.ts";
import { V3Store } from "../board/data-client/store.ts";
import { createThemeWriter } from "../board/theme/persistence.ts";

function workspace(dir: string) {
  const registry = createRegistry();
  registry.registerPack(basePack, "builtin");
  const { db } = openWorkspace(dir, "demo", registry, { title: "Demo" });
  return { db, registry, actor: { id: "human", kind: "human" as const } };
}

test("两套预设正文对比度至少 4.5:1", () => {
  assert.ok(presetContrastOk(PAPER_THEME));
  assert.ok(presetContrastOk(MONO_THEME));
  assert.ok(
    contrastRatio(PAPER_THEME.colors.ink, PAPER_THEME.colors.surface) >= 4.5,
  );
  assert.ok(
    contrastRatio(MONO_THEME.colors.ink, MONO_THEME.colors.surface) >= 4.5,
  );
});

test("主题字段取值范围校验", () => {
  assert.match(validateThemeField("fontSize", 11) ?? "", /12–20/);
  assert.match(validateThemeField("lineHeight", 2.2) ?? "", /1.3–2/);
  assert.match(validateThemeField("colors.ink", "red") ?? "", /#RRGGBB/);
});

test("白板覆盖与工作空间主题合并", () => {
  const merged = mergeThemes(PAPER_THEME, {
    colors: { background: "#eeeeee" },
    radius: 4,
  });
  assert.equal(merged.colors.background, "#eeeeee");
  assert.equal(merged.colors.ink, PAPER_THEME.colors.ink);
  assert.equal(merged.radius, 4);
  assert.equal(merged.base, "paper");
});

test("工作空间和白板主题经过界面投影后保留全部属性", () => {
  const store = new V3Store(async () => ({}));
  const theme = {
    ...PAPER_THEME,
    name: "我的主题",
    fontSize: 18,
    lineHeight: 1.8,
    shadow: "strong" as const,
    motion: { speed: 1.7, reduce: true },
  };
  const override = { colors: { accent: "#112233" }, motion: { speed: 0.8 } };
  store.cache.settings.set("theme", {
    key: "theme",
    value: theme,
    rev: 1,
    deleted: false,
  });
  store.cache.settings.set(boardThemeSettingKey("board"), {
    key: boardThemeSettingKey("board"),
    value: override,
    rev: 1,
    deleted: false,
  });
  const board = toBoard(store.cache, {
    boardId: "board",
    workspaceId: "demo",
    view: {
      id: "view",
      spaceId: "board",
      camera: { x: 0, y: 0, zoom: 1 },
      selection: [],
      updatedAt: 0,
    },
  });
  assert.deepEqual(coerceTheme(board.themeWorkspace), theme);
  assert.deepEqual(coerceTheme(board.theme), mergeThemes(theme, override));
});

test("跟随工作空间会取消尚未写入的旧覆盖", async () => {
  const writes: string[] = [];
  const writer = createThemeWriter(
    async (write) => {
      writes.push(String(write.commands[0]?.op));
    },
    () => assert.fail("写入不应失败"),
    15,
  );
  writer.schedule({ workspaceId: "demo", commands: [{ op: "setting.set" }] });
  await writer.writeNow({
    workspaceId: "demo",
    commands: [{ op: "setting.delete" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(writes, ["setting.delete"]);
});

test("正在写入的覆盖完成后才清除，最后一次操作生效", async () => {
  const writes: string[] = [];
  let finish: (() => void) | undefined;
  const writer = createThemeWriter(
    async (write) => {
      const op = String(write.commands[0]?.op);
      writes.push(op);
      if (op === "setting.set")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    },
    () => assert.fail("写入不应失败"),
    0,
  );
  writer.schedule({ workspaceId: "demo", commands: [{ op: "setting.set" }] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(writes, ["setting.set"]);
  const following = writer.writeNow({
    workspaceId: "demo",
    commands: [{ op: "setting.delete" }],
  });
  assert.deepEqual(writes, ["setting.set"]);
  finish!();
  await following;
  assert.deepEqual(writes, ["setting.set", "setting.delete"]);
});

test("关闭再打开设置时，新的主题写入不会被旧请求覆盖", async () => {
  const writes: string[] = [];
  let finish: (() => void) | undefined;
  const send = async (write: { commands: Record<string, unknown>[] }) => {
    const value = String(write.commands[0]?.value);
    writes.push(value);
    if (value === "old")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  };
  const first = createThemeWriter(send, () => assert.fail("写入不应失败"));
  const second = createThemeWriter(send, () => assert.fail("写入不应失败"));
  first.schedule({
    workspaceId: "demo-reopen",
    commands: [{ op: "setting.set", value: "old" }],
  });
  first.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const next = second.writeNow({
    workspaceId: "demo-reopen",
    commands: [{ op: "setting.set", value: "new" }],
  });
  assert.deepEqual(writes, ["old"]);
  finish!();
  await next;
  assert.deepEqual(writes, ["old", "new"]);
});

test("导入不合格 JSON 逐条报错", () => {
  const bad = validateThemeImport({
    name: "",
    base: "neon",
    fontSize: 30,
    colors: { ink: "bad" },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 3);
  assert.ok(bad.errors.some((item) => item.includes("基础皮肤")));
  assert.ok(bad.errors.some((item) => item.includes("字号")));
});

test("setting.delete 清除白板主题覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-theme-"));
  try {
    const { db, registry, actor } = workspace(dir);
    const boardId = "base-board";
    applyCommands(db, registry, {
      actor,
      commands: [
        {
          op: "setting.set",
          key: THEME_SETTING_KEY,
          value: PAPER_THEME,
        },
        {
          op: "setting.set",
          key: boardThemeSettingKey(boardId),
          value: { colors: { accent: "#112233" } },
        },
      ],
    });
    const override = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(boardThemeSettingKey(boardId)) as { value: string } | undefined;
    assert.ok(override);
    applyCommands(db, registry, {
      actor,
      commands: [{ op: "setting.delete", key: boardThemeSettingKey(boardId) }],
    });
    const gone = db
      .prepare("SELECT deleted_rev FROM settings WHERE key = ?")
      .get(boardThemeSettingKey(boardId)) as
      { deleted_rev: number | null } | undefined;
    assert.ok(gone);
    assert.notEqual(gone.deleted_rev, null);
    assert.doesNotThrow(() =>
      applyCommands(db, registry, {
        actor,
        commands: [
          { op: "setting.delete", key: boardThemeSettingKey(boardId) },
        ],
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
