import { blocksCanvasShortcut } from "./keyboard.ts";
import "./domain-ui.ts";
import { CanvasShell } from "./CanvasShell.tsx";
import type { WorkspaceImportReport } from "./WorkspacePanel.tsx";
import React, { useState, useEffect, useRef, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { Board, Item, GuideFocus } from "./data-client/model.ts";
import "./style.css";
import { FlowCanvas } from "./canvas/FlowCanvas.tsx";
import { ChangePanel } from "./ChangePanel.tsx";
import { ThemePanel } from "./ThemePanel.tsx";
import { Inspector } from "./views/Inspector.tsx";
import { safeUrl } from "./data-client/spaces.ts";
import { resultData } from "./data-client/results.ts";
import { GuidePanel } from "./GuidePanel.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import type { HistorySnapshot } from "./data-client/history.ts";
import {
  canShowTaskEntry,
  resolveBridge,
  mapHostResult,
} from "../core/host-bridge.ts";
import { installHostBridgeClient } from "./host-bridge-client.ts";
import { translateLegacyTool } from "./data-client/legacy-calls.ts";
import { V3Store } from "./data-client/store.ts";
import {
  toBoard,
  toCommands,
  toReportedActivities,
  v3RetryInfo,
  type V3View,
} from "./data-client/adapter.ts";
import type {
  HostTaskEvent,
  WorkspaceDescriptor,
} from "./data-client/objects.ts";
const relationLabels = {
  contains: "包含",
  imports: "导入",
  "syntactic-call": "可能调用（语法推断）",
};
/** v3 的核心工具：界面这一层按原名调用它们。 */
const V3_CORE_TOOLS = new Set([
  "sand_status",
  "sand_types",
  "sand_query",
  "sand_read",
  "sand_edit",
  "sand_history",
  "sand_context",
  "sand_activity",
]);
function unpack(r: any) {
  if (r.isError) throw Error(r.content?.[0]?.text || "Request failed");
  return resultData(r) ?? JSON.parse(r.content[0].text);
}
function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message)
      return parsed.message;
  } catch {
    /* 工具失败时文本是 JSON；别的错误保持原样。 */
  }
  return raw;
}
const SANDBOX_VIEW_ID = "local-human";

function storedViewId() {
  /* 沙箱 iframe 没有同源权限，sessionStorage 随页面一起丢掉。
     同一份工作空间用固定视角编号，重新打开才能读回白板和镜头。 */
  if (window.origin === "null") return SANDBOX_VIEW_ID;
  const key = "sand-table-view";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return SANDBOX_VIEW_ID;
  }
}

