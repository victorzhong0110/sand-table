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

import { createTaskChannel } from "./tasks.js";
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
export const inject = ["tools", "commands", "sessionController"];

const PLUGIN_VERSION = "0.1.0";
/** 宿主标识，写进注入给白板的桥。 */
const HOST_ID = "dsh";
/** Client 半调用的会话命令名（只能小写字母、数字、下划线、连字符）。 */
const COMMAND_NAME = "sand-table";
/** 白板画布地址默认值。 */
const DEFAULT_BOARD_URL = "http://127.0.0.1:4173/embed";
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
      text("serverEntry") || join("..", "local", "bridge.ts"),
      here,
    ),
    workspaceDir: resolvePath(
      text("workspaceDir") || DEFAULT_WORKSPACE_DIR,
      here,
    ),
    workspaceId: text("workspaceId") || DEFAULT_WORKSPACE_ID,
    sessionFile: text("sessionFile"),
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
      ...(config.sessionFile ? ["--session-file", config.sessionFile] : []),
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

/** v2 类型名换成 v3 类型名。已经带点的名字视为 v3 类型，原样使用。 */
const TYPE_MAP = {
  text: "base.note",
  heading: "base.heading",
  code: "base.code_snippet",
  metric: "base.metric",
  status: "base.status",
  chart: "base.chart",
  table: "base.table",
  events: "base.events",
  task: "base.task",
  reasoning: "base.reasoning",
  comparison: "base.comparison",
  board: "base.board",
  character: "novel.character",
  event: "novel.event",
  chapter: "novel.chapter",
  hypothesis: "research.hypothesis",
  evidence: "research.evidence",
  conclusion: "research.conclusion",
};

const RELATION_KINDS = {
  related: "base.related",
  "depends-on": "base.depends_on",
  supports: "base.supports",
  compares: "base.compares",
  "belongs-to": "base.belongs_to",
};

function mapContentType(type, data) {
  if (typeof type !== "string" || !type.trim())
    throw new Error("创建对象要给出类型。");
  if (type.includes(".")) return type;
  if (type === "resource") {
    if (data && typeof data.assetId === "string" && data.assetId)
      return "base.media";
    return "base.link";
  }
  return TYPE_MAP[type] || `legacy.${type}`;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** 便签的旧字段 text 写成 v3 的 body。媒体的 assetId / description 写成 blob / caption。 */
function mapContentData(type, data) {
  const next =
    data && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};
  if (
    (type === "text" || type === "base.note") &&
    !Object.prototype.hasOwnProperty.call(next, "body") &&
    typeof next.text === "string"
  ) {
    next.body = next.text;
    delete next.text;
  }
  const media =
    type === "base.media" ||
    (type === "resource" &&
      typeof next.assetId === "string" &&
      next.assetId.length > 0);
  if (media) {
    if (!Object.prototype.hasOwnProperty.call(next, "blob")) {
      if (typeof next.assetId !== "string" || !SHA256.test(next.assetId))
        throw new Error(
          "媒体附件要给出 64 位 sha256。旧的 assetId 不是内容指纹时，请先上传附件，用返回的 sha256 作为 blob。",
        );
      next.blob = next.assetId;
    }
    delete next.assetId;
    if (
      !Object.prototype.hasOwnProperty.call(next, "caption") &&
      typeof next.description === "string"
    )
      next.caption = next.description;
    delete next.description;
    delete next.url;
  }
  return next;
}

/** v2 的 appearance.detail 写在展示上，不写进对象数据。 */
function presentationAppearance(appearance) {
  if (!appearance || typeof appearance !== "object" || Array.isArray(appearance))
    return undefined;
  const next = {};
  if (typeof appearance.detail === "string" && appearance.detail)
    next.detail = appearance.detail;
  if (typeof appearance.coverBlob === "string" && appearance.coverBlob)
    next.coverBlob = appearance.coverBlob;
  if (typeof appearance.accent === "string" && appearance.accent)
    next.accent = appearance.accent;
  return Object.keys(next).length ? next : undefined;
}

