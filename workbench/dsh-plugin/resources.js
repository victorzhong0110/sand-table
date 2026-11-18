import { createResourceRegistry } from "../resources/registry.ts";

/** DSH 原生插件用 ctx.effect 注册能力；声明式数据包没有此入口。 */
export function applyResources(ctx, mcp, dataOf) {
  const registry = createResourceRegistry();
  const available = typeof ctx.provide === "function";
  if (available) ctx.provide("sandTableResources", registry);
  ctx.effect(() => () => registry.dispose(), "sand-table: resource registry");
  async function request(args) {
    if (!["read", "open"].includes(args?.action))
      throw Error("资源操作只能是读取或打开。");
    const binding = dataOf(
      await mcp.callTool("app_resource", { ...args, action: "binding" }),
    );
    if (binding.ref.providerId === "sand-table.board")
      return dataOf(await mcp.callTool("app_resource", args));
    const value = await registry[args.action](binding.ref);
    const current = dataOf(
      await mcp.callTool("app_resource", { ...args, action: "binding" }),
    );
    if (JSON.stringify(binding) !== JSON.stringify(current))
      throw Error("资源读取期间工作空间或引用已变化，请重新读取。");
    return { ...binding, value };
  }
  return { registry, available, request };
}
