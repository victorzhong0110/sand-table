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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
