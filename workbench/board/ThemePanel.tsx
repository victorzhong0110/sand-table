import { useState } from "react";
import type { Board } from "./data-client/model.ts";
import type { ThemeConfig } from "./data-client/spaces.ts";

const palettes = {
  paper: {
    background: "#f6f1e6",
    surface: "#fffdf7",
    ink: "#322f28",
    muted: "#777366",
    line: "#ddd5c4",
    accent: "#9b552f",
  },
  mono: {
    background: "#f5f5f5",
    surface: "#ffffff",
    ink: "#191919",
    muted: "#737373",
    line: "#d9d9d9",
    accent: "#222222",
  },
};
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/../g)!
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function ThemePanel({
  board,
  operate,
  onUseCustom,
}: {
  board: Board;
  operate: (op: any) => Promise<any>;
  onUseCustom: () => void;
}) {
  const [config, setConfig] = useState<ThemeConfig>(
    board.theme || {
      base: "paper",
      ...palettes.paper,
      font: "system",
      density: "comfortable",
      radius: 10,
      reduceMotion: false,
    },
  );
  return (
    <section>
      <h2>自定义</h2>
      {contrast(config.ink, config.surface) < 4.5 && (
        <p role="status">
          当前正文和组件背景接近，阅读可能吃力。建议提高对比度或恢复基础皮肤。
        </p>
      )}
      <label>
        基础皮肤
        <select
          value={config.base}
          onChange={(e) => {
            const base = e.target.value as "paper" | "mono";
            setConfig({ ...config, base, ...palettes[base] });
          }}
        >
          <option value="paper">温暖纸张</option>
          <option value="mono">黑白</option>
        </select>
      </label>
      {Object.entries({
        background: "背景",
        surface: "组件背景",
        ink: "正文",
        muted: "次要文字",
        line: "边框",
        accent: "强调色",
      }).map(([key, label]) => (
        <label className="theme-color" key={key}>
          {label}
          <input
            type="color"
            value={String(config[key as keyof ThemeConfig])}
            onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
          />
        </label>
      ))}
      <label>
        字体
        <select
          value={config.font}
          onChange={(e) =>
            setConfig({
              ...config,
              font: e.target.value as ThemeConfig["font"],
            })
          }
        >
          <option value="system">系统字体</option>
          <option value="serif">衬线字体</option>
          <option value="mono">等宽字体</option>
        </select>
      </label>
      <label>
        密度
        <select
          value={config.density}
          onChange={(e) =>
            setConfig({
              ...config,
              density: e.target.value as ThemeConfig["density"],
            })
          }
        >
          <option value="comfortable">舒适</option>
          <option value="compact">紧凑</option>
        </select>
      </label>
      <label>
        圆角
        <input
          type="range"
          min="0"
          max="24"
          value={config.radius}
          onChange={(e) =>
            setConfig({ ...config, radius: Number(e.target.value) })
          }
        />
      </label>
      <label className="file-choice">
        <input
          type="checkbox"
          checked={config.reduceMotion}
          onChange={(e) =>
            setConfig({ ...config, reduceMotion: e.target.checked })
          }
        />
        减少动效
      </label>
      <button
        onClick={async () => {
          if (await operate({ kind: "theme", theme: config })) onUseCustom();
        }}
      >
        应用自定义外观
      </button>
      <button onClick={() => void operate({ kind: "theme", theme: null })}>
        重置自定义外观
      </button>
    </section>
  );
}
