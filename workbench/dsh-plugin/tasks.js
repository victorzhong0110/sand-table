import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  boardScope,
  record,
  sessionIdentity,
  taskRequest,
} from "../server/host/contracts.ts";
import { RECORD_TYPE, taskProjection, terminal } from "./projection.js";

const identity = (session) => sessionIdentity.parse(session.header);
const sameSession = (a, b) => a?.id === b?.id && a?.createdAt === b?.createdAt;
const sameScope = (a, b) =>
  a.workspaceId === b.workspaceId && a.boardId === b.boardId;

async function loadSessionRecords() {
  const name = "@deepseek-ai/dsh-session";
  const local = createRequire(import.meta.url);
  let resolver = local;
  if (process.argv[1]) {
    // Use the CLI's module instance so its Session objects and record helpers share ownership.
    const host = createRequire(pathToFileURL(process.argv[1]));
    try {
      host.resolve(name + "/package.json");
      resolver = host;
    } catch {
      // Library installations may resolve the declared peer directly.
    }
  }
  const manifest = resolver(name + "/package.json");
  const accepted = local("./package.json").peerDependencies[name];
  if (manifest.version !== accepted)
    throw Error(
      `会话恢复需要 ${name}@${accepted}，当前为 ${manifest.version}。`,
    );
  return await import(pathToFileURL(resolver.resolve(name)).href);
}