function mapRelationKind(kind) {
  if (typeof kind !== "string" || !kind.trim())
    throw new Error("关系要给出类型。");
  return RELATION_KINDS[kind] || kind;
}

function editIntent(operation, label) {
  return {
    ...(operation.intentId ? { intentId: operation.intentId } : {}),
    label,
  };
}

async function loadBoard(mcp, boardId) {
  const result = await mcp.callTool("app_board", { boardId });
  const full = result?._meta?.data;
  if (full && Array.isArray(full.presentations)) return full;
  throw new Error("读不到这块白板的展示。请重新读取白板后再改。");
}

function presentationOf(contents, id) {
  const found = (contents.presentations || []).find((item) => item.id === id);
  if (!found)
    throw new Error(`找不到展示「${id}」。请重新读取白板，用展示编号再试。`);
  return found;
}

/**
 * 把原来的白板操作译成 v3 调用。
 *
 * 内容写入走 sand_edit。选区、镜头、进入白板走 app_view。
 * 撤销和重做走 sand_history。展示编号先用 app_board 换成对象编号。
 */
async function editOnV3(mcp, args, operation) {
  if (Array.isArray(operation.commands))
    return mcp.callTool("sand_edit", {
      commands: operation.commands,
      ...(operation.intentId ? { intentId: operation.intentId } : {}),
      ...(operation.label ? { label: operation.label } : { label: "DSH 修改" }),
    });
  const kind = operation.kind;
  if (kind === "select") {
    if (!Array.isArray(operation.ids))
      throw new Error("选择要给出展示编号列表。");
    return mcp.callTool("app_view", {
      action: "select",
      viewId: args.viewId,
      boardId: args.boardId,
      selection: operation.ids,
    });
  }
  if (kind === "camera") {
    if (!operation.camera) throw new Error("调整镜头要给出镜头参数。");
    return mcp.callTool("app_view", {
      action: "camera",
      viewId: args.viewId,
      boardId: args.boardId,
      camera: operation.camera,
    });
  }
  if (kind === "navigate") {
    if (!operation.spaceId) throw new Error("进入白板要给出 spaceId。");
    return mcp.callTool("app_view", {
      action: "navigate",
      viewId: args.viewId,
      boardId: operation.spaceId,
    });
  }
  if (kind === "undo" || kind === "redo")
    return mcp.callTool("sand_history", { action: kind });
  if (kind === "create") {
    const data = mapContentData(operation.type, operation.data);
    const type = mapContentType(operation.type, operation.data);
    const place = operation.rect
      ? {
          x: operation.rect.x,
          y: operation.rect.y,
          width: operation.rect.width,
          height: operation.rect.height,
          ...(typeof operation.rect.pinned === "boolean"
            ? { locked: operation.rect.pinned }
            : {}),
        }
      : {};
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 创建"),
      commands: [
        {
          op: "object.create",
          ref: "created",
          type,
          title: operation.title,
          data,
        },
        {
          op: "presentation.create",
          boardId: args.boardId,
          objectId: "@created",
          ...place,
        },
      ],
    });
  }
  if (kind === "update") {
    const contents = await loadBoard(mcp, args.boardId);
    const presentation = presentationOf(contents, operation.instanceId);
    const object = (contents.objects || []).find(
      (item) => item.id === presentation.objectId,
    );
    const data = mapContentData(object?.type, operation.data);
    const command = { op: "object.update", id: presentation.objectId };
    if (
      typeof operation.title === "string" &&
      operation.title !== operation.baseTitle
    )
      command.title = operation.title;
    if (operation.data) {
      const set = operation.baseData
        ? changedFields(data, operation.baseData)
        : data;
      if (Object.keys(set).length) command.set = set;
    }
    if (typeof operation.expectedVersion === "number")
      command.expectedVersion = operation.expectedVersion;
    const commands = [];
    if (command.title || command.set) commands.push(command);
    const appearance = presentationAppearance(operation.appearance);
    if (appearance)
      commands.push({
        op: "presentation.update",
        id: operation.instanceId,
        appearance,
      });
    if (!commands.length)
      throw new Error("内容和标题都没有变化。请改过后再提交。");
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 更新"),
      commands,
    });
  }
  if (kind === "place") {
    if (!Array.isArray(operation.items) || !operation.items.length)
      throw new Error("摆放要给出至少一个展示和位置。");
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 摆放"),
      commands: operation.items.map((item) => ({
        op: "presentation.update",
        id: item.id,
        x: item.rect?.x,
        y: item.rect?.y,
        width: item.rect?.width,
        height: item.rect?.height,
        ...(typeof item.rect?.pinned === "boolean"
          ? { locked: item.rect.pinned }
          : {}),
      })),
    });
  }
  if (kind === "remove")
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 移除展示"),
      commands: [{ op: "presentation.delete", id: operation.instanceId }],
    });
  if (kind === "present")
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 放置"),
      commands: [
        {
          op: "presentation.create",
          boardId: operation.spaceId || args.boardId,
          objectId: operation.objectId,
        },
      ],
    });
  if (kind === "deleteObject") {
    const policy = operation.onReferenced || "refuse";
    if (policy !== "refuse" && policy !== "detach")
      throw new Error(
        "删除被引用对象时，onReferenced 只能是 refuse 或 detach。",
      );
    if (policy === "refuse") {
      const read = dataOf(
        await mcp.callTool("sand_read", { ids: [operation.objectId] }),
      );
      const object = (Array.isArray(read?.objects) ? read.objects : []).find(
        (item) => item.id === operation.objectId,
      );
      if (!object)
        throw new Error("找不到要删除的对象。请先读取白板，再用对象编号重试。");
      const presentations = object.presentations;
      const relations = object.relations;
      if (!Array.isArray(presentations) || !Array.isArray(relations))
        throw new Error(
          "读不到这个对象的展示和关系，已拒绝删除。请先读对象确认没有引用，或把 onReferenced 设为 detach。",
        );
      if (presentations.length || relations.length)
        throw new Error(
          "这个对象还被展示或关系引用，已拒绝删除。若要连展示和关系一起去掉，请把 onReferenced 设为 detach 后再提交。",
        );
    }
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 删除"),
      commands: [{ op: "object.delete", id: operation.objectId }],
    });
  }
  if (kind === "duplicate" || kind === "copyObject") {
    const contents = await loadBoard(mcp, args.boardId);
    const presentation = presentationOf(contents, operation.instanceId);
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 复制"),
      commands: [
        { op: "object.clone", ref: "copy", id: presentation.objectId },
        {
          op: "presentation.create",
          boardId: args.boardId,
          objectId: "@copy",
        },
      ],
    });
  }
  if (kind === "link") {
    const contents = await loadBoard(mcp, args.boardId);
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 关联"),
      commands: [
        {
          op: "relation.create",
          kind: mapRelationKind(operation.relation),
          sourceId: presentationOf(contents, operation.source).objectId,
          targetId: presentationOf(contents, operation.target).objectId,
          status: "confirmed",
          ...(operation.description ? { basis: operation.description } : {}),
        },
      ],
    });
  }
  if (kind === "relate")
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 关联"),
      commands: [
        {
          op: "relation.create",
          kind: mapRelationKind(operation.relation),
          sourceId: operation.source,
          targetId: operation.target,
          ...(operation.status ? { status: operation.status } : {}),
          ...(operation.basis ? { basis: operation.basis } : {}),
          ...(operation.evidence ? { evidence: operation.evidence } : {}),
        },
      ],
    });
  if (kind === "unlink" || kind === "unlinkRelation")
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 解除关联"),
      commands: [
        {
          op: "relation.delete",
          id: operation.relationId || operation.linkId,
        },
      ],
    });
  if (kind === "theme")
    return mcp.callTool("sand_edit", {
      ...editIntent(operation, "DSH 主题"),
      commands: [{ op: "setting.set", key: "theme", value: operation.theme }],
    });
  if (kind === "group")
    throw new Error(
      "分组要直接提交 commands：先建 base.frame，再把展示放进框里。",
    );
  if (kind === "move")
    throw new Error(
      "跨白板移动要直接提交 commands：删掉原展示，再在目标白板建一条展示。",
    );
  throw new Error(
    `还不认识操作「${kind || "(空)"}」。内容修改请用 create、update、place、remove，或直接给 commands。`,
  );
}

