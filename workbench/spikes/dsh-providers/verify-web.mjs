import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocal } from "../../local/service.ts";

const root = dirname(fileURLToPath(import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), "sand-dsh-web-"));
const cli = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
const reportPath = join(runtime, "report.json");
const patch = join(runtime, "probe.yml");
const sessionFile = join(runtime, "connection.json");
let local, child, closed;
try {
  local = await startLocal({
    workspaces: [],
    sessionFile,
    workspaceDir: join(runtime, "boards"),
  });
  // Absolute paths are generated for this run; nothing points at the user's DSH home.
  await writeFile(
    patch,
    JSON.stringify([
      {
        insert: [
          {
            id: "sand-table",
            name: resolve(root, "../../dsh-plugin/index.js"),
            config: {
              workspaceDir: join(runtime, "boards"),
              sessionFile,
              serverEntry: resolve(root, "../../local/bridge.ts"),
              boardUrl: new URL("/embed", local.url).href,
            },
          },
          {
            id: "dsh-context",
            name: join(root, "node_modules/dsh-context/lib/index.js"),
          },
          {
            id: "sand-table-web-probe",
            name: join(root, "web-probe.mjs"),
            config: { reportPath, workspace: runtime },
          },
        ],
      },
    ]),
  );
  child = spawn(
    process.execPath,
    [cli, "--profile", "web", "--patch", patch, "--no-open", "--port", "0"],
    {
      cwd: root,
      env: { ...process.env, DSH_HOME: join(runtime, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (data) => {
    log = (log + data).slice(-12000);
  });
  child.stderr.on("data", (data) => {
    log = (log + data).slice(-12000);
  });
  closed = new Promise((resolve) => child.once("exit", resolve));
  let report;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(report, log.replace(/token=[^\s]+/g, "token=REDACTED"));
  assert.equal(report.ok, true, JSON.stringify(report));
  console.log(
    JSON.stringify(
      { dsh: "0.2.2-rc.1", node: process.version, ...report },
      null,
      2,
    ),
  );
} finally {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  await local?.close();
  await rm(runtime, { recursive: true, force: true });
}
