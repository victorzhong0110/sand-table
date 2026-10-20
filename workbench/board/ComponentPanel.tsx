import { useState, useEffect } from "react";
import type { Board } from "../core/model.ts";
import type { ComponentInstance, ThemeConfig } from "../core/spaces.ts";
import { componentTypes, defaultData } from "../core/spaces.ts";
export function ComponentPanel({
  board: b,
  viewId,
  busy,
  operate,
  action,
  selectNew,
  detailsOnly = false,
}: {
  board: Board;
  detailsOnly?: boolean;
  viewId: string;
  busy: boolean;
  operate: (op: any) => Promise<any>;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
  selectNew: () => void;
}) {
  const [type, setType] = useState("text"),
    [title, setTitle] = useState(""),
    [group, setGroup] = useState(""),
    [relation, setRelation] = useState("related"),
    [relationText, setRelationText] = useState("");
  const view = b.views[viewId],
    selected = b.instances.filter((c) => view?.selection.includes(c.id));
  async function create(t = type, label = title) {
    await operate({
      kind: "create",
      type: t,
      title: label || componentTypes.find((c) => c.type === t)?.title || t,
      data: defaultData(t),
    });
    setTitle("");
    selectNew();
  }
  return (
    <section>
      {!detailsOnly && (
        <>
          <span className="eyebrow">COMPOSE YOUR SPACE</span>
          <h2>组件与编排</h2>
          <label>
            组件类型
            <select
              aria-label="组件类型"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {componentTypes
                .filter((t) => !["object", "space-link"].includes(t.type))
                .map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            组件名称
            <input
              aria-label="组件名称"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <button disabled={busy || !view} onClick={() => void create()}>
            添加组件
          </button>
          <h3>场景入口</h3>
          <button
            disabled={busy}
            onClick={() =>
              void operate({
                kind: "create",
                type: "board",
                title: "Bug 修复工作区",
                data: { preset: "bug" },
              }).then(selectNew)
            }
          >
            添加 Bug 修复白板
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void operate({
                kind: "create",
                type: "board",
                title: "研究比较白板",
                data: { preset: "research" },
              }).then(selectNew)
            }
          >
            添加研究比较白板
          </button>
        </>
      )}
      {selected.length > 0 && (
        <>
          <h3>选中组件</h3>
          {selected.map((c) => (
            <div key={c.id} className="report">
              <b>{c.title}</b>
              <button
                disabled={busy}
                onClick={() =>
                  void operate({ kind: "duplicate", instanceId: c.id })
                }
              >
                复制
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void operate({
                    kind: "place",
                    items: [
                      { id: c.id, rect: { ...c.rect, pinned: !c.rect.pinned } },
                    ],
                  })
                }
              >
                {c.rect.pinned ? "取消固定" : "固定位置"}
              </button>
              <select
                aria-label={`移动 ${c.title} 到白板`}
                value={c.spaceId}
                onChange={(e) =>
                  void operate({
                    kind: "move",
                    instanceId: c.id,
                    spaceId: e.target.value,
                  })
                }
              >
                {b.spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <button
                disabled={busy}
                onClick={() =>
                  void operate({ kind: "remove", instanceId: c.id })
                }
              >
                移除
              </button>
            </div>
          ))}
        </>
      )}
      {selected.length === 1 && (
        <ComponentEditor
          key={selected[0].id}
          instance={selected[0]}
          busy={busy}
          operate={operate}
          action={action}
        />
      )}
      {selected.length >= 2 && (
        <>
          <h3>阅读分组与关系</h3>
          <input
            aria-label="分组名称"
            placeholder="这组对象表达什么？"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
          <button
            disabled={busy || !group.trim()}
            onClick={() =>
              void operate({
                kind: "group",
                ids: selected.map((c) => c.id),
                title: group,
              }).then(() => setGroup(""))
            }
          >
            将选区分组
          </button>
          <select
            aria-label="关系类型"
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          >
            <option value="related">相关</option>
            <option value="depends-on">依赖</option>
            <option value="belongs-to">从属</option>
            <option value="compares">比较</option>
            <option value="supports">支持／证据</option>
          </select>
          <input
            aria-label="关系说明"
            value={relationText}
            onChange={(e) => setRelationText(e.target.value)}
            placeholder="说明前两个选中组件的关系"
          />
          <button
            disabled={busy}
            onClick={() =>
              void operate({
                kind: "link",
                source: selected[0].id,
                target: selected[1].id,
                relation,
                description: relationText,
              })
            }
          >
            连接前两个组件
          </button>
        </>
      )}
      {b.spaceLinks
        .filter((l) =>
          selected.some((c) => c.id === l.source || c.id === l.target),
        )
        .map((l) => (
          <p key={l.id}>
            {l.description || l.kind}
            <button
              onClick={() => void operate({ kind: "unlink", linkId: l.id })}
            >
              移除关系
            </button>
          </p>
        ))}
    </section>
  );
}
function ComponentEditor({
  instance: c,
  busy,
  operate,
  action,
}: {
  instance: ComponentInstance;
  busy: boolean;
  operate: (op: any) => Promise<any>;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
}) {
  const [title, setTitle] = useState(c.title),
    [data, setData] = useState<Record<string, any>>(c.data),
    [json, setJson] = useState(JSON.stringify(c.data, null, 2)),
    [error, setError] = useState("");
  useEffect(() => {
    setData(c.data);
    setJson(JSON.stringify(c.data, null, 2));
    setTitle(c.title);
  }, [c.updatedAt]);
  const field = (key: string, label: string, multiline = false) => (
    <label key={key}>
      {label}
      {multiline ? (
        <textarea
          value={String(data[key] ?? "")}
          onChange={(e) => setData({ ...data, [key]: e.target.value })}
        />
      ) : (
        <input
          value={String(data[key] ?? "")}
          onChange={(e) => setData({ ...data, [key]: e.target.value })}
        />
      )}
    </label>
  );
  const save = () => operate({ kind: "update", instanceId: c.id, title, data });
  return (
    <section className="component-editor">
      <h3>配置</h3>
      <label>
        名称
        <input
          aria-label="编辑组件名称"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {["text", "heading", "code"].includes(c.type) &&
        field("text", c.type === "code" ? "代码" : "内容", true)}
      {c.type === "code" && field("language", "语言")}
      {c.type === "resource" && (
        <>
          {field("url", "外部资源链接")}
          {field("description", "说明", true)}
          <label>
            附加图片／音视频
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/ogg,video/mp4,video/webm"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 2000000) {
                  setError("附件上限为 2 MB。");
                  return;
                }
                const encoded = await new Promise<string>((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result).split(",")[1]);
                  r.onerror = reject;
                  r.readAsDataURL(file);
                });
                const asset = await action("sand_attach_asset", {
                  name: file.name,
                  mime: file.type,
                  base64: encoded,
                });
                if (asset) {
                  await action("sand_read_board");
                  setData({ ...data, assetId: asset.id });
                  await operate({
                    kind: "update",
                    instanceId: c.id,
                    data: { ...data, assetId: asset.id },
                  });
                }
              }}
            />
          </label>
        </>
      )}
      {c.type === "metric" && (
        <>
          {field("value", "数值")}
          {field("unit", "单位")}
          {field("description", "说明")}
        </>
      )}
      {c.type === "status" && (
        <>
          <label>
            状态
            <select
              value={data.state || "unknown"}
              onChange={(e) =>
                setData({
                  ...data,
                  state: e.target.value,
                  observedAt: Date.now(),
                })
              }
            >
              <option value="unknown">未知</option>
              <option value="operational">可用</option>
              <option value="degraded">降级</option>
              <option value="down">不可用</option>
            </select>
          </label>
          {field("description", "状态说明")}
          {field("sourceUrl", "来源链接")}
        </>
      )}
      {c.type === "task" && (
        <>
          {field("goal", "任务目标", true)}
          <label>
            清单（每行一项，已完成项以 [x] 开头）
            <textarea
              value={(data.items || [])
                .map((i: any) => `${i.done ? "[x] " : ""}${i.text}`)
                .join("\n")}
              onChange={(e) =>
                setData({
                  ...data,
                  items: e.target.value
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => ({
                      text: line.replace(/^\[x\]\s*/, ""),
                      done: line.startsWith("[x]"),
                    })),
                })
              }
            />
          </label>
        </>
      )}
      {c.type === "chart" && (
        <>
          <label>
            图表形式
            <select
              value={data.kind || "bar"}
              onChange={(e) => setData({ ...data, kind: e.target.value })}
            >
              <option value="bar">柱状图</option>
              <option value="line">折线图</option>
            </select>
          </label>
          <label>
            数据（每行：名称,数值）
            <textarea
              defaultValue={(data.points || [])
                .map((p: any) => `${p.label},${p.value}`)
                .join("\n")}
              onBlur={(e) => {
                const points = e.target.value
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => {
                    const at = line.lastIndexOf(",");
                    return {
                      label: line.slice(0, at),
                      value: Number(line.slice(at + 1)),
                    };
                  });
                setData({ ...data, points });
              }}
            />
          </label>
        </>
      )}
      {c.type === "reasoning" && (
        <>
          {field("question", "问题", true)}
          {field("decision", "当前判断", true)}
          {field("unknowns", "仍不确定的事情", true)}
        </>
      )}
      {c.type === "comparison" && (
        <>
          {["left", "right"].map((key, i) => (
            <fieldset key={key}>
              <legend>方案 {i + 1}</legend>
              <input
                aria-label={`方案 ${i + 1} 名称`}
                value={data[key]?.title || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    [key]: { ...data[key], title: e.target.value },
                  })
                }
              />
              <textarea
                value={data[key]?.text || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    [key]: { ...data[key], text: e.target.value },
                  })
                }
              />
            </fieldset>
          ))}
          {field("conclusion", "比较结论", true)}
        </>
      )}
      {c.type === "table" && (
        <>
          <label>
            列名（用逗号分隔）
            <input
              value={(data.columns || []).join(",")}
              onChange={(e) =>
                setData({ ...data, columns: e.target.value.split(",") })
              }
            />
          </label>
          <label>
            数据（每行一条，用逗号分列）
            <textarea
              value={(data.rows || [])
                .map((row: any[]) => row.join(","))
                .join("\n")}
              onChange={(e) =>
                setData({
                  ...data,
                  rows: e.target.value
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => line.split(",")),
                })
              }
            />
          </label>
        </>
      )}
      {c.type === "events" && (
        <label>
          事件（每行：时间 | 事件 | 详情）
          <textarea
            value={(data.events || [])
              .map((v: any) => `${v.at} | ${v.label} | ${v.detail || ""}`)
              .join("\n")}
            onChange={(e) =>
              setData({
                ...data,
                events: e.target.value
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => {
                    const [at, label, ...detail] = line
                      .split("|")
                      .map((v) => v.trim());
                    return { at, label, detail: detail.join(" | ") };
                  }),
              })
            }
          />
        </label>
      )}
      {!["object", "board"].includes(c.type) && (
        <details>
          <summary>高级</summary>
          <textarea
            aria-label="组件高级配置"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <button
            onClick={() => {
              try {
                const parsed = JSON.parse(json);
                if (
                  !parsed ||
                  typeof parsed !== "object" ||
                  Array.isArray(parsed)
                )
                  throw Error("需要对象格式");
                setData(parsed);
                setError("");
                void operate({
                  kind: "update",
                  instanceId: c.id,
                  title,
                  data: parsed,
                });
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            应用高级配置
          </button>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() =>
          void (["object", "board"].includes(c.type)
            ? operate({ kind: "update", instanceId: c.id, title })
            : save())
        }
      >
        保存组件
      </button>
    </section>
  );
}
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