function Workbench() {
  /* 同一浏览器会话复用视角编号。沙箱里没有可持久的 sessionStorage，用固定编号。 */
  const [viewId] = useState(storedViewId);
  const [tab, setTab] = useState("inspect");
  const [, hostChanged] = useState(0);
  const [hostTask, setHostTask] = useState<HostTaskEvent>();
  const operations = useRef<Promise<unknown>>(Promise.resolve());
  /* 数据缓存：整块装载一次，之后每秒拉一次增量。 */
  const storeRef = useRef<V3Store | undefined>(undefined);
  /* v3 的活动报告：内核的活动表不在增量集里，只能单独读一次。 */
  const activitiesRef = useRef<Board["activities"]>([]);
  const spaceActivitiesRef = useRef<Board["spaceActivities"]>([]);
  /* v3 的视角由界面自己掌握：内核的 views 表没有读接口（见 T20 的说明）。 */
  const viewRef = useRef<V3View>({
    id: viewId,
    spaceId: "",
    selection: [],
    camera: { x: 24, y: 24, zoom: 1 },
    updatedAt: 0,
  });
  /* 进过的白板：从首页一路进到现在的这一条路。 */
  const navStackRef = useRef<unknown[]>([]);
  const [board, setBoard] = useState<Board>(),
    [error, setError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [ended, setEnded] = useState(false),
    [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState("paper"),
    [mode, setMode] = useState("browse"),
    [query, setQuery] = useState(""),
    [scope, setScope] = useState("all"),
    [kind, setKind] = useState("symbol"),
    [arrows, setArrows] = useState(false),
    [source, setSource] = useState<{
      objectId: string;
      hash: string;
      text: string;
      startLine: number;
      endLine: number;
      nextLine: number | null;
    }>(),
    [note, setNote] = useState(""),
    [groupTitle, setGroupTitle] = useState("");
  const boardRef = useRef(board);
  boardRef.current = board;
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [workspaceErrors, setWorkspaceErrors] = useState<
    { id: string; reason: string }[]
  >([]);
  const [workspaceActiveId, setWorkspaceActiveId] = useState<
    string | undefined
  >();
  const [importReport, setImportReport] =
    useState<WorkspaceImportReport | null>(null);
  const {
    app,
    error: connectionError,
    isConnected,
  } = useApp({
    appInfo: { name: "Sand Table", version: "0.3.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolresult = (r) => {
        try {
          const data = unpack(r);
          if (
            data.objects &&
            data.spaces &&
            (!boardRef.current ||
              data.id !== boardRef.current.id ||
              data.revision >= boardRef.current.revision)
          ) {
            boardRef.current = data;
            setBoard(data);
          }
        } catch (e) {
          setError(String(e));
        }
      };
    },
  });
  /* 宿主桥：白板内对话入口显隐由**真实能力**决定（决策 D7 / 契约 X1–X2）。
     MCP App 宿主能发消息，算一种「host」；注入的 DSH 桥按它自报的能力算。 */
  /* 宿主桥接线：宿主（DSH 插件）用 postMessage 送来能力，
     提交任务走请求-应答往返。装一次就够，卸载时拆掉。 */
  useEffect(() => {
    if (typeof window === "undefined" || !window.parent) return;
    const client = installHostBridgeClient({
      scope: window,
      parent: window.parent,
      /* 跨源时不能用 "*"：那等于把能力与任务内容广播给任何嵌入者。 */
      onCapabilities: () => hostChanged((n) => n + 1),
    });
    return () => client.dispose();
  }, []);
  /* 桥每帧重读：宿主可能晚于首帧注入（DSH 插件是异步加载的），
     缓存起来会永远读不到那一次注入。 */
  const bridge = resolveBridge(
    typeof window === "undefined" ? undefined : window,
    app ? "mcp" : "local",
  );
  const resultQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(
    () =>
      bridge.subscribe((event) => {
        if (event.boardId && event.boardId !== boardRef.current?.id) return;
        setHostTask(event);
        for (const result of event.results ?? []) {
          resultQueue.current = resultQueue.current
            .then(async () => {
              if (event.boardId && event.boardId !== boardRef.current?.id)
                return;
              const mapped = mapHostResult(result);
              const current = boardRef.current;
              if (!current) return;
              const r = await call("sand_edit_space", {
                revision: current.revision,
                viewId,
                author: "DSH",
                operation: {
                  kind: "create",
                  type: mapped.type,
                  title: mapped.title,
                  data: {
                    ...mapped.data,
                    hostSource: mapped.source ?? bridge.host,
                    hostTaskId: event.taskId,
                  },
                },
              });
              /* 写入回的是一次写入的结果：板面由增量同步拉回来。 */
              void r;
            })
            .catch((e) => setError(`AI 结果未能写入白板：${String(e)}`));
        }
      }),
    [bridge.host, bridge.capabilities().eventStream, app],
  );
  const hostReady = canShowTaskEntry(bridge);
  /** 直接调服务端工具：版本分支之外的那一条路。 */
  async function callTool(name: string, args: Record<string, unknown> = {}) {
    if (!app) throw Error("尚未连接宿主");
    /* 白板编号还没拿到时不要带上它：v3 的工具会按参数校验，
       多一个空值会被当成非法参数挡下来。 */
    const boardId = boardRef.current?.id;
    return unpack(
      await app.callServerTool({
        name,
        arguments: { ...(boardId ? { boardId } : {}), ...args },
      }),
    );
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    return v3Call(name, args);
  }
  /** v3 模式下的界面视角：内核的 views 表没有读接口，视角由界面自己掌握。 */
  function v3View(): V3View {
    return { ...viewRef.current, updatedAt: Date.now() };
  }
  /** v3 模式下的白板：缓存里的行翻译成现有组件认得的结构。 */
  function v3Board(): Board {
    const store = storeRef.current;
    if (!store) throw Error("白板还没装载，请稍候再试。");
    return toBoard(store.cache, {
      boardId: store.cache.boardId,
      view: { ...v3View(), navStack: navStackRef.current },
      activities: activitiesRef.current,
      spaceActivities: spaceActivitiesRef.current,
      ...(store.workspaceId ? { workspaceId: store.workspaceId } : {}),
    });
  }
  /** 缓存变了就把界面拉回来。 */
  function refreshV3Board() {
    const board = v3Board();
    boardRef.current = board;
    setBoard(board);
  }
  /**
   * v3 的工具面。
   *
   * 现有组件用的是 v2 的工具名；这里把它们翻译成 v3 的工具，
   * 组件因此不用改：外观与交互一字未动，只是数据从哪来、写到哪去换了地方。
   */
  async function v3Call(name: string, args: Record<string, unknown> = {}) {
    switch (name) {
      case "sand_read_board": {
        const store = storeRef.current;
        if (!store) throw Error("白板还没装载，请稍候再试。");
        await store.sync();
        return v3Board();
      }
      case "sand_history":
        return v3History();
      case "sand_undo":
        return v3HistoryMove("undo");
      case "sand_redo":
        return v3HistoryMove("redo");
      case "sand_undo_to":
        return v3HistoryMove("jump", String(args.recordId ?? ""));
      case "sand_workspace_status":
        /* v3 的写入失败会当场报出来，没有单独的「保存失败」状态。 */
        return { lastSaveError: "" };
      case "sand_list_workspaces": {
        const data: any = await callTool("app_workspace", { action: "list" });
        return {
          activeId: data?.activeId,
          workspaces: (data?.workspaces ?? []).map((w: any) => ({
            id: w.id,
            title: w.title,
            createdAt: 0,
            updatedAt: 0,
            revision: 0,
            boardCount: 0,
            objectCount: 0,
          })),
          errors: (data?.errors ?? []).map((e: any) => ({
            id: e.id,
            reason: e.message ?? e.reason ?? "",
          })),
        };
      }
      case "sand_create_workspace":
        return callTool("app_workspace", {
          action: "create",
          ...(args.id ? { id: args.id } : {}),
          ...(args.title ? { title: args.title } : {}),
        });
      case "sand_switch_workspace": {
        const result = await callTool("app_workspace", {
          action: "switch",
          id: args.id,
        });
        /* 换工作空间就是换一块数据库：白板要重新装载，不能等下一次增量。
           缓存也整块换掉 —— store 按工作空间判定，旧库的内容一条都不留下。
           切换本身就回了新的工作空间编号，状态里的编号只作兜底。 */
        const switched = result as { id?: string };
        const status: any = await callTool("sand_status");
        const home = status?.homeBoardId;
        /* 会话编号是目录名。状态里的编号是库里记下的旧文件编号，
           导入之后两者可以不同，不能拿来核对是不是这一次打开的库。 */
        const workspaceId = switched.id;
        if (home) {
          await storeRef.current?.load(
            home,
            workspaceId ? { workspaceId } : {},
          );
          viewRef.current = { ...viewRef.current, spaceId: home };
          refreshV3Board();
        }
        return result;
      }
      case "sand_rename_workspace":
        return callTool("app_workspace", {
          action: "rename",
          id: args.id,
          title: args.title,
        });
      case "sand_delete_workspace":
        return callTool("app_workspace", { action: "delete", id: args.id });
      case "sand_refresh_board": {
        /* 刷新 = 整块重装一次。 */
        const store = storeRef.current;
        if (!store) throw Error("白板还没装载，请稍候再试。");
        await store.load(store.cache.boardId);
        refreshV3Board();
        return v3Board();
      }
      case "sand_rename_board": {
        /* 白板在 v3 里是 base.board 对象，改名就是改这个对象的标题。 */
        const store = storeRef.current;
        const board = store?.cache.objects.get(store.cache.boardId);
        if (!board) throw Error("找不到当前白板。请重新载入后再试。");
        await callTool("app_edit", {
          commands: [
            {
              op: "object.update",
              id: board.id,
              title: String(args.title ?? ""),
            },
          ],
        });
        await store?.sync();
        refreshV3Board();
        return true;
      }
      case "sand_export_workspace": {
        const exported: any = await callTool("app_workspace", {
          action: "export",
        });
        return { filename: exported.filename, json: exported.json };
      }
      case "sand_reload_workspace":
        throw Error(
          "v3 内核的工作空间就是数据库文件，没有「保留副本并重新加载」这一步。",
        );
      case "app_view":
        return callTool("app_view", args);
      case "sand_open_view":
        /* 视角由界面自己掌握：v3 的 app_view 只在没有 app_view 接口时用。 */
        return { viewId };
      case "sand_attach_asset":
        /* v3 的附件是内容：blob 挂在 base.media 对象上，
           现有界面把附件挂在「媒体」组件上（base.link），这一条路还没有接上。 */
        throw Error(
          "这一版还不能上传附件：v3 里附件是 base.media 对象的内容，界面的「媒体」组件放的是链接。请先用「媒体」组件放链接。",
        );
      case "sand_read_asset": {
        const sha = String(args.assetId ?? "");
        const read: any = await callTool("app_asset", {
          action: "read",
          sha256: sha,
        });
        const mime = v3AssetMime(sha);
        return {
          id: sha,
          name: sha,
          mime,
          dataUrl: `data:${mime};base64,${read.base64}`,
        };
      }
      case "sand_edit_space": {
        /* 宿主桥（DSH）把 AI 的结果写成一次白板操作：
           v3 下翻译成内核命令，写完立刻拉一次增量。 */
        const store = storeRef.current;
        if (!store) throw Error("白板还没装载，请稍候再试。");
        const commands = toCommands((args.operation ?? {}) as any, {
          boardId: store.cache.boardId,
          objects: store.cache.objects,
          presentations: store.cache.presentations,
        });
        if (!commands.length) return undefined;
        const result = await callTool("app_edit", { commands });
        await store.sync();
        refreshV3Board();
        return result;
      }
      case "sand_import_repository":
      case "sand_read_source":
      case "sand_edit_view": {
        const translated = translateLegacyTool(name, args);
        if (!translated || "unsupported" in translated)
          throw Error(
            translated && "unsupported" in translated
              ? translated.unsupported
              : `这一版内核还没有「${name}」这个操作。请重新载入白板后再试。`,
          );
        let last: unknown;
        for (const step of translated.steps)
          last = await callTool(step.name, step.args);
        if (translated.refreshBoard) {
          const store = storeRef.current;
          if (store) {
            await store.sync();
            refreshV3Board();
          }
        }
        return translated.result === "ok" ? true : last;
      }
      default:
        /* v3 的核心工具按原名调用；其余是 v2 才有的工具，明确说清楚。 */
        if (V3_CORE_TOOLS.has(name)) return callTool(name, args);
        throw Error(
          `这一版内核还没有「${name}」这个操作。请重新载入白板后再试。`,
        );
    }
  }
  /** 附件的类型：内核的 blobs 表还没登记，从对象的载荷里找。 */
  function v3AssetMime(sha: string): string {
    const objects = storeRef.current?.cache.objects;
    if (!objects) return "application/octet-stream";
    for (const object of objects.values()) {
      const data = object.data ?? {};
      if (data.blob === sha && typeof data.mime === "string") return data.mime;
    }
    return "application/octet-stream";
  }
  /** v3 的历史：内核给的是时间线，界面要的是同形状的快照。 */
  async function v3History(): Promise<HistorySnapshot> {
    const data: any = await callTool("app_history", {
      action: "list",
      limit: 100,
    });
    const entries: any[] = data?.entries ?? [];
    const cursorId: string | undefined = data?.cursorId ?? undefined;
    const cursor = entries.find((e) => e.id === cursorId);
    const cursorSeq = cursor?.seq ?? 0;
    const records = entries.map((e) => ({
      id: e.id,
      label: e.label,
      at: e.at,
      author: e.actorKind === "agent" ? "Agent" : "人",
      authorKind: e.actorKind,
      intentId: "",
      parentId: e.parentId ?? undefined,
      seq: e.seq,
      current: Boolean(e.current),
      onPath: Boolean(e.onCurrentPath),
      ahead: !e.current && !e.onCurrentPath && e.seq > cursorSeq,
      branch: !e.current && !e.onCurrentPath && e.seq <= cursorSeq,
    }));
    return {
      boardId: storeRef.current?.cache.boardId ?? "",
      records,
      cursorId,
      canUndo: Boolean(cursor && cursor.parentId),
      canRedo: entries.some((e) => e.parentId === cursorId),
      note: "每一步都是一次原子写入；撤销与重做沿着当前这条线走。",
    };
  }
  /** 撤销、重做与跳转：走内核的历史导航。 */
  async function v3HistoryMove(
    action: "undo" | "redo" | "jump",
    entryId?: string,
  ) {
    await callTool("app_history", {
      action,
      ...(action === "jump" ? { entryId } : {}),
    });
    const store = storeRef.current;
    if (store) await store.sync();
    refreshV3Board();
    return v3History();
  }
  /** 读一次工作空间列表。读不到就不显示条目——不假装有。 */
  async function refreshWorkspaces() {
    try {
      const data: any = await action("sand_list_workspaces");
      setWorkspaces((data?.workspaces ?? []) as WorkspaceDescriptor[]);
      setWorkspaceErrors(
        (data?.errors ?? []) as { id: string; reason: string }[],
      );
      setWorkspaceActiveId(data?.activeId);
    } catch {
      /* 没连上服务端时不显示工作空间入口。 */
    }
  }
  async function exportWorkspace() {
    try {
      if (!app) throw Error("尚未连接宿主。");
      const exported = await call("sand_export_workspace");
      const result = await app.downloadFile({
        contents: [
          {
            type: "resource",
            resource: {
              uri: `file:///${exported.filename}`,
              mimeType: "application/json",
              text: exported.json,
            },
          },
        ],
      });
      if (result.isError) throw Error("宿主未接受下载，当前编辑仍保留。");
      setRecoveryMessage("已导出当前工作空间。");
    } catch (error) {
      setError(readableError(error));
    }
  }
  async function importWorkspace(json: string) {
    setBusy(true);
    setError("");
    try {
      const report = (await callTool("app_workspace", {
        action: "import",
        json,
      })) as WorkspaceImportReport;
      if (!report?.workspaceId)
        throw Error("导入没有返回新的工作空间编号。请重新导出后再试。");
      setImportReport(report);
      setRecoveryMessage("");
      await refreshWorkspaces();
    } catch (error) {
      setError(readableError(error));
    } finally {
      setBusy(false);
    }
  }
  async function reloadWorkspace() {
    setBusy(true);
    try {
      const result = await call("sand_reload_workspace");
      boardRef.current = result.board;
      setBoard(result.board);
      setSaveError("");
      setError("");
      setRecoveryMessage(
        `本地编辑已保存到「${result.recoveryCopyTitle}」，已加载磁盘版本。可从工作空间列表切换到副本。`,
      );
      await refreshWorkspaces();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function action(
    name: string,
    args: Record<string, unknown> = {},
    options: { background?: boolean } = {},
  ) {
    if (!options.background) setBusy(true);
    if (name !== "sand_read_board") setError("");
    const absorb = (data: any) => {
      if (
        data?.objects &&
        data?.spaces &&
        (!boardRef.current ||
          data.id !== boardRef.current.id ||
          data.revision >= boardRef.current.revision)
      ) {
        boardRef.current = data;
        setBoard(data);
      }
      return data;
    };
    try {
      return absorb(await call(name, args));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      /* A write refused because the board moved on is not something the
         person can act on: the board changed under them, most likely because
         an agent wrote to it. Read the current board and make the same write
         once more against the fresh revision. The refused write was never
         applied, so retrying it cannot apply it twice. */
      if (/^Board changed\./.test(message) && args.revision !== undefined) {
        try {
          const fresh = absorb(await call("sand_read_board"));
          return absorb(
            await call(name, {
              ...args,
              revision: fresh?.revision ?? args.revision,
            }),
          );
        } catch (retryError) {
          setError(
            retryError instanceof Error
              ? retryError.message
              : String(retryError),
          );
          return undefined;
        }
      }
      setError(message);
      if (name !== "sand_read_board")
        try {
          setBoard(await call("sand_read_board"));
        } catch {}
      return undefined;
    } finally {
      if (!options.background) setBusy(false);
    }
  }
  function edit(data: Record<string, unknown>) {
    /* 视角只有选择与镜头；备注、导览、分组还没有对应的内核接口。 */
    if (Array.isArray(data.selection)) {
      const selection = data.selection as string[];
      viewRef.current = { ...viewRef.current, selection };
      return callTool("app_view", {
        action: "select",
        viewId,
        selection,
      }).then(() => {
        refreshV3Board();
        return true;
      });
    }
    return Promise.reject(
      Error("这一版内核还没有这个操作。请重新载入白板后再试。"),
    );
  }
  const operate = (operation: any) => {
    const next = operations.current
      .then(() => operateV3(operation))
      .catch((e) => {
        const text = e instanceof Error ? e.message : String(e);
        if (operation.reportError) {
          let code = "";
          let message = text;
          try {
            const parsed = JSON.parse(text) as {
              code?: unknown;
              message?: unknown;
            };
            if (typeof parsed.code === "string") code = parsed.code;
            if (typeof parsed.message === "string") message = parsed.message;
          } catch {
            /* 不是工具 JSON。 */
          }
          if (code !== "VERSION_CONFLICT") setError(message);
          return { error: { code, message } };
        }
        setError(text);
        return undefined;
      });
    operations.current = next.catch(() => undefined);
    return next;
  };
  /**
   * v3 的写入。
   *
   * 视角（选择、镜头、进入白板）走 app_view，内容走 app_edit：
   * 一次操作就是内核里的一条命令（或者一批）。
   */
  async function operateV3(operation: any) {
    const kind = String(operation.kind ?? "");
    if (kind === "select") {
      const selection = [...(operation.ids ?? [])];
      viewRef.current = { ...viewRef.current, selection };
      /* 视角是第一次建立：内核要知道这块视角在看哪块白板。 */
      await callTool("app_view", {
        action: "select",
        viewId,
        boardId: storeRef.current?.cache.boardId,
        selection,
      });
      refreshV3Board();
      return true;
    }
    if (kind === "camera") {
      viewRef.current = { ...viewRef.current, camera: operation.camera };
      await callTool("app_view", {
        action: "camera",
        viewId,
        boardId: storeRef.current?.cache.boardId,
        camera: operation.camera,
      });
      refreshV3Board();
      return true;
    }
    if (kind === "navigate") {
      const spaceId = String(operation.spaceId);
      const from = storeRef.current?.cache.boardId;
      let stack = Array.isArray(operation.navStack)
        ? operation.navStack
        : navStackRef.current;
      if (!Array.isArray(operation.navStack) && from && from !== spaceId)
        stack = [
          ...stack,
          {
            boardId: from,
            camera: viewRef.current.camera,
            selection: [...viewRef.current.selection],
            enteredFrom:
              typeof operation.enteredFrom === "string"
                ? operation.enteredFrom
                : null,
          },
        ];
      navStackRef.current = stack;
      const selection = Array.isArray(operation.selection)
        ? operation.selection.filter(
            (item: unknown): item is string => typeof item === "string",
          )
        : [];
      const rawCamera = operation.camera as
        { x?: unknown; y?: unknown; zoom?: unknown } | undefined;
      const camera =
        rawCamera &&
        typeof rawCamera.x === "number" &&
        typeof rawCamera.y === "number" &&
        typeof rawCamera.zoom === "number"
          ? { x: rawCamera.x, y: rawCamera.y, zoom: rawCamera.zoom }
          : { x: 24, y: 24, zoom: 1 };
      viewRef.current = {
        ...viewRef.current,
        spaceId,
        selection,
        camera,
      };
      await callTool("app_view", {
        action: "navigate",
        viewId,
        boardId: spaceId,
        navStack: stack,
        camera,
        selection,
      });
      await storeRef.current?.load(spaceId);
      refreshV3Board();
      return true;
    }
    const store = storeRef.current;
    if (!store) throw Error("白板还没装载，请稍候再试。");
    const commands = toCommands(operation, {
      boardId: store.cache.boardId,
      objects: store.cache.objects,
      presentations: store.cache.presentations,
    });
    if (!commands.length) return true;
    /* 意图分组沿用现有的编辑会话：一次连续输入仍然只是一步撤销。 */
    const intentId = operation.intentId ?? operation.intent;
    const send = (ops: any[]) =>
      callTool("app_edit", {
        ...(intentId ? { intentId: String(intentId) } : {}),
        commands: ops,
      });
    let written: any;
    try {
      written = await send(commands);
    } catch (e) {
      /* 表单自己展示冲突并保留草稿，不能在这里拿新版本把别人的修改盖掉。 */
      if (operation.reportError) throw e;
      /* 版本对不上：先同步一次（拿最新的内容），再看是不是界面自己
         连着写了两次（先标题、后正文）。改的不是同一处就拿着新版本
         再写一次；别人改了同一处就照实报冲突。 */
      if (operation.expectedVersion === undefined) throw e;
      await store.sync();
      const retry = v3RetryInfo(operation, {
        boardId: store.cache.boardId,
        objects: store.cache.objects,
        presentations: store.cache.presentations,
      });
      if (!retry || !retry.sameFields) throw e;
      const again = toCommands(
        { ...operation, expectedVersion: retry.version },
        {
          boardId: store.cache.boardId,
          objects: store.cache.objects,
          presentations: store.cache.presentations,
        },
      );
      if (!again.length) throw e;
      written = await send(again);
    }
    /* 建完就选中：v2 里新建完组件是选中的（属性面板会打开），
       v3 也要一样。选中的是展示编号，内核新建时把它回传了。 */
    if (operation.kind === "create") {
      const created = written?.created ?? {};
      const presentationId = created["newP"];
      if (presentationId) {
        viewRef.current = {
          ...viewRef.current,
          selection: [String(presentationId)],
        };
        await callTool("app_view", {
          action: "select",
          viewId,
          boardId: store.cache.boardId,
          selection: [String(presentationId)],
        });
      }
    }
    /* 自己写完立刻拉一次增量：界面不用等下一个整秒。 */
    await store.sync();
    refreshV3Board();
    if (operation.reportError)
      return {
        warnings: Array.isArray(written?.warnings) ? written.warnings : [],
        changed: Array.isArray(written?.changed) ? written.changed : [],
      };
    return true;
  }
  /* Board history: the newest record can always be flipped, and the flip is
     itself recorded, so an undo can be undone. */
  const [history, setHistory] = useState<HistorySnapshot>();
  const historyRef = useRef(history);
  historyRef.current = history;
  const flip = (kind: "undo" | "redo") =>
    action("sand_" + kind, { author: "human" });
  const jump = (recordId: string) =>
    action("sand_undo_to", { recordId, author: "human" });
  const flipRef = useRef(flip);
  flipRef.current = flip;
  /**
   * 连上之后装载首页白板。
   *
   * sand_status 打不开就直接说明原因，不再改走另一套工具。
   */
  useEffect(() => {
    if (!isConnected) return;
    let alive = true;
    void (async () => {
      let status: any;
      try {
        status = await callTool("sand_status");
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!alive) return;
      const boardId = status?.homeBoardId;
      if (!boardId) {
        setError("服务端没有给出首页白板。请重新连接后再试。");
        return;
      }
      const store = new V3Store(callTool);
      storeRef.current = store;
      let opened = String(boardId);
      let knownView = false;
      try {
        /* 同一个会话再打开时，视角里已经记下白板和镜头。
           不能先导航回首页，否则会把这次看到的白板冲掉。 */
        const existing: any = await callTool("app_view", {
          action: "get",
          viewId,
        });
        knownView = true;
        const savedId = existing?.board?.id;
        if (typeof savedId === "string" && savedId) opened = savedId;
        if (Array.isArray(existing?.navStack))
          navStackRef.current = existing.navStack;
        const camera = existing?.camera;
        const selection = Array.isArray(existing?.selection)
          ? existing.selection.flatMap((item: unknown) => {
              if (typeof item === "string") return [item];
              if (
                item &&
                typeof item === "object" &&
                typeof (item as { presentationId?: unknown }).presentationId ===
                  "string"
              )
                return [(item as { presentationId: string }).presentationId];
              return [];
            })
          : [];
        viewRef.current = {
          ...viewRef.current,
          spaceId: opened,
          selection,
          ...(camera &&
          typeof camera === "object" &&
          typeof (camera as { x?: unknown }).x === "number" &&
          typeof (camera as { y?: unknown }).y === "number" &&
          typeof (camera as { zoom?: unknown }).zoom === "number"
            ? {
                camera: {
                  x: (camera as { x: number }).x,
                  y: (camera as { y: number }).y,
                  zoom: (camera as { zoom: number }).zoom,
                },
              }
            : {}),
        };
      } catch {
        knownView = false;
        viewRef.current = { ...viewRef.current, spaceId: opened };
      }
      try {
        /* 不把状态里的工作空间编号传进去：那是库内记录的旧编号，
           和这次打开用的目录名不一定相同。第一次装载不带编号，
           服务端回什么就认什么。 */
        try {
          await store.load(opened);
        } catch (loadError) {
          if (opened === boardId) throw loadError;
          opened = String(boardId);
          knownView = false;
          navStackRef.current = [];
          viewRef.current = {
            ...viewRef.current,
            spaceId: opened,
            selection: [],
          };
          await store.load(opened);
        }
        if (!knownView) {
          /* 登记视角：内核要先有这条视角，之后的选中与镜头才有地方放。
             app_view 的 select / camera 不带白板编号，视角只能由 navigate 建立。 */
          await callTool("app_view", {
            action: "navigate",
            viewId,
            boardId: opened,
            navStack: [],
          });
        }
        if (!alive) return;
        refreshV3Board();
        setError("");
      } catch (e) {
        if (alive)
          setError(
            `白板没有装载成功：${e instanceof Error ? e.message : String(e)}`,
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [isConnected]);
  useEffect(() => {
    if (!board?.id || !isConnected) return;
    let alive = true;
    void call("sand_history")
      .then((data) => {
        if (alive && data?.records) setHistory(data as HistorySnapshot);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [board?.id, board?.revision, isConnected]);
  /**
   * v3：每秒拉一次增量，页面不可见时暂停。
   *
   * 空闲时只有这一个很小的请求；不再每 5 秒整块拉白板。
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const store = storeRef.current;
      if (!store) return;
      void store
        .sync()
        .then((changed) => {
          if (changed) refreshV3Board();
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  /**
   * 活动报告单独读一次。
   *
   * 活动表不在增量集里（增量只带内容与布局），所以每 5 秒读一次活动列表。
   * 用 app_activity 而不是 sand_context：sand_context 会写 agent_reads
   * （把 Agent 的读取游标往前推），而且它按上报者排除自己，
   * 本地桥接下界面与别的调用共用一个身份，界面就看不到自己那条。
   */
  useEffect(() => {
    if (!isConnected) return;
    const readActivities = async () => {
      const data: any = await callTool("app_activity", { action: "list" });
      const reported = toReportedActivities(
        data?.activities ?? [],
        storeRef.current?.cache.presentations.values() ?? [],
      );
      activitiesRef.current = reported.activities;
      spaceActivitiesRef.current = reported.spaceActivities;
      refreshV3Board();
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void readActivities().catch(() => {});
    }, 5000);
    void readActivities().catch(() => {});
    return () => clearInterval(timer);
  }, [isConnected]);
  /* 连上服务端后读一次工作空间列表。 */
  useEffect(() => {
    if (!isConnected) return;
    void refreshWorkspaces();
  }, [isConnected]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (blocksCanvasShortcut(e)) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      const h = historyRef.current;
      if (!h) return;
      const redo = key === "y" || e.shiftKey;
      if (redo ? !h.canRedo : !h.canUndo) return;
      e.preventDefault();
      void flipRef.current(redo ? "redo" : "undo");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const clearFilters = () => {
    setQuery("");
    setKind("all");
    setScope("all");
  };
  useEffect(() => {
    if (board?.theme) setTheme("custom");
  }, [JSON.stringify(board?.theme)]);
  async function readSource(object: Item, startLine?: number) {
    const result = await action("sand_read_source", {
      objectId: object.id,
      startLine,
    });
    if (result)
      setSource({
        objectId: object.id,
        hash: result.reference.hash,
        text:
          result.text +
          (result.characterTruncated
            ? "\n… 本段超出 12,000 字符，请缩小读取行数"
            : ""),
        startLine: result.reference.startLine,
        endLine: result.reference.endLine,
        nextLine: result.nextLine,
      });
  }
  async function focusGuide(focus: GuideFocus | null) {
    const updated = await edit({ guideFocus: focus });
    if (!updated || !focus) return;
    setMode("browse");
    setKind("all");
    setScope("all");
    setQuery("");
    setArrows(true);
  }
  async function openDocument(object: Item) {
    const updated = await edit({ selection: [object.id] });
    if (!updated) return;
    setMode("browse");
    setKind("file");
    setScope(object.workspaceId);
    setQuery(object.title);
    await readSource(object);
  }
  const view = board?.views[viewId];
  const selectedInstance = board?.instances.find(
    (c) => c.id === view?.selection.at(-1),
  );
  const selected = board?.objects.find(
    (o) => o.id === selectedInstance?.objectId,
  );
  useEffect(() => {
    setSource(undefined);
    setNote(selected ? board?.notes[selected.id] || "" : "");
  }, [selected?.id, board?.notes[selected?.id || ""]]);
  if (ended)
    return (
      <main className={theme}>
        <h1>白板已结束</h1>
        <p>本次整理已从内存清除。请让 Agent 重新打开白板。</p>
      </main>
    );
  if (!board)
    return (
      <main className={theme}>
        <h1>Sand Table</h1>
        <p>{connectionError?.message || error || "等待宿主打开项目总览…"}</p>
      </main>
    );
  const focusedGuide = board.guides.find(
    (g) => g.id === board.guideFocus?.guideId,
  );
  function choose(id: string, shift = false) {
    const old = boardRef.current!.selection;
    void edit({
      selection: shift
        ? old.includes(id)
          ? old.filter((x) => x !== id)
          : [...old, id]
        : [id],
    });
  }
  const workLabel = (id: string) =>
    board.workspaces.find((w) => w.id === id)?.label || "未知";
  const custom = theme === "custom" ? board.theme : undefined;
  const customStyle = custom
    ? ({
        "--bg": custom.background,
        "--surface": custom.surface,
        "--ink": custom.ink,
        "--muted": custom.muted,
        "--line": custom.line,
        "--accent": custom.accent,
        "--soft": custom.background,
        "--radius": `${custom.radius}px`,
        fontFamily:
          custom.font === "serif"
            ? "Georgia,serif"
            : custom.font === "mono"
              ? "ui-monospace,monospace"
              : "system-ui,sans-serif",
      } as CSSProperties)
    : undefined;
  if (board.presentation !== "code")
    return (
      <CanvasShell
        board={board}
        viewId={viewId}
        busy={busy}
        error={[error || connectionError?.message, saveError]
          .filter(Boolean)
          .join("\n")}
        action={action}
        call={call}
        operate={operate}
        openLink={(url) => void app?.openLink({ url })}
        history={history}
        onUndo={() => void flip("undo")}
        onRedo={() => void flip("redo")}
        onJump={(recordId) => void jump(recordId)}
        aiMode={hostReady ? "host" : "mcp"}
        workspacePanel={{
          workspaces,
          activeId: workspaceActiveId,
          busy,
          onExport: () => void exportWorkspace(),
          onReload: () => void reloadWorkspace(),
          onImport: (json: string) => void importWorkspace(json),
          importReport,
          recoveryMessage,
          errors: workspaceErrors,
          onRefresh: () => void refreshWorkspaces(),
          onCreate: async (input) => {
            await action("sand_create_workspace", input);
            await refreshWorkspaces();
          },
          onSwitch: async (id) => {
            const switched = await action("sand_switch_workspace", { id });
            if (!switched) return;
            await refreshWorkspaces();
            /* 切换之后活动工作空间的内容变了：重新载入最省事，
               也避免旧白板的状态残留在界面上。 */
            location.reload();
          },
          onRename: async (id, title) => {
            await action("sand_rename_workspace", { id, title });
            await refreshWorkspaces();
          },
          onDelete: async (id) => {
            await action("sand_delete_workspace", { id });
            await refreshWorkspaces();
          },
        }}
        hostTask={hostTask}
        onCancelHostTask={
          bridge.cancelTask && hostTask
            ? () => bridge.cancelTask!(hostTask.taskId)
            : undefined
        }
        sendToHost={
          canShowTaskEntry(bridge)
            ? async (text) => {
                const current = boardRef.current;
                const selected = new Set(current?.selection ?? []);
                /* 目标用「引用 + 版本」，不带整份快照：任务开始后用户改选择，
                   也不会把已提交任务的目标悄悄换掉。 */
                const targets = (current?.instances ?? [])
                  .filter((i) => selected.has(i.id))
                  .map((i) => {
                    const objectId = i.binding?.objectId ?? i.objectId;
                    if (!objectId) return undefined;
                    const object = current?.contentObjects?.find(
                      (o) => o.id === objectId,
                    );
                    return { objectId, version: object?.version ?? 0 };
                  })
                  .filter((t): t is { objectId: string; version: number } =>
                    Boolean(t),
                  );
                const submitted = await bridge.submitTask({
                  boardId: current?.id ?? "",
                  instruction: text,
                  targets,
                  contextVersion: current?.contentRevision ?? 0,
                });
                setHostTask({
                  taskId: submitted.taskId,
                  boardId: current?.id,
                  state: "queued",
                  message: "已提交",
                  at: Date.now(),
                });
              }
            : undefined
        }
        sendMessage={async (text) => {
          if (!app) throw Error("Not connected");
          const result = await app.sendMessage({
            role: "user",
            content: [{ type: "text", text }],
          });
          if (result.isError) throw Error("Host rejected message.");
        }}
      />
    );
  return (
    <main
      className={`${theme === "custom" ? board.theme?.base || "paper" : theme} ${custom?.density === "compact" ? "compact" : ""} ${custom?.reduceMotion ? "reduce-motion" : ""}`}
      style={customStyle}
    >
      <header>
        <div>
          <span className="eyebrow">SAND TABLE / SHARED UNDERSTANDING</span>
          <h1>{board.title}</h1>
          <p>看见整体，指向局部，和你的 AI 一起理解。</p>
        </div>
        <div className="header-actions">
          <button
            onClick={() => setTheme(theme === "paper" ? "mono" : "paper")}
          >
            {theme === "paper" ? "切换黑白" : "切换纸张"}
          </button>
          {board.theme && theme !== "custom" && (
            <button onClick={() => setTheme("custom")}>使用自定义外观</button>
          )}
          <button
            disabled={busy}
            onClick={() => void action("sand_refresh_board")}
          >
            刷新源码
          </button>
          <button
            onClick={async () => {
              if (await action("sand_end_board")) setEnded(true);
            }}
          >
            结束白板
          </button>
        </div>
      </header>
      <section className="overview">
        <div>
          <strong>{board.workspaces.length}</strong> 工作区
        </div>
        <div>
          <strong>
            {board.objects.filter((o) => o.kind === "symbol").length}
          </strong>{" "}
          代码入口
        </div>
        <div>
          <strong>{board.activities.length}</strong> 活动报告
        </div>
        <div>
          <strong>{view?.selection.length || 0}</strong> 已选组件
        </div>
        <span>白板确认改动 · Agent 使用宿主工具写入</span>
      </section>
      <section className="workspaces">
        <button
          className={scope === "all" ? "active" : ""}
          onClick={() => setScope("all")}
        >
          全部工作区
        </button>
        {board.workspaces.map((w) => (
          <button
            key={w.id}
            className={scope === w.id ? "active" : ""}
            onClick={() => setScope(w.id)}
          >
            <b>{w.label}</b>{" "}
            <small>
              {w.branch} · {w.head.slice(0, 7)}
            </small>
          </button>
        ))}
      </section>
      <div className="tools">
        <div className="modes">
          {[
            ["browse", "浏览"],
            ["arrange", "编排"],
            ["ai", "AI 上下文"],
          ].map(([id, title]) => (
            <button
              className={mode === id ? "active" : ""}
              onClick={() => {
                setMode(id);
                setTab(id === "arrange" ? "components" : "inspect");
              }}
              key={id}
            >
              {title}
            </button>
          ))}
        </div>
        <input
          aria-label="搜索对象"
          placeholder="搜索名称或文件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="对象类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="symbol">代码入口</option>
          <option value="file">文件</option>
          <option value="all">全部对象</option>
        </select>
        <button aria-pressed={arrows} onClick={() => setArrows(!arrows)}>
          关系 {arrows ? "开" : "关"}
        </button>
      </div>
      {(error || connectionError) && (
        <div role="alert" className="error">
          {error || connectionError?.message}
        </div>
      )}
      <div className="layout">
        <FlowCanvas
          board={board}
          viewId={viewId}
          mode={mode}
          query={query}
          kind={kind}
          scope={scope}
          arrows={arrows}
          busy={busy}
          operate={operate}
          call={call}
          clearFilters={clearFilters}
          onOpenLink={(url) => {
            const safe = safeUrl(url);
            if (safe)
              void app
                ?.openLink({ url: safe })
                .catch(() => setError(`宿主无法打开链接，请复制：${safe}`));
          }}
        />
        <aside>
          <div className="side-tabs" role="tablist" aria-label="工作面板">
            {[
              ["inspect", "理解"],
              ["changes", "改动"],
              ["components", "组件"],
              ["theme", "外观"],
            ].map(([id, title]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {title}
              </button>
            ))}
          </div>
          {tab === "changes" ? (
            <ChangePanel
              board={board}
              viewId={viewId}
              busy={busy}
              action={action}
            />
          ) : tab === "components" ? (
            <Inspector
              board={board}
              viewId={viewId}
              call={call}
              operate={operate}
            />
          ) : tab === "theme" ? (
            <ThemePanel
              board={board}
              operate={operate}
              onUseCustom={() => setTheme("custom")}
            />
          ) : (
            <>
              <GuidePanel
                board={board}
                busy={busy}
                onFocus={(focus) => void focusGuide(focus)}
                onDocument={(object) => void openDocument(object)}
              />
              <span className="eyebrow">
                {mode === "ai" ? "SHARED CONTEXT" : "INSPECT"}
              </span>
              <h2>
                {mode === "ai"
                  ? "AI 看到了什么"
                  : selected?.title || "从一个入口开始"}
              </h2>
              {mode === "ai" ? (
                <>
                  <p>
                    已选 {board.selection.length}{" "}
                    个对象。请在宿主对话中提问，Agent 调用 sand_read_context
                    后读取此处的选区、分组和备注。
                  </p>
                  <p className="muted">
                    选区表示关注范围，不代表写入授权。这里不展示宿主全部上下文。
                  </p>
                  <p>
                    最近读取：
                    {board.lastContextRead
                      ? new Date(
                          board.lastContextRead.at,
                        ).toLocaleTimeString() +
                        " · 修订 " +
                        board.lastContextRead.revision
                      : "尚未读取"}
                  </p>
                  <ul>
                    {board.selection.map((id) => (
                      <li key={id}>
                        {board.objects.find((o) => o.id === id)?.title}
                      </li>
                    ))}
                  </ul>
                </>
              ) : selected ? (
                <>
                  <p>
                    {workLabel(selected.workspaceId)} / {selected.source?.path}
                  </p>
                  <button
                    disabled={!selected.source || busy}
                    onClick={() => void readSource(selected)}
                  >
                    查看源码依据
                  </button>
                  {source?.objectId === selected.id &&
                    source.hash === selected.source?.hash && (
                      <section className="source-reader">
                        <small>
                          源码 {source.startLine}–{source.endLine} 行
                        </small>
                        <pre className="source">{source.text}</pre>
                        {source.nextLine && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void readSource(selected, source.nextLine!)
                            }
                          >
                            继续读取下一段
                          </button>
                        )}
                        {source.startLine !== selected.source?.startLine && (
                          <button
                            disabled={busy}
                            onClick={() => void readSource(selected)}
                          >
                            回到开头
                          </button>
                        )}
                      </section>
                    )}
                  <label>
                    给 AI 的备注
                    <textarea
                      value={note}
                      maxLength={2000}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="我想了解这一部分如何配合…"
                    />
                  </label>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void edit({ note: { objectId: selected.id, text: note } })
                    }
                  >
                    保存备注
                  </button>
                  <button
                    onClick={() => {
                      if (selectedInstance)
                        void operate({
                          kind: "place",
                          items: [
                            {
                              id: selectedInstance.id,
                              rect: {
                                ...selectedInstance.rect,
                                pinned: !selectedInstance.rect.pinned,
                              },
                            },
                          ],
                        });
                    }}
                  >
                    {selectedInstance?.rect.pinned ? "取消固定" : "固定位置"}
                  </button>
                  <h3>关联对象</h3>
                  {board.relations
                    .filter(
                      (r) =>
                        r.source === selected.id || r.target === selected.id,
                    )
                    .map((r, i) => {
                      const target =
                          r.source === selected.id ? r.target : r.source,
                        o = board.objects.find((o) => o.id === target);
                      return (
                        <button
                          className="relation"
                          key={i}
                          onClick={() => choose(target)}
                        >
                          {relationLabels[r.kind]} → {o?.title}
                        </button>
                      );
                    })}
                  <small>“可能调用”来自语法匹配，不保证运行时实际发生。</small>
                </>
              ) : (
                <p>
                  点击卡片查看真实源码，按需打开关系箭头。按住 Shift
                  选择多个对象，再向你的 AI 提问。
                </p>
              )}
              {mode === "arrange" && (
                <section>
                  <h3>阅读分组</h3>
                  <input
                    aria-label="分组名称"
                    placeholder="这组对象表达什么？"
                    value={groupTitle}
                    onChange={(e) => setGroupTitle(e.target.value)}
                  />
                  <button
                    disabled={board.selection.length < 2 || !groupTitle.trim()}
                    onClick={async () => {
                      if (
                        await edit({
                          group: {
                            title: groupTitle,
                            objectIds: board.selection,
                          },
                        })
                      )
                        setGroupTitle("");
                    }}
                  >
                    将选区分组
                  </button>
                  {board.groups.map((g) => (
                    <p key={g.id}>
                      {g.title}{" "}
                      <button onClick={() => void edit({ removeGroup: g.id })}>
                        解散
                      </button>
                    </p>
                  ))}
                </section>
              )}
              <section>
                <h3>Agent 在哪里</h3>
                {board.activities.length ? (
                  board.activities.map((a) => (
                    <div className="report" key={a.agentId}>
                      <b>{a.agentId}</b>
                      <p>{a.task}</p>
                      <p>
                        {workLabel(a.workspaceId)} ·{" "}
                        {a.stale ? "最后已知 / 已过期" : a.state}
                      </p>
                      <small>
                        {a.action} ·{" "}
                        {new Date(a.reportedAt).toLocaleTimeString()}
                        <br />
                        来源：Agent 自报
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="muted">
                    尚无活动报告。没有报告不代表 Agent 空闲。
                  </p>
                )}
              </section>
              <section>
                <h3>AI 解读</h3>
                {board.explanations
                  .filter(
                    (e) =>
                      !selected ||
                      e.evidence.some(
                        (ref) =>
                          ref.path === selected.source?.path &&
                          ref.workspaceId === selected.workspaceId,
                      ),
                  )
                  .map((e) => (
                    <div className="report" key={e.id}>
                      <small>
                        {e.stale ? "依据已过期" : "Agent 推断 · 非已证实结论"}
                      </small>
                      <p>{e.text}</p>
                      <small>
                        {e.evidence
                          .map((r) => `${r.path}:${r.startLine}`)
                          .join(" · ")}
                      </small>
                    </div>
                  ))}
              </section>
            </>
          )}
        </aside>
      </div>
      <footer>
        {board.workspaces.map((w) => (
          <details key={w.id}>
            <summary>
              {w.label}：索引 {w.files} 个文件 · 未索引 {w.omitted.length} 项 ·
              快照 {w.snapshot.slice(0, 10)}
            </summary>
            <p>
              当前支持已跟踪的 JS / TS / Python /
              Markdown；不执行仓库代码。索引快照不代表整个工作区。
            </p>
            <pre>{w.omitted.join("\n")}</pre>
          </details>
        ))}
        <p>
          会话仅在内存中 · 30 分钟无访问后过期 · 活动报告超过 60 秒显示最后已知
        </p>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Workbench />);
