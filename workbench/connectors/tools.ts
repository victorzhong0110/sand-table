// 连接器的 MCP 工具接线：让连接器在产品里可达。
//
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 3 节。
//
// 每个连接器按**自己声明的读能力**注册一个读工具：
// 没声明的能力不注册工具，调用时也不许假装能做。
// 工具名：sand_read_<连接器 id>（例如 sand_read_folder）。

import { z } from "zod";
import type { RegisterTool } from "../server/tool-types.ts";
import type { Connector } from "./types.ts";
import { readThrough } from "./types.ts";

/** 连接器读工具的参数。 */
const readShape = {
  /** 读什么种类：必须是连接器声明过的。 */
  kind: z.string().min(1).max(20),
  /** 目标目录（文件夹连接器用）。 */
  root: z.string().min(1).max(2000).optional(),
  /** 目标工作区 id（Git 连接器用：已绑定的仓库）。 */
  workspaceId: z.string().min(1).max(500).optional(),
  /** 限定路径。 */
  paths: z.array(z.string().min(1).max(500)).max(200).optional(),
};

/**
 * 为每个连接器注册一个读工具。
 *
 * 工具名与描述都来自连接器的能力声明：声明里没有的种类，调用时会被拒绝。
 */
export function registerConnectorTools(
  tool: RegisterTool,
  connectors: Connector[],
): void {
  for (const connector of connectors) {
    const descriptor = connector.descriptor();
    const kinds = descriptor.capabilities.read.kinds;
    tool(
      `sand_read_${descriptor.id}`,
      `${descriptor.description ?? descriptor.title}。只读已声明的种类：${kinds.join("、")}。`,
      readShape,
      (a) => {
        const binding =
          a.root || a.workspaceId
            ? {
                id: a.workspaceId ?? a.root!,
                label: a.workspaceId ?? a.root!,
                root: a.root ?? "",
              }
            : undefined;
        return readThrough(connector, {
          kind: a.kind as (typeof kinds)[number],
          ...(binding ? { binding } : {}),
          ...(a.paths ? { paths: a.paths } : {}),
        });
      },
      true,
    );
  }
}
