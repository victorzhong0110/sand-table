import { useEffect, useMemo, useRef, useState } from "react";
import { createThemeWriter } from "./persistence.ts";
import { presetOfBase, THEME_PRESETS } from "./presets.ts";
import {
  boardThemeSettingKey,
  contrastRatio,
  coerceTheme,
  themeOverrideDiff,
  THEME_SETTING_KEY,
  validateThemeImport,
  type Theme,
} from "./tokens.ts";

type CallFn = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function ThemeSettings({
  boardId,
  workspaceId,
  workspaceTheme,
  activeTheme,
  boardScope,
  call,
  onPreview,
}: {
  boardId: string;
  workspaceId?: string;
  workspaceTheme: Theme | null;
  activeTheme: Theme;
  /** 为 true 时编辑当前白板的覆盖主题。 */
  boardScope: boolean;
  call: CallFn;
  onPreview: (theme: Theme) => void;
}) {
  const workspace = useMemo(
    () => workspaceTheme ?? presetOfBase("paper"),
    [workspaceTheme],
  );
  const [draft, setDraft] = useState<Theme>(activeTheme);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [saveError, setSaveError] = useState("");
  const callRef = useRef(call);
  callRef.current = call;
  const writerRef = useRef<ReturnType<typeof createThemeWriter> | undefined>(
    undefined,
  );
  if (!writerRef.current) {
    writerRef.current = createThemeWriter(
      async (write) => {
        if (!write.workspaceId)
          throw Error("工作空间尚未准备好，请重新打开设置后再试。");
        await callRef.current("app_edit", {
          workspaceId: write.workspaceId,
          commands: write.commands,
        });
        setSaveError("");
      },
      (error) =>
        setSaveError(
          `外观未能保存：${error instanceof Error ? error.message : String(error)}。请重新调整后再试。`,
        ),
    );
  }
  const writer = writerRef.current;
  const scope = JSON.stringify([workspaceId, boardId, boardScope]);
  const previousScope = useRef(scope);
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;

  useEffect(
    () => () => writer.flush(),
    [writer, boardId, boardScope, workspaceId],
  );

  useEffect(() => {
    const scopeChanged = previousScope.current !== scope;
    previousScope.current = scope;
    if (!scopeChanged && writer.isBusy()) return;
    const next = boardScope ? activeTheme : workspace;
    setDraft(next);
    previewRef.current(next);
  }, [
    JSON.stringify(workspace),
    JSON.stringify(activeTheme),
    boardScope,
    boardId,
    workspaceId,
  ]);

  const inkContrast = contrastRatio(draft.colors.ink, draft.colors.surface);

  const persist = (next: Theme) => {
    const diff = boardScope ? themeOverrideDiff(workspace, next) : null;
    const key = boardScope ? boardThemeSettingKey(boardId) : THEME_SETTING_KEY;
    const commands =
      diff && !Object.keys(diff).length
        ? [{ op: "setting.delete", key }]
        : [{ op: "setting.set", key, value: diff ?? next }];
    writer.schedule({ workspaceId, commands });
  };

  const update = (patch: Partial<Theme>) => {
    const next = {
      ...draft,
      ...patch,
      colors: { ...draft.colors, ...(patch.colors ?? {}) },
      motion: { ...draft.motion, ...(patch.motion ?? {}) },
    };
    setDraft(next);
    onPreview(next);
    persist(next);
  };

  const setPreset = (base: "paper" | "mono") => {
    const next = { ...presetOfBase(base), name: THEME_PRESETS[base].name };
    setDraft(next);
    onPreview(next);
    persist(next);
  };

  const restoreDefault = () => {
    const next = presetOfBase(draft.base);
    setDraft(next);
    onPreview(next);
    persist(next);
  };

  const followWorkspace = async () => {
    const key = boardThemeSettingKey(boardId);
    setDraft(workspace);
    onPreview(workspace);
    try {
      await writer.writeNow({
        workspaceId,
        commands: [{ op: "setting.delete", key }],
      });
    } catch (error) {
      setSaveError(
        `外观未能保存：${error instanceof Error ? error.message : String(error)}。请重试。`,
      );
    }
  };

  const exportTheme = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${draft.name || "theme"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importTheme = async (file: File) => {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setImportErrors(["文件不是合法的 JSON。"]);
      return;
    }
    const checked = validateThemeImport(parsed);
    if (!checked.ok || !checked.theme) {
      setImportErrors(checked.errors);
      return;
    }
    setImportErrors([]);
    setDraft(checked.theme);
    onPreview(checked.theme);
    persist(checked.theme);
  };

  return (
    <section className="theme-settings" aria-label="外观设置">
      <h3>外观主题</h3>
      <div className="settings-presets appearance-controls">
        {(
          [
            ["paper", "暖纸"],
            ["mono", "黑白"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={draft.base === id}
            onClick={() => setPreset(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {boardScope && (
        <button type="button" onClick={() => void followWorkspace()}>
          跟随工作空间
        </button>
      )}
      <p className="settings-hint">
        {boardScope
          ? "只保存与本工作空间主题不同的项；进入这块白板时自动合并。"
          : "调整会立即预览；停止操作约半秒后写入，每一步可撤销。"}
      </p>
      {saveError && <p role="alert">{saveError}</p>}
      {inkContrast < 4.5 && (
        <p className="theme-contrast-warn" role="status">
          正文与组件背景的对比度约为 {inkContrast.toFixed(1)}:1，低于推荐的
          4.5:1。阅读可能吃力，建议调高对比度。
        </p>
      )}
      {(
        [
          ["background", "背景"],
          ["surface", "组件背景"],
          ["ink", "正文"],
          ["muted", "次要文字"],
          ["line", "边框"],
          ["accent", "强调色"],
        ] as const
      ).map(([key, label]) => (
        <label className="theme-color" key={key}>
          {label}
          <input
            type="color"
            value={draft.colors[key]}
            onChange={(e) =>
              update({ colors: { ...draft.colors, [key]: e.target.value } })
            }
          />
        </label>
      ))}
      <label>
        字体
        <select
          value={draft.font}
          onChange={(e) => update({ font: e.target.value as Theme["font"] })}
        >
          <option value="system">系统字体</option>
          <option value="serif">衬线字体</option>
          <option value="mono">等宽字体</option>
        </select>
      </label>
      <label>
        字号 {draft.fontSize}px
        <input
          type="range"
          min={12}
          max={20}
          value={draft.fontSize}
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
        />
      </label>
      <label>
        行距 {draft.lineHeight.toFixed(1)}
        <input
          type="range"
          min={1.3}
          max={2}
          step={0.1}
          value={draft.lineHeight}
          onChange={(e) => update({ lineHeight: Number(e.target.value) })}
        />
      </label>
      <label>
        密度
        <select
          value={draft.density}
          onChange={(e) =>
            update({ density: e.target.value as Theme["density"] })
          }
        >
          <option value="comfortable">舒适</option>
          <option value="compact">紧凑</option>
        </select>
      </label>
      <label>
        圆角 {draft.radius}px
        <input
          type="range"
          min={0}
          max={20}
          value={draft.radius}
          onChange={(e) => update({ radius: Number(e.target.value) })}
        />
      </label>
      <label>
        阴影
        <select
          value={draft.shadow}
          onChange={(e) =>
            update({ shadow: e.target.value as Theme["shadow"] })
          }
        >
          <option value="none">无</option>
          <option value="soft">柔和</option>
          <option value="strong">明显</option>
        </select>
      </label>
      <label>
        动效速度 {draft.motion.speed.toFixed(1)}×
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={draft.motion.speed}
          onChange={(e) =>
            update({
              motion: { ...draft.motion, speed: Number(e.target.value) },
            })
          }
        />
      </label>
      <label className="file-choice">
        <input
          type="checkbox"
          checked={draft.motion.reduce}
          onChange={(e) =>
            update({ motion: { ...draft.motion, reduce: e.target.checked } })
          }
        />
        减少动效
      </label>
      <div className="theme-io">
        <button type="button" onClick={exportTheme}>
          导出主题
        </button>
        <label className="file-choice">
          导入主题
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importTheme(file);
              e.target.value = "";
            }}
          />
        </label>
        <button type="button" onClick={restoreDefault}>
          恢复默认
        </button>
      </div>
      {importErrors.length > 0 && (
        <div className="theme-import-errors" role="alert">
          <p>无法导入主题：</p>
          <ul>
            {importErrors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function readWorkspaceTheme(value: unknown) {
  return coerceTheme(value);
}