export function createTaskChannel(ctx, options) {
  const service = (name) => ctx.get(name, false);
  const sessions = () => service("sessions");
  const persistence = () => service("sessionPersistence");
  const controller = () => service("sessionController");
  const queue = new Map();
  const admission = new Map();
  let handle,
    definition,
    records,
    disposed = false,
    off;
  let installing;
  function install() {
    if (handle || disposed) return Promise.resolve();
    if (installing) return installing;
    installing = (async () => {
      if (
        !sessions()?.flush ||
        !persistence()?.open ||
        !controller()?.prompt ||
        !service("sessionProjections")?.register
      )
        return;
      records = options.records ?? (await loadSessionRecords());
      definition = taskProjection(records.pluginRecordOf);
      const installed =
        await service("sessionProjections").register(definition);
      if (disposed) {
        await installed.dispose();
        return;
      }
      handle = installed;
      off = ctx.on("session/event", onEvent);
    })()
      .catch((error) =>
        ctx.logger?.warn(`Sand Table 会话恢复未启用：${error.message}`),
      )
      .finally(() => {
        installing = undefined;
      });
    return installing;
  }

  const enabled = () => !!handle && !disposed;
  async function requireReady() {
    await install();
    if (!enabled()) throw Error("当前 DSH 没有可用的会话持久化与恢复接口。");
  }

  async function durableRecord(session, data) {
    if (disposed || sessions().get(session.id) !== session)
      throw Error("会话已关闭，请重新打开原会话核对。");
    const seq = records.appendPluginRecord(
      session,
      RECORD_TYPE,
      record.parse(data),
    );
    await sessions().flush(session);
    const reader = await persistence().open(session.id, "read");
    try {
      if (!sameSession(reader.header, session.header))
        throw Error("会话身份已变化，请重新打开原会话。");
      const persisted = await reader.read();
      if (
        !persisted.events.some(
          (event) =>
            event.seq === seq &&
            records.pluginRecordOf(event)?.type === RECORD_TYPE,
        )
      )
        throw Error("DSH 尚未持久化此记录，请核对会话后再操作。");
    } finally {
      await reader.close();
    }
  }

  async function lookup(id) {
    await requireReady();
    const session = sessions().get(id);
    if (session) return { session, state: handle.stateOf(session) };
    const reader = await persistence().open(id, "read");
    try {
      const { events } = await reader.read();
      return {
        state: events.reduce(
          definition.apply,
          definition.init(reader.header, reader.inheritedEventCount),
        ),
      };
    } finally {
      await reader.close();
    }
  }

  function lookupTask(state, taskId) {
    if (!Object.hasOwn(state.tasks, taskId))
      throw Error("当前会话中找不到该任务，请回到原会话核对。");
    const task = state.tasks[taskId];
    if (!options.writer.matchesScope(task.binding))
      throw Error("该任务绑定到另一个白板存储位置，请切换回原工作空间。");
    return task;
  }

  function deliverySnapshot(task) {
    return Object.entries(task.deliveries).map(([operationId, entry]) => ({
      operationId,
      state: entry.state,
      objectId: entry.objectId,
      reason: entry.reason,
    }));
  }

  function view(task, live) {
    const { binding } = task;
    return {
      taskId: binding.requestId,
      workspaceId: binding.workspaceId,
      boardId: binding.boardId,
      session: binding.session,
      instruction: binding.displayText,
      targets: binding.targets,
      state: live || terminal(task.state) ? task.state : "waiting",
      messages: task.messages,
      reason:
        !live && !terminal(task.state)
          ? "原轮次状态待核对，请打开原 DSH 会话。"
          : task.state === "waiting"
            ? "宿主尚未确认原请求是否进入执行队列。"
            : task.reason,
      deliveries: deliverySnapshot(task),
      at: task.updated,
    };
  }

  async function commit(session, task, result) {
    const b = task.binding;
    const data = { requestId: b.requestId, operationId: result.operationId };
    try {
      await durableRecord(session, {
        kind: "delivery",
        requestId: b.requestId,
        delivery: result,
      });
      if (disposed) return;
      let receipt = options.writer.receipt(b, result.operationId);
      if (!receipt) receipt = options.writer.write(b, result);
      await durableRecord(session, {
        kind: "written",
        ...data,
        objectId: receipt.created.artifact,
        revision: receipt.revision,
      });
    } catch (error) {
      if (disposed) return;
      await durableRecord(session, {
        kind: "delivery-error",
        ...data,
        reason: String(error.message ?? error).slice(0, 500),
      }).catch((failure) =>
        ctx.logger?.warn(`Sand Table 无法记录交付状态：${failure.message}`),
      );
    }
  }

  function enqueue(session, job) {
    const previous = queue.get(session) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => {
        if (!disposed) return job();
      });
    queue.set(session, pending);
    const release = () => {
      if (queue.get(session) === pending) queue.delete(session);
    };
    void pending.then(release, release);
    return pending;
  }

  function onEvent(session, event) {
    if (event.type !== "tool/result" || event.data.message?.isError) return;
    const state = handle.stateOf(session);
    if (
      !state.active ||
      state.turn !== event.data.turn ||
      !Object.hasOwn(state.calls, event.data.message?.toolCallId)
    )
      return;
    const task = state.tasks[state.active];
    const entry = Object.values(task.deliveries).find(
      (item) => item.delivery.seq === event.seq,
    );
    if (!entry || entry.recorded) return;
    void enqueue(session, () => {
      const current =
        handle.stateOf(session).tasks[task.binding.requestId].deliveries[
          entry.delivery.operationId
        ];
      if (!current.recorded) return commit(session, task, entry.delivery);
    });
  }

  const api = {
    get ready() {
      return install();
    },
    enabled,
    async submit(input, agent, signal = new AbortController().signal) {
      await requireReady();
      const request = taskRequest.parse(input);
      const id = agent?.id;
      if (!id || (request.sessionId && request.sessionId !== id))
        throw Error("DSH 会话已切换，请重新确认提交目标。");
      const session = sessions().get(id);
      if (!session || (agent.session && agent.session !== session))
        throw Error("原会话未打开，请先在 DSH 打开会话。");
      if (
        request.sessionCreatedAt !== undefined &&
        request.sessionCreatedAt !== session.header.createdAt
      )
        throw Error("原会话已被替换，请重新选择会话。");
      const { sessionId: _, sessionCreatedAt: __, ...fields } = request;
      const existing = handle.stateOf(session).tasks[request.requestId];
      if (existing) {
        const {
          session: _,
          workspaceNamespace: __,
          ...previous
        } = existing.binding;
        if (JSON.stringify(previous) !== JSON.stringify(fields))
          throw Error("同一请求编号不能用于不同任务，请核对原请求。");
        return { taskId: request.requestId, state: existing.state };
      }
      const key = JSON.stringify([identity(session), request.requestId]);
      const previous = admission.get(key);
      const payload = JSON.stringify(fields);
      if (previous) {
        if (previous.payload !== payload)
          throw Error("同一请求编号不能用于不同任务，请核对原请求。");
        return await previous.pending;
      }
      const pending = (async () => {
        signal.throwIfAborted();
        const scope = await options.resolveScope(request);
        options.writer.verify(scope, request.targets);
        signal.throwIfAborted();
        const b = {
          ...fields,
          session: identity(session),
          workspaceNamespace: scope.workspaceNamespace,
        };
        try {
          await durableRecord(session, { kind: "binding", binding: b });
        } catch {
          throw Error("未能确认提交关联已保存。请核对原请求。");
        }
        const content = [
          {
            type: "text",
            text: [
              request.instruction,
              "",
              `Sand Table boardId: ${request.boardId}`,
              `contextVersion: ${request.contextVersion}`,
              `targets: ${JSON.stringify(request.targets)}`,
              "核对原版本后再修改。另存作品可调用 sand_table_publish_artifact。",
            ].join("\n"),
          },
        ];
        try {
          if (sessions().get(id) !== session) throw Error("原会话已关闭。");
          const accepted = await controller().prompt(
            {
              requestId: request.requestId,
              sessionId: id,
              mode: "queue",
              content,
            },
            signal,
          );
          if (!accepted?.accepted) throw Error("宿主尚未确认接收任务。");
          await durableRecord(session, {
            kind: "accepted",
            requestId: request.requestId,
          });
        } catch {
          return {
            taskId: request.requestId,
            state:
              handle.stateOf(session).tasks[request.requestId]?.state ??
              "waiting",
          };
        }
        return {
          taskId: request.requestId,
          state: handle.stateOf(session).tasks[request.requestId].state,
        };
      })();
      admission.set(key, { payload, pending });
      try {
        return await pending;
      } finally {
        admission.delete(key);
      }
    },
    selectedSession(agent) {
      const session = sessions()?.get(agent?.id);
      return session ? identity(session) : undefined;
    },
    async get(taskId, agent) {
      const { session, state } = await lookup(agent.id);
      return view(lookupTask(state, taskId), !!session);
    },
    async follow(scopeInput, agent) {
      const scope = boardScope.parse(scopeInput);
      const { session, state } = await lookup(agent.id);
      return {
        session: state.session,
        seq: state.seq,
        tasks: Object.values(state.tasks)
          .filter(
            (task) =>
              sameScope(task.binding, scope) &&
              options.writer.matchesScope(task.binding),
          )
          .slice(-30)
          .map((task) => view(task, !!session)),
      };
    },
    async cancel(taskId, agent) {
      const { session } = await lookup(agent.id);
      if (!session || sessions().get(session.id) !== session)
        throw Error("会话已关闭，请在 DSH 查看原轮次状态。");
      const latest = handle.stateOf(session);
      const task = lookupTask(latest, taskId);
      if (
        task.state !== "running" ||
        latest.active !== taskId ||
        task.turn !== latest.turn
      )
        throw Error("只能停止当前会话中与原请求匹配的执行轮次。");
      return await controller().cancel({ sessionId: session.id });
    },
    async reconcile(taskId, agent) {
      const { session, state } = await lookup(agent.id);
      const task = lookupTask(state, taskId);
      if (!session) throw Error("请先打开原 DSH 会话，再核对待交付作品。");
      await enqueue(session, async () => {
        const current = lookupTask(handle.stateOf(session), taskId);
        for (const entry of Object.values(current.deliveries)) {
          if (entry.state !== "written")
            await commit(session, current, entry.delivery);
        }
      });
      return api.get(taskId, agent);
    },
    dispose() {
      disposed = true;
      off?.();
      return handle?.dispose();
    },
  };
  return api;
}
