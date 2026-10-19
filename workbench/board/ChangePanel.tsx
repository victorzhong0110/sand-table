import { useState } from "react";
import type { Board } from "../core/model.ts";
import type { ChangeIntent, FileRef, Proposal } from "../core/changes.ts";
const decisions = {
  pending: "待确认",
  accepted: "已确认",
  rejected: "已拒绝",
  revise: "请求调整",
  stale: "已失效",
};
const results = {
  "not-applied": "尚未写入",
  partial: "部分写入",
  matches: "实际内容与提案一致",
  diverged: "实际差异偏离提案",
  incomplete: "范围核对不完整",
};
function FileDiff({
  before,
  after,
}: {
  before: string | null;
  after: string | null;
}) {
  const a = (before || "").split("\n"),
    b = (after || "").split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return (
    <>
      <div className="diff-lines">
        <small>
          {before === null
            ? "新文件"
            : after === null
              ? "删除文件"
              : `从第 ${prefix + 1} 行起的差异`}
        </small>
        {a.slice(Math.max(0, prefix - 2), prefix).map((line, i) => (
          <div key={"c" + i}> {line}</div>
        ))}
        {a.slice(prefix, a.length - suffix).map((line, i) => (
          <div className="removed" key={"a" + i}>
            − {line}
          </div>
        ))}
        {b.slice(prefix, b.length - suffix).map((line, i) => (
          <div className="added" key={"b" + i}>
            + {line}
          </div>
        ))}
        {b.slice(b.length - suffix, b.length - suffix + 2).map((line, i) => (
          <div key={"z" + i}> {line}</div>
        ))}
      </div>
      <details>
        <summary>查看完整原内容和目标内容</summary>
        <div className="diff-columns">
          <section>
            <b>原内容</b>
            <pre>{before ?? "（文件不存在）"}</pre>
          </section>
          <section>
            <b>目标内容</b>
            <pre>{after ?? "（删除文件）"}</pre>
          </section>
        </div>
      </details>
    </>
  );
}
export function ChangePanel({
  board: b,
  viewId,
  busy,
  action,
}: {
  board: Board;
  viewId: string;
  busy: boolean;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
}) {
  const [request, setRequest] = useState(""),
    [editing, setEditing] = useState<ChangeIntent>(),
    [extras, setExtras] = useState<FileRef[]>([]),
    [excluded, setExcluded] = useState<string[]>([]),
    [workspace, setWorkspace] = useState(b.workspaces[0]?.id || ""),
    [path, setPath] = useState("");
  const objectIds = b.instances
    .filter((c) => b.views[viewId]?.selection.includes(c.id) && c.objectId)
    .map((c) => c.objectId!);
  const selected = b.objects
    .filter((o) => objectIds.includes(o.id) && o.source)
    .map((o) => ({ workspaceId: o.workspaceId, path: o.source!.path }));
  const refs = [
    ...new Map(
      [...(editing ? editing.allowedFiles : selected), ...extras].map((r) => [
        `${r.workspaceId}:${r.path}`,
        r,
      ]),
    ).values(),
  ];
  const allowed = refs.filter(
    (r) => !excluded.includes(`${r.workspaceId}:${r.path}`),
  );
  const revise = (intent: ChangeIntent) => {
    setEditing(intent);
    setRequest(intent.request);
    setExtras([]);
    setExcluded([]);
  };
  return (
    <section className="change-panel">
      <span className="eyebrow">INTENT → PROPOSAL → VERIFY</span>
      <h2>把改动说清楚</h2>
      <p className="muted">
        选区和整理表示关注。提交下面的请求，才会明确你希望改变什么、允许涉及哪些文件。
      </p>
      <label>
        你想改变什么
        <textarea
          aria-label="改动请求"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="现在发生什么？期望变成什么？哪些行为应保持？"
          maxLength={4000}
        />
      </label>
      <fieldset>
        <legend>允许修改的文件</legend>
        {refs.map((r) => {
          const k = `${r.workspaceId}:${r.path}`;
          return (
            <label className="file-choice" key={k}>
              <input
                type="checkbox"
                checked={!excluded.includes(k)}
                onChange={(e) =>
                  setExcluded(
                    e.target.checked
                      ? excluded.filter((v) => v !== k)
                      : [...excluded, k],
                  )
                }
              />
              {b.workspaces.find((w) => w.id === r.workspaceId)?.label} /{" "}
              {r.path}
            </label>
          );
        })}
        {!refs.length && <p>先选择源码对象，或明确加入一个文件路径。</p>}
        <select
          aria-label="额外文件工作区"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {b.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        <input
          aria-label="额外文件路径"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="相对路径，如 tests/example.test.ts"
        />
        <button
          disabled={!path.trim()}
          onClick={() => {
            setExtras([
              ...extras,
              { workspaceId: workspace, path: path.trim() },
            ]);
            setPath("");
          }}
        >
          加入文件范围
        </button>
      </fieldset>
      <button
        disabled={busy || !request.trim() || !allowed.length}
        onClick={async () => {
          const result = await action("sand_create_intent", {
            revision: b.revision,
            request,
            objectIds,
            viewId,
            allowedFiles: allowed,
            intentId: editing?.id,
          });
          if (result) {
            setRequest("");
            setEditing(undefined);
            setExtras([]);
            setExcluded([]);
          }
        }}
      >
        {editing ? "更新这个请求" : "提交改动意图"}
      </button>
      {editing && (
        <button
          onClick={() => {
            setEditing(undefined);
            setRequest("");
            setExtras([]);
            setExcluded([]);
          }}
        >
          改为新请求
        </button>
      )}
      <h3>已表达的意图</h3>
      {b.intents.map((i) => (
        <div className="report" key={i.id}>
          <b>请求版本 {i.version}</b>
          <p>{i.request}</p>
          <small>
            {i.allowedFiles.length} 个允许涉及的文件 · 包含当时的编排和备注
          </small>
          <button onClick={() => revise(i)}>修改这个请求</button>
        </div>
      ))}
      <h3>具体目标版本</h3>
      {!b.proposals.length && (
        <p className="muted">
          等待你的 Agent
          读取意图、核对源码并提交具体修改。方案方向和具体内容的确认是两个动作。
        </p>
      )}
      {[...b.proposals].reverse().map((p) => (
        <ProposalCard
          key={`${p.id}:${p.version}`}
          proposal={p}
          board={b}
          busy={busy}
          action={action}
        />
      ))}
    </section>
  );
}
function ProposalCard({
  proposal: p,
  board: b,
  busy,
  action,
}: {
  proposal: Proposal;
  board: Board;
  busy: boolean;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
}) {
  const decide = (decision: string) =>
    action("sand_decide_proposal", {
      proposalId: p.id,
      version: p.version,
      digest: p.digest,
      decision,
    });
  const reports = b.validations.filter((r) => r.proposalId === p.id);
  return (
    <article className="proposal-card">
      <h3>{p.title}</h3>
      <p>
        <b>{decisions[p.decision]}</b> · 修订 {p.version} · {p.files.length}{" "}
        个文件
      </p>
      <p className="preserve-lines">{p.explanation}</p>
      <details>
        <summary>查看这版的具体差异</summary>
        {p.files.map((f) => (
          <section key={`${f.workspaceId}:${f.path}`} className="proposal-file">
            <h4>
              {b.workspaces.find((w) => w.id === f.workspaceId)?.label} /{" "}
              {f.path}
            </h4>
            <FileDiff before={f.before} after={f.after} />
          </section>
        ))}
        <small>内容指纹：{p.digest}</small>
      </details>
      <p>
        <b>计划如何验证：</b>
        {p.testPlan}
      </p>
      {p.baseline.some((s) => s.omitted.length > 0) && (
        <p className="notice">
          部分工作区文件无法纳入范围核对，最终结果会保留这一限制。
        </p>
      )}
      <div className="proposal-actions">
        <button
          disabled={busy || p.decision === "stale" || p.decision === "accepted"}
          onClick={() => void decide("accepted")}
        >
          确认这一版
        </button>
        <button disabled={busy} onClick={() => void decide("revise")}>
          需要调整
        </button>
        <button disabled={busy} onClick={() => void decide("rejected")}>
          拒绝这一版
        </button>
      </div>
      {p.decision === "accepted" && (
        <p className="muted">
          已确认这份具体内容。Agent
          仍需核对前置条件并使用宿主工具写入；确认按钮本身不写文件。回到 AI
          对话说“继续处理白板中已确认的提案，并核对实际结果”。
        </p>
      )}
      <button
        disabled={busy}
        onClick={() =>
          void action("sand_verify_proposal", { proposalId: p.id }).then(() =>
            action("sand_read_board"),
          )
        }
      >
        核对实际结果
      </button>
      {p.verification && (
        <div className={`verification verification-${p.verification.state}`}>
          <b>{results[p.verification.state]}</b>
          <small>
            上次核对：{new Date(p.verification.at).toLocaleString()}
          </small>
          {p.verification.files.map((f) => (
            <p key={`${f.workspaceId}:${f.path}`}>
              {f.path}：
              {
                {
                  before: "仍是原内容",
                  after: "与目标内容一致",
                  unexpected: "出现其他内容或无法读取",
                }[f.state]
              }
            </p>
          ))}
          {p.verification.outsideChanges.length > 0 && (
            <details>
              <summary>
                发现 {p.verification.outsideChanges.length} 处范围外变化
              </summary>
              {p.verification.outsideChanges.map((f, i) => (
                <p key={i}>
                  {b.workspaces.find((w) => w.id === f.workspaceId)?.label} /{" "}
                  {f.path}
                </p>
              ))}
            </details>
          )}
          {p.verification.omitted.length > 0 && (
            <small>
              {p.verification.omitted.length} 个观察缺口；不会当作完整核对通过
            </small>
          )}
        </div>
      )}
      {reports.map((r) => (
        <div className="report" key={r.id}>
          <b>
            {r.outcome === "passed"
              ? "测试报告：通过"
              : r.outcome === "failed"
                ? "测试报告：失败"
                : "测试尚未运行"}
          </b>
          <p>{r.command}</p>
          <small>
            {r.environment} · 来源：Agent 自报
            <br />
            {p.verification?.fingerprint === r.fingerprint
              ? "内容指纹与上次核对一致"
              : "工作区依据已变化，请重新验证"}
          </small>
          <details>
            <summary>查看报告输出</summary>
            <pre>{r.output}</pre>
          </details>
        </div>
      ))}
      <p className="fine-print">
        核对与宿主实际写入之间可能有并发变化。是否强制执行确认约束，取决于你的客户端；板子会如实展示可核对的结果。
      </p>
    </article>
  );
}