function changedFields(data, base) {
  if (!base || typeof base !== "object") return data;
  const next = {};
  for (const [key, value] of Object.entries(data)) {
    if (JSON.stringify(base[key]) !== JSON.stringify(value)) next[key] = value;
  }
  return next;
}

/**
 * 白板操作：一次实现，两个调用方（Agent 工具与会话命令共用同一份实现）。
 * 全部走 Sand Table 的 MCP server，不重复实现内核逻辑。
 */
export function createOperations(mcp, kernel = process.env.SAND_KERNEL) {
  if (kernel === "v3") return createV3Operations(mcp);
  return createV2Operations(mcp);
}

function createV2Operations(mcp) {
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
  const readBoard = async (boardId, offset = 0) => {
    if (!boardId) throw new Error("缺少 boardId");
    const summary = dataOf(await mcp.callTool("sand_read_board", { boardId }));
    const objects = dataOf(
      await mcp.callTool("sand_list_objects", { boardId, offset, limit: 50 }),
    );
    const spaces = dataOf(
      await mcp.callTool("sand_read_spaces", { boardId, offset, limit: 50 }),
    );
    return {
      ...summary,
      objects,
      spaces,
      hint: "objects/spaces 各有分页信息；用 offset 读取下一页，再用 sand_table_read_object 读完整对象。",
    };
  };

  /** 读白板上的一个对象。 */
  const readObject = async (boardId, objectId) => {
    if (!boardId) throw new Error("缺少 boardId");
    if (!objectId) throw new Error("缺少 objectId");
    return dataOf(
      await mcp.callTool("sand_read_object", { boardId, objectId }),
    );
  };

  const editSpace = async (args) =>
    dataOf(
      await mcp.callTool("sand_edit_space", {
        boardId: args.boardId,
        viewId: args.viewId,
        revision: args.revision,
        author: "DSH",
        operation: JSON.parse(args.operation),
      }),
    );
  return { listBoards, readBoard, readObject, editSpace };
}

