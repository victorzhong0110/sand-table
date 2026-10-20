/**
 * Sand Table 的 DSH 插件 —— Client 半（浏览器侧）。
 *
 * 职责（见 docs/architecture/dsh-integration.zh-CN.md §3.2）：
 * 1. 在侧栏注册一个面板条目（`sidebar.panellist`），点了就在中央列
 *    （`main`）打开 Sand Table 面板 —— 两处用**同一个 id/key**，
 *    侧栏选中的面板 id 就是中央列要渲染的键；
 * 2. 面板用 **iframe** 承载 Sand Table 本地服务，不替换应用根，
 *    也不往 document.body 追加第二个应用；
 * 3. 把宿主能力按**宿主自报**的样子注入给白板页面
 *    （window.__SAND_TABLE_HOST__），拿不到就不注入。
 *
 * 运行时代码不 import 宿主包：React 来自浏览器的模块表（require），
 * 其余全部走 ctx 上的服务。
 */

window.__ModuleLoader__.load({
  id: "@sand-table/dsh-plugin",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** 侧栏条目 id 与中央列键必须是同一个值。 */
    const PANEL_ID = "sand-table";
    /** 白板画布地址默认值（宿主会用它自己的配置覆盖）。 */
    const DEFAULT_BOARD_URL = "http://127.0.0.1:4173/board.html";
    /** 宿主侧的会话命令名。 */
    const COMMAND_NAME = "sand-table";
    /** 宿主标识。 */
    const HOST_ID = "dsh";
    /** 父页 → 画布：宿主能力（跨源时只能传数据，函数走消息往返）。 */
    const HOST_MESSAGE = "sand-table:host-bridge";
    /** 画布 → 父页：请求提交任务。 */
    const TASK_MESSAGE = "sand-table:submit-task";
    /** 父页 → 画布：任务已提交。 */
    const TASK_RESULT_MESSAGE = "sand-table:submit-task-result";
    /** 父页 → 画布：任务提交失败。 */
    const TASK_ERROR_MESSAGE = "sand-table:submit-task-error";

    return {
      inject: ["slots", "locale", "remote", "remote.commands"],
      apply(ctx) {
        /**
         * 面板共享状态。组件用订阅拿变化，宿主能力探测完就更新一次。
         */
        const state = {
          boardUrl: DEFAULT_BOARD_URL,
          version: "",
          capabilities: null,
          status: "idle",
          message: "尚未探测宿主能力。",
        };
        const listeners = new Set();
        const emit = () => {
          for (const listener of [...listeners]) listener();
        };
        /** 当前挂着的画布 iframe（消息往返只认自己的画布）。 */
        let currentFrame = null;

        const text = (value) => {
          const resolve = ctx.locale?.resolveText;
          return typeof resolve === "function" ? resolve(value) : value;
        };

        /** 当前会话 id：命令入口按会话寻址，找不到就提交不了。 */
        const resolveSessionId = () => {
          const uiSession = ctx.get("uiSession");
          const key = uiSession?.adapter?.current?.value?.key;
          return typeof key === "string" && key ? key : undefined;
        };

        /** 调用宿主侧的命令入口，返回命令结果文本。 */
        const callHost = async (sessionId, line) => {
          const commands = ctx.remote?.commands;
          if (!commands || typeof commands.execute !== "function")
            throw new Error("当前宿主没有提供命令入口。");
          const outcome = await commands.execute(sessionId, line, []);
          if (!outcome?.ok)
            throw new Error(
              outcome?.error?.message ?? "宿主拒绝了这次命令调用。",
            );
          const value = outcome.value;
          if (!value) throw new Error("宿主没有识别这条命令。");
          if (value.result?.kind === "error")
            throw new Error(value.result.text || "宿主拒绝了这次操作。");
          return String(value.result?.text ?? "");
        };

        /**
         * 探测宿主能力。
         *
         * 探测不到就返回 undefined —— 那就是「没有宿主」，不是错误，
         * 白板里也就不该出现「问 AI」入口。
         */
        const fetchCapabilities = async (sessionId) => {
          const commands = ctx.remote?.commands;
          if (!commands || typeof commands.list !== "function")
            return undefined;
          const listed = await commands.list(sessionId);
          if (!listed?.ok) return undefined;
          const names = (Array.isArray(listed.value) ? listed.value : []).map(
            (item) => item?.name,
          );
          if (!names.includes(COMMAND_NAME)) return undefined;
          const raw = await callHost(
            sessionId,
            `/${COMMAND_NAME} capabilities`,
          );
          try {
            return JSON.parse(raw);
          } catch {
            return undefined;
          }
        };

        /** 把任务提交给宿主会话，返回任务 id。 */
        const submitThroughHost = async (request) => {
          const sessionId = resolveSessionId();
          if (!sessionId) throw new Error("找不到当前会话，无法提交任务。");
          const line = `/${COMMAND_NAME} submit ${JSON.stringify(request ?? {})}`;
          await callHost(sessionId, line);
          return `sand-${Date.now().toString(36)}`;
        };

        /** 注入给白板的桥对象（同源时直接写，函数也带过去）。 */
        const hostObject = () => ({
          host: HOST_ID,
          version: state.version,
          capabilities: state.capabilities,
          submitTask: async (request) => ({
            taskId: await submitThroughHost(request),
          }),
          // 宿主没有事件通道：不伪造进度，订阅是空操作。
          subscribe: () => () => {},
        });

        /**
         * 把能力交给白板页面。
         *
         * 同源：直接写 window.__SAND_TABLE_HOST__（函数也能带过去）。
         * 跨源：只能发 postMessage，白板侧按 README 的消息契约接手。
         */
        const injectHostBridge = (frame) => {
          const target = frame?.contentWindow;
          if (!target || !state.capabilities) return;
          const bridge = hostObject();
          try {
            target.__SAND_TABLE_HOST__ = bridge;
            if (target.__SAND_TABLE_HOST__ === bridge) return;
          } catch {
            // 跨源读写受限：走消息通道。
          }
          try {
            target.postMessage(
              {
                type: HOST_MESSAGE,
                host: {
                  host: HOST_ID,
                  version: state.version,
                  capabilities: state.capabilities,
                },
              },
              "*",
            );
          } catch {
            // 画布还没准备好：下一次 load 事件会再试一次。
          }
        };

        /** 探测本机工作台在不在。 */
        const probeWorkbench = async (url) => {
          try {
            await fetch(url, {
              mode: "no-cors",
              signal: AbortSignal.timeout(4000),
            });
            return true;
          } catch {
            return false;
          }
        };

        /** 探测宿主能力并更新面板状态。 */
        const probe = async () => {
          state.status = "probing";
          state.message = "正在探测宿主能力…";
          emit();
          const sessionId = resolveSessionId();
          if (!sessionId) {
            state.status = "degraded";
            state.message =
              "找不到当前会话：白板可以浏览，但白板内不显示「问 AI」入口。";
            emit();
            return;
          }
          let payload;
          try {
            payload = await fetchCapabilities(sessionId);
          } catch (error) {
            state.status = "degraded";
            state.message = `探测宿主失败：${
              error instanceof Error ? error.message : String(error)
            }`;
            emit();
            return;
          }
          if (!payload) {
            state.status = "degraded";
            state.message =
              "宿主没有提供 sand-table 入口：白板可以浏览，但白板内不显示「问 AI」入口。";
            emit();
            return;
          }
          state.capabilities = payload.capabilities ?? null;
          state.version = String(payload.version ?? "");
          if (typeof payload.boardUrl === "string" && payload.boardUrl.trim())
            state.boardUrl = payload.boardUrl.trim();
          state.status = "ready";
          state.message = state.capabilities?.taskSubmit
            ? "宿主可接收任务：白板内会显示「问 AI」入口。"
            : "宿主只读：白板内不显示「问 AI」入口。";
          emit();
          const reachable = await probeWorkbench(state.boardUrl);
          if (!reachable) {
            state.message +=
              " 另外：本机工作台没有响应，先在终端里启动它（npm run launch）。";
            emit();
          }
        };

        /** 侧栏图标：中央列的白板面板入口。 */
        const SandTablePanelIcon = (props) => {
          const size = typeof props?.size === "number" ? props.size : 18;
          return h(
            "svg",
            {
              viewBox: "0 0 64 64",
              width: size,
              height: size,
              "aria-hidden": "true",
              focusable: "false",
              style: { display: "block" },
            },
            h("rect", {
              x: 5,
              y: 9,
              width: 54,
              height: 46,
              rx: 7,
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 4,
            }),
            h("rect", {
              x: 13,
              y: 17,
              width: 17,
              height: 13,
              rx: 3,
              fill: "currentColor",
            }),
            h("rect", {
              x: 34,
              y: 17,
              width: 17,
              height: 13,
              rx: 3,
              fill: "currentColor",
              opacity: 0.45,
            }),
            h("rect", {
              x: 13,
              y: 34,
              width: 38,
              height: 13,
              rx: 3,
              fill: "currentColor",
              opacity: 0.25,
            }),
          );
        };

        /** 中央列的白板面板：工具条 + iframe。 */
        const SandTablePanel = () => {
          const frameRef = useRef(null);
          const [, bump] = useState(0);
          useEffect(() => {
            const listener = () => bump((value) => value + 1);
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          }, []);
          useEffect(() => {
            void probe();
          }, []);
          useEffect(() => {
            injectHostBridge(frameRef.current);
          }, [state.status, state.capabilities]);
          useEffect(() => {
            currentFrame = frameRef.current;
            return () => {
              currentFrame = null;
            };
          }, []);
          const reload = () => {
            const frame = frameRef.current;
            if (frame) frame.src = state.boardUrl;
          };
          return h(
            "section",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: 0,
                color: "inherit",
                background: "transparent",
              },
            },
            h(
              "header",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 12px",
                  fontSize: 12,
                  opacity: 0.85,
                },
              },
              h("strong", null, text("Sand Table")),
              h(
                "button",
                {
                  type: "button",
                  onClick: reload,
                  style: {
                    cursor: "pointer",
                    font: "inherit",
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: "1px solid currentColor",
                    background: "transparent",
                    color: "inherit",
                  },
                },
                text("重新载入"),
              ),
              h(
                "a",
                {
                  href: state.boardUrl,
                  target: "_blank",
                  rel: "noreferrer noopener",
                  style: { color: "inherit" },
                },
                text("在新标签打开"),
              ),
              h("span", { style: { flex: 1 } }, text(state.message)),
            ),
            h("iframe", {
              ref: frameRef,
              src: state.boardUrl,
              title: "Sand Table 白板",
              sandbox: "allow-scripts allow-same-origin allow-forms",
              onLoad: () => injectHostBridge(frameRef.current),
              style: {
                flex: 1,
                minHeight: 0,
                width: "100%",
                border: 0,
                background: "transparent",
              },
            }),
          );
        };

        // 中央列：键与侧栏条目 id 相同，侧栏选中的面板 id 就是这个键。
        ctx.slots.inject("main", () => {
          try {
            return ctx.slots.register(
              { name: "main", key: PANEL_ID },
              SandTablePanel,
            );
          } catch (error) {
            // 槽位不可用（没声明、被别的键占用等）：降级为不显示。
            console.warn("[sand-table] main 槽位不可用：", error);
            return () => {};
          }
        });

        // 侧栏：新增一个面板条目（list 语义是加法，不顶掉官方条目）。
        ctx.slots.inject("sidebar.panellist", () => {
          try {
            return ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 100,
                label: () => text("Sand Table"),
              },
              SandTablePanelIcon,
            );
          } catch (error) {
            console.warn("[sand-table] sidebar.panellist 槽位不可用：", error);
            return () => {};
          }
        });

        // 跨源时的任务往返：画布发请求，父页调宿主，父页回结果。
        // 只认自己画布发来的消息，不接别的窗口的请求。
        ctx.effect(() => {
          const onMessage = (event) => {
            const data = event?.data;
            if (!data || typeof data !== "object") return;
            if (data.type !== TASK_MESSAGE) return;
            const frame = currentFrame;
            if (!frame || event.source !== frame.contentWindow) return;
            const id = String(data.id ?? "");
            void submitThroughHost(data.request)
              .then((taskId) => {
                frame.contentWindow?.postMessage(
                  { type: TASK_RESULT_MESSAGE, id, taskId },
                  "*",
                );
              })
              .catch((error) => {
                frame.contentWindow?.postMessage(
                  {
                    type: TASK_ERROR_MESSAGE,
                    id,
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                  "*",
                );
              });
          };
          window.addEventListener("message", onMessage);
          return () => window.removeEventListener("message", onMessage);
        }, "sand-table: host bridge messages");
      },
    };
  },
});
