/**
 * Sand Table 的 DSH 插件 —— Host 半。
 *
 * 职责（见 docs/architecture/dsh-integration.zh-CN.md §3.1）：
 * 1. 把白板的**读**操作暴露成 Agent 工具：列白板、读白板、读对象；
 * 2. 注册一个 Client 可调用的 Host 入口（会话命令 `sand-table`），
 *    供 Client 半探测宿主能力、提交任务；
 * 3. **不**实现模型调用、凭据管理、对话压缩。
 *
 * 内核逻辑不重复实现：所有白板读写都代理给 Sand Table 自己的 MCP server
 * （stdio 子进程），见下面的 createMcpClient。
 *
 * 运行时代码不 import 宿主包（@deepseek-ai/*）：插件只通过 ctx 拿服务，
 * 这样它在没有 DSH 的机器上也能被静态检查、被 node --check 解析。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件名，只用于诊断信息。 */
export const name = "@sand-table/dsh-plugin";

/**
 * 宿主必须先有的服务。
 * - tools：Agent 工具注册表；
 * - commands：会话命令注册表（Client 半用 ctx.remote.commands.execute 调用）。
 */
export const inject = ["tools", "commands"];

const PLUGIN_VERSION = "0.1.0";
/** 宿主标识，写进注入给白板的桥。 */
const HOST_ID = "dsh";
/** Client 半调用的会话命令名（只能小写字母、数字、下划线、连字符）。 */
const COMMAND_NAME = "sand-table";
/** 白板画布地址默认值。 */
const DEFAULT_BOARD_URL = "http://127.0.0.1:4173/board.html";
/** 工作空间存储目录默认值（与 server/main.ts 的默认一致）。 */
const DEFAULT_WORKSPACE_DIR = join(homedir(), ".sand-table", "workspaces");
/** 工作空间 ID 默认值（与 server/main.ts 的默认一致）。 */
const DEFAULT_WORKSPACE_ID = "default";
/** 附加到工作空间时用的白板标题。 */
const DEFAULT_BOARD_TITLE = "Sand Table";
/** 单次 MCP 调用超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 读取插件行上的配置，拼出实际生效的参数。
 *
 * 插件不声明 Config（那需要宿主的 schemastery 依赖），因此这里自己做兜底：
 * 缺哪个就用哪个的默认值，不因为配置缺失而拒绝启动。
 */
function resolveConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const here = dirname(fileURLToPath(import.meta.url));
  const text = (key) =>
    typeof config[key] === "string" && config[key].trim()
      ? config[key].trim()
      : "";
  const timeout = Number(config.timeoutMs);
  return {
    serverEntry: resolvePath(
      text("serverEntry") || join("..", "server", "main.ts"),
      here,
    ),
    workspaceDir: resolvePath(
      text("workspaceDir") || DEFAULT_WORKSPACE_DIR,
      here,
    ),
    workspaceId: text("workspaceId") || DEFAULT_WORKSPACE_ID,
    boardUrl: text("boardUrl") || DEFAULT_BOARD_URL,
    nodePath: text("nodePath") || process.execPath,
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/** 相对路径按插件目录解析，绝对路径原样使用。 */
function resolvePath(value, base) {
  return isAbsolute(value) ? value : resolve(base, value);
}

/**
 * 极简 MCP stdio 客户端。
 *
 * MCP 的 stdio 传输就是「每行一个 JSON-RPC 消息」（见
 * @modelcontextprotocol/server 的 serializeMessage：JSON.stringify + "\n"），
 * 所以这里不需要任何第三方依赖。
 */
function createMcpClient(config) {
  let child;
  let buffer = "";
  let stderrTail = "";
  let nextId = 1;
  let ready;
  const pending = new Map();

  /** 进程没了就一次性把所有等待中的调用判失败，不让调用方永远挂着。 */
  const rejectAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const handle = (message) => {
    if (!message || typeof message !== "object") return;
    const id = message.id;
    // 通知与服务端发起的请求当前用不到，直接忽略。
    if (typeof id !== "number") return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(
        new Error(
          `${message.error.message ?? "MCP 调用失败"}（code ${message.error.code ?? "?"}）`,
        ),
      );
    else entry.resolve(message.result);
  };

  const start = () => {
    if (child) return child;
    const args = [
      "--experimental-strip-types",
      config.serverEntry,
      "--workspace-dir",
      config.workspaceDir,
      "--workspace-id",
      config.workspaceId,
    ];
    child = spawn(config.nodePath, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            handle(JSON.parse(line));
          } catch {
            // 不是 JSON 的行（启动横幅之类）直接忽略。
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on("error", (error) => {
      child = undefined;
      rejectAll(new Error(`Sand Table MCP server 启动失败：${error.message}`));
    });
    child.on("exit", (code, signal) => {
      child = undefined;
      rejectAll(
        new Error(
          `Sand Table MCP server 已退出（code ${code ?? "?"}${
            signal ? `，signal ${signal}` : ""
          }）。${stderrTail}`,
        ),
      );
    });
    return child;
  };

  const request = (method, params) => {
    let proc;
    try {
      proc = start();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = nextId++;
    const answer = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`MCP 调用超时：${method}`));
      }, config.timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
    });
    try {
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    } catch (error) {
      pending.delete(id);
      rejectAll(new Error(`Sand Table MCP server 写入失败：${error.message}`));
    }
    return answer;
  };

  const initialize = () => {
    if (!ready)
      ready = request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sand-table-dsh-plugin", version: PLUGIN_VERSION },
      })
        .then(() => {
          start().stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }) + "\n",
          );
        })
        .catch((error) => {
          // 初始化失败允许下次重试，不要把失败永久记住。
          ready = undefined;
          throw error;
        });
    return ready;
  };

  /** 调用一个 MCP 工具，返回工具的原始结果。 */
  const callTool = async (name, args) => {
    await initialize();
    const result = await request("tools/call", { name, arguments: args });
    if (result?.isError) throw new Error(textOf(result) || `工具 ${name} 失败`);
    return result;
  };

  const close = () => {
    if (!child) return;
    const proc = child;
    child = undefined;
    proc.stdin.end();
    proc.kill();
  };

  return { callTool, close };
}

