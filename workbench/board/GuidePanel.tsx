import { useState } from "react";
import type { Board, GuideFocus, Item } from "../core/model.ts";
type Props = {
  board: Board;
  busy: boolean;
  onFocus: (focus: GuideFocus | null) => void;
  onDocument: (object: Item) => void;
};
export function GuidePanel({ board, busy, onFocus, onDocument }: Props) {
  const [choice, setChoice] = useState("");
  const guide =
    board.guides.find((g) => g.id === (choice || board.guideFocus?.guideId)) ||
    board.guides[0];
  const docs = board.objects
    .filter(
      (o) =>
        o.kind === "file" &&
        /(^|\/)readme(?:\.[^/]*)?\.md$/i.test(o.source?.path || ""),
    )
    .sort(
      (a, b) =>
        (a.source!.path.includes("/") ? 1 : 0) -
        (b.source!.path.includes("/") ? 1 : 0),
    )
    .slice(0, 8);
  return (
    <section className="guide-panel" aria-label="功能讲解">
      <div className="guide-heading">
        <div>
          <span className="eyebrow">UNDERSTAND THE PROJECT</span>
          <h2>从一条功能路径开始</h2>
        </div>
        <div className="document-links">
          {docs.map((o) => (
            <button key={o.id} disabled={busy} onClick={() => onDocument(o)}>
              项目说明 ·{" "}
              {board.workspaces.find((w) => w.id === o.workspaceId)?.label}
              {o.source?.path !== "readme.md" && o.source?.path !== "README.md"
                ? ` / ${o.source?.path}`
                : ""}
            </button>
          ))}
        </div>
      </div>
      {!guide ? (
        <p className="guide-empty">
          先阅读项目说明，或在宿主对话中请 AI：
          <q>
            解释这个项目解决什么问题，选一条功能路径，说明输入输出，并把带源码依据的讲解放到白板。
          </q>
          <br />
          <small>
            当前还没有功能讲解。Agent 读取源码后可用 sand_publish_guide
            创建；这里不会自动生成未经核对的架构结论。
          </small>
        </p>
      ) : (
        <>
          <div className="guide-controls">
            <label>
              功能路径{" "}
              <select
                aria-label="功能路径"
                value={guide.id}
                onChange={(e) => setChoice(e.target.value)}
              >
                {board.guides.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                    {g.stale ? "（依据已过期）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <span className={guide.stale ? "guide-stale" : "muted"}>
              {guide.stale
                ? "源码已变化，请让 Agent 更新这份讲解"
                : "Agent 解读 · 引用有效不等于语义正确"}{" "}
              · {guide.agentId}
            </span>
          </div>
          <p className="guide-purpose">{guide.purpose}</p>
          <details className="guide-inputs">
            <summary>查看输入与输出</summary>
            <dl className="guide-io">
              <div>
                <dt>输入</dt>
                <dd>{guide.inputs}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{guide.outputs}</dd>
              </div>
            </dl>
          </details>
          <div className="guide-steps">
            {guide.steps.map((step, index) => {
              const active =
                board.guideFocus?.guideId === guide.id &&
                board.guideFocus.step === index;
              return (
                <button
                  key={index}
                  className={active ? "active" : ""}
                  aria-pressed={active}
                  disabled={busy || guide.stale}
                  onClick={() => onFocus({ guideId: guide.id, step: index })}
                >
                  <span>{index + 1}</span>
                  <b>{step.title}</b>
                  <small>{step.objectIds.length} 个对象</small>
                </button>
              );
            })}
          </div>
          {board.guideFocus?.guideId === guide.id && (
            <div className="guide-detail">
              <p>{guide.steps[board.guideFocus.step]?.explanation}</p>
              <p>
                <b>尚未确定：</b>
                {guide.steps[board.guideFocus.step]?.uncertainty}
              </p>
              <small>
                {guide.steps[board.guideFocus.step]?.evidence
                  .map(
                    (r) =>
                      `${board.workspaces.find((w) => w.id === r.workspaceId)?.label} / ${r.path}:${r.startLine}–${r.endLine}`,
                  )
                  .join(" · ")}
              </small>
              <button onClick={() => onFocus(null)}>退出步骤定位</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
