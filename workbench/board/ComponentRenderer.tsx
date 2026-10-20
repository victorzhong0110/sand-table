import { useEffect, useState } from "react";
import type { Board } from "../core/model.ts";
import type { ComponentInstance } from "../core/spaces.ts";
import { componentTypes, safeUrl } from "../core/spaces.ts";
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));
export function ComponentRenderer({
  instance: c,
  board,
  call,
  onNavigate,
  onOpenLink,
}: {
  instance: ComponentInstance;
  board: Board;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  onNavigate: (spaceId: string) => void;
  onOpenLink: (url: string) => void;
}) {
  const d = c.data;
  const object = board.objects.find((o) => o.id === c.objectId);
  const [asset, setAsset] = useState<any>();
  useEffect(() => {
    setAsset(undefined);
    if (c.type === "resource" && d.assetId)
      void call("sand_read_asset", { assetId: d.assetId })
        .then(setAsset)
        .catch(() => {});
  }, [d.assetId]);
  if (c.type === "object") {
    const a = board.activities.find((a) =>
      a.objectIds.includes(c.objectId || ""),
    );
    return (
      <>
        <span className="card-type">
          {object?.kind === "symbol" ? "代码入口" : "源码文件"} ·{" "}
          {board.workspaces.find((w) => w.id === object?.workspaceId)?.label ||
            "未知工作区"}
        </span>
        <strong>{c.title}</strong>
        <span className="path">
          {object?.source
            ? `${object.source.path}:${object.source.startLine}`
            : "来源已缺失；保留当前展示，不自动重定向"}
        </span>
        {a && (
          <span className={`activity ${a.stale ? "stale" : a.state}`}>
            ● {a.stale ? "最后已知" : a.state} · {a.action}
          </span>
        )}
      </>
    );
  }
  if (c.type === "board" || c.type === "space-link") {
    const space = board.spaces.find((s) => s.id === d.spaceId);
    return (
      <>
        <span className="card-type">
          {c.type === "board" ? "白板容器" : "白板入口"}
        </span>
        <strong>{c.title}</strong>
        <p>
          {space
            ? `${board.instances.filter((i) => i.spaceId === space.id).length} 个组件`
            : "目标白板已缺失"}
        </p>
        <button
          disabled={!space}
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(String(d.spaceId));
          }}
        >
          进入白板
        </button>
      </>
    );
  }
  const header = (
    <>
      <span className="card-type">
        {componentTypes.find((t) => t.type === c.type)?.title || "未知组件"}
      </span>
      {!componentTypes.some((t) => t.title === c.title) && (
        <strong>{c.title}</strong>
      )}
    </>
  );
  switch (c.type) {
    case "heading":
      return <h2 className="component-heading">{text(d.text) || c.title}</h2>;
    case "text":
      return (
        <>
          {header}
          <p className="component-text">
            {text(d.text) || "写点什么…"}
          </p>
        </>
      );
    case "code":
      return (
        <>
          {header}
          <small>{text(d.language)} · 展示片段</small>
          <pre>{text(d.text) || "尚未提供代码片段"}</pre>
        </>
      );
    case "resource": {
      const url = safeUrl(d.url);
      return (
        <>
          {header}
          <p>{text(d.description)}</p>
          {asset?.dataUrl &&
            (asset.mime.startsWith("image/") ? (
              <img src={asset.dataUrl} alt={asset.name} />
            ) : asset.mime.startsWith("audio/") ? (
              <audio controls src={asset.dataUrl} />
            ) : (
              <video controls src={asset.dataUrl} />
            ))}
          {d.assetId && !asset && <small>加载附件…</small>}
          {url ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenLink(url);
              }}
            >
              打开资源 ↗
            </button>
          ) : (
            !d.assetId && <small>尚未关联资源</small>
          )}
        </>
      );
    }
    case "metric":
      return (
        <>
          {header}
          <div className="metric-value">
            {text(d.value) || "—"} <small>{text(d.unit)}</small>
          </div>
          <small>{text(d.description)}</small>
        </>
      );
    case "status": {
      const states: Record<string, string> = {
        operational: "可用",
        degraded: "降级",
        down: "不可用",
        unknown: "未知",
      };
      const stale =
        typeof d.observedAt === "number" && Date.now() - d.observedAt > 300000;
      return (
        <>
          {header}
          <p className={`status-value status-${text(d.state)}`}>
            ● {stale ? "最后已知 · " : ""}
            {states[text(d.state)] || "未知"}
          </p>
          <small>
            {text(d.description)}
            <br />
            {typeof d.observedAt === "number"
              ? new Date(d.observedAt).toLocaleString()
              : "尚无观测时间"}{" "}
            · 来源：{c.author}
          </small>
          {safeUrl(d.sourceUrl) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenLink(safeUrl(d.sourceUrl)!);
              }}
            >
              查看状态来源 ↗
            </button>
          )}
        </>
      );
    }
    case "chart": {
      const points = Array.isArray(d.points)
        ? (d.points as { label: string; value: number }[])
        : [];
      const min = Math.min(0, ...points.map((p) => p.value)),
        max = Math.max(1, ...points.map((p) => p.value)),
        range = max - min;
      const y = (v: number) => 140 - ((v - min) / range) * 110;
      return (
        <>
          {header}
          {points.length ? (
            <svg
              className="component-chart"
              viewBox="0 0 320 180"
              role="img"
              aria-label={points.map((p) => `${p.label} ${p.value}`).join("，")}
            >
              <line
                x1="24"
                y1={y(0)}
                x2="310"
                y2={y(0)}
                stroke="currentColor"
                opacity=".3"
              />
              {d.kind === "line" ? (
                <polyline
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  points={points
                    .map(
                      (p, i) =>
                        `${36 + (i * 260) / Math.max(1, points.length - 1)},${y(p.value)}`,
                    )
                    .join(" ")}
                />
              ) : (
                points.map((p, i) => (
                  <rect
                    key={i}
                    x={30 + (i * 275) / points.length}
                    y={Math.min(y(p.value), y(0))}
                    width={Math.max(2, 230 / points.length)}
                    height={Math.max(1, Math.abs(y(p.value) - y(0)))}
                    fill="var(--accent)"
                  >
                    <title>
                      {p.label}: {p.value}
                    </title>
                  </rect>
                ))
              )}
              {points.length <= 10 &&
                points.map((p, i) => (
                  <g key={i}>
                    <text
                      x={
                        d.kind === "line"
                          ? 36 + (i * 260) / Math.max(1, points.length - 1)
                          : 40 + (i * 275) / points.length
                      }
                      y="165"
                      textAnchor="middle"
                    >
                      {p.label.slice(0, 10)}
                    </text>
                    <text
                      x={
                        d.kind === "line"
                          ? 36 + (i * 260) / Math.max(1, points.length - 1)
                          : 40 + (i * 275) / points.length
                      }
                      y={y(p.value) - 6}
                      textAnchor="middle"
                    >
                      {p.value}
                    </text>
                  </g>
                ))}
            </svg>
          ) : (
            <p className="muted">尚未提供数据</p>
          )}
          <small>来源：{c.author} · 当前提供的数据</small>
        </>
      );
    }
    case "table":
      return (
        <>
          {header}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {(Array.isArray(d.columns) ? d.columns : []).map((v, i) => (
                    <th key={i}>{text(v)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(d.rows) ? d.rows : []).map((row, i) => (
                  <tr key={i}>
                    {(Array.isArray(row) ? row : []).map((v, j) => (
                      <td key={j}>{text(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      );
    case "events":
      return (
        <>
          {header}
          <ol className="component-events">
            {(Array.isArray(d.events) ? d.events : []).map((e: any, i) => (
              <li key={i}>
                <small>{text(e.at)}</small> {text(e.label)}
                <p>{text(e.detail)}</p>
              </li>
            ))}
          </ol>
          <small>当前事件片段 · 不保存回放历史</small>
        </>
      );
    case "task":
      return (
        <>
          {header}
          <p>{text(d.goal)}</p>
          <ul className="component-tasks">
            {(Array.isArray(d.items) ? d.items : []).map((i: any, index) => (
              <li key={index}>
                {i.done ? "☑" : "☐"} {text(i.text)}
              </li>
            ))}
          </ul>
        </>
      );
    case "reasoning":
      return (
        <>
          {header}
          <p>{text(d.question)}</p>
          {Array.isArray(d.evidence) && (
            <ul>
              {d.evidence.map((e: any, i) => (
                <li key={i}>{typeof e === "string" ? e : text(e.text)}</li>
              ))}
            </ul>
          )}
          {d.decision && (
            <p>
              <b>当前判断：</b>
              {text(d.decision)}
            </p>
          )}
          {d.unknowns && <small>未知：{text(d.unknowns)}</small>}
        </>
      );
    case "comparison":
      return (
        <>
          {header}
          <div className="comparison-columns">
            {[d.left, d.right].map((v: any, i) => (
              <section key={i}>
                <b>{text(v?.title) || `方案 ${i + 1}`}</b>
                <p>{text(v?.text)}</p>
              </section>
            ))}
          </div>
          <small>{text(d.conclusion)}</small>
        </>
      );
    case "intent": {
      const i =
        board.intents.find((i) => i.id === d.intentId) || board.intents.at(-1);
      return (
        <>
          {header}
          <p>{i?.request || "尚未创建改动意图"}</p>
          <small>
            {i
              ? `${i.allowedFiles.length} 个允许修改的文件 · 意图版本 ${i.version}`
              : "在“改动”面板创建明确请求"}
          </small>
        </>
      );
    }
    case "proposal": {
      const p =
        board.proposals.find((p) => p.id === d.proposalId) ||
        board.proposals.at(-1);
      return (
        <>
          {header}
          <p>{p?.title || "等待 Agent 提交目标版本"}</p>
          <small>
            {p
              ? `修订 ${p.version} · ${p.decision} · 核对 ${p.verification?.state || "尚未核对"}`
              : "需要具体内容后才能确认"}
          </small>
        </>
      );
    }
    case "validation": {
      const r = board.validations
        .filter((r) => !d.proposalId || r.proposalId === d.proposalId)
        .at(-1);
      return (
        <>
          {header}
          <p>{r ? `${r.outcome} · ${r.command}` : "尚无验证报告"}</p>
          <small>
            {r
              ? `来源：Agent 自报 · ${r.environment}`
              : "未运行与未验证不会显示为通过"}
          </small>
        </>
      );
    }
    default:
      return (
        <>
          {header}
          <p>此版本不支持组件类型“{c.type}”；数据已保留。</p>
          <pre>{JSON.stringify(d, null, 2)}</pre>
        </>
      );
  }
}