function createV3Operations(mcp) {
  const listBoards = async () => {
    const status = dataOf(await mcp.callTool("sand_status", {}));
    const boards = Array.isArray(status?.boards) ? status.boards : [];
    return {
      boards: boards.map((board) => ({
        boardId: board.id,
        id: board.id,
        title: board.title ?? "",
        revision: status?.workspace?.revision,
        objectCount:
          typeof board.presentations === "number" ? board.presentations : 0,
      })),
    };
  };

  const readBoard = async (boardId, offset = 0) => {
    if (!boardId) throw new Error("缺少 boardId");
    const query = { boardId };
    if (offset) {
      if (!Number.isInteger(offset) || offset < 0)
        throw new Error("offset 必须是大于等于 0 的整数。");
      query.cursor = Buffer.from(String(offset)).toString("base64url");
    }
    const found = dataOf(await mcp.callTool("sand_query", query));
    const rows = Array.isArray(found?.rows) ? found.rows : [];
    return {
      boardId,
      objects: rows,
      total: found?.total ?? rows.length,
      nextCursor: found?.nextCursor ?? null,
      hint: "objects 是从 offset 起的一页对象。要完整内容请用 sand_table_read_object。",
    };
  };

  const readObject = async (boardId, objectId) => {
    if (!boardId) throw new Error("缺少 boardId");
    if (!objectId) throw new Error("缺少 objectId");
    const read = dataOf(
      await mcp.callTool("sand_read", { ids: [objectId] }),
    );
    const objects = Array.isArray(read?.objects) ? read.objects : [];
    const object = objects.find((item) => item.id === objectId);
    if (!object)
      throw new Error("找不到这个对象。请先读取白板，再用对象编号重试。");
    return { boardId, ...object };
  };

  const editSpace = async (args) => {
    if (!args?.boardId) throw new Error("缺少 boardId");
    if (typeof args.revision !== "number") throw new Error("缺少 revision");
    let operation;
    try {
      operation = JSON.parse(args.operation);
    } catch {
      throw new Error("operation 不是合法的 JSON。请按操作说明重新发送。");
    }
    if (!operation || typeof operation !== "object" || Array.isArray(operation))
      throw new Error("operation 必须是一个 JSON 对象。");
    if (
      ["select", "camera", "navigate"].includes(operation.kind) &&
      !args.viewId
    )
      throw new Error(
        "选择、镜头或进入白板要给出 viewId。创建和更新内容不需要视角编号。",
      );
    const current = dataOf(await mcp.callTool("sand_status", {}));
    if (current?.workspace?.revision !== args.revision)
      throw new Error("白板已经变了。请重新读取 revision，再提交这一次修改。");
    return dataOf(await editOnV3(mcp, args, operation));
  };

  return { listBoards, readBoard, readObject, editSpace };
}

