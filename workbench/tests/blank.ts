import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readConnection } from "../local/session.ts";
import { resultData } from "../board/data-client/results.ts";
import { V3Store } from "../board/data-client/store.ts";
import { toCommands, toBoard } from "../board/data-client/adapter.ts";
const root = mkdtempSync(join(tmpdir(), "sand-blank-")),
  sessionFile = join(root, "connection.json");
const service = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "../scripts/start-workbench.mjs",
    "--no-open",
    "--session-file",
    sessionFile,
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
    /* 沙箱里这套构建与握手要几十秒：给足时间，别把慢当成失败。 */
    const t = setTimeout(() => reject(Error(logs)), 300000);
    service.stdout.on("data", (d) => {
      logs += d;
      if (logs.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    service.once("exit", (c) => {
      clearTimeout(t);
      reject(Error("Exited " + c + ": " + logs));
    });
  });
  const c = readConnection(sessionFile);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(c.url + "#session=" + c.token);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  assert.equal(await frame.locator(".component-card").count(), 0);
  assert.equal(await frame.locator(".studio-inspector").count(), 0);
  assert.equal(await frame.getByText("代码入口", { exact: true }).count(), 0);
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/blank-canvas.png", fullPage: true });
  await page.getByRole("button", { name: "连接我的 AI", exact: true }).click();
  const config = JSON.parse(await page.locator("#json").inputValue())
    .mcpServers["sand-table"];
  client = new Client({
    name: "Scripted blank-canvas acceptance; not a model",
    version: "1",
  });
  await client.connect(new StdioClientTransport(config), {
    timeout: 300000,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool(
      { name, arguments: args },
      { timeout: 300000 },
    );
    assert.ok(!r.isError, JSON.stringify(r));
    return resultData(r);
  };
  /* v3 时界面走的是 v3 的工具面：读白板、增量同步、历史导航都不一样。
     两种工具面读出来的白板形状是一样的（界面这一层负责翻译），
     所以下面的断言两边通用。 */
  const v3 = true;
  const store = v3 ? new V3Store(call) : undefined;
  const boardId = v3
    ? (await call("sand_status")).homeBoardId
    : (await call("sand_list_boards")).boards[0].boardId;
  /* 视角：v3 的内核没有读接口，选择与镜头从内核的视图里读。 */
  const v3View = async () => {
    /* 界面正在看的视角：内核的视图表没有读接口，
       sand_context 给的是最近更新过的那一个视角。 */
    const context: any = await call("sand_context", {});
    return {
      id: "view",
      /* 界面正在看的那块白板：进到子白板以后读的就是子白板。 */
      spaceId: context?.board?.id ?? boardId,
      /* sand_context 给的是选中对象，界面这一侧要的是展示编号。 */
      selection: (context?.selection ?? []).map((s: any) => s.presentationId),
      camera: { x: 0, y: 0, zoom: 1 },
      updatedAt: Date.now(),
    };
  };
  const read = async () => {
    if (!v3) return call("sand_read_board", { boardId });
    const view = await v3View();
    await store!.load(view.spaceId);
    return toBoard(store!.cache, { boardId: view.spaceId, view });
  };
  /* 界面自己的一次写入：v2 走 sand_edit_space，v3 走 app_edit。 */
  const editSpace = async (operation: any, author = "Protocol probe") => {
    if (!v3) {
      const b = await read();
      return call("sand_edit_space", {
        boardId,
        revision: b.revision,
        viewId: Object.keys(b.views ?? {})[0] ?? "",
        author,
        operation,
      });
    }
    /* 视角由界面自己掌握：测试不替界面改视角，也不改它看到的东西。 */
    if (["select", "camera", "navigate"].includes(operation.kind)) return;
    /* 写在哪块白板上：界面正在看的那一块（进到子白板以后就是子白板）。 */
    const view = await v3View();
    const commands = toCommands(operation, {
      boardId: view.spaceId,
      objects: store!.cache.objects,
      presentations: store!.cache.presentations,
    });
    return call("app_edit", { commands });
  };
  /* 历史：v2 给的是快照，v3 给的是时间线，形状在这里对齐。 */
  const readHistory = async () => {
    if (!v3) return call("sand_history", { boardId });
    const data: any = await call("app_history", { action: "list", limit: 100 });
    const entries: any[] = data?.entries ?? [];
    const cursorId: string | undefined = data?.cursorId ?? undefined;
    const cursor = entries.find((e) => e.id === cursorId);
    const cursorSeq = cursor?.seq ?? 0;
    return {
      boardId,
      cursorId,
      records: entries.map((e) => ({
        id: e.id,
        label: e.label,
        at: e.at,
        author: e.actorKind === "agent" ? "Agent" : "人",
        authorKind: e.actorKind,
        intentId: "",
        parentId: e.parentId ?? undefined,
        seq: e.seq,
        current: Boolean(e.current),
        onPath: Boolean(e.onCurrentPath),
        ahead: !e.current && !e.onCurrentPath && e.seq > cursorSeq,
        branch: !e.current && !e.onCurrentPath && e.seq <= cursorSeq,
      })),
      canUndo: Boolean(cursor && cursor.parentId),
      canRedo: entries.some((e) => e.parentId === cursorId),
      note: "",
    };
  };
  const undo = async () =>
    v3
      ? call("app_history", { action: "undo" })
      : call("sand_undo", { boardId });
  const redo = async () =>
    v3
      ? call("app_history", { action: "redo" })
      : call("sand_redo", { boardId });
  const jumpTo = async (recordId: string) =>
    v3
      ? call("app_history", { action: "jump", entryId: recordId })
      : call("sand_undo_to", { boardId, recordId });
  const until = async (test: (b: any) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const b = await read();
      if (test(b)) return b;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw Error("Expected state not reached.");
  };
  /* 按键前要等界面把选区画出来。
     画布上的 Delete / Esc 读的是界面这一版板面（SpaceCanvas 的 selection），
     只等服务端会差半拍：服务端先记下选中，浏览器还没收到回话，
     这时按下的键会落在空选区上，什么都不发生。
     测试确认可见选区；快速点击后的键盘响应另由产品的待确认选区保证。 */
  const untilUiSelection = async (count: number) => {
    for (let i = 0; i < 150; i++) {
      if ((await frame.locator(".component-card.selected").count()) === count) {
        return;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    throw Error("The board never showed the expected selection.");
  };
  /* #10: the zoom bar's five controls must stay visible and clickable. A "放大"
     button that silently disappeared was reported; visibility is asserted
     here so it cannot regress unnoticed. The ruler in the issue is "any
     window size, any zoom level, any panel state", so all three are swept. */
  const assertZoomBarUsable = async (label: string) => {
    const zoom = frame.locator(".zoom");
    await zoom.waitFor();
    const measured = await zoom.evaluate((el) => {
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const bar = el.getBoundingClientRect();
      return {
        view: { w: win.innerWidth, h: win.innerHeight },
        bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height },
        controls: Array.from(el.querySelectorAll("button")).map((b) => {
          const r = b.getBoundingClientRect();
          const hit = doc.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          return {
            name: b.getAttribute("aria-label") || b.textContent || "",
            width: r.width,
            height: r.height,
            x: r.x,
            y: r.y,
            covered: !(hit === b || (hit && b.contains(hit))),
          };
        }),
      };
    });
    assert.ok(
      measured.controls.length >= 4,
      `The zoom bar lost controls (${label}).`,
    );
    for (const c of measured.controls) {
      assert.ok(
        c.width > 0 && c.height > 0,
        `Zoom control "${c.name}" has no box (${label}).`,
      );
      assert.ok(
        !c.covered,
        `Zoom control "${c.name}" is covered by another element (${label}).`,
      );
      assert.ok(
        c.x >= 0 &&
          c.y >= 0 &&
          c.x + c.width <= measured.view.w &&
          c.y + c.height <= measured.view.h,
        `Zoom control "${c.name}" sits outside the viewport (${label}).`,
      );
    }
  };
  let b = await read();
  assert.equal(b.workspaces.length, 0);
  assert.equal(b.instances.length, 0);
  assert.equal(
    v3
      ? ((await call("sand_context", {})).selection ?? []).length
      : (await call("sand_read_context", { boardId })).contextLimits
          .selectedInstances,
    0,
  );
  await page.getByRole("button", { name: "返回白板" }).click();
  /* #10: the zoom bar's five controls stay visible and clickable. */
  await assertZoomBarUsable("default 1440x1000");
  for (let i = 0; i < 3; i++) {
    await frame.getByRole("button", { name: "缩小" }).click();
    await page.waitForTimeout(120);
  }
  await assertZoomBarUsable("zoomed out");
  /* Zoom back in to where the canvas started. The rest of this test measures
     sizes in screen pixels, so the zoom has to be back at 100%. */
  for (let i = 0; i < 3; i++) {
    await frame.getByRole("button", { name: "放大" }).click();
    await page.waitForTimeout(120);
  }
  await assertZoomBarUsable("zoomed back in");
  /* The zoom level the report used is unknown, so the extremes are swept as
     well: the bar has to survive being pushed all the way in and out. */
  for (let i = 0; i < 10; i++) {
    await frame.getByRole("button", { name: "缩小" }).click();
    await page.waitForTimeout(60);
  }
  await assertZoomBarUsable("zoomed all the way out");
  for (let i = 0; i < 10; i++) {
    await frame.getByRole("button", { name: "放大" }).click();
    await page.waitForTimeout(60);
  }
  await assertZoomBarUsable("zoomed all the way in");
  await frame.getByRole("button", { name: "复位", exact: true }).click();
  await page.waitForTimeout(150);
  await assertZoomBarUsable("reset");
  /* Any window size: the bar is anchored to the canvas, and the canvas has
     to stay usable when the window is narrow or short. */
  for (const size of [
    { width: 1100, height: 800 },
    { width: 820, height: 640 },
    { width: 600, height: 900 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(200);
    await assertZoomBarUsable(`window ${size.width}x${size.height}`);
  }
  const canvasBeforeDrop = await frame.locator(".canvas").boundingBox();
  await frame
    .getByRole("button", { name: "便签", exact: true })
    .dragTo(frame.locator(".canvas"), { targetPosition: { x: 300, y: 240 } });
  b = await until((b) => b.instances.some((i: any) => i.type === "text"));
  /* #10: the bar has to survive the panels being open as well. */
  await assertZoomBarUsable("properties panel open");
  assert.ok(b.instances[0].rect.x > 100);
  const placed = await frame
    .locator('[data-instance-id="' + b.instances[0].id + '"]')
    .boundingBox();
  assert.ok(placed && canvasBeforeDrop);
  assert.ok(
    Math.abs(placed.x - (canvasBeforeDrop.x + 300)) < 4,
    "Drop preserves the requested horizontal position.",
  );
  assert.ok(
    Math.abs(placed.y - (canvasBeforeDrop.y + 240)) < 4,
    "Drop accounts for the world origin, not just the camera.",
  );

  /* #9.2: a component can be dragged straight on the canvas. The arrange
     mode is not a precondition — the person does not have to know that a
     mode exists. */
  const card = frame.locator('[data-instance-id="' + b.instances[0].id + '"]');
  const dragTo = async (dx: number, dy: number) => {
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      box.y + box.height / 2 + dy,
      { steps: 8 },
    );
    await page.mouse.up();
  };
  const beforeDrag = b.instances[0].rect;
  const historyBeforeDrag = await readHistory();
  const pathBeforeDrag = historyBeforeDrag.records.filter(
    (record: { onPath?: boolean }) => record.onPath,
  ).length;
  await dragTo(60, 40);
  b = await until(
    (board) =>
      Math.abs(board.instances[0].rect.x - (beforeDrag.x + 60)) < 2 &&
      Math.abs(board.instances[0].rect.y - (beforeDrag.y + 40)) < 2,
  );
  const historyAfterDrag = await readHistory();
  assert.equal(
    historyAfterDrag.records.filter(
      (record: { onPath?: boolean }) => record.onPath,
    ).length,
    pathBeforeDrag + 1,
    "Dragging a card adds one history record.",
  );
  assert.ok(
    Math.abs(b.instances[0].rect.x - (beforeDrag.x + 60)) < 2 &&
      Math.abs(b.instances[0].rect.y - (beforeDrag.y + 40)) < 2,
    "The card lands where the pointer was released.",
  );
  await undo();
  b = await until(
    (board) => Math.abs(board.instances[0].rect.x - beforeDrag.x) < 0.6,
  );
  await redo();
  b = await until(
    (board) => Math.abs(board.instances[0].rect.x - (beforeDrag.x + 60)) < 2,
  );

  /* 锁住的展示不能被拖走，位置和锁定都保持。 */
  await frame.getByRole("button", { name: "固定位置", exact: true }).click();
  b = await until((board) => board.instances[0].rect.pinned === true);
  const pinned = b.instances[0].rect;
  await dragTo(-50, 30);
  await page.waitForTimeout(400);
  b = await read();
  assert.equal(b.instances[0].rect.pinned, true);
  assert.equal(b.instances[0].rect.x, pinned.x);
  assert.equal(
    b.instances[0].rect.y,
    pinned.y,
    "A locked card stays where it is.",
  );
  await frame.getByRole("button", { name: "取消固定", exact: true }).click();
  b = await until((board) => board.instances[0].rect.pinned === false);

  /* 拖出视口再拖回来时，同一张卡片的 DOM 节点必须还在。
     选中项不参与裁剪，所以先点空白处取消选择。再把画布收窄，
     指针才能停在 iframe 里、同时把卡片算到视口外。 */
  b = await read();
  const probeId = b.instances[0].id;
  const probe = frame.locator(`[data-instance-id="${probeId}"]`);
  const canvas = frame.locator(".canvas");
  await canvas.click({ position: { x: 420, y: 80 } });
  let deselected = false;
  for (let i = 0; i < 20; i++) {
    const cls = (await probe.getAttribute("class")) || "";
    if (!cls.includes("selected")) {
      deselected = true;
      break;
    }
    await page.waitForTimeout(50);
  }
  assert.equal(deselected, true, "The probe card has to leave the selection.");
  await probe.evaluate((el) => {
    el.dataset.probe = "1";
  });
  await canvas.evaluate((el) => {
    el.style.right = "auto";
    el.style.width = "520px";
  });
  b = await read();
  const probeBefore = b.instances[0].rect;
  const probeBox = (await probe.boundingBox())!;
  const canvasBox = (await canvas.boundingBox())!;
  const zoom = await frame.locator(".world").evaluate((el) => {
    const scale = new DOMMatrixReadOnly(getComputedStyle(el).transform).a;
    return scale || 1;
  });
  const downX = probeBox.x + probeBox.width / 2;
  const downY = probeBox.y + probeBox.height / 2;
  const outsideX = canvasBox.x + canvasBox.width + probeBox.width / 2 + 180;
  const releaseX = Math.min(downX + 80, canvasBox.x + canvasBox.width - 40);
  const releaseY = downY - 30;
  await page.mouse.move(downX, downY);
  await page.mouse.down();
  await page.mouse.move(outsideX, downY, { steps: 12 });
  assert.equal(
    await probe.getAttribute("data-probe"),
    "1",
    "The card must stay mounted while it is dragged outside the viewport.",
  );
  await page.mouse.move(releaseX, releaseY, { steps: 12 });
  await page.mouse.up();
  await canvas.evaluate((el) => {
    el.style.width = "";
    el.style.right = "";
  });
  assert.equal(
    await probe.getAttribute("data-probe"),
    "1",
    "Coming back must be the same DOM node, not a remount.",
  );
  const released = {
    x: probeBefore.x + (releaseX - downX) / zoom,
    y: probeBefore.y + (releaseY - downY) / zoom,
  };
  b = await until(
    (board) =>
      Math.abs(board.instances[0].rect.x - released.x) < 0.6 &&
      Math.abs(board.instances[0].rect.y - released.y) < 0.6,
  );
  assert.ok(
    Math.abs(b.instances[0].rect.x - released.x) < 0.6 &&
      Math.abs(b.instances[0].rect.y - released.y) < 0.6,
    "The server stores the position where the pointer was released.",
  );
  await probe.click();

  /* #9.4: the property panel's content field saves itself — no button.
     内容在对象上：断言要读解析后的内容，不是实例自己的空壳。 */
  const contentText = (board: any, instance: any) => {
    const objectId = (instance.binding || {}).objectId || instance.objectId;
    const object = (board.contentObjects || []).find(
      (o: any) => o.id === objectId,
    );
    return object?.data?.text;
  };
  await frame
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("改完即存");
  b = await until((b) => contentText(b, b.instances[0]) === "改完即存");
  assert.equal(
    contentText(b, b.instances[0]),
    "改完即存",
    "Stopping typing is enough to save the content.",
  );

  /* #9.3: a double click edits the component where it sits. */
  await card.dblclick();
  const inline = frame.getByRole("textbox", { name: "就地编辑内容" });
  await inline.waitFor();
  await inline.fill("就地改过的内容");
  await inline.press("Enter");
  b = await until((b) => contentText(b, b.instances[0]) === "就地改过的内容");
  assert.equal(
    contentText(b, b.instances[0]),
    "就地改过的内容",
    "Editing on the canvas writes the component back.",
  );
  const beforeTyping = { ...b.instances[0].rect };
  await card.dblclick();
  const composing = frame.getByRole("textbox", { name: "就地编辑内容" });
  await composing.waitFor();
  await composing.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    el.dispatchEvent(new CompositionEvent("compositionupdate", { data: "测" }));
  });
  const typingBox = (await composing.boundingBox())!;
  await page.mouse.move(typingBox.x + 8, typingBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(typingBox.x + 48, typingBox.y + 36, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  b = await read();
  assert.ok(
    Math.abs(b.instances[0].rect.x - beforeTyping.x) < 0.6 &&
      Math.abs(b.instances[0].rect.y - beforeTyping.y) < 0.6,
    "Typing and IME composition do not drag the card.",
  );

  await frame.getByRole("textbox", { name: "编辑组件名称" }).fill("我的计划");
  await frame
    .getByRole("textbox", { name: "内容", exact: true })
    .fill("先收集证据，再比较方案");
  await frame.getByRole("button", { name: "保存组件", exact: true }).click();
  // 内容在对象里，实例只是展示（P2 的对象/展示分离）。
  const contentOf = (b: any, instance: any) =>
    b.contentObjects.find(
      (o: any) =>
        o.id === (instance.binding || {}).objectId ||
        o.id === instance.objectId,
    );
  b = await until(
    (b) =>
      contentOf(b, b.instances[0])?.data?.text === "先收集证据，再比较方案",
  );
  /* #9.5: the same history is reachable from outside the browser. */
  const history = await readHistory();
  assert.ok(history.records.length >= 2, "The writes are on the history.");
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
  /* 时间线模型：kind 字段已废弃，用 onPath（游标路径上 = 可撤销的那条线）。 */
  const edit = history.records.find(
    (r: any) => r.onPath && r.label.includes("我的计划"),
  );
  assert.ok(edit, "The edit is on the history with a readable label.");
  await undo();
  b = await read();
  assert.notEqual(
    contentOf(b, b.instances[0])?.title,
    "我的计划",
    "The undo reverts the last edit.",
  );
  await redo();
  b = await until((b) => contentOf(b, b.instances[0])?.title === "我的计划");
  assert.equal(
    contentOf(b, b.instances[0])?.data?.text,
    "先收集证据，再比较方案",
  );
  /* 跳到某条记录：板面回到那条记录刚发生时的样子。
     时间线按 seq 升序：最早的在前面，最新的在后面。 */
  const edits = history.records.filter((r: any) => r.onPath);
  const oldest = edits[0];
  const newest = edits.at(-1)!;
  const jumped = await jumpTo(oldest.id);
  assert.ok(jumped, "A recorded step can be jumped back to.");
  b = await read();
  assert.notEqual(
    contentOf(b, b.instances[0])?.title,
    "我的计划",
    "Jumping back to the oldest record restores the content it produced.",
  );
  assert.notEqual(
    contentOf(b, b.instances[0])?.data?.text,
    "先收集证据，再比较方案",
  );
  await jumpTo(newest.id);
  b = await until((b) => contentOf(b, b.instances[0])?.title === "我的计划");
  assert.equal(
    contentOf(b, b.instances[0])?.data?.text,
    "先收集证据，再比较方案",
    "Jumping forward to the newest edit brings the content back.",
  );
  const noteId = b.instances[0].id;
  const expandedRect = { ...b.instances[0].rect };
  assert.equal(await frame.getByRole("heading", { name: "图标库" }).count(), 0);
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  await frame.getByRole("button", { name: "图标＋标题", exact: true }).click();
  b = await until((b) => b.instances[0].appearance?.detail === "label");
  let note = frame.locator('[data-instance-id="' + noteId + '"]');
  assert.equal(Math.round((await note.boundingBox())!.height), 48);
  assert.deepEqual(
    b.instances[0].rect,
    expandedRect,
    "Folding preserves expanded geometry",
  );
  await frame.getByRole("button", { name: "仅图标", exact: true }).click();
  await until((b) => b.instances[0].appearance?.detail === "icon");
  assert.equal(Math.round((await note.boundingBox())!.width), 48);
  await frame.getByRole("button", { name: "完整界面", exact: true }).click();
  b = await until((b) => b.instances[0].appearance?.detail === "full");
  assert.deepEqual(b.instances[0].rect, expandedRect);
  assert.equal(await note.locator(".component-symbol").isVisible(), false);
  assert.equal(
    contentOf(b, b.instances[0])?.data?.text,
    "先收集证据，再比较方案",
  );
  await frame.getByRole("button", { name: "关闭设置" }).click();
  await page.screenshot({
    path: "artifacts/material-note.png",
    fullPage: true,
  });
  /* #30: 选中就能改大小、Delete 删除、Esc 取消选择——不切换任何模式。 */
  /* 板面读回来的 selection 是对象 id；视图里的才是实例 id。 */
  const selectedInstances = (board: any) =>
    Object.values(board.views as Record<string, any>).flatMap(
      (v: any) => v.selection as string[],
    );
  await frame.getByRole("button", { name: "浏览", exact: true }).click();
  const t02 = frame.locator('[data-instance-id="' + noteId + '"]');
  await frame.locator(".palette-list").evaluate((root) => {
    (window as any).__paletteDisabledChanges = 0;
    const observer = new MutationObserver((records) => {
      (window as any).__paletteDisabledChanges += records.length;
    });
    observer.observe(root, {
      attributes: true,
      subtree: true,
      attributeFilter: ["disabled"],
    });
    (window as any).__paletteObserver = observer;
  });

  await t02.click();
  b = await until((b) => selectedInstances(b).includes(noteId));
  assert.ok(
    selectedInstances(b).includes(noteId),
    "Clicking a card in browse mode selects it.",
  );
  const handle = t02.locator(".resize-handle");
  await handle.waitFor({ state: "visible" });
  const sizeBefore = b.instances[0].rect;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 + 60,
    grip.y + grip.height / 2 + 40,
    { steps: 8 },
  );
  await page.mouse.up();
  b = await until((b) => b.instances[0].rect.width > sizeBefore.width);
  assert.ok(
    b.instances[0].rect.width > sizeBefore.width &&
      b.instances[0].rect.height > sizeBefore.height,
    "Dragging the handle resizes the selected component.",
  );
  const paletteDisabledChanges = await frame
    .locator(".palette-list")
    .evaluate(() => {
      (window as any).__paletteObserver.disconnect();
      return (window as any).__paletteDisabledChanges;
    });
  assert.equal(
    paletteDisabledChanges,
    0,
    "Selecting/resizing must not flash disabled toolbox controls.",
  );
  /* Delete 移除选中的展示，对象还在。撤销一次把展示带回来。 */
  await untilUiSelection(1);
  const removedObjectId = b.instances.find(
    (i: any) => i.id === noteId,
  )?.objectId;
  await page.keyboard.press("Delete");
  b = await until((b) => !b.instances.some((i: any) => i.id === noteId));
  if (v3 && removedObjectId) {
    const still = await call("sand_read", { ids: [removedObjectId] });
    assert.ok(
      (still.objects ?? []).some(
        (object: any) => object.id === removedObjectId,
      ),
      "Delete removes the presentation, not the object.",
    );
  }
  assert.equal(
    b.instances.filter((i: any) => i.id === noteId).length,
    0,
    "Delete removes the selected component.",
  );
  await page.keyboard.press("Control+z");
  b = await until((b) => b.instances.some((i: any) => i.id === noteId));
  assert.ok(
    b.instances.some((i: any) => i.id === noteId),
    "One undo brings the removed component back.",
  );
  /* 设置中的键只影响设置，不删除卡片或改变撤销位置。 */
  await t02.click();
  await untilUiSelection(1);
  const beforeModal = await readHistory();
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  await frame.getByRole("button", { name: "关闭设置" }).focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Escape");
  await frame
    .getByRole("dialog", { name: "设置" })
    .waitFor({ state: "hidden" });
  b = await read();
  assert.ok(b.instances.some((c: any) => c.id === noteId));
  assert.ok(selectedInstances(b).includes(noteId));
  const afterModal = await readHistory();
  assert.equal(afterModal.cursorId, beforeModal.cursorId);
  /* Esc 取消选择。 */
  await t02.click();
  b = await until((b) => selectedInstances(b).includes(noteId));
  await untilUiSelection(1);
  await page.keyboard.press("Escape");
  b = await until((b) => selectedInstances(b).length === 0);
  assert.equal(selectedInstances(b).length, 0, "Escape clears the selection.");
  /* 输入框里的 Backspace 是删字，不是删组件。 */
  await t02.click();
  b = await until((b) => selectedInstances(b).includes(noteId));
  const nameField = frame.getByRole("textbox", { name: "编辑组件名称" });
  await nameField.click();
  await nameField.press("Backspace");
  await page.waitForTimeout(200);
  b = await read();
  assert.ok(
    b.instances.some((i: any) => i.id === noteId),
    "Backspace in a text field does not remove the component.",
  );
  await nameField.fill("我的计划");
  /* 第一次 Escape 归输入框（撤销改动并失焦），第二次才是取消选择。 */
  await untilUiSelection(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  b = await until((b) => selectedInstances(b).length === 0);
  /* 重新选中，属性面板回到打开的状态。 */
  await t02.click();
  b = await until((b) => selectedInstances(b).includes(noteId));
  /* 回到编排态：工具箱开着，和这段测试原本的样子一致。 */
  await frame.getByRole("button", { name: "编排", exact: true }).click();
  await frame.getByRole("button", { name: "编排", exact: true }).click();
  assert.equal(await frame.locator(".floating-tool-wrap").isVisible(), false);
  await frame.getByRole("button", { name: "编排", exact: true }).click();
  await frame.getByRole("button", { name: "关闭详情" }).click();
  /* 工具箱里的「白板」：面包屑里也有一个同名按钮，要限定在工具箱里。 */
  await frame
    .locator(".palette-list")
    .getByRole("button", { name: "白板", exact: true })
    .click();
  b = await until((b) => b.instances.some((i: any) => i.type === "board"));
  const container = b.instances.find((i: any) => i.type === "board"),
    child = container.data.spaceId;
  await frame
    .locator('[data-instance-id="' + container.id + '"]')
    .getByRole("button", { name: "进入白板" })
    .click();
  await frame
    .locator(".breadcrumbs")
    .getByRole("button", { name: "白板", exact: true })
    .waitFor();
  await frame.getByRole("heading", { name: "从一块空白开始" }).waitFor();
  await frame.getByRole("button", { name: "添加第一张便签" }).click();
  b = await until((b) =>
    b.instances.some((i: any) => i.spaceId === child && i.type === "text"),
  );
  if (v3) {
    /* v3 里每块白板是各自的对象：父白板的内容要单独读一次。 */
    await store!.load(boardId);
    const parent = toBoard(store!.cache, {
      boardId,
      view: { ...(await v3View()), spaceId: boardId },
    });
    assert.equal(
      parent.instances.filter((i: any) => i.spaceId === boardId).length,
      2,
    );
  } else
    assert.equal(
      b.instances.filter((i: any) => i.spaceId === "overview").length,
      2,
    );
  await frame
    .getByRole("button", { name: "AI 编排", exact: true })
    .first()
    .click();
  assert.equal(
    await frame.getByRole("textbox", { name: "给 AI 的编排请求" }).count(),
    0,
    "read-only MCP is not an executable AI channel",
  );
  await frame.getByRole("heading", { name: "你的 AI 怎么接入" }).waitFor();
  // A scripted external MCP client maintains the same board, without a repository.
  b = await read();
  const viewId = Object.keys(b.views)[0];
  await editSpace({
    kind: "create",
    type: "comparison",
    title: "AI 搭建的比较",
    data: {
      left: { title: "方案甲", text: "" },
      right: { title: "方案乙", text: "" },
      conclusion: "",
    },
  });
  await frame.getByText("AI 搭建的比较", { exact: true }).first().waitFor();
  b = await read();
  const comparison = b.instances.find((i: any) => i.title === "AI 搭建的比较");
  if (v3)
    await call("sand_activity", {
      state: "running",
      task: "Arrange the comparison",
      action: "Checking component data",
      objectIds: [comparison.objectId],
      boardId: comparison.spaceId,
    });
  else
    await call("sand_report_space_activity", {
      boardId,
      agentId: "Protocol probe",
      spaceId: comparison.spaceId,
      instanceIds: [comparison.id],
      task: "Arrange the comparison",
      action: "Checking component data",
      state: "running",
    });
  await frame.getByText("● Agent 有活动报告", { exact: true }).waitFor();
  await frame
    .getByRole("button", { name: "AI 编排", exact: true })
    .first()
    .click();
  await frame.getByText("Arrange the comparison", { exact: true }).waitFor();
  /* v3 的代码包（仓库导入、源码读取、代码改动）还没有接上：
     这一段只测 v2 的那条路。 */
  if (process.env.SAND_EXTERNAL_REPO && !v3) {
    await frame.getByRole("button", { name: "编排", exact: true }).click();
    await frame.getByRole("tab", { name: "仓库", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "本机仓库路径" })
      .fill(process.env.SAND_EXTERNAL_REPO);
    await frame
      .getByRole("button", { name: "导入到白板", exact: true })
      .click();
    b = await until(
      (b) =>
        b.workspaces.length === 1 &&
        b.instances.some((i: any) => i.type === "object"),
    );
    assert.equal(
      b.instances.filter((i: any) => i.spaceId === "overview").length,
      2,
      "Import stays inside the current child board.",
    );
    assert.equal(b.autoProjectSources, false);
    assert.ok(b.spaces.length > 3);
    const source =
      b.instances.find(
        (i: any) => i.type === "object" && i.title === "readme.md",
      ) || b.instances.find((i: any) => i.type === "object");
    const v = b.views[viewId];
    // Agent can explicitly focus the imported file's board and the human sees it.
    if (v.spaceId !== source.spaceId)
      await call("sand_edit_space", {
        boardId,
        revision: b.revision,
        viewId,
        author: "Protocol probe",
        operation: { kind: "navigate", spaceId: source.spaceId },
      });
    await frame.locator('[data-instance-id="' + source.id + '"]').waitFor();
    await frame.getByRole("button", { name: "浏览", exact: true }).click();
    await frame.locator('[data-instance-id="' + source.id + '"]').click();
    await until((b) => b.views[viewId].selection.includes(source.id));
    await frame
      .getByRole("button", { name: "查看源码依据", exact: true })
      .click();
    await frame.locator(".source-inspector pre.source").waitFor();
    await frame.getByRole("button", { name: "组件属性", exact: true }).click();
    await frame.getByRole("button", { name: "复制", exact: true }).waitFor();
    await frame
      .getByRole("button", { name: "源码与理解", exact: true })
      .click();
    await frame
      .getByRole("button", { name: "表达代码改动", exact: true })
      .click();
    await frame
      .getByRole("textbox", { name: "改动请求", exact: true })
      .fill("讨论这份文档的补充说明；先提出具体方案。");
    await frame
      .getByRole("button", { name: "提交改动意图", exact: true })
      .click();
    b = await until((b) => b.intents.length === 1);
    assert.equal(b.intents[0].arrangement.viewId, viewId);
    const intent = b.intents[0],
      allowed = intent.allowedFiles[0];
    const actualTarget = await call("sand_read_target", {
      boardId,
      intentId: intent.id,
      ...allowed,
    });
    assert.ok(actualTarget.hash);
  }
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  await frame.locator('input[type="color"]').first().fill("#edf2ed");
  await frame
    .getByRole("button", { name: "应用自定义外观", exact: true })
    .click();
  await until((b) => b.theme?.background === "#edf2ed");
  await page.screenshot({
    path: "artifacts/composed-canvas.png",
    fullPage: true,
  });
  assert.equal(await frame.locator('[role="alert"]').count(), 0);
  await frame.getByRole("button", { name: "关闭设置" }).click();
  b = await read();
  const motionView = Object.keys(b.views)[0];
  const zoomBefore = v3
    ? await frame
        .locator(".world")
        .evaluate(
          (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
        )
    : b.views[motionView].camera.zoom;
  await editSpace(
    {
      kind: "create",
      type: "text",
      title: "远处便签",
      data: { text: "定位目标" },
      rect: { x: 5000, y: 3000, width: 280, height: 180, pinned: false },
    },
    "Motion probe",
  );
  b = await read();
  const farId = b.instances.find((i: any) => i.title === "远处便签").id;
  await editSpace({ kind: "select", ids: [] }, "Motion probe");
  await frame.getByRole("button", { name: "画板", exact: true }).click();
  const locate = frame.getByRole("button", {
    name: "定位 远处便签",
    exact: true,
  });
  await locate.waitFor();
  const world = frame.locator(".world");
  const cameraX = () =>
    world.evaluate(
      (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41,
    );
  const startX = await cameraX();
  await locate.click();
  await page.waitForTimeout(100);
  const intermediateX = await cameraX();
  await page.waitForTimeout(800);
  const endX = await cameraX();
  assert.ok(
    Math.abs(intermediateX - startX) > 1 && Math.abs(endX - intermediateX) > 1,
    "Focus moves over multiple frames",
  );
  if (v3) {
    /* v3 的镜头在界面手里，内核没有读接口：从画布的变换里读。 */
    const camera = await world.evaluate((el) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: m.m41, zoom: m.a };
    });
    assert.ok(camera.x < -3000, "Focus moves the camera to the far card.");
    assert.equal(camera.zoom, zoomBefore, "Focusing preserves zoom");
  } else {
    b = await until((b) => b.views[motionView].camera.x < -3000);
    assert.equal(
      b.views[motionView].camera.zoom,
      zoomBefore,
      "Focusing preserves zoom",
    );
  }
  const targetBox = await frame
    .locator('[data-instance-id="' + farId + '"]')
    .boundingBox();
  const viewport = await frame.locator(".canvas").boundingBox();
  assert.ok(targetBox && viewport);
  const expectedCenter = viewport.x + (256 + viewport.width - 332) / 2;
  assert.ok(
    Math.abs(targetBox.x + targetBox.width / 2 - expectedCenter) < 8,
    "Focus centers inside the area between floating panels",
  );
  await frame.getByRole("button", { name: "收起面板", exact: true }).click();
  await frame.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.mouse.move(
    viewport.x + viewport.width - 3,
    viewport.y + viewport.height / 2,
  );
  const quietStart = await cameraX();
  await page.waitForTimeout(300);
  assert.ok(
    Math.abs((await cameraX()) - quietStart) < 2,
    "Edge panning is off by default: the board must not move on its own",
  );
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  await frame.getByRole("checkbox", { name: "边缘移动" }).check();
  await frame.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.mouse.move(
    viewport.x + viewport.width / 2,
    viewport.y + viewport.height / 2,
  );
  await page.waitForTimeout(80);
  await page.mouse.move(
    viewport.x + viewport.width - 3,
    viewport.y + viewport.height / 2,
  );
  const edgeStart = await cameraX();
  await page.waitForTimeout(300);
  assert.ok(
    (await cameraX()) < edgeStart - 30,
    "Hovering at the right edge pans without a drag once it is switched on",
  );
  await page.mouse.move(
    viewport.x + viewport.width / 2,
    viewport.y + viewport.height / 2,
  );
  await page.waitForTimeout(80);
  const stopped = await cameraX();
  await page.waitForTimeout(150);
  assert.ok(
    Math.abs((await cameraX()) - stopped) < 1,
    "Leaving the edge stops motion",
  );
  for (const size of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 900, height: 700 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(120);
    await assertZoomBarUsable(`${size.width}x${size.height}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(120);
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(
    await frame
      .locator(".settings-body")
      .evaluate((el) => getComputedStyle(el).scrollbarWidth),
    "none",
  );
  await frame.getByRole("button", { name: "关闭设置", exact: true }).click();
  /* The toolbox was collapsed for the focus check; open it again for the
     component pack protocol. */
  await frame.getByRole("button", { name: "编排", exact: true }).click();
  await frame.getByRole("tab", { name: "组件" }).click();
  await frame.locator(".pack-import").waitFor();
  /* v3 的组件包清单格式与这里的不一样（v3 用 format/formatVersion），
     导入这一段只测 v2 的那条路。 */
  if (!v3) {
    /* The component pack protocol, end to end: a pack is data. It adds presets
     to the toolbox, and a preset fills in a component type that already
     exists. A type this version does not know is imported with a warning —
     the data is kept and the canvas shows the placeholder. */
    const pack = {
      protocol: "sand-table/component-pack",
      version: 1,
      id: "com.example.review",
      name: "评审包",
      components: [
        { key: "goal", type: "task", title: "目标与验收条件" },
        { key: "future", type: "timeline", title: "未来组件" },
      ],
    };
    await frame.locator(".pack-import > summary").click();
    await frame
      .getByRole("textbox", { name: "组件包 JSON" })
      .fill(JSON.stringify(pack));
    await frame.getByRole("button", { name: "从粘贴的 JSON 导入" }).click();
    await frame
      .getByRole("button", { name: "目标与验收条件", exact: true })
      .waitFor();
    await frame
      .getByRole("button", { name: "未来组件", exact: true })
      .waitFor();
    const packNotice = await frame.locator(".pack-notice").innerText();
    assert.ok(
      packNotice.includes("未知组件类型"),
      "The unknown type is reported to the person: " + packNotice,
    );
    await frame
      .getByRole("button", { name: "目标与验收条件", exact: true })
      .click();
    b = await until((b) =>
      b.instances.some((i: any) => i.title === "目标与验收条件"),
    );
    const preset = b.instances.find((i: any) => i.title === "目标与验收条件");
    assert.equal(
      preset.type,
      "task",
      "The preset fills in a type that exists.",
    );
    // 预设的原生内容进对象，实例只是展示（P2 的对象/展示分离）。
    assert.deepEqual(
      contentOf(b, preset)?.data?.items,
      [],
      "The preset uses the type's own data.",
    );
  }
  /* #10: in the "icon + title" level a long title must not push the card's
     own level toggle out of the card. A flex item's automatic minimum size
     is its content size, so the title used to refuse to shrink: the
     ellipsis never applied and the button was pushed hundreds of pixels
     past the card's edge — it looked like the button had vanished. */
  const longTitle =
    "为输出增加 label 前缀并保持原有参数转换规则与边界条件不变以便回归比对";
  const beforeCount = b.instances.length;
  await frame
    .getByRole("button", { name: "便签", exact: true })
    .dragTo(frame.locator(".canvas"), { targetPosition: { x: 700, y: 300 } });
  b = await until((b) => b.instances.length > beforeCount);
  const longCard = frame.locator(
    '[data-instance-id="' + b.instances[b.instances.length - 1].id + '"]',
  );
  await longCard.waitFor();
  await frame.getByRole("textbox", { name: "编辑组件名称" }).fill(longTitle);
  await page.waitForTimeout(900); // the content field saves on stop
  await longCard.hover();
  await longCard.locator(".detail-toggle").click();
  await page.waitForTimeout(400);
  const labelState = await longCard.evaluate((el) => {
    const title = el.querySelector(".collapsed-title") as HTMLElement | null;
    const btn = el.querySelector(".detail-toggle") as HTMLElement | null;
    if (!title || !btn) return null;
    const card = el.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      titleClientW: title.clientWidth,
      titleScrollW: title.scrollWidth,
      truncated: title.scrollWidth > title.clientWidth + 1,
      toggleInsideCard: card.right >= b.right - 1,
      cardRight: Math.round(card.right),
      toggleRight: Math.round(b.right),
    };
  });
  assert.ok(labelState, "The card should be in the icon + title level.");
  assert.ok(
    labelState.truncated,
    "A long title is truncated with an ellipsis (title " +
      labelState.titleClientW +
      "px shown, " +
      labelState.titleScrollW +
      "px of text).",
  );
  assert.ok(
    labelState.toggleInsideCard,
    "The level toggle stays inside the card (card right " +
      labelState.cardRight +
      "px, toggle right " +
      labelState.toggleRight +
      "px).",
  );
  /* The zoom bar has to stay usable even when a card sits on top of it. */
  const longBox = (await longCard.boundingBox())!;
  await page.mouse.move(
    longBox.x + longBox.width / 2,
    longBox.y + longBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(80, 880, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await assertZoomBarUsable("a card with a long title over the zoom bar");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/blank-mobile.png", fullPage: true });
  assert.ok(
    (await frame.locator(".canvas").evaluate((el) => el.clientWidth)) > 100,
  );
  /* v3 专有：界面上的东西与内核里的东西必须是同一份。
     这里用模型可见的读工具（sand_query / sand_read）反过来核对，
     不依赖界面自己那一套读法。 */
  if (v3) {
    b = await read();
    /* app_view 的 get 必须带界面自己的视角编号，测试拿不到那个随机编号。
       read() 已经按当前视角装载了这块白板，核对就用同一块。 */
    const rows: any = await call("sand_query", {
      boardId: b.id,
      types: ["base.note"],
      limit: 50,
    });
    const uiNotes = b.instances.filter((i: any) => i.type === "text");
    assert.ok(rows.rows.length > 0, "内核里查得到界面上的便签。");
    const titles = new Set(rows.rows.map((r: any) => r.title));
    for (const note of uiNotes)
      assert.ok(
        titles.has(note.title),
        "界面上的便签在内核里也查得到：" + note.title,
      );
    const readBack: any = await call("sand_read", {
      ids: rows.rows.slice(0, 10).map((r: any) => r.id),
    });
    let compared = 0;
    for (const object of readBack.objects ?? []) {
      const ui = b.instances.find((i: any) => i.objectId === object.id);
      if (!ui) continue;
      compared += 1;
      assert.equal(object.title, ui.title, "界面上的标题与内核里的一致。");
      assert.equal(
        object.data?.body ?? "",
        ui.data?.text ?? "",
        "界面上的正文与内核里的一致。",
      );
    }
    assert.ok(compared > 0, "至少核对上一张便签的内容。");
    /* 空闲时只有增量请求：每秒一次，不再整块拉白板。 */
    const frameHandle = page.frames().find((f) => f !== page.mainFrame());
    assert.ok(frameHandle, "白板还在页面里。");
    const before = await frameHandle.evaluate(
      () => ({ ...(window as any).__sandV3Stats }) as any,
    );
    await page.waitForTimeout(3000);
    const after = await frameHandle.evaluate(
      () => ({ ...(window as any).__sandV3Stats }) as any,
    );
    assert.equal(after.board, before.board, "空闲时不再整块拉白板。");
    const changes = after.changes - before.changes;
    assert.ok(
      changes >= 2 && changes <= 5,
      `空闲时每秒一次增量请求（3 秒内 ${changes} 次）。`,
    );
    /* 此时窗口还是 390 宽，镜头停在远处便签上。先回到宽窗口和默认镜头。
       比较卡片紧挨在第一张便签右边，会挡住句柄；空位按现有矩形找。 */
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frame.getByRole("button", { name: "复位", exact: true }).click();
    for (let i = 0; i < 30; i++) {
      const camera = await frame.locator(".world").evaluate((el) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
      });
      if (
        Math.abs(camera.x - 24) < 1 &&
        Math.abs(camera.y - 24) < 1 &&
        Math.abs(camera.zoom - 1) < 0.02
      )
        break;
      await page.waitForTimeout(50);
    }
    const reset = await frame.locator(".world").evaluate((el) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
    });
    assert.ok(
      Math.abs(reset.x - 24) < 1 &&
        Math.abs(reset.y - 24) < 1 &&
        Math.abs(reset.zoom - 1) < 0.02,
      "复位后镜头应回到默认位置：" + JSON.stringify(reset),
    );
    const overlaps = (
      a: { x: number; y: number; width: number; height: number },
      c: { x: number; y: number; width: number; height: number },
    ) =>
      a.x < c.x + c.width &&
      a.x + a.width > c.x &&
      a.y < c.y + c.height &&
      a.y + a.height > c.y;
    let sourceAt: {
      x: number;
      y: number;
      width: number;
      height: number;
      pinned: false;
    } | null = null;
    let targetAt: {
      x: number;
      y: number;
      width: number;
      height: number;
      pinned: false;
    } | null = null;
    for (let y = 420; y <= 720; y += 30) {
      const pair = { x: 320, y, width: 540, height: 140 };
      const blocked = b.instances.some(
        (item: {
          rect: { x: number; y: number; width: number; height: number };
        }) => overlaps(pair, item.rect),
      );
      if (blocked) continue;
      sourceAt = { x: 320, y, width: 220, height: 140, pinned: false };
      targetAt = { x: 640, y, width: 220, height: 140, pinned: false };
      break;
    }
    assert.ok(
      sourceAt && targetAt,
      "视口里没有空位放两张要连线的便签：" +
        JSON.stringify(
          b.instances.map((item: { title?: string; rect?: unknown }) => ({
            title: item.title,
            rect: item.rect,
          })),
        ),
    );
    await editSpace({
      kind: "create",
      type: "text",
      title: "连线甲",
      data: { text: "从这里拖出" },
      rect: sourceAt,
    });
    await editSpace({
      kind: "create",
      type: "text",
      title: "连线乙",
      data: { text: "接到这里" },
      rect: targetAt,
    });
    b = await until(
      (board) =>
        board.instances.some((item: any) => item.title === "连线甲") &&
        board.instances.some((item: any) => item.title === "连线乙"),
    );
    const sourceNote = b.instances.find((item: any) => item.title === "连线甲");
    const targetNote = b.instances.find((item: any) => item.title === "连线乙");
    const sourceCard = frame.locator(
      '[data-instance-id="' + sourceNote.id + '"]',
    );
    const targetCard = frame.locator(
      '[data-instance-id="' + targetNote.id + '"]',
    );
    const handle = sourceCard.locator('[aria-label="拖出关系"]');
    const size = page.viewportSize();
    assert.ok(size, "浏览器窗口尺寸还在。");
    const inside = (
      box: { x: number; y: number; width: number; height: number } | null,
    ) =>
      !!box &&
      box.x >= 1 &&
      box.y >= 1 &&
      box.x + box.width <= size.width - 1 &&
      box.y + box.height <= size.height - 1;
    let sourceBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    let targetBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    for (let i = 0; i < 50; i++) {
      sourceBox = await handle.boundingBox();
      targetBox = await targetCard.boundingBox();
      if (inside(sourceBox) && inside(targetBox)) break;
      await page.waitForTimeout(100);
    }
    assert.ok(
      inside(sourceBox) && inside(targetBox),
      "两张便签都要在视口里才能连线：" +
        JSON.stringify({ sourceBox, targetBox, size }),
    );
    await handle.dragTo(targetCard);
    await frame
      .getByRole("dialog", { name: "选择关系" })
      .getByRole("button", { name: "相关", exact: true })
      .click();
    const related = await call("sand_read", {
      ids: [sourceNote.objectId],
      include: ["relations"],
    });
    assert.ok(
      (related.objects?.[0]?.relations ?? []).some(
        (relation: { kind?: string; otherId?: string }) =>
          relation.kind === "base.related" &&
          relation.otherId === targetNote.objectId,
      ),
      "Connecting two cards and choosing 相关 creates base.related.",
    );
    await frame.getByRole("button", { name: "缩小", exact: true }).click();
    await frame.getByRole("button", { name: "缩小", exact: true }).click();
    await page.waitForTimeout(1200);
    const zoomLabel = (await frame.locator(".zoom span").innerText()).trim();
    await page.reload();
    await frame.locator(".zoom span").waitFor();
    await frame.locator(".component-card").first().waitFor({ timeout: 30000 });
    let restored = "";
    for (let i = 0; i < 40; i++) {
      restored = (await frame.locator(".zoom span").innerText()).trim();
      if (restored === zoomLabel) break;
      await page.waitForTimeout(150);
    }
    assert.equal(
      restored,
      zoomLabel,
      "Reopening the board restores the viewport.",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    /* 导出再导入：文件能下来，导入后能切到新工作空间并看到原来的组件。 */
    await page.setViewportSize({ width: 1440, height: 1000 });
    await frame.getByRole("button", { name: "设置", exact: true }).click();
    const settings = frame.getByRole("dialog", { name: "设置" });
    const downloadPromise = page.waitForEvent("download");
    await settings
      .getByRole("button", { name: "导出工作空间", exact: true })
      .click();
    const download = await downloadPromise;
    const exportedText = readFileSync((await download.path())!, "utf8");
    const exported = JSON.parse(exportedText);
    assert.equal(exported.format, "sand-table-workspace");
    const homeId = exported.workspace?.homeBoardId;
    const onHome = new Set(
      (exported.presentations ?? [])
        .filter(
          (item: { boardId?: string; objectId?: string }) =>
            item.boardId === homeId,
        )
        .map((item: { objectId?: string }) => item.objectId),
    );
    const kept = (exported.objects ?? []).find(
      (object: { id?: string; type?: string; title?: string }) =>
        object.type === "base.note" &&
        object.title === "我的计划" &&
        onHome.has(object.id),
    );
    assert.ok(kept?.title, "导出的文件里有首页上的「我的计划」");
    const bundleFile = join(root, "exported-workspace.json");
    writeFileSync(bundleFile, exportedText);
    const chooserPromise = page.waitForEvent("filechooser");
    await settings.getByRole("button", { name: "导入", exact: true }).click();
    await (await chooserPromise).setFiles(bundleFile);
    await settings.getByText(/已导入/).waitFor({ timeout: 30000 });
    await settings
      .getByRole("button", { name: "切换到导入的工作空间" })
      .click();
    await frame
      .locator(".component-card", { hasText: kept.title })
      .first()
      .waitFor({ timeout: 30000 });
  }
  assert.deepEqual(errors, []);
  console.log(
    "BLANK CANVAS PASSED: no workspace required, zero initial components, palette drag/drop and editing, drag without the arrange mode, resize and Delete and Escape on a selected card, inline editing, save-on-stop, undo/redo/jump through MCP, edge pan off by default, the zoom bar across sizes and levels, component pack import, nested boards, capability-gated AI/shared MCP composition, optional human repository import, source reading, custom theme and narrow-screen layout.",
  );
} catch (e) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    await failedPage
      .screenshot({ path: "artifacts/blank-failure.png", fullPage: true })
      .catch(() => {});
    console.log(
      "Canvas state at failure:",
      await failedPage
        .frameLocator("iframe")
        .locator("main")
        .innerText()
        .catch(() => "(not visible)"),
    );
  }
  throw e;
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
