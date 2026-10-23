const { test } = require("node:test"),
  assert = require("node:assert/strict");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
const { persistMcpRuntime } = require("../main/mcp-runtime.cjs");
test("便携临时目录删除后 MCP 入口与脚本仍存在", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sand-portable-"));
  const source = path.join(root, "temp"),
    workbenchRoot = path.join(source, "resources", "workbench"),
    execPath = path.join(source, "SandTable.exe");
  mkdirSync(path.join(workbenchRoot, "local"), { recursive: true });
  writeFileSync(execPath, "fake-exe");
  writeFileSync(
    path.join(workbenchRoot, "local", "bridge.ts"),
    'console.log("bridge-ready");',
  );
  try {
    const options = {
      execPath,
      workbenchRoot,
      userData: path.join(root, "user"),
    };
    const saved = persistMcpRuntime(options);
    assert.deepEqual(persistMcpRuntime(options), saved);
    rmSync(source, { recursive: true });
    assert.equal(readFileSync(saved.command, "utf8"), "fake-exe");
    const run = spawnSync(process.execPath, [saved.bridge], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /bridge-ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
