import { fileURLToPath } from "node:url";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * MCP 客户端条目：客户端按它启动一个 stdio 进程，与工作台共享同一张板。
 * 打包成桌面版后，命令是应用自己的可执行文件，需要附带运行环境变量
 * （例如 ELECTRON_RUN_AS_NODE=1），否则客户端会拉起界面而不是桥接进程。
 */
export type McpEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export function connectionConfig(
  sessionFile: string,
  entry?: McpEntry,
  platform = process.platform,
) {
  const args = [
    "--experimental-strip-types",
    fileURLToPath(new URL("./bridge.ts", import.meta.url)),
    "--session-file",
    sessionFile,
  ];
  const resolved: McpEntry = {
    command: entry?.command ?? process.execPath,
    args: entry?.args ?? args,
    ...(entry?.env ? { env: entry.env } : {}),
  };
  const cliQuote =
    platform === "win32"
      ? (value: string) => `'${value.replaceAll("'", "''")}'`
      : quote;
  const envArgs = Object.entries(resolved.env ?? {}).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
  const envToml = Object.keys(resolved.env ?? {}).length
    ? `\n[mcp_servers.sand-table.env]\n${Object.entries(resolved.env ?? {})
        .map(
          ([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`,
        )
        .join("\n")}\n`
    : "";
  return {
    json: JSON.stringify({ mcpServers: { "sand-table": resolved } }, null, 2),
    codex: `codex mcp add sand-table ${[...envArgs, "--", resolved.command, ...resolved.args].map(cliQuote).join(" ")}`,
    toml: `[mcp_servers.sand-table]\ncommand = ${JSON.stringify(resolved.command)}\nargs = ${JSON.stringify(resolved.args)}\n${envToml}`,
  };
}
