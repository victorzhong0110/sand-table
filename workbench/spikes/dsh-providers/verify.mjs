import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), "sand-dsh-providers-"));
const cli = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
const results = [];

async function phase(name) {
  const reportPath = join(runtime, name + ".json");
  const patch = join(runtime, name + ".yml");
  await writeFile(
    patch,
    JSON.stringify([
      {
        insert: [
          {
            id: "sand-table-provider-probe",
            name: join(root, "probe.mjs"),
            config: { phase: name, reportPath, workspace: runtime },
          },
        ],
      },
    ]),
  );
  const child = spawn(
    process.execPath,
    [cli, "--profile", "sdk-minimal", "--patch", patch],
    {
      cwd: root,
      env: { ...process.env, DSH_HOME: join(runtime, "home") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (data) => {
    errors = (errors + data).slice(-6000);
  });
  child.stdout.resume();
  const closed = new Promise((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  try {
    const deadline = Date.now() + 30000;
    let report;
    while (Date.now() < deadline) {
      try {
        report = JSON.parse(await readFile(reportPath, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (child.exitCode !== null)
        throw Error("DSH exited before probe: " + errors);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(report, "DSH probe timed out: " + errors);
    assert.equal(report.ok, true, JSON.stringify(report));
    child.stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "shutdown",
        params: {},
      }) + "\n",
    );
    const code = await Promise.race([
      closed,
      new Promise((resolve) =>
        setTimeout(() => resolve("timeout"), 5000).unref(),
      ),
    ]);
    assert.equal(code, 0, "DSH clean shutdown: " + errors);
    return report;
  } finally {
    if (child.exitCode === null) {
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
  }
}

try {
  results.push(await phase("write"));
  results.push(await phase("read"));
  console.log(
    JSON.stringify(
      {
        dsh: "0.2.2-rc.1",
        node: process.version,
        platform: process.platform,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(runtime, { recursive: true, force: true });
}
