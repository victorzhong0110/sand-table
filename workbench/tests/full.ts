import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright";
import { readConnection } from "../local/session.ts";
import { resultData } from "../core/results.ts";
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
    "--workspace",
    "clsx=" + repo,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "",
  browser,
  client: Client | undefined;
service.stderr.on("data", (d) => (logs += d));
try {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(Error(logs)), 30000);
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
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(connection.url + "#session=" + connection.token);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "项目总览", exact: true }).waitFor();
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  const config = JSON.parse(await page.locator("#json").inputValue())
    .mcpServers["sand-table"];
  client = new Client({
    name: "Scripted host workflow acceptance",
    version: "1",
  });
  await client.connect(new StdioClientTransport(config));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return resultData(r);
  };
  const boards = await call("sand_list_boards"),
    boardId = boards.boards[0].boardId;
  const readBoard = () => call("sand_read_board", { boardId });
  await page.getByRole("button", { name: "返回白板" }).click();
  await frame.getByRole("textbox", { name: "搜索对象" }).fill("src/index.js");
  await frame
    .locator(".card")
    .filter({ has: frame.locator("strong", { hasText: /^clsx$/ }) })
    .click();
  await frame.getByRole("tab", { name: "改动", exact: true }).click();
  await frame
    .getByRole("textbox", { name: "改动请求" })
    .fill("为输出增加 label: 前缀；保持原有参数转换规则。");
  await frame
    .getByRole("button", { name: "提交改动意图", exact: true })
    .click();
  const intents = await call("sand_read_intents", { boardId }),
    intent = intents[0];
  assert.equal(intent.allowedFiles[0].path, "src/index.js");
  const file = intent.allowedFiles[0],
    before = readFileSync(join(repo, file.path), "utf8");
  const target = await call("sand_read_target", {
    boardId,
    intentId: intent.id,
    ...file,
  });
  const after = before.replace("return str;", "return 'label:' + str;");
  assert.notEqual(after, before);
  const proposal = await call("sand_publish_proposal", {
    boardId,
    intentId: intent.id,
    intentVersion: intent.version,
    agentId: "Scripted external host",
    title: "Add output label",
    explanation: "Prefix final output and preserve conversion rules.",
    testPlan: "Import isolated clsx source and assert mixed-input output.",
    files: [{ ...file, beforeHash: target.hash, after }],
  });
  const pre = await client.callTool({
    name: "sand_prepare_apply",
    arguments: {
      boardId,
      proposalId: proposal.id,
      version: proposal.version,
      digest: proposal.digest,
    },
  });
  assert.equal(pre.isError, true);
  assert.equal(readFileSync(join(repo, file.path), "utf8"), before);
  await frame.getByRole("button", { name: "确认这一版" }).click();
  const args = {
    boardId,
    proposalId: proposal.id,
    version: proposal.version,
    digest: proposal.digest,
  };
  await call("sand_prepare_apply", args);
  const approved = await call("sand_read_approved_file", {
    ...args,
    fileIndex: 0,
  });
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(repo, file.path)))
      .digest("hex"),
    approved.beforeHash,
  );
  // Only this independent test host writes. The source MCP server never writes files.
  writeFileSync(join(repo, file.path), approved.after);
  const url = pathToFileURL(join(repo, file.path)).href;
  const code =
    "import assert from 'node:assert/strict'; import {clsx} from " +
    JSON.stringify(url) +
    "; assert.equal(clsx('x',{yes:true},[false,'y']),'label:x yes y'); console.log('mixed-input assertion passed');";
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { encoding: "utf8" },
  );
  let v = await call("sand_verify_proposal", {
    boardId,
    proposalId: proposal.id,
  });
  assert.equal(v.state, "matches");
  await call("sand_report_validation", {
    ...args,
    agentId: "Scripted external host",
    workspaceId: file.workspaceId,
    command: "node --input-type=module -e <isolated mixed-input assertion>",
    environment:
      "Node " + process.version + "; Linux test host; isolated clsx copy",
    outcome: "passed",
    output,
  });
  await frame.getByRole("button", { name: "核对实际结果" }).click();
  await frame
    .getByText("mixed-input assertion passed", { exact: false })
    .waitFor();
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/confirmed-change.png",
    fullPage: true,
  });
  writeFileSync(join(repo, "outside.md"), "unexpected host edit");
  v = await call("sand_verify_proposal", { boardId, proposalId: proposal.id });
  assert.equal(v.state, "diverged");
  await frame.getByRole("button", { name: "核对实际结果" }).click();
  await frame.getByRole("tab", { name: "组件", exact: true }).click();
  await frame
    .getByRole("button", { name: "添加研究比较白板", exact: true })
    .click();
  let b = await readBoard(),
    view = Object.values(b.views).find((v: any) =>
      v.selection.some((id: string) =>
        b.instances.some((c: any) => c.id === id && c.type === "board"),
      ),
    ) as any;
  const entry = b.instances.find((c: any) => c.id === view.selection[0]);
  await frame.locator('[data-instance-id="' + entry.id + '"]').dblclick();
  await frame.getByRole("button", { name: "总览", exact: true }).waitFor();
  b = await readBoard();
  const chart = b.instances.find(
    (c: any) => c.spaceId === entry.data.spaceId && c.type === "chart",
  );
  assert.ok(chart);
  await frame.locator('[data-instance-id="' + chart.id + '"]').click();
  // Use the normal form, not raw JSON, for non-code data.
  await frame
    .getByRole("textbox", { name: /数据.*每行/ })
    .fill("基线,10\n实验,15");
  await frame.getByRole("button", { name: "保存组件", exact: true }).click();
  b = await readBoard();
  assert.equal(
    b.instances.find((c: any) => c.id === chart.id).data.points[1].value,
    15,
  );
  await frame.locator('[data-instance-id="' + chart.id + '"] svg').waitFor();
  await frame.getByRole("button", { name: /编排/ }).first().click();
  const card = frame.locator('[data-instance-id="' + chart.id + '"]');
  await card.focus();
  const width = b.instances.find((c: any) => c.id === chart.id).rect.width;
  await card.press("Alt+ArrowRight");
  b = await readBoard();
  assert.equal(
    b.instances.find((c: any) => c.id === chart.id).rect.width,
    width + 10,
  );
  const unknown = await call("sand_edit_space", {
    boardId,
    revision: b.revision,
    viewId: view.id,
    author: "test host",
    operation: {
      kind: "create",
      type: "future-domain-widget",
      title: "未知扩展",
      data: { preserved: "yes" },
    },
  });
  assert.equal(unknown.instances.at(-1).data.preserved, "yes");
  await frame.getByRole("tab", { name: "外观", exact: true }).click();
  await frame.locator('input[type="color"]').first().fill("#e8f0ff");
  await frame
    .getByRole("button", { name: "应用自定义外观", exact: true })
    .click();
  await page.screenshot({
    path: "artifacts/nested-custom-workbench.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "FULL WORKFLOW PASSED: explicit intent, exact browser confirmation, independent host write, external-code assertion, actual scope verification, nested research components, chart form, keyboard resize, unknown component and custom theme.",
  );
} finally {
  await client?.close().catch(() => {});
  await browser?.close();
  service.kill("SIGTERM");
  if (service.exitCode === null)
    await Promise.race([
      once(service, "exit"),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  rmSync(root, { recursive: true, force: true });
}
