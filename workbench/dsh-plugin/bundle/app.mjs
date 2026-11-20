import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as workbench from "../index.js";
import { startLocal } from "../../local/service.ts";
import { createRegistry, importWorkspaceBundle } from "../../kernel/index.ts";
import { builtinPacks } from "../../packs/index.ts";
import { exportComposition, importComposition } from "./composition.ts";

export const name = workbench.name;
export const inject = [...workbench.inject, "webServer", "sessions"];

export async function apply(ctx, config = {}) {
  const workspaceDir = resolve(
    config.workspaceDir || join(homedir(), ".sand-table", "workspaces"),
  );
  const connection = await mkdtemp(join(tmpdir(), "sand-dsh-workbench-"));
  const sessionFile = join(connection, "connection.json");
  const serverEntry = fileURLToPath(
    new URL("../server/main.mjs", import.meta.url),
  );
  const bridge = fileURLToPath(new URL("./bridge.mjs", import.meta.url));
  let local;
  const composition = {
    async export(mode, signal) {
      signal.throwIfAborted();
      const result = await local.callTool("app_workspace", {
        action: "export",
      });
      if (result.isError)
        throw Error("当前工作空间导出失败，请核对附件后重试。");
      const json = result._meta?.data?.json;
      if (typeof json !== "string") throw Error("本地服务未返回工作空间快照。");
      return exportComposition(json, ctx.sandTableResources, mode, signal);
    },
    async import(raw, signal, sessionId) {
      const registry = createRegistry();
      for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
      const resolveOwner = async () => {
        signal.throwIfAborted();
        sessionId ??= (
          await ctx.sessionController.create({ cwd: workspaceDir })
        ).sessionId;
        const owner = ctx.sessions.get(sessionId)?.header;
        if (!owner) throw Error("请先打开要接收图稿的 DSH 会话。");
        return owner;
      };
      const report = await importComposition(
        raw,
        ctx.sandTableResources,
        resolveOwner,
        (json) => importWorkspaceBundle(workspaceDir, registry, json),
        signal,
      );
      return { ...report, sessionId };
    },
  };
  const close = async () => {
    try {
      await local?.close();
    } finally {
      await rm(connection, { recursive: true, force: true });
    }
  };
  try {
    local = await startLocal({
      workspaces: [],
      workspaceDir,
      workspaceId: config.workspaceId,
      port: config.port,
      sessionFile,
      serverEntry,
      composition,
      embedOrigins: [ctx.webServer.getOrigin()],
      mcpEntry: {
        command: process.execPath,
        args: [bridge, "--session-file", sessionFile],
      },
    });
    ctx.effect(() => close, "sand-table: packaged workbench");
    const boardUrl = new URL("/embed", local.url).href;
    ctx.on("webserver/index-inject", (rows) => {
      rows.push({
        kind: "global",
        name: "__SAND_TABLE_BOARD_URL__",
        value: boardUrl,
      });
    });
    workbench.apply(ctx, {
      ...config,
      workspaceDir,
      sessionFile,
      serverEntry: bridge,
      boardUrl,
    });
    ctx.provide("sandTableComposition", composition);
  } catch (error) {
    await close();
    throw error;
  }
}
