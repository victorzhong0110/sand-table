import { fileURLToPath } from "node:url";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function connectionConfig(sessionFile: string) {
  const args = [
    "--experimental-strip-types",
    fileURLToPath(new URL("./bridge.ts", import.meta.url)),
    "--session-file",
    sessionFile,
  ];
  const entry = { command: process.execPath, args };
  return {
    json: JSON.stringify({ mcpServers: { "sand-table": entry } }, null, 2),
    codex: `codex mcp add sand-table -- ${[entry.command, ...args].map(quote).join(" ")}`,
    toml: `[mcp_servers.sand-table]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(args)}\n`,
  };
}
