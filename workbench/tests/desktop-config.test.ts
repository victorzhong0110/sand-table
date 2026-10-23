import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionConfig } from "../local/config.ts";
test("全部桌面 MCP 配置保留环境与参数", () => {
  const entry = {
    command: "C:/Program Files/O'Brien/$app.exe",
    args: ["--experimental-strip-types", "C:/资料/bridge.ts"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const c = connectionConfig("ignored", entry, "win32");
  assert.deepEqual(JSON.parse(c.json).mcpServers["sand-table"], entry);
  assert.match(c.codex, /--env.*ELECTRON_RUN_AS_NODE=1/);
  assert.ok(c.codex.includes("'C:/Program Files/O''Brien/$app.exe'"));
  assert.ok(c.toml.includes('"ELECTRON_RUN_AS_NODE" = "1"'));
  assert.ok(c.toml.includes("args = " + JSON.stringify(entry.args)));
});
