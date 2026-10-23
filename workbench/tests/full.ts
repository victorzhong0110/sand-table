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
    "--code-board",
    "--session-file",
    sessionFile,
    "--workspace",
    "clsx=" + repo,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    // 测试之间互不干扰，也不碰用户真实的工作空间
    env: { ...process.env, SAND_WORKSPACE_DIR: join(root, "workspaces") },
  },
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
      .replace("$" + "{__dirname}", unpacked)
      .replace("$" + "{user_config.connection_file}", sessionFile),
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: bundleArgs,
      cwd: unpacked,
    }),
  );
  assert.ok(
    config.args.includes(sessionFile),
    "Generated JSON and portable bundle point to the same connection file.",
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return resultData(r);
  };
  const boards = await call("sand_list_boards"),
    boardId = boards.boards[0].boardId;
  const readBoard = () => call("sand_read_board", { boardId });
  const untilBoard = async (predicate: (b: any) => boolean) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const b = await readBoard();
      if (predicate(b)) return b;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw Error("Board did not reach expected state after UI operation.");
  };
  /* 界面上的按钮是异步写：点了不等它落到服务端，下一步就可能读到旧状态。
     提案的「确认这一版」就是这种——确认没记上就 prepare，会被服务端拒绝。 */
  const untilProposal = async (
    proposalId: string,
    predicate: (p: any) => boolean,
  ) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const p = await call("sand_read_proposal", { boardId, proposalId });
      if (predicate(p)) return p;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw Error("Proposal did not reach expected state after UI operation.");
  };
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
  // The UI writes the intent asynchronously; give the board a moment to settle
  // so the MCP read below does not race the write.
  await untilBoard((b: any) => b.intents.length > 0);
  const intents = await call("sand_read_intents", { boardId }),
    intent = intents[0];
  assert.ok(intent, "The UI-submitted intent should be readable through MCP.");
  assert.equal(intent.allowedFiles[0].path, "src/index.js");
  const file = intent.allowedFiles[0],
    before = readFileSync(join(repo, file.path), "utf8");
  const target = await call("sand_read_target", {
    boardId,
    intentId: intent.id,
    ...file,
  });
  const after = before.replace(
    "return str;\n}\n\nexport default",
    "return 'label:' + str;\n}\n\nexport default",
  );
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
  await untilProposal(proposal.id, (p: any) => p.decision === "accepted");
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
  await frame.getByText("查看报告输出", { exact: true }).click();
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
  await frame
    .locator(".breadcrumbs")
    .getByRole("button", { name: "研究比较白板", exact: true })
    .waitFor();
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
  // 内容在对象里，实例只是展示（P2 的对象/展示分离）。
  const chartData = (b: any, instance: any) =>
    b.contentObjects.find(
      (o: any) =>
        o.id === (instance.binding || {}).objectId ||
        o.id === instance.objectId,
    )?.data;
  b = await untilBoard(
    (b) =>
      chartData(
        b,
        b.instances.find((c: any) => c.id === chart.id),
      )?.points?.[1]?.value === 15,
  );
  assert.equal(
    chartData(
      b,
      b.instances.find((c: any) => c.id === chart.id),
    )?.points[1].value,
    15,
  );
  await frame
    .locator('[data-instance-id="' + chart.id + '"] svg.component-chart')
    .waitFor();
  await frame.getByRole("button", { name: /编排/ }).first().click();
  const card = frame.locator('[data-instance-id="' + chart.id + '"]');
  await card.focus();
  const width = b.instances.find((c: any) => c.id === chart.id).rect.width;
  await card.press("Alt+ArrowRight");
  b = await untilBoard(
    (b) =>
      b.instances.find((c: any) => c.id === chart.id).rect.width === width + 10,
  );
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
  await frame
    .locator('[data-instance-id="' + unknown.instances.at(-1).id + '"]')
    .waitFor();
  await frame
    .getByRole("combobox", { name: "组件类型", exact: true })
    .selectOption("resource");
  await frame
    .getByRole("textbox", { name: "组件名称", exact: true })
    .fill("本次会话附件");
  await frame.getByRole("button", { name: "添加组件", exact: true }).click();
  await frame.locator('input[type="file"]').setInputFiles({
    name: "one-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3h8AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await frame.locator(".component-card img").waitFor();
  assert.equal(
    await frame
      .locator(".component-card img")
      .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    1,
  );
  await frame.getByRole("tab", { name: "外观", exact: true }).click();
  await frame.locator('input[type="color"]').first().fill("#e8f0ff");
  await frame
    .getByRole("button", { name: "应用自定义外观", exact: true })
    .click();
  b = await untilBoard((b) => b.theme?.background === "#e8f0ff");
  assert.equal(b.theme.background, "#e8f0ff");
  assert.equal(
    await frame
      .locator("main")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--bg").trim()),
    "#e8f0ff",
  );
  assert.equal(await frame.locator('[role="alert"]').count(), 0);
  await page.screenshot({
    path: "artifacts/nested-custom-workbench.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "FULL WORKFLOW PASSED: explicit intent, exact browser confirmation, independent host write, external-code assertion, actual scope verification, nested research components, chart form, keyboard resize, unknown component, media attachment and custom theme.",
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
