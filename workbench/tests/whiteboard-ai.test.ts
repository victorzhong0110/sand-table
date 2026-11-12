import test from "node:test";
import assert from "node:assert/strict";
import type { Board } from "../board/data-client/model.ts";
import { aiRequest, aiTargets } from "../board/ai/context.ts";
import {
  activeTurn,
  applyAIEvent,
  type AITurn,
} from "../board/ai/conversation.ts";

function board(): Board {
  return {
    id: "home",
    workspaceId: "workspace",
    contentRevision: 12,
    selection: ["object-a"],
    views: {
      human: {
        id: "human",
        spaceId: "child",
        selection: ["display-a"],
        camera: { x: 0, y: 0, zoom: 1 },
        updatedAt: 0,
      },
    },
    instances: [
      { id: "display-a", spaceId: "child", objectId: "object-a" },
      { id: "display-copy", spaceId: "child", objectId: "object-a" },
      { id: "display-b", spaceId: "child", binding: { objectId: "object-b" } },
      { id: "other", spaceId: "home", objectId: "object-outside" },
    ],
    contentObjects: [
      {
        id: "object-a",
        title: "方案 A",
        version: 3,
        data: { body: "正文不应发送" },
      },
      { id: "object-b", title: "方案 B", version: 2 },
      { id: "object-outside", title: "其他板", version: 5 },
    ],
  } as unknown as Board;
}

test("AI 选区把展示编号解析为真实对象版本，不误用 board.selection 的对象编号", () => {
  assert.deepEqual(aiTargets(board(), "human", "selection"), [
    { objectId: "object-a", version: 3, title: "方案 A" },
  ]);
});
test("整板范围限于子白板，重复展示只发一次对象", () => {
  const b = board();
  assert.deepEqual(
    aiTargets(b, "human", "board").map((t) => t.objectId),
    ["object-a", "object-b"],
  );
  b.views.human.selection.push("display-copy");
  assert.equal(aiTargets(b, "human", "selection").length, 1);
});
test("空选区、失效展示、缺内容和无效版本均拒绝，不回退为整板", () => {
  for (const selection of [[], ["missing"], ["other"]]) {
    const b = board();
    b.views.human.selection = selection;
    assert.throws(() => aiTargets(b, "human", "selection"), /选区为空或已变化/);
  }
  const b = board();
  b.contentObjects[0].version = 0;
  assert.throws(() => aiTargets(b, "human", "selection"), /内容版本尚未读到/);
  b.contentObjects = [];
  assert.throws(() => aiTargets(b, "human", "selection"), /内容版本尚未读到/);
});
test("空白白板允许生成；超过 200 个目标在提交前拒绝", () => {
  const b = board();
  b.instances = [];
  assert.deepEqual(
    aiRequest(b, "human", "board", "搭一张方案比较板").targets,
    [],
  );
  for (let i = 0; i < 201; i++) {
    b.instances.push({
      id: `p${i}`,
      spaceId: "child",
      objectId: `o${i}`,
    } as any);
    b.contentObjects.push({ id: `o${i}`, title: String(i), version: 1 } as any);
  }
  assert.throws(() => aiRequest(b, "human", "board", "整理"), /200/);
});
test("提交快照固定白板、引用、版本及修订，不携带正文", () => {
  const b = board(),
    request = aiRequest(b, "human", "selection", "整理");
  b.views.human.spaceId = "home";
  b.views.human.selection = [];
  b.contentObjects[0].version = 99;
  b.contentRevision = 88;
  assert.equal(request.boardId, "child");
  assert.equal(request.contextVersion, 12);
  assert.deepEqual(request.targets, [{ objectId: "object-a", version: 3 }]);
  assert.ok(!JSON.stringify(request).includes("正文不应发送"));
  assert.match(request.instruction, /^整理/);
  assert.throws(() => aiRequest(board(), "human", "board", " "), /1–8000/);
});
test("宿主事件按任务与白板隔离，迟到事件不回退终态", () => {
  const turn: AITurn = {
    id: "local",
    boardId: "child",
    text: "整理",
    targets: [],
    taskId: "task",
    state: "queued",
    messages: [],
  };
  const event = {
    taskId: "task",
    boardId: "child",
    state: "running" as const,
    at: 2,
    message: "回答",
  };
  assert.equal(applyAIEvent(turn, { ...event, taskId: "other" }), turn);
  assert.equal(applyAIEvent(turn, { ...event, boardId: "other" }), turn);
  const running = applyAIEvent(turn, event);
  assert.equal(activeTurn(running), true);
  assert.equal(applyAIEvent(running, { ...event, at: 1 }), running);
  const done = applyAIEvent(running, {
    ...event,
    state: "done",
    at: 3,
    message: "完成",
  });
  assert.deepEqual(done.messages, ["回答", "完成"]);
  assert.equal(activeTurn(done), false);
  assert.equal(applyAIEvent(done, { ...event, at: 4 }), done);
});