/**
 * 宿主自报的能力。
 *
 * 只有真的能提交任务时才说能：会话控制器不在，taskSubmit 就是假，
 * 白板里也就不该出现「问 AI」入口。
 */
function hostCapabilities(tasks) {
  const available = tasks.enabled();
  return {
    host: HOST_ID,
    version: PLUGIN_VERSION,
    capabilities: {
      taskSubmit: available,
      eventStream: available,
      contentRead: true,
      resultKinds: ["text", "paper", "dataset", "file"],
    },
  };
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
      name: "sand_table_edit_space",
      description:
        "按用户请求修改当前白板的组件、布局或关系，不修改真实文件。revision 来自 sand_table_list_boards。创建和更新内容只需要 boardId 与 revision；选择、镜头或进入白板时才需要 viewId。operation 为 sand_edit_space 操作的 JSON 字符串。冲突时重新读取，不盲目重试。",
      parameters: {
        boardId: { type: "string", required: true },
        viewId: {
          type: "string",
          description: "只在选择、调整镜头或进入白板时需要。内容修改不用填。",
        },
        revision: { type: "number", required: true },
        operation: { type: "string", required: true },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      execute: async (args) => json(await operations.editSpace(args)),
    },
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
        offset: { type: "number", description: "对象与展示分页偏移，默认 0" },
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
      execute: async (args) =>
        json(await operations.readBoard(args?.boardId, args?.offset)),
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
  const tasks = createTaskChannel(ctx);
  ctx.effect(() => () => tasks.dispose(), "sand-table: task events");

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
                ...hostCapabilities(tasks),
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
              text: JSON.stringify(
                await operations.readBoard(
                  rest.split(/\s+/)[0],
                  Number(rest.split(/\s+/)[1] || 0),
                ),
              ),
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
            return {
              kind: "success",
              text: JSON.stringify(
                await tasks.submit(
                  request,
                  invocation.agent,
                  invocation.signal,
                ),
              ),
            };
          }
          if (action === "status") {
            const { taskId, after } = JSON.parse(rest);
            return {
              kind: "success",
              text: JSON.stringify(
                tasks.status(taskId, invocation.agent, after),
              ),
            };
          }
          if (action === "cancel")
            return {
              kind: "success",
              text: JSON.stringify(await tasks.cancel(rest, invocation.agent)),
            };
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
