import {
  useState,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyEvent,
} from "react";
import { findObjectType } from "../core/domains.ts";
import type { Board } from "../core/model.ts";
import type { ComponentInstance, ThemeConfig } from "../core/spaces.ts";
import { componentTypes, defaultData } from "../core/spaces.ts";
import { peekContent, resolveContent } from "../core/content.ts";
import type { WorkspaceObject } from "../core/objects.ts";
import { Icon } from "./Icon.tsx";
import {
  clearDraft,
  editIntent,
  endEditSession,
  readDraft,
  writeDraft,
} from "./edit-session.ts";
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
          {selected.map((c) => {
            /* 标题同源（D4）：展示处一律从内容模型解析，不读实例自己的旧标题。
               绑定了内容对象的实例改名后，这里显示的是对象上的新标题；
               只读渲染用 peekContent，下面要改副本的编辑器用 resolveContent。 */
            const shown = peekContent(c, b.contentObjects);
            /* 绑定了内容对象的实例：内容在对象上，这张卡只是一次呈现。 */
            const bound = shown.objectId
              ? b.contentObjects.find((o) => o.id === shown.objectId)
              : undefined;
            return (
              <div key={c.id} className="report">
                <div className="report-head">
                  <b title={shown.title}>{shown.title}</b>
                  <div className="report-actions">
                    <button
                      className="icon-button"
                      title={`复制 ${shown.title}`}
                      aria-label="复制"
                      disabled={busy}
                      onClick={() =>
                        void operate({ kind: "duplicate", instanceId: c.id })
                      }
                    >
                      <Icon name="copy" size={15} />
                    </button>
                    <button
                      className="icon-button"
                      title={
                        c.rect.pinned
                          ? `取消固定 ${shown.title}`
                          : `固定位置 ${shown.title}`
                      }
                      aria-label={c.rect.pinned ? "取消固定" : "固定位置"}
                      aria-pressed={c.rect.pinned}
                      disabled={busy}
                      onClick={() =>
                        void operate({
                          kind: "place",
                          items: [
                            {
                              id: c.id,
                              rect: { ...c.rect, pinned: !c.rect.pinned },
                            },
                          ],
                        })
                      }
                    >
                      <Icon name="pin" size={15} />
                    </button>
                  </div>
                </div>
                <select
                  aria-label={`移动 ${shown.title} 到白板`}
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
                {bound && (
                  /* 这两件事不是一回事（D8）：
                     「再放一份」= 同一个对象在当前白板新增一次呈现（内容共享、布局独立）；
                     「复制出独立对象」= 内容深拷贝出一个新对象，此后互不影响。 */
                  <div className="report-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void operate({ kind: "present", objectId: bound.id })
                      }
                    >
                      再放一份
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void operate({ kind: "copyObject", instanceId: c.id })
                      }
                    >
                      复制出独立对象
                    </button>
                  </div>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void operate({ kind: "remove", instanceId: c.id })
                  }
                >
                  移除
                </button>
              </div>
            );
          })}
        </>
      )}
      {selected.length === 1 && (
        <ComponentEditor
          key={selected[0].id}
          instance={selected[0]}
          objects={b.contentObjects}
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
/**
 * 属性栏里的编辑器。
 *
 * 内容在对象上，展示只是它的一次呈现：标题与字段都从对象解析，
 * 写回也写进对象（同一个对象在别处的展示会同步更新）。
 *
 * 自动保存：停止输入约 600ms（或失焦）写一次。
 * - 一次编辑会话里的连续保存共用同一个 intentId，600ms 防抖不会把一次
 *   编辑拆成一堆历史步骤。
 * - 写回带 baseData（编辑器看到的那份基线）与 expectedVersion（对象版本）：
 *   服务端只应用真正改动的字段，并对「同一字段被别人改过」报冲突。
 * - 没写进去时草稿留着，失败说清楚是哪些字段，并提示重新载入。
 */
function ComponentEditor({
  instance: c,
  objects,
  busy,
  operate,
  action,
}: {
  instance: ComponentInstance;
  objects: WorkspaceObject[];
  busy: boolean;
  operate: (op: any) => Promise<any>;
  action: (name: string, args?: Record<string, unknown>) => Promise<any>;
}) {
  const content = resolveContent(c, objects);
  const bound = content.objectId
    ? objects.find((o) => o.id === content.objectId)
    : undefined;
  /* 服务端内容变了才有新基线：绑定对象看对象版本，没绑定看实例自身。 */
  const contentKey = bound ? `object:${bound.version}` : `local:${c.updatedAt}`;
  /* 切换组件再回来，上次没写进去的输入还在。 */
  const restored = useRef(readDraft(c.id)).current;
  const [title, setTitle] = useState(restored ? restored.title : content.title);
  const [data, setData] = useState<Record<string, any>>(() =>
    restored ? applyPaths(content.data, restored.edits) : content.data,
  );
  const [json, setJson] = useState(() =>
    JSON.stringify(
      restored ? applyPaths(content.data, restored.edits) : content.data,
      null,
      2,
    ),
  );
  const [error, setError] = useState("");
  const [failure, setFailure] = useState("");
  const [dirty, setDirty] = useState(
    restored
      ? Object.keys(restored.edits).length > 0 ||
          restored.title !== restored.startTitle
      : false,
  );
  const timer = useRef(0);
  /* 改过的字段：路径 → 新值。 */
  const edits = useRef<Record<string, unknown>>(
    restored ? { ...restored.edits } : {},
  );
  /* 改过的字段在被改之前的值：冲突判定拿它跟服务端的当前值比。 */
  const starts = useRef<Record<string, unknown>>(
    restored ? { ...restored.starts } : {},
  );
  const labels = useRef<Record<string, string>>({});
  const titleRef = useRef(title);
  const startTitle = useRef(restored ? restored.startTitle : content.title);
  /* 服务端当前的内容（基线）。 */
  const serverData = useRef<Record<string, any>>(content.data);
  const serverTitle = useRef(content.title);
  /* 本地草稿：服务端的内容叠上人的未提交改动。 */
  const draftData = useRef<Record<string, any>>(data);
  const jsonDirty = useRef(false);
  const version = useRef<number | undefined>(bound?.version);

  const refreshDirty = () =>
    setDirty(
      Object.keys(edits.current).length > 0 ||
        titleRef.current !== startTitle.current,
    );
  /** 把草稿留在组件之外：切换组件、关掉面板都不丢输入。 */
  const persist = () => {
    const paths = Object.keys(edits.current);
    if (!paths.length && titleRef.current === startTitle.current) {
      clearDraft(c.id);
      return;
    }
    writeDraft(c.id, {
      title: titleRef.current,
      startTitle: startTitle.current,
      edits: { ...edits.current },
      starts: { ...starts.current },
    });
  };
  /** 写回一次。成功返回 true；失败保留草稿并把原因说清楚。 */
  const commit = async (): Promise<boolean> => {
    /* 一次只写一笔：写的时候再来一次（失焦与自动保存撞在一起），
       记下来等这一笔写完再写。否则两笔会拿着同一个版本号，
       后一笔要么白写一次，要么跟内核撞版本。 */
    if (writing.current) {
      writeAgain.current = true;
      return true;
    }
    writing.current = true;
    try {
      return await writeOnce();
    } finally {
      writing.current = false;
      if (writeAgain.current) {
        writeAgain.current = false;
        void commit();
      }
    }
  };
  const writing = useRef(false);
  const writeAgain = useRef(false);
  const writeOnce = async (): Promise<boolean> => {
    clearTimeout(timer.current);
    const paths = Object.keys(edits.current);
    const titleChanged = titleRef.current !== startTitle.current;
    if (!paths.length && !titleChanged) return true;
    const op: any = {
      kind: "update",
      instanceId: c.id,
      /* 一次编辑会话里的连续保存共用同一个意图。 */
      intentId: editIntent(c.id),
    };
    if (titleChanged) {
      op.title = titleRef.current;
      /* 标题冲突也要能指出来：带上编辑器看到的旧标题。 */
      op.baseTitle = startTitle.current;
    }
    if (paths.length) {
      /* baseData 是编辑器看到的那份基线：服务端只应用真正改动的字段，
         并能判断「同一字段被别人改过」。 */
      op.baseData = applyPaths(serverData.current, starts.current);
      op.data = applyPaths(serverData.current, edits.current);
    }
    /* 绑定对象时带上当前版本：版本对不上就拒绝写入，不覆盖别人的改动。 */
    if (version.current !== undefined) op.expectedVersion = version.current;
    const result = await operate(op);
    if (result === undefined) {
      /* 没写进去：草稿留着，失败说清楚是哪些字段，并提示重新载入。 */
      const names = paths.map((p) => labels.current[p] || p);
      if (titleChanged) names.unshift("名称");
      setFailure(
        `${names.length ? `「${names.join("、")}」` : "这次改动"}没有保存成功：服务端拒绝了这次写入（原因见页面上方的提示）。草稿已保留，重新载入后可以再试一次。`,
      );
      refreshDirty();
      persist();
      return false;
    }
    for (const path of paths) {
      delete edits.current[path];
      delete starts.current[path];
      delete labels.current[path];
    }
    if (titleChanged) startTitle.current = titleRef.current;
    /* 服务端把对象版本加了一：下一次保存要用新版本。 */
    if (version.current !== undefined) version.current += 1;
    setFailure("");
    refreshDirty();
    persist();
    return true;
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void commit(), 600);
  };
  /** 改一个字段：记下新值与它被改之前的值（冲突判定要用）。 */
  const touch = (path: string, label: string, value: unknown) => {
    const start = getPath(serverData.current, path);
    edits.current[path] = value;
    labels.current[path] = label;
    if (!(path in starts.current)) starts.current[path] = start;
    if (sameValue(value, start)) {
      /* 改回原样：这一项没有改动，不写回。 */
      delete edits.current[path];
      delete starts.current[path];
      delete labels.current[path];
    }
    const next = applyPaths(draftData.current, { [path]: value });
    draftData.current = next;
    setData(next);
    refreshDirty();
    schedule();
    persist();
  };
  /** 改标题：标题不属于 data，单独记。 */
  const touchTitle = (value: string) => {
    titleRef.current = value;
    setTitle(value);
    refreshDirty();
    schedule();
    persist();
  };
  /** Esc：这一项回到服务端的值，并结束这次编辑会话。 */
  const revert = (path: string) => {
    delete edits.current[path];
    delete starts.current[path];
    delete labels.current[path];
    if (path === "title") {
      titleRef.current = serverTitle.current;
      startTitle.current = serverTitle.current;
      setTitle(serverTitle.current);
    } else {
      const next = applyPaths(draftData.current, {
        [path]: getPath(serverData.current, path),
      });
      draftData.current = next;
      setData(next);
    }
    endEditSession(c.id);
    refreshDirty();
    persist();
  };
  /** 重新载入：草稿留着，改动叠在服务端最新值之上，基线换成最新值。 */
  const reload = async () => {
    const fresh = (await action("sand_read_board")) as Board | undefined;
    const latest = fresh?.contentObjects;
    if (!latest) return;
    const resolved = resolveContent(c, latest);
    const nextStarts: Record<string, unknown> = {};
    for (const path of Object.keys(edits.current))
      nextStarts[path] = getPath(resolved.data, path);
    starts.current = nextStarts;
    if (titleRef.current !== startTitle.current)
      startTitle.current = resolved.title;
    const next = applyPaths(resolved.data, edits.current);
    draftData.current = next;
    setData(next);
    if (!jsonDirty.current) setJson(JSON.stringify(next, null, 2));
    setFailure("");
    persist();
  };
  /* 离开一个字段不是编辑会话的结束：改动写回去，但意图不变，
     一次连续编辑仍然只是一步。 */
  const leave = () => void commit();
  const onKey = (path: string) => (e: ReactKeyEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      revert(path);
      (e.target as HTMLElement).blur();
    }
  };

  /* 服务端内容变了：以它为新基线，人的未提交改动叠在上面。
     没被改过的字段跟着服务端走（别人的并发修改不会被旧草稿覆盖），
     改过的字段保留草稿值与它的起始值（冲突判定要用）。 */
  useEffect(() => {
    const server = content.data;
    serverData.current = server;
    serverTitle.current = content.title;
    if (
      bound &&
      (version.current === undefined || bound.version > version.current)
    )
      version.current = bound.version;
    const next = applyPaths(server, edits.current);
    draftData.current = next;
    setData(next);
    if (!jsonDirty.current) setJson(JSON.stringify(next, null, 2));
    if (titleRef.current === startTitle.current) {
      /* 标题没被改：基线跟着服务端走（别人的改名不算我改的）。 */
      titleRef.current = content.title;
      startTitle.current = content.title;
      setTitle(content.title);
    }
  }, [contentKey]);
  useEffect(() => () => clearTimeout(timer.current), []);
  /* 离开这个组件就是一次编辑会话的结束：下一次编辑是新的意图、新的步骤。 */
  useEffect(() => () => endEditSession(c.id), [c.id]);
  /* 上次没写进去的改动：回到这个组件就补一次自动保存。 */
  useEffect(() => {
    if (!restored) return;
    if (
      Object.keys(edits.current).length ||
      titleRef.current !== startTitle.current
    )
      schedule();
  }, []);

  const field = (key: string, label: string, multiline = false) => (
    <label key={key}>
      {label}
      {multiline ? (
        <textarea
          value={String(data[key] ?? "")}
          onChange={(e) => touch(key, label, e.target.value)}
          onBlur={leave}
          onKeyDown={onKey(key)}
        />
      ) : (
        <input
          value={String(data[key] ?? "")}
          onChange={(e) => touch(key, label, e.target.value)}
          onBlur={leave}
          onKeyDown={onKey(key)}
        />
      )}
    </label>
  );
  return (
    <section className="component-editor">
      <h3>配置</h3>
      <label>
        名称
        <input
          aria-label="编辑组件名称"
          value={title}
          onChange={(e) => touchTitle(e.target.value)}
          onBlur={leave}
          onKeyDown={onKey("title")}
        />
      </label>
      {findObjectType(c.type)?.fields?.map((spec) => {
        if (spec.key === "citation")
          return data.citation ? (
            <p key={spec.key}>
              {data.citation.uri} · {data.citation.fragment} ·{" "}
              {data.citation.status}
            </p>
          ) : null;
        if (spec.kind === "boolean")
          return (
            <label key={spec.key}>
              {spec.label}
              <input
                type="checkbox"
                checked={Boolean(data[spec.key])}
                onChange={(e) => {
                  touch(spec.key, spec.label, e.target.checked);
                  leave();
                }}
              />
            </label>
          );
        if (spec.kind === "number")
          return (
            <label key={spec.key}>
              {spec.label}
              <input
                type="number"
                value={data[spec.key] ?? ""}
                onChange={(e) =>
                  touch(
                    spec.key,
                    spec.label,
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
                onBlur={leave}
              />
            </label>
          );
        if (spec.kind === "list")
          return (
            <label key={spec.key}>
              {spec.label}
              <textarea
                value={(data[spec.key] ?? []).join("\n")}
                onChange={(e) =>
                  touch(spec.key, spec.label, e.target.value.split("\n"))
                }
                onBlur={leave}
              />
            </label>
          );
        return field(spec.key, spec.label, spec.kind === "longtext");
      })}
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
                  touch("assetId", "附加图片／音视频", asset.id);
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
              onChange={(e) => {
                touch("state", "状态", e.target.value);
                touch("observedAt", "观测时间", Date.now());
              }}
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
                touch(
                  "items",
                  "清单",
                  e.target.value
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => ({
                      text: line.replace(/^\[x\]\s*/, ""),
                      done: line.startsWith("[x]"),
                    })),
                )
              }
              onBlur={leave}
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
              onChange={(e) => touch("kind", "图表形式", e.target.value)}
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
                touch("points", "数据", points);
                leave();
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
                  touch(`${key}.title`, `方案 ${i + 1} 名称`, e.target.value)
                }
                onBlur={leave}
                onKeyDown={onKey(`${key}.title`)}
              />
              <textarea
                value={data[key]?.text || ""}
                onChange={(e) =>
                  touch(`${key}.text`, `方案 ${i + 1} 内容`, e.target.value)
                }
                onBlur={leave}
                onKeyDown={onKey(`${key}.text`)}
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
                touch("columns", "列名", e.target.value.split(","))
              }
            />
          </label>
          <label>
            数据（每行一条，用逗号分列）
            <textarea
              defaultValue={(data.rows || [])
                .map((row: any[]) => row.join(","))
                .join("\n")}
              onBlur={(e) => {
                const rows = e.target.value
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => line.split(","));
                touch("rows", "数据", rows);
                leave();
              }}
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
              touch(
                "events",
                "事件",
                e.target.value
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => {
                    const [at, label, ...detail] = line
                      .split("|")
                      .map((v) => v.trim());
                    return { at, label, detail: detail.join(" | ") };
                  }),
              )
            }
            onBlur={leave}
          />
        </label>
      )}
      {!["object", "board"].includes(c.type) && (
        <details>
          <summary>高级</summary>
          <textarea
            aria-label="组件高级配置"
            value={json}
            onChange={(e) => {
              jsonDirty.current = true;
              setJson(e.target.value);
            }}
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
                /* 整份替换：逐字段标出与基线的差异，交给服务端按字段合并。 */
                const server = serverData.current;
                const nextEdits: Record<string, unknown> = {};
                const nextStarts: Record<string, unknown> = {};
                for (const key of Array.from(
                  new Set([...Object.keys(server), ...Object.keys(parsed)]),
                )) {
                  if (!sameValue(parsed[key], server[key])) {
                    nextEdits[key] = parsed[key];
                    nextStarts[key] = server[key];
                  }
                }
                edits.current = nextEdits;
                starts.current = nextStarts;
                const next = applyPaths(server, nextEdits);
                draftData.current = next;
                setData(next);
                setJson(JSON.stringify(next, null, 2));
                jsonDirty.current = false;
                setError("");
                void commit();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            应用高级配置
          </button>
        </details>
      )}
      {(error || failure) && (
        <div className="edit-failure" role="alert">
          <p>{error || failure}</p>
          {failure && (
            <button disabled={busy} onClick={() => void reload()}>
              重新载入并保留草稿
            </button>
          )}
        </div>
      )}
      {dirty && !error && !failure && (
        <p className="edit-status">
          有未保存的改动：停止输入约 0.6
          秒后自动写入，也可以点「保存组件」立即写入。
        </p>
      )}
      <button
        disabled={busy}
        onClick={() =>
          void commit().then((ok) => {
            /* 显式保存是一次编辑会话的结束：下一次编辑是新的历史步骤。 */
            if (ok) endEditSession(c.id);
          })
        }
      >
        保存组件
      </button>
    </section>
  );
}
/** Read one value out of a dotted path. */
function getPath(target: Record<string, any>, path: string): unknown {
  let node: any = target;
  for (const key of path.split(".")) {
    if (node === null || node === undefined || typeof node !== "object")
      return undefined;
    node = node[key];
  }
  return node;
}
/** Copy the path's ancestors and write the value: the input is not modified. */
function withPath(
  target: Record<string, any>,
  path: string,
  value: unknown,
): Record<string, any> {
  const parts = path.split(".");
  const root: Record<string, any> = { ...target };
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const child = node[key];
    node[key] =
      child && typeof child === "object"
        ? Array.isArray(child)
          ? [...child]
          : { ...child }
        : {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
  return root;
}
/** Apply a set of path → value patches onto a copy of the data. */
function applyPaths(
  target: Record<string, any>,
  patches: Record<string, unknown>,
): Record<string, any> {
  let next = { ...target };
  for (const [path, value] of Object.entries(patches))
    next = withPath(next, path, value);
  return next;
}
/** Deep equality for the values inside a component's data. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
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
