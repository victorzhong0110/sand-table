const { createHash } = require("node:crypto");
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");
function persistMcpRuntime({ execPath, workbenchRoot, userData }) {
  const source = path.dirname(execPath),
    relativeWorkbench = path.relative(source, workbenchRoot);
  if (relativeWorkbench.startsWith("..") || path.isAbsolute(relativeWorkbench))
    throw Error("工作台不在应用目录内，无法保存便携 MCP 运行时。");
  const root = path.join(userData, "mcp-runtime");
  const inside = path.relative(source, root);
  if (
    !inside.startsWith(`..${path.sep}`) &&
    inside !== ".." &&
    !path.isAbsolute(inside)
  )
    throw Error("MCP 持久目录不能位于便携应用临时目录内。");
  const hash = createHash("sha256");
  function fingerprint(dir, prefix = "") {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (item.name === "node_modules") continue;
      const name = path.join(prefix, item.name);
      if (item.isDirectory()) fingerprint(path.join(dir, item.name), name);
      else if (item.isFile())
        hash.update(name).update(readFileSync(path.join(dir, item.name)));
    }
  }
  fingerprint(workbenchRoot);
  hash.update(readFileSync(execPath));
  const target = path.join(root, hash.digest("hex").slice(0, 24));
  const result = {
    command: path.join(target, path.basename(execPath)),
    bridge: path.join(target, relativeWorkbench, "local", "bridge.ts"),
  };
  if (
    !existsSync(path.join(target, ".complete")) ||
    !existsSync(result.command) ||
    !existsSync(result.bridge)
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(path.join(root, ".preparing-"));
    try {
      cpSync(source, staging, { recursive: true });
      writeFileSync(path.join(staging, ".complete"), "1");
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return result;
}
module.exports = { persistMcpRuntime };
