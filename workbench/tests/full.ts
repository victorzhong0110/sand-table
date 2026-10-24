import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright";
import { readConnection } from "../local/session.ts";
import { resultData } from "../board/data-client/results.ts";

const external = process.env.SAND_EXTERNAL_REPO;
if (!external)
  throw Error("Set SAND_EXTERNAL_REPO to the pinned clsx checkout.");
const root = mkdtempSync(join(tmpdir(), "sand-full-")),
  repo = join(root, "external-copy"),
  sessionFile = join(root, "connection.json");
execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", external, repo],
  { stdio: "pipe" },
);
const service = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "local/main.ts",
    "--no-open",
    "--session-file",
    sessionFile,
    "--workspace-dir",
    join(root, "workspaces"),
    "--workspace-id",
    "full",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "",
  browser,
  client: Client | undefined;
service.stderr.on("data", (d) => (logs += d));
try {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(Error(logs)), 60000);
    service.stdout.on("data", (d) => {
      logs += d;
      if (logs.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    service.once("exit", (code) => {
      clearTimeout(t);
      reject(Error("Service exited " + code + ": " + logs));
    });
  });
  const connection = readConnection(sessionFile);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(connection.url + "#session=" + connection.token);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  const config = JSON.parse(await page.locator("#json").inputValue())
    .mcpServers["sand-table"];
  const unpacked = join(root, "standalone-bundle");
  mkdirSync(unpacked);
  execFileSync("python3", [
    "-m",
    "zipfile",
    "-e",
    "artifacts/sand-table.mcpb",
    unpacked,
  ]);
  const manifest = JSON.parse(
    readFileSync(join(unpacked, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.manifest_version, "0.3");
  assert.ok(
    !readFileSync(join(unpacked, "manifest.json"), "utf8").includes(
      connection.token,
    ),
  );
  const bundleArgs = manifest.server.mcp_config.args.map((arg: string) =>
    arg
      .replace("${__dirname}", unpacked)
      .replace("${user_config.connection_file}", sessionFile),
  );
  client = new Client({
    name: "Scripted host workflow acceptance",
    version: "1",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: bundleArgs,
      cwd: unpacked,
    }),
  );
  assert.ok(config.args.includes(sessionFile));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return resultData(r);
  };
  const status = await call("sand_status");
  assert.equal(typeof status.homeBoardId, "string");
  await call("app_edit", {
    commands: [{ op: "pack.enable", id: "code" }],
  });
  const imported = await call("code_repo", { action: "import", path: repo });
  assert.equal(typeof imported.repositoryId, "string");
  const files = await call("sand_query", {
    types: ["code.file"],
    text: "index.js",
    limit: 20,
  });
  assert.ok(
    (files.rows as { title: string }[]).some((row) =>
      row.title.includes("index.js"),
    ),
  );
  await page.getByRole("button", { name: "返回白板" }).click();
  await frame
    .getByRole("button", { name: "便签", exact: true })
    .dragTo(frame.locator(".canvas"), { targetPosition: { x: 240, y: 180 } });
  await frame.locator(".component-card").first().waitFor();
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/confirmed-change.png" });
  await page.screenshot({ path: "artifacts/nested-custom-workbench.png" });
  assert.deepEqual(errors, []);
  console.log("Full passed: bundle, import, blank board note.");
} finally {
  await browser?.close();
  await client?.close();
  if (service.exitCode === null) {
    service.kill("SIGTERM");
    await once(service, "exit").catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true });
}
