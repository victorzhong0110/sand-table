// Dependency-free entry point for a fresh clone; no root npm install required.
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const dir = fileURLToPath(new URL("../workbench/", import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error("Sand Table 需要 Node.js 22.18 或更新版本。请先更新 Node.js。");
  process.exit(1);
}
if (!process.argv.slice(2).length) {
  console.error(
    "用法：npm start -- /absolute/path/to/repository\n或：npm start -- --workspace name=/absolute/path/to/repository",
  );
  process.exit(1);
}
let active;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => active?.kill(signal));

async function run(command, args) {
  await new Promise((resolve, reject) => {
    active = spawn(command, args, { cwd: dir, stdio: "inherit", shell: false });
    active.on("error", reject);
    active.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function newest(path) {
  const stat = statSync(path);
  if (stat.isFile()) return stat.mtimeMs;
  return Math.max(
    stat.mtimeMs,
    ...readdirSync(path).map((name) => newest(join(path, name))),
  );
}
try {
  const lock = createHash("sha256")
      .update(readFileSync(join(dir, "package-lock.json")))
      .digest("hex"),
    marker = join(dir, "node_modules/.sand-lock-sha");
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== lock) {
    console.log("正在安装 Sand Table 的固定版本依赖（首次启动需要联网）…");
    await run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    writeFileSync(marker, lock);
  }
  const output = join(dir, "dist/host.js");
  const inputs = [
    "board",
    "local",
    "core",
    "server",
    "scripts",
    "board.html",
    "vite.config.ts",
    "package.json",
  ].map((p) => join(dir, p));
  if (
    !existsSync(output) ||
    !existsSync(join(dir, "dist/board.html")) ||
    Math.max(...inputs.map(newest)) > statSync(output).mtimeMs
  ) {
    console.log("正在构建工作台…");
    await run(npm, ["run", "build"]);
  }
  await run(process.execPath, [
    "--experimental-strip-types",
    "local/main.ts",
    ...process.argv.slice(2),
  ]);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