/** 取工具结果里的文本。 */
function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item && item.type === "text")
    .map((item) => String(item.text ?? ""))
    .join("\n");
}

/**
 * 取工具结果里的结构化数据。
 * MCP server 同时给 structuredContent.data 与文本，这里优先用前者。
 */
function dataOf(result) {
  const structured = result?.structuredContent?.data;
  if (structured !== undefined) return structured;
  const text = textOf(result);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 白板操作：一次实现，两个调用方（Agent 工具与会话命令共用同一份实现）。
 * 全部走 Sand Table 的 MCP server，不重复实现内核逻辑。
 */
function createOperations(mcp) {
  /** 列出这个 MCP 进程里已经打开的白板。 */
  const readBoards = async () =>
    dataOf(await mcp.callTool("sand_list_boards", {}));

  /**
   * 列出白板；一个都没有时先附加到工作空间里保存的白板。
   *
   * MCP server 进程刚起来时内存里没有白板（工作空间是在 open 时才载入的），
   * 不先附加的话 Agent 永远读到空列表。返回形状始终是 { boards: [...] }。
   */
  const listBoards = async () => {
    const boards = await readBoards();
    const list = Array.isArray(boards?.boards) ? boards.boards : [];
    if (list.length > 0) return { boards: list };
    await mcp.callTool("sand_open_board", {
      title: DEFAULT_BOARD_TITLE,
      preset: "blank",
    });
    const attached = await readBoards();
    return {
      boards: Array.isArray(attached?.boards) ? attached.boards : [],
    };
  };

  /** 读一张白板。 */
  const readBoard = async (boardId) => {
    if (!boardId) throw new Error("缺少 boardId");
    return dataOf(await mcp.callTool("sand_read_board", { boardId }));
  };

  /** 读白板上的一个对象。 */
  const readObject = async (boardId, objectId) => {
    if (!boardId) throw new Error("缺少 boardId");
    if (!objectId) throw new Error("缺少 objectId");
    return dataOf(
      await mcp.callTool("sand_read_object", { boardId, objectId }),
    );
  };

  return { listBoards, readBoard, readObject };
}

/**
 * 宿主自报的能力。
 *
 * 只有真的能提交任务时才说能：会话控制器不在，taskSubmit 就是假，
 * 白板里也就不该出现「问 AI」入口。
 */
function hostCapabilities(ctx) {
  const canSubmit = Boolean(ctx.get("sessionController"));
  return {
    host: HOST_ID,
    version: PLUGIN_VERSION,
    capabilities: {
      taskSubmit: canSubmit,
      eventStream: false,
      contentRead: true,
      resultKinds: ["text"],
    },
  };
}

/**
 * 把任务提交给宿主会话。
 *
 * 任务上下文只带**引用与版本**，不带整份快照（契约 X3）。
 */
async function submitTask(ctx, request, agent, signal) {
  const controller = ctx.get("sessionController");
  if (!controller)
    return { kind: "error", text: "当前宿主没有会话任务通道，无法提交任务。" };
  const instruction = String(request?.instruction ?? "").trim();
  if (!instruction) return { kind: "error", text: "任务指令为空，没有提交。" };
  const targets = Array.isArray(request?.targets) ? request.targets : [];
  const lines = [
    instruction,
    "",
    "【Sand Table 白板上下文】",
    `boardId: ${String(request?.boardId ?? "")}`,
    `上下文版本: ${String(request?.contextVersion ?? "")}`,
    targets.length
      ? `对象引用: ${targets
          .map(
            (target) =>
              `${String(target?.objectId ?? "")}@${String(target?.version ?? "")}`,
          )
          .join(", ")}`
      : "对象引用: （无）",
    "先用 sand_table_read_board / sand_table_read_object 读取内容再回答；引用与版本只是当时的快照，读取结果才是事实。",
  ];
  try {
    const value = await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId: agent.id,
        mode: "queue",
        content: [{ type: "text", text: lines.join("\n") }],
      },
      signal,
    );
    if (value?.accepted !== true)
      return { kind: "error", text: "宿主没有确认接收这次任务。" };
    return { kind: "success", text: "已提交给宿主会话。" };
  } catch (error) {
    return {
      kind: "error",
      text: `提交失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Agent 工具定义。
 *
 * 工具的规范值是 JSON 字符串，渲染成给模型看的文本。
 * 这里没有 import 宿主的 defineTool（运行时代码不引宿主包），
 * 但产出的结构与它一致：name / description / parameters(JSON Schema) /
 * output{schema, render} / execute。
 */
function toolDefinitions(operations) {
  const json = (value) => JSON.stringify(value);
  return [
    {
      name: "sand_table_list_boards",
      description:
        "列出 Sand Table 工作空间里的白板。返回 boardId、标题、版本与对象数量。先拿到 boardId 再读白板或对象。",
      parameters: {},
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      execute: async () => json(await operations.listBoards()),
    },
    {
      name: "sand_table_read_board",
      description:
        "读取一张 Sand Table 白板：标题、版本、选区、对象与空间概览、备注与编排摘要。boardId 来自 sand_table_list_boards。",
      parameters: {
        boardId: {
          type: "string",
          required: true,
          description: "白板 ID",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      execute: async (args) => json(await operations.readBoard(args?.boardId)),
    },
    {
      name: "sand_table_read_object",
      description:
        "读取白板上的一个对象：内容、版本、出现在哪些展示实例上、语义关系。对象 ID 来自白板内容。",
      parameters: {
        boardId: {
          type: "string",
          required: true,
          description: "白板 ID",
        },
        objectId: {
          type: "string",
          required: true,
          description: "对象 ID",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      execute: async (args) =>
        json(await operations.readObject(args?.boardId, args?.objectId)),
    },
  ];
}

/** 把工具定义编译成 ctx.tools.register 认识的形状。 */
function defineTool(definition) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(definition.parameters ?? {})) {
    properties[key] = {
      type: spec.type,
      ...(spec.description ? { description: spec.description } : {}),
    };
    if (spec.required) required.push(key);
  }
  return {
    name: definition.name,
    description: definition.description,
    parameters: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    },
    output: definition.output,
    execute: definition.execute,
  };
}

/**
 * Host 半入口。
 *
 * @param ctx - 宿主上下文
 * @param config - 插件行上的 config（见 cordis.patch.yml）
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config);
  const mcp = createMcpClient(settings);
  const operations = createOperations(mcp);

  // Agent 工具：白板的读操作。
  ctx.effect(() => {
    const disposers = toolDefinitions(operations).map((definition) =>
      ctx.tools.register(defineTool(definition)),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "sand-table: agent tools");

  // Client 可调用的 Host 入口：一条会话命令。
  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: COMMAND_NAME,
      description:
        "Sand Table 白板：探测宿主能力、读白板（列白板 / 读白板 / 读对象）、把白板里的任务提交给当前会话。",
      input: {
        hint: "<capabilities|list_boards|read_board <id>|read_object <boardId> <objectId>|submit {json}>",
      },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? "").trim();
        const space = raw.indexOf(" ");
        const action = (space < 0 ? raw : raw.slice(0, space)).trim();
        const rest = space < 0 ? "" : raw.slice(space + 1).trim();
        try {
          if (action === "capabilities")
            return {
              kind: "success",
              text: JSON.stringify({
                ...hostCapabilities(ctx),
                boardUrl: settings.boardUrl,
                workspaceId: settings.workspaceId,
              }),
            };
          if (action === "list_boards")
            return {
              kind: "success",
              text: JSON.stringify(await operations.listBoards()),
            };
          if (action === "read_board")
            return {
              kind: "success",
              text: JSON.stringify(await operations.readBoard(rest)),
            };
          if (action === "read_object") {
            const parts = rest.split(/\s+/).filter(Boolean);
            return {
              kind: "success",
              text: JSON.stringify(
                await operations.readObject(parts[0], parts[1]),
              ),
            };
          }
          if (action === "submit") {
            const request = rest ? JSON.parse(rest) : {};
            return await submitTask(
              ctx,
              request,
              invocation.agent,
              invocation.signal,
            );
          }
          return {
            kind: "error",
            text: `未知子命令「${action || "(空)"}」。可用：capabilities、list_boards、read_board、read_object、submit。`,
          };
        } catch (error) {
          return {
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    return () => dispose();
  }, "sand-table: host command");

  // 子进程是插件自己拉起来的，卸载时必须收掉。
  ctx.effect(() => () => mcp.close(), "sand-table: mcp server");
}
