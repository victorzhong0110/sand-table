// v2 工作空间导入器的测试。
//
// 契约见 docs/kernel-v3/01-data-model.md §10（映射规则）、§10.1（类型改名），
// 任务卡 docs/kernel-v3/tasks/T17-import-v2.md。
//
// fixtures/v2/ 下是手写的旧版工作空间文件（v2 的 workspace.json），
// 覆盖卡片验收里的七条。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCommands,
  createRegistry,
  getMeta,
  importV2,
  openWorkspace,
  openWorkspaceDb,
  redo,
  undo,
  type Actor,
  type Db,
  type Registry,
} from "../kernel/index.ts";
import {
  groupFrameBox,
  mapV2Type,
  toFrameRelative,
} from "../kernel/legacy/import-v2.ts";
import { builtinPacks } from "../packs/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/v2/", import.meta.url));
const actor: Actor = { id: "tester", kind: "human" };

type Scene = {
  root: string;
  dir: string;
  registry: Registry;
  close: () => void;
};

/** 把一个 fixture 摆进临时工作空间目录，返回可以打开它的现场。 */
function scene(fixture: string, workspaceId = "demo"): Scene {
  const root = mkdtempSync(join(tmpdir(), "sand-import-"));
  const dir = join(root, workspaceId);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIXTURES, fixture), join(dir, "workspace.json"));
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  return {
    root,
    dir,
    registry,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 把一份手写的旧文件写进临时目录。prepare 用来放 attachments。 */
function sceneFrom(
  json: unknown,
  prepare?: (dir: string) => void,
  workspaceId = "mini",
): Scene {
  const root = mkdtempSync(join(tmpdir(), "sand-import-"));
  const dir = join(root, workspaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(json));
  prepare?.(dir);
  const registry = createRegistry();
  for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
  return {
    root,
    dir,
    registry,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function presentation(
  id: string,
  objectId: string,
  rect: { x: number; y: number },
  extra?: { type?: string; data?: Record<string, unknown>; binding?: boolean },
) {
  const type = extra?.type ?? "text";
  const binding = extra?.binding !== false;
  return {
    id,
    spaceId: "overview",
    type,
    ...(binding
      ? {
          binding: { kind: "object", objectId },
          objectId,
        }
      : {}),
    title: id,
    data: extra?.data ?? {},
    rect: { ...rect, width: 100, height: 80, pinned: false },
    updatedAt: 1,
    author: "lin",
  };
}

function objectsOf(db: Db, type?: string) {
  const sql = type
    ? "SELECT * FROM objects WHERE type = ? AND deleted_rev IS NULL ORDER BY id"
    : "SELECT * FROM objects WHERE deleted_rev IS NULL ORDER BY id";
  const rows = (
    type ? db.prepare(sql).all(type) : db.prepare(sql).all()
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    typeVersion: Number(row.type_version),
    title: String(row.title),
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
    source: row.source
      ? (JSON.parse(String(row.source)) as Record<string, unknown>)
      : null,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
    rev: Number(row.rev),
  }));
}

function presentationsOf(db: Db) {
  const rows = db
    .prepare(
      "SELECT * FROM presentations WHERE deleted_rev IS NULL ORDER BY id",
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    boardId: String(row.board_id),
    objectId: String(row.object_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    z: Number(row.z),
    locked: Number(row.locked) === 1,
    appearance: JSON.parse(String(row.appearance)) as Record<string, unknown>,
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
  }));
}

function relationsOf(db: Db) {
  const rows = db
    .prepare("SELECT * FROM relations WHERE deleted_rev IS NULL ORDER BY id")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    sourceId: String(row.source_id),
    targetId: String(row.target_id),
    status: String(row.status),
    basis: row.basis == null ? null : String(row.basis),
    attributes: JSON.parse(String(row.attributes)) as Record<string, unknown>,
    evidence: JSON.parse(String(row.evidence)) as unknown[],
  }));
}

test("原生对象、绑定展示、本地内容、嵌套空间、链接、关系、分组、备注、附件、代码链路、导览、主题、组件包、审计都按 §10 导入", () => {
  const s = scene("full.json");
  try {
    const { db, imported } = openWorkspace(s.root, "demo", s.registry);
    assert.ok(imported, "这次是从旧版文件导入的");
    assert.equal(imported.from, join(s.dir, "workspace.json"));

    // —— 对象：id、创建时间、作者都保留，类型按 §10.1 改名 ——
    const text = objectsOf(db, "base.note").find((o) => o.id === "obj-text-1");
    assert.ok(text, "text 对象变成 base.note");
    assert.equal(text!.title, "林澈");
    assert.equal(text!.data.body, "在港口长大，怕水。", "text 字段改名为 body");
    assert.equal(text!.data.text, undefined, "旧字段名不再重复保留");
    assert.equal(text!.createdAt, 1699999000000);
    assert.equal(text!.updatedAt, 1700000001000);
    assert.equal(text!.createdBy, "lin");
    assert.equal(text!.updatedBy, "lin");
    assert.equal(text!.version, 3, "版本也保留");

    const character = objectsOf(db, "novel.character").find(
      (o) => o.id === "obj-char-1",
    );
    assert.ok(character, "character 对象变成 novel.character");
    assert.equal(character!.data.name, "林澈", "旧字段原样保留");
    assert.equal(character!.data.age, 0, "真实的 0 不会被当成占位删掉");

    const hypothesis = objectsOf(db, "research.hypothesis").find(
      (o) => o.id === "obj-hyp-1",
    );
    assert.ok(hypothesis, "hypothesis 对象变成 research.hypothesis");

    // 来源：origin 保留，外部定位保留
    const event = objectsOf(db, "novel.event").find(
      (o) => o.id === "obj-event-1",
    );
    assert.equal(event!.source?.origin, "ai-generated");
    assert.equal(event!.source?.basis, "从正文里抽出来的");

    // —— 白板：分区变成 base.board 对象，id 不变，根空间成为首页 ——
    const boards = objectsOf(db, "base.board");
    assert.deepEqual(
      boards.map((b) => b.id).sort(),
      ["overview", "space-child"],
      "每个分区一个白板对象，id 不变",
    );
    assert.equal(
      getMeta(db, "home_board_id"),
      "overview",
      "根空间成为首页白板",
    );
    assert.equal(getMeta(db, "imported_from"), "workspace.json@42");
    assert.equal(
      objectsOf(db).every((o) => o.rev === 1),
      true,
      "导入的写入算一次修订",
    );

    // —— 展示：绑定展示、本地内容、白板入口 ——
    const presentations = presentationsOf(db);
    const bound = presentations.find((p) => p.id === "p-text");
    assert.equal(bound!.boardId, "overview", "board_id 是原分区 id");
    assert.equal(bound!.objectId, "obj-text-1");
    assert.equal(bound!.width, 280);
    assert.equal(bound!.height, 180);
    const absolute = presentations.find((p) => p.id === "p-note-target");
    assert.equal(absolute!.x, 700, "不在分组里的展示保留绝对坐标");
    assert.equal(absolute!.y, 500);

    const local = presentations.find((p) => p.id === "p-local");
    assert.equal(local!.objectId, "p-local", "本地内容先建对象再指向它");
    const localObject = objectsOf(db).find((o) => o.id === "p-local");
    assert.equal(localObject!.type, "base.note");
    assert.equal(localObject!.data.body, "这条内容只存在于展示里");

    const boardEntry = presentations.find((p) => p.id === "p-board");
    assert.equal(
      boardEntry!.objectId,
      "space-child",
      "board 展示指向对应的白板对象",
    );
    const spaceLink = presentations.find((p) => p.id === "p-space-link");
    assert.equal(
      spaceLink!.objectId,
      "space-child",
      "space-link 展示指向对应的白板对象",
    );
    const nested = presentations.find((p) => p.id === "p-child");
    assert.equal(
      nested!.boardId,
      "space-child",
      "嵌套分区里的展示挂在自己的白板上",
    );

    // 钉住 → 锁定
    const pinned = presentations.find((p) => p.id === "p-char");
    assert.equal(pinned!.locked, true, "v2 的固定位置变成锁定");

    // —— 空间链接：5 种 kind 各一条，两端是展示绑定的对象 ——
    const spaceLinks = relationsOf(db).filter((r) => r.id.startsWith("link-"));
    assert.equal(spaceLinks.length, 5, "5 种空间链接都导入了");
    const byId = new Map(spaceLinks.map((r) => [r.id, r]));
    assert.equal(byId.get("link-related")!.kind, "base.related");
    assert.equal(byId.get("link-depends")!.kind, "base.depends_on");
    assert.equal(byId.get("link-supports")!.kind, "base.supports");
    assert.equal(byId.get("link-compares")!.kind, "base.compares");
    assert.equal(byId.get("link-belongs")!.kind, "base.belongs_to");
    assert.equal(
      byId.get("link-related")!.sourceId,
      "obj-text-1",
      "链接的两端是展示绑定的对象",
    );
    assert.equal(byId.get("link-related")!.targetId, "obj-char-1");
    assert.equal(
      byId.get("link-supports")!.basis,
      "人物支持这段正文",
      "description 存进 basis",
    );
    assert.equal(byId.get("link-belongs")!.sourceId, "obj-char-1");
    assert.equal(byId.get("link-belongs")!.targetId, "p-local");

    // —— 对象关系：kind 改名，id 保留 ——
    const rel = relationsOf(db).find((r) => r.id === "rel-1");
    assert.equal(rel!.kind, "参与", "§10.1 没有的对象关系 kind 原样保留");
    assert.equal(rel!.sourceId, "obj-char-1", "方向保留");
    assert.equal(rel!.targetId, "obj-event-1");
    assert.equal(rel!.status, "confirmed");
    const supports = relationsOf(db).find((r) => r.id === "rel-2");
    assert.equal(supports!.kind, "支持");
    assert.equal(supports!.basis, "正文里写到了");

    // —— 分组：一个 base.frame 对象加一个框展示，组内展示挂它下面 ——
    const frame = objectsOf(db, "base.frame");
    assert.equal(frame.length, 1);
    assert.equal(frame[0]!.id, "group-1");
    assert.equal(frame[0]!.title, "第一幕");
    const framePresentation = presentations.find(
      (p) => p.objectId === "group-1",
    );
    assert.ok(framePresentation, "分组有一个框展示");
    const member = presentations.find((p) => p.id === "p-text");
    assert.equal(member!.parentId, framePresentation!.id, "组内展示挂在框下面");
    const other = presentations.find((p) => p.id === "p-char");
    assert.equal(other!.parentId, framePresentation!.id);

    // —— 备注：一条 base.note 对象加一条 base.about 关系，摆在目标旁边 ——
    const notes = objectsOf(db, "base.note").filter(
      (o) => o.data.body === "这条备注要跟着对象走",
    );
    assert.equal(notes.length, 1, "备注变成一个便签对象");
    const about = relationsOf(db).find(
      (r) => r.kind === "base.about" && r.sourceId === notes[0]!.id,
    );
    assert.ok(about, "备注和目标之间建了 base.about 关系");
    assert.equal(about!.targetId, "obj-note-target");
    const notePresentation = presentations.find(
      (p) => p.objectId === notes[0]!.id,
    );
    assert.ok(notePresentation, "备注摆在白板上");
    assert.equal(notePresentation!.boardId, "overview");
    assert.equal(notePresentation!.x, 700 + 280 + 24, "备注摆在目标右边");
    assert.equal(notePresentation!.y, 500);

    // —— 附件：字节写进 blobs/，登记进 blobs 表 ——
    const media = objectsOf(db, "base.media");
    assert.equal(media.length, 1);
    const sha = String(media[0]!.data.blob);
    assert.match(sha, /^[0-9a-f]{64}$/);
    const blobFile = join(s.dir, "blobs", sha);
    assert.ok(existsSync(blobFile), "附件字节写进了 blobs 目录");
    assert.equal(statSync(blobFile).size, 8);
    const blobRow = db
      .prepare("SELECT * FROM blobs WHERE sha256 = ?")
      .get(sha) as { mime: string; bytes: number } | undefined;
    assert.equal(blobRow?.mime, "image/png");
    assert.equal(blobRow?.bytes, 8);

    // —— 意图 / 提案 / 验证 ——
    const intent = objectsOf(db, "code.intent").find(
      (o) => o.id === "intent-1",
    );
    assert.ok(intent, "意图变成 code.intent");
    assert.equal(intent!.data.request, "把林澈的设定改一下");
    const proposal = objectsOf(db, "code.proposal").find(
      (o) => o.id === "proposal-1",
    );
    assert.ok(proposal, "提案变成 code.proposal");
    assert.equal(proposal!.data.title, "改一下设定");
    const validation = objectsOf(db, "code.validation").find(
      (o) => o.id === "validation-1",
    );
    assert.ok(validation, "验证变成 code.validation");
    assert.equal(validation!.data.outcome, "passed");
    const contains = relationsOf(db).filter((r) => r.kind === "code.contains");
    assert.equal(contains.length, 2, "提案与验证各自指向意图与提案");
    assert.ok(
      contains.some(
        (r) => r.sourceId === "proposal-1" && r.targetId === "intent-1",
      ),
    );

    // —— 导览：一个 base.tour 对象，每一站一条 base.tour_stop 关系 ——
    const tour = objectsOf(db, "base.tour").find((o) => o.id === "guide-1");
    assert.ok(tour, "导览变成 base.tour");
    assert.equal(tour!.data.purpose, "按顺序读一遍");
    const stops = relationsOf(db).filter((r) => r.kind === "base.tour_stop");
    assert.equal(stops.length, 2, "有对象的站变成关系");
    const first = stops.find((r) => r.targetId === "obj-text-1");
    assert.equal(first!.sourceId, "guide-1");
    assert.equal(first!.attributes.order, 0);
    assert.equal(first!.attributes.title, "起点");
    assert.equal(first!.attributes.explanation, "先看便签");
    const second = stops.find((r) => r.targetId === "obj-event-1");
    assert.equal(second!.attributes.order, 1);
    assert.equal(second!.basis, "还不确定");
    assert.equal(
      (second!.evidence[0] as { uri: string }).uri,
      "src/app.ts",
      "证据变成了外部定位",
    );
    const legacySteps = tour!.data.legacySteps as { title: string }[];
    assert.equal(legacySteps.length, 1, "没有对象的站存进 data.legacySteps");
    assert.equal(legacySteps[0]!.title, "没有对象的一站");

    // —— 主题 ——
    const theme = db
      .prepare("SELECT value FROM settings WHERE key = 'theme'")
      .get() as { value: string } | undefined;
    assert.ok(theme, "主题写进了 settings");
    assert.equal(JSON.parse(theme!.value).accent, "#0066cc");

    // —— 组件包（v1 清单）———
    const pack = db
      .prepare("SELECT * FROM packs WHERE id = 'my-pack'")
      .get() as { kind: string; enabled: number; manifest: string } | undefined;
    assert.ok(pack, "v1 组件包转成了数据包");
    assert.equal(pack!.kind, "data");
    assert.equal(pack!.enabled, 1);
    const manifest = JSON.parse(pack!.manifest) as {
      format: string;
      formatVersion: number;
      title: string;
      presets: { key: string; type: string; data: Record<string, unknown> }[];
    };
    assert.equal(manifest.format, "sand-table-pack");
    assert.equal(manifest.formatVersion, 2);
    assert.equal(manifest.title, "我的包");
    assert.equal(manifest.presets[0]!.key, "note");
    assert.equal(
      manifest.presets[0]!.type,
      "base.note",
      "组件类型也按 §10.1 改名",
    );
    assert.equal(manifest.presets[0]!.data.body, "占位", "占位字段改名");
    assert.equal(manifest.presets[0]!.data.text, undefined);

    // —— 审计：旧记录原样保留，另外写一条 import ——
    const audit = db.prepare("SELECT * FROM audit ORDER BY seq").all() as {
      action: string;
      actor: string;
      actor_kind: string;
      detail: string | null;
    }[];
    assert.ok(
      audit.some((row) => row.action === "apply" && row.actor === "lin"),
      "旧审计记录保留",
    );
    const importRow = audit.find((row) => row.action === "import");
    assert.ok(importRow, "写了一条 import 审计");
    assert.equal(importRow!.actor_kind, "system");
    assert.ok(
      audit.some(
        (row) =>
          row.action === "apply" &&
          row.actor === "import" &&
          row.actor_kind === "human",
      ),
      "syncPacks 用 actor import",
    );
    const detail = JSON.parse(importRow!.detail!) as { objects: number };
    assert.equal(detail.objects, imported!.objects);

    // —— 导入不写撤销历史 ——
    const history = db.prepare("SELECT COUNT(*) AS n FROM history").get() as {
      n: number;
    };
    assert.equal(history.n, 0, "导入本身不进撤销历史");

    db.close();
  } finally {
    s.close();
  }
});

test("分组内展示的坐标是相对框左上角的，换算回绝对坐标与 v2 一致", () => {
  const s = scene("full.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const presentations = presentationsOf(db);
    const frame = presentations.find((p) => p.objectId === "group-1");
    assert.ok(frame, "分组框");
    const member = presentations.find((p) => p.id === "p-text");
    const other = presentations.find((p) => p.id === "p-char");
    assert.equal(member!.parentId, frame!.id);
    // v2 的绝对坐标
    assert.equal(frame!.x, 88, "框的左上角是组员外接矩形加留白");
    assert.equal(frame!.y, 172);
    assert.equal(frame!.width, 604);
    // 留白与 v2 画布一致：左右 12、上 28、下 12
    assert.equal(frame!.height, 280);
    // 相对坐标
    assert.equal(member!.x, 12);
    assert.equal(member!.y, 28);
    assert.equal(other!.x, 332);
    assert.equal(other!.y, 88);
    // 换算回绝对坐标与 v2 一致
    assert.equal(frame!.x + member!.x, 100);
    assert.equal(frame!.y + member!.y, 200);
    assert.equal(frame!.x + other!.x, 420);
    assert.equal(frame!.y + other!.y, 260);
    db.close();
  } finally {
    s.close();
  }
});

test("坐标换算只在一个地方：换算函数自己也是对的", () => {
  const members = [
    { x: 100, y: 200, width: 280, height: 180 },
    { x: 420, y: 260, width: 260, height: 180 },
  ];
  const frame = groupFrameBox(members);
  assert.deepEqual(frame, { x: 88, y: 172, width: 604, height: 280 });
  for (const member of members) {
    const relative = toFrameRelative(frame, member);
    assert.equal(frame.x + relative.x, member.x);
    assert.equal(frame.y + relative.y, member.y);
  }
});

test("无损迁移：真实的 0、空字符串、空数组、未知字段都保留", () => {
  const s = scene("lossless.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const zero = objectsOf(db).find((o) => o.id === "obj-zero");
    assert.ok(zero);
    assert.equal(zero!.data.count, 0, "真实的 0 保留");
    assert.equal(zero!.data.ratio, 0);
    assert.equal(zero!.data.unknownNumber, 0);
    assert.equal(zero!.data.body, "", "空字符串保留");
    assert.equal(zero!.data.text, undefined, "旧字段名按 §10.1 改名成 body");
    assert.deepEqual(zero!.data.items, [], "空数组保留");
    assert.deepEqual(zero!.data.tags, []);
    assert.deepEqual(zero!.data.nested, { empty: "", zero: 0, list: [] });
    assert.equal(zero!.data.unknownField, "原样保留", "未知字段保留");
    const empty = objectsOf(db).find((o) => o.id === "obj-empty");
    assert.equal(empty!.data.unknownField, "");
    db.close();
  } finally {
    s.close();
  }
});

test("名单只报告不建关系：重复同名、唯一同名、未匹配分别报告", () => {
  const s = scene("lossless.json");
  try {
    const { db, imported } = openWorkspace(s.root, "demo", s.registry);
    const event = objectsOf(db, "novel.event").find(
      (o) => o.id === "obj-event",
    );
    assert.ok(event);
    assert.deepEqual(
      event!.data.participants,
      ["同名", "独此一人", "查无此人"],
      "名单原文保留",
    );
    assert.deepEqual(
      event!.data.legacyParticipants,
      ["同名", "独此一人", "查无此人"],
      "名单也按旧字段标记出来",
    );
    const participates = relationsOf(db).filter(
      (r) => r.kind === "novel.participates",
    );
    assert.equal(participates.length, 0, "没有凭名字建关系");
    const warnings = imported!.warnings.map((w) => `${w.what} ${w.reason}`);
    assert.ok(
      warnings.some((w) => w.includes("同名") && w.includes("2 个同名的人物")),
      "重复同名单独报告",
    );
    assert.ok(
      warnings.some((w) => w.includes("独此一人") && w.includes("可以建立")),
      "唯一同名给建议",
    );
    assert.ok(
      warnings.some(
        (w) => w.includes("查无此人") && w.includes("没有同名的人物"),
      ),
      "未匹配单独报告",
    );
    db.close();
  } finally {
    s.close();
  }
});

test("原始稳定 ID 的关系保留", () => {
  const s = scene("lossless.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const first = relationsOf(db).find((r) => r.id === "rel-stable-1");
    assert.ok(first, "关系的 id 保留");
    assert.equal(first!.kind, "先于", "「先于」原样保留");
    assert.equal(first!.sourceId, "obj-same-1");
    assert.equal(first!.targetId, "obj-unique");
    const second = relationsOf(db).find((r) => r.id === "rel-stable-2");
    assert.equal(second!.kind, "导致");
    assert.equal(second!.status, "inferred");
    db.close();
  } finally {
    s.close();
  }
});

test("未知类型 foo 变成 legacy.foo，数据原样保留", () => {
  const s = scene("unknown-type.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const foo = objectsOf(db).find((o) => o.id === "obj-foo");
    assert.ok(foo, "未知类型的对象也导入了");
    assert.equal(foo!.type, "legacy.foo");
    assert.deepEqual(foo!.data, { whatever: "原样", count: 0, list: [] });
    const presentation = presentationsOf(db).find((p) => p.id === "p-foo");
    assert.equal(presentation!.objectId, "obj-foo");
    db.close();
  } finally {
    s.close();
  }
});

test("类型改名按 §10.1", () => {
  assert.equal(mapV2Type("text", {}), "base.note");
  assert.equal(mapV2Type("heading", {}), "base.heading");
  assert.equal(mapV2Type("code", {}), "base.code_snippet");
  assert.equal(
    mapV2Type("resource", { url: "https://example.com" }),
    "base.link",
  );
  assert.equal(mapV2Type("resource", { assetId: "a-1" }), "base.media");
  assert.equal(mapV2Type("metric", {}), "base.metric");
  assert.equal(mapV2Type("events", {}), "base.events");
  assert.equal(mapV2Type("character", {}), "novel.character");
  assert.equal(mapV2Type("event", {}), "novel.event");
  assert.equal(mapV2Type("chapter", {}), "novel.chapter");
  assert.equal(mapV2Type("hypothesis", {}), "research.hypothesis");
  assert.equal(mapV2Type("evidence", {}), "research.evidence");
  assert.equal(mapV2Type("conclusion", {}), "research.conclusion");
  assert.equal(mapV2Type("foo", {}), "legacy.foo");
});

test("展示指向不存在的对象：跳过并进报告，其余正常导入", () => {
  const s = scene("dangling.json");
  try {
    const { db, imported } = openWorkspace(s.root, "demo", s.registry);
    const presentations = presentationsOf(db);
    assert.equal(
      presentations.filter((p) => p.id === "p-dangling").length,
      0,
      "指向不存在对象的展示没有导入",
    );
    assert.ok(
      presentations.some((p) => p.id === "p-ok"),
      "其余展示照常导入",
    );
    assert.ok(objectsOf(db).some((o) => o.id === "obj-ok"));
    assert.ok(
      imported!.skipped.some(
        (item) =>
          item.what.includes("指向已删除对象的便签") &&
          item.reason.includes("obj-vanished"),
      ),
      "跳过的展示出现在报告里",
    );
    db.close();
  } finally {
    s.close();
  }
});

test("代码投影：建占位对象，id 与外部位置都稳定", () => {
  const s = scene("dangling.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const code = objectsOf(db, "code.file").find(
      (o) => o.id === "w-1:src/app.ts",
    );
    assert.ok(code, "代码投影建了占位对象");
    assert.equal(code!.title, "src/app.ts");
    assert.equal(code!.source?.origin, "derived");
    const external = code!.source?.external as
      { kind: string; uri: string; fragment?: string } | undefined;
    assert.equal(external?.kind, "file");
    assert.equal(external?.uri, "v2-code-entry:w-1:src/app.ts", "外部位置稳定");
    assert.equal(external?.fragment, "src/app.ts");
    const presentation = presentationsOf(db).find((p) => p.id === "p-code");
    assert.equal(presentation!.objectId, "w-1:src/app.ts", "展示指向占位对象");
    db.close();
  } finally {
    s.close();
  }
});

test("损坏的 JSON：抛错，目录里没有 workspace.db，旧文件字节不变", () => {
  const s = scene("broken.json");
  try {
    const before = readFileSync(join(s.dir, "workspace.json"));
    assert.throws(
      () => openWorkspace(s.root, "demo", s.registry),
      /不是合法的 JSON/,
    );
    assert.equal(
      existsSync(join(s.dir, "workspace.db")),
      false,
      "没有留下半成品数据库",
    );
    assert.equal(existsSync(join(s.dir, "workspace.db-wal")), false);
    assert.deepEqual(
      readFileSync(join(s.dir, "workspace.json")),
      before,
      "旧文件一个字节都没动",
    );
  } finally {
    s.close();
  }
});

test("导入成功后再次打开：不再导入，直接打开", () => {
  const s = scene("full.json");
  try {
    const first = openWorkspace(s.root, "demo", s.registry);
    assert.ok(first.imported, "第一次是导入");
    const count = objectsOf(first.db).length;
    first.db.close();
    const second = openWorkspace(s.root, "demo", s.registry);
    assert.equal(second.imported, null, "第二次不再导入");
    assert.equal(objectsOf(second.db).length, count, "数据还在");
    second.db.close();
  } finally {
    s.close();
  }
});

test("导入后可以改导入的对象、撤销、重做", () => {
  const s = scene("full.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const result = applyCommands(db, s.registry, {
      actor,
      intentId: "edit-imported",
      label: "改导入的便签",
      commands: [
        {
          op: "object.update",
          id: "obj-text-1",
          set: { body: "改过的正文" },
        },
      ],
    });
    assert.ok(result.historyId, "这次修改进了撤销历史");
    const changed = objectsOf(db).find((o) => o.id === "obj-text-1");
    assert.equal(changed!.data.body, "改过的正文");
    assert.equal(changed!.version, 4, "版本号加一");

    undo(db, actor);
    const undone = objectsOf(db).find((o) => o.id === "obj-text-1");
    assert.equal(
      undone!.data.body,
      "在港口长大，怕水。",
      "撤销回到导入时的内容",
    );

    redo(db, actor);
    const redone = objectsOf(db).find((o) => o.id === "obj-text-1");
    assert.equal(redone!.data.body, "改过的正文", "重做又改回来");
    db.close();
  } finally {
    s.close();
  }
});

test("导入后可以移动导入的展示并撤销", () => {
  const s = scene("full.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    const presentation = presentationsOf(db).find(
      (p) => p.id === "p-note-target",
    );
    assert.ok(presentation);
    applyCommands(db, s.registry, {
      actor,
      intentId: "move-imported",
      commands: [
        {
          op: "presentation.update",
          id: "p-note-target",
          x: 1234,
          y: 567,
        },
      ],
    });
    const moved = presentationsOf(db).find((p) => p.id === "p-note-target");
    assert.equal(moved!.x, 1234);
    undo(db, actor);
    const back = presentationsOf(db).find((p) => p.id === "p-note-target");
    assert.equal(back!.x, 700, "撤销回到导入时的位置");
    db.close();
  } finally {
    s.close();
  }
});

test("打开一个什么都没有的工作空间：新建一个空的", () => {
  const root = mkdtempSync(join(tmpdir(), "sand-import-"));
  try {
    const registry = createRegistry();
    for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
    const { db, imported } = openWorkspace(root, "brand-new", registry);
    assert.equal(imported, null, "没有旧文件就不导入");
    assert.ok(existsSync(join(root, "brand-new", "workspace.db")));
    const boards = objectsOf(db, "base.board");
    assert.equal(boards.length, 1, "新库自带一个首页白板");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importV2 直接调用：写入算一次修订，旧文件不动", () => {
  const s = scene("full.json");
  try {
    const dbFile = join(s.dir, "workspace.db");
    const report = importV2(
      join(s.dir, "workspace.json"),
      dbFile,
      s.registry,
      () => 1700000900000,
    );
    assert.ok(report.objects > 0);
    assert.ok(report.presentations > 0);
    assert.ok(report.relations > 0);
    assert.ok(existsSync(dbFile));
    assert.equal(
      existsSync(join(s.dir, "workspace.db-wal")),
      false,
      "写完就落盘了",
    );
    const db = openWorkspaceDb(dbFile, { create: false });
    assert.equal(getMeta(db, "revision"), "1", "导入算一次修订");
    assert.equal(
      getMeta(db, "workspace_id"),
      "demo-workspace",
      "工作空间 id 取自旧文件",
    );
    assert.equal(getMeta(db, "title"), "示例工作空间", "标题取自旧文件");
    assert.equal(
      getMeta(db, "created_at"),
      "1700000000000",
      "创建时间取自旧文件",
    );
    assert.equal(
      objectsOf(db).every((o) => o.rev === 1),
      true,
    );
    db.close();
  } finally {
    s.close();
  }
});

test("旧版本的文件先升到 v2 的形状再导入", () => {
  const s = scene("v0.json");
  try {
    const { db, imported } = openWorkspace(s.root, "demo", s.registry);
    assert.ok(imported, "老文件也导入了");
    const note = objectsOf(db, "base.note").find((o) => o.id === "obj-old");
    assert.ok(note, "老文件里的对象导进来了");
    assert.equal(note!.data.body, "很久以前写的");
    const presentation = presentationsOf(db).find((p) => p.id === "p-old");
    assert.ok(presentation, "老文件里的展示也导进来了");
    assert.equal(presentation!.boardId, "overview");
    assert.equal(getMeta(db, "home_board_id"), "overview");
    db.close();
  } finally {
    s.close();
  }
});

test("附件路径限制在 attachments 目录内", () => {
  const s = sceneFrom(
    {
      schemaVersion: 2,
      id: "attach-guard",
      title: "附件",
      revision: 1,
      boards: [
        {
          id: "board-1",
          title: "板",
          spaces: [{ id: "overview", title: "总览" }],
          assets: [
            {
              id: "asset-ok",
              name: "ok.txt",
              mime: "text/plain",
              bytes: 9,
            },
            {
              id: "asset-escape",
              name: "../secret.txt",
              mime: "text/plain",
              bytes: 14,
            },
            {
              id: "asset-passwd",
              name: "../../../../../../etc/passwd",
              mime: "text/plain",
              bytes: 1,
            },
            {
              id: "asset-link",
              name: "escape",
              mime: "text/plain",
              bytes: 14,
            },
          ],
        },
      ],
      objects: [],
      relations: [],
    },
    (dir) => {
      writeFileSync(join(dir, "secret.txt"), "SECRET_OUTSIDE");
      const attachments = join(dir, "attachments");
      mkdirSync(attachments);
      writeFileSync(join(attachments, "ok.txt"), "inside-ok");
      symlinkSync(join(dir, "secret.txt"), join(attachments, "escape"));
    },
  );
  try {
    const { db, imported } = openWorkspace(s.root, "mini", s.registry);
    const reasons = imported!.skipped.map(
      (item) => `${item.what} ${item.reason}`,
    );
    assert.ok(
      reasons.some(
        (line) => line.includes("../secret.txt") && line.includes("路径分隔"),
      ),
      "带 .. 的名字被拒绝",
    );
    assert.ok(
      reasons.some(
        (line) => line.includes("etc/passwd") && line.includes("路径分隔"),
      ),
      "逃出目录的名字被拒绝",
    );
    assert.ok(
      reasons.some(
        (line) => line.includes("etc/passwd") && line.includes("越界"),
      ),
      "报告里写明附件名越界",
    );
    assert.ok(
      reasons.some(
        (line) => line.includes("escape") && line.includes("超出了"),
      ),
      "指向目录外的符号链接被拒绝",
    );
    const blobs = join(s.dir, "blobs");
    const texts = existsSync(blobs)
      ? readdirSync(blobs).map((name) =>
          readFileSync(join(blobs, name)).toString("utf8"),
        )
      : [];
    assert.ok(texts.includes("inside-ok"), "目录内的附件照常导入");
    assert.equal(
      texts.some((text) => text.includes("SECRET_OUTSIDE")),
      false,
      "目录外的文件没有被复制进 blobs",
    );
    assert.equal(
      texts.some((text) => text.includes("root:")),
      false,
      "越界读到的系统文件没有被复制进 blobs",
    );
    const media = objectsOf(db, "base.media");
    assert.deepEqual(
      media.map((item) => item.id),
      ["asset-ok"],
    );
    db.close();
  } finally {
    s.close();
  }
});

test("引用附件的 resource 写成 base.media 的 blob", () => {
  const s = sceneFrom(
    {
      schemaVersion: 2,
      id: "resource-blob",
      title: "媒体",
      revision: 1,
      boards: [
        {
          id: "board-1",
          title: "板",
          spaces: [{ id: "overview", title: "总览" }],
          presentations: [
            presentation("p-pic", "obj-pic", { x: 0, y: 0 }),
            presentation(
              "p-local",
              "p-local",
              { x: 200, y: 0 },
              {
                type: "resource",
                binding: false,
                data: { assetId: "asset-file" },
              },
            ),
          ],
          assets: [
            {
              id: "asset-1",
              name: "a.png",
              mime: "image/png",
              dataUrl: "data:image/png;base64,iVBORw0KGgo=",
              bytes: 8,
            },
            {
              id: "asset-file",
              name: "note.txt",
              mime: "text/plain",
              bytes: 5,
            },
          ],
        },
      ],
      objects: [
        {
          id: "obj-pic",
          type: "resource",
          title: "封面",
          data: { assetId: "asset-1", caption: "封面" },
        },
        {
          id: "obj-missing",
          type: "resource",
          title: "缺附件",
          data: { assetId: "missing" },
        },
      ],
      relations: [
        {
          id: "rel-custom",
          source: "obj-pic",
          target: "obj-missing",
          kind: "自造",
          status: "confirmed",
        },
      ],
    },
    (dir) => {
      mkdirSync(join(dir, "attachments"));
      writeFileSync(join(dir, "attachments", "note.txt"), "hello");
    },
  );
  try {
    const { db, imported } = openWorkspace(s.root, "mini", s.registry);
    const pic = objectsOf(db).find((item) => item.id === "obj-pic");
    const asset = objectsOf(db).find((item) => item.id === "asset-1");
    assert.equal(pic!.type, "base.media");
    assert.equal(pic!.data.assetId, "asset-1", "原来的 assetId 保留");
    assert.equal(pic!.data.caption, "封面");
    assert.equal(pic!.data.blob, asset!.data.blob, "blob 指向已导入的附件");
    assert.equal(pic!.data.mime, "image/png");
    assert.match(String(pic!.data.blob), /^[0-9a-f]{64}$/);
    assert.ok(
      existsSync(join(s.dir, "blobs", String(pic!.data.blob))),
      "blob 的字节文件真的写进了 blobs 目录",
    );
    const blobRow = db
      .prepare("SELECT * FROM blobs WHERE sha256 = ?")
      .get(String(pic!.data.blob)) as { mime: string } | undefined;
    assert.equal(blobRow?.mime, "image/png", "blobs 表里登记了这个附件");
    const shown = presentationsOf(db).find((item) => item.id === "p-pic");
    assert.equal(shown!.objectId, "obj-pic", "展示仍绑在原来的对象上");

    const local = objectsOf(db).find((item) => item.title === "p-local");
    const fileAsset = objectsOf(db).find((item) => item.id === "asset-file");
    assert.equal(local!.type, "base.media");
    assert.equal(local!.data.blob, fileAsset!.data.blob);
    assert.equal(
      readFileSync(join(s.dir, "blobs", String(local!.data.blob)), "utf8"),
      "hello",
    );

    const missing = objectsOf(db).find((item) => item.id === "obj-missing");
    assert.equal(missing!.type, "base.media");
    assert.equal(missing!.data.assetId, "missing");
    assert.equal(missing!.data.blob, undefined);
    assert.ok(
      imported!.warnings.some(
        (item) =>
          item.what.includes("缺附件") && item.reason.includes("missing"),
      ),
    );

    const custom = relationsOf(db).find((item) => item.id === "rel-custom");
    assert.equal(custom!.kind, "自造", "未知对象关系 kind 不加 legacy 前缀");
    db.close();
  } finally {
    s.close();
  }
});

test("分组的展示 id 全部失效时改用对象 id", () => {
  const s = sceneFrom({
    schemaVersion: 2,
    id: "groups",
    title: "分组",
    revision: 1,
    boards: [
      {
        id: "board-1",
        title: "板",
        spaces: [{ id: "overview", title: "总览" }],
        presentations: [
          presentation("p1", "o1", { x: 10, y: 10 }),
          presentation("p2", "o2", { x: 200, y: 10 }),
          presentation("p3", "o3", { x: 10, y: 200 }),
          presentation("p4", "o4", { x: 200, y: 200 }),
        ],
        groups: [
          {
            id: "g-stale",
            title: "旧展示",
            instanceIds: ["missing-a", "missing-b"],
            objectIds: ["o1", "o2"],
          },
          {
            id: "g-partial",
            title: "只认展示",
            instanceIds: ["p3"],
            objectIds: ["o3", "o4"],
          },
        ],
      },
    ],
    objects: [
      { id: "o1", type: "text", title: "甲", data: { text: "甲" } },
      { id: "o2", type: "text", title: "乙", data: { text: "乙" } },
      { id: "o3", type: "text", title: "丙", data: { text: "丙" } },
      { id: "o4", type: "text", title: "丁", data: { text: "丁" } },
    ],
    relations: [],
  });
  try {
    const { db } = openWorkspace(s.root, "mini", s.registry);
    const presentations = presentationsOf(db);
    const stale = presentations.find((item) => item.objectId === "g-stale");
    const partial = presentations.find((item) => item.objectId === "g-partial");
    assert.ok(stale, "展示 id 全部失效时分组仍导入");
    assert.equal(
      presentations.find((item) => item.id === "p1")!.parentId,
      stale!.id,
    );
    assert.equal(
      presentations.find((item) => item.id === "p2")!.parentId,
      stale!.id,
    );
    assert.ok(partial, "还有对得上的展示 id 时分组导入");
    assert.equal(
      presentations.find((item) => item.id === "p3")!.parentId,
      partial!.id,
    );
    assert.equal(
      presentations.find((item) => item.id === "p4")!.parentId,
      null,
      "对得上一部分时不把其余对象 id 再加进来",
    );
    db.close();
  } finally {
    s.close();
  }
});

test("组件包清单不合格：不写库、记进报告，工作空间照样打得开", () => {
  const s = scene("bad-pack.json");
  try {
    const { db, imported } = openWorkspace(s.root, "demo", s.registry);
    assert.ok(imported, "这次是从旧版文件导入的");
    const entries = [
      ...imported!.skipped.map((item) => `${item.what} ${item.reason}`),
      ...imported!.warnings.map((item) => `${item.what} ${item.reason}`),
    ];
    assert.ok(
      entries.some(
        (line) => line.includes("大包") && line.includes("清单不合格"),
      ),
      "不合格的组件包进了报告",
    );
    const pack = db
      .prepare("SELECT * FROM packs WHERE id = ?")
      .get("big-pack") as unknown;
    assert.equal(pack, undefined, "不合格的包没有写进 packs 表");
    assert.ok(
      objectsOf(db).some((o) => o.id === "obj-ok"),
      "其余数据照常导入",
    );
    assert.ok(
      presentationsOf(db).some((p) => p.id === "p-ok"),
      "其余展示照常导入",
    );
    db.close();

    // 关键：这个工作空间以后还能打开。
    const again = openWorkspace(s.root, "demo", s.registry);
    assert.equal(again.imported, null, "第二次不再导入");
    assert.ok(
      objectsOf(again.db).some((o) => o.id === "obj-ok"),
      "数据还在",
    );
    again.db.close();
  } finally {
    s.close();
  }
});

test("库里已经有不合格的组件包：跳过它并给出提示，工作空间照样打得开", () => {
  const s = scene("full.json");
  try {
    const first = openWorkspace(s.root, "demo", s.registry);
    assert.ok(first.imported, "第一次是导入");
    first.db.prepare("UPDATE packs SET manifest = ? WHERE id = ?").run(
      JSON.stringify({
        format: "sand-table-pack",
        formatVersion: 2,
        id: "my-pack",
        version: 1,
      }),
      "my-pack",
    );
    first.db.close();

    // 换一个干净的注册表，模拟重新打开这个工作空间。
    const registry = createRegistry();
    for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
    const second = openWorkspace(s.root, "demo", registry);
    assert.equal(second.imported, null, "库在就不再导入");
    assert.ok(second.skippedPacks.length, "跳过的包有交代");
    assert.equal(second.skippedPacks[0]!.id, "my-pack");
    assert.match(second.skippedPacks[0]!.reason, /清单不合格/);
    assert.match(
      second.skippedPacks[0]!.reason,
      /删掉 workspace\.db 后重新导入/,
      "提示说清下一步怎么做",
    );
    assert.ok(
      objectsOf(second.db).some((o) => o.id === "obj-text-1"),
      "数据没有丢",
    );
    second.db.close();
  } finally {
    s.close();
  }
});

test("软删除坏包用新修订号：墓碑和 meta.revision 一起推进，没有坏包时修订号不动", () => {
  const s = scene("full.json");
  const saved = process.env.SAND_KERNEL;
  // 这条修复不在 SAND_KERNEL=v3 开关后面：不设它行为也一样。
  delete process.env.SAND_KERNEL;
  try {
    const first = openWorkspace(s.root, "demo", s.registry);
    assert.ok(first.imported, "第一次是导入");
    const before = Number(getMeta(first.db, "revision"));
    assert.equal(before, 2, "导入算一次修订，内置包同步再算一次");
    first.db.prepare("UPDATE packs SET manifest = ? WHERE id = ?").run(
      JSON.stringify({
        format: "sand-table-pack",
        formatVersion: 2,
        id: "my-pack",
        version: 1,
      }),
      "my-pack",
    );
    first.db.close();

    // 换一个干净的注册表，模拟重新打开这个工作空间。
    const registry = createRegistry();
    for (const pack of builtinPacks) registry.registerPack(pack, "builtin");
    const second = openWorkspace(s.root, "demo", registry);
    assert.equal(second.imported, null, "库在就不再导入");
    assert.equal(second.skippedPacks.length, 1, "坏包被跳过了");

    // (a) 墓碑的修订号 = 打开前的修订号 + 1
    const row = second.db
      .prepare("SELECT deleted_rev, rev FROM packs WHERE id = ?")
      .get("my-pack") as
      { deleted_rev: number | null; rev: number } | undefined;
    assert.ok(row, "坏包这一行还留在库里");
    assert.equal(
      row!.deleted_rev,
      before + 1,
      "墓碑用的是新修订号，停在旧修订号的客户端才看得到这次删除",
    );
    assert.equal(row!.rev, before + 1, "这一行的修订号也是新修订号");
    const live = second.db
      .prepare("SELECT id FROM packs WHERE id = ? AND deleted_rev IS NULL")
      .get("my-pack");
    assert.equal(live, undefined, "坏包已经软删除，syncPacks 不会装入它");

    // (b) meta.revision 同步推进到同一个值
    assert.equal(
      Number(getMeta(second.db, "revision")),
      before + 1,
      "修订号和墓碑一起推进",
    );

    // 没有坏包时不该涨修订号：再打开一次，修订号不动。
    second.db.close();
    const third = openWorkspace(s.root, "demo", registry);
    assert.equal(third.skippedPacks.length, 0, "没有坏包了");
    assert.equal(
      Number(getMeta(third.db, "revision")),
      before + 1,
      "打开工作空间不会每次都涨修订号",
    );
    third.db.close();
  } finally {
    if (saved === undefined) delete process.env.SAND_KERNEL;
    else process.env.SAND_KERNEL = saved;
    s.close();
  }
});

test("内容对象的 id 和分区 id 撞车：对象照常导入，报告写清冲突，展示不被改绑", () => {
  const s = sceneFrom({
    schemaVersion: 2,
    id: "collide",
    title: "撞车",
    revision: 1,
    boards: [
      {
        id: "board-1",
        title: "板",
        spaces: [{ id: "overview", title: "总览" }],
        presentations: [
          presentation("p-collide", "overview", { x: 10, y: 10 }),
        ],
        groups: [],
        spaceLinks: [],
        assets: [],
        guides: [],
        intents: [],
        proposals: [],
        validations: [],
      },
    ],
    objects: [
      {
        id: "overview",
        kind: "native",
        type: "text",
        title: "正文",
        data: { text: "这是正文，不是分区" },
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        author: "lin",
      },
    ],
    relations: [],
  });
  try {
    const { db, imported } = openWorkspace(s.root, "mini", s.registry);
    const object = objectsOf(db).find((o) => o.id === "overview");
    assert.ok(object, "内容对象没有被静默丢弃");
    assert.equal(object!.type, "base.note");
    assert.equal(object!.data.body, "这是正文，不是分区");

    const boards = objectsOf(db, "base.board");
    assert.equal(boards.length, 1);
    assert.equal(
      boards[0]!.id,
      "board-1:overview",
      "分区让出 id，改用带白板前缀的 id",
    );
    assert.equal(getMeta(db, "home_board_id"), "board-1:overview");

    const shown = presentationsOf(db).find((p) => p.id === "p-collide");
    assert.ok(shown, "展示导进来了");
    assert.equal(
      shown!.objectId,
      "overview",
      "展示仍然绑在它原来的内容对象上，没有被改绑到分区",
    );
    assert.equal(shown!.boardId, "board-1:overview");

    assert.ok(
      imported!.warnings.some(
        (item) =>
          item.what.includes("分区") &&
          item.reason.includes("overview") &&
          item.reason.includes("重名"),
      ),
      "报告里写清了 id 冲突",
    );
    db.close();
  } finally {
    s.close();
  }
});

test("内容对象的 id 同时占了分区 id 和它的备用名：分区另起 id，首页和分区入口都指着分区自己", () => {
  const s = sceneFrom({
    schemaVersion: 2,
    id: "collide-twice",
    title: "撞两次",
    revision: 1,
    boards: [
      {
        id: "board-1",
        title: "板",
        spaces: [
          { id: "overview", title: "总览" },
          { id: "child", title: "子分区", parentId: "overview" },
        ],
        presentations: [
          {
            id: "p-to-overview",
            spaceId: "child",
            type: "board",
            title: "回总览",
            data: { spaceId: "overview" },
            rect: { x: 10, y: 10, width: 200, height: 120, pinned: false },
            updatedAt: 1,
            author: "lin",
          },
          {
            id: "p-text",
            spaceId: "child",
            type: "text",
            binding: { kind: "object", objectId: "overview" },
            objectId: "overview",
            title: "正文",
            data: {},
            rect: { x: 300, y: 10, width: 200, height: 120, pinned: false },
            updatedAt: 1,
            author: "lin",
          },
        ],
        groups: [],
        spaceLinks: [],
        assets: [],
        guides: [],
        intents: [],
        proposals: [],
        validations: [],
      },
    ],
    objects: [
      {
        id: "overview",
        kind: "native",
        type: "text",
        title: "正文",
        data: { text: "这是正文，不是分区" },
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        author: "lin",
      },
      {
        id: "board-1:overview",
        kind: "native",
        type: "text",
        title: "占备用名的正文",
        data: { text: "这个正文占了分区改名的备用名" },
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        author: "lin",
      },
    ],
    relations: [],
  });
  try {
    const { db, imported } = openWorkspace(s.root, "mini", s.registry);

    // —— 分区对象：两个 id 都被占了，只能另起一个 ——
    const boards = objectsOf(db, "base.board");
    assert.equal(boards.length, 2, "两个分区都导进来了");
    const root = boards.find((b) => b.title === "总览");
    assert.ok(root, "总览分区导进来了");
    assert.notEqual(root!.id, "overview", "分区没有占着内容对象的 id");
    assert.notEqual(
      root!.id,
      "board-1:overview",
      "备用名也被内容对象占了，分区不能用它",
    );
    assert.match(
      root!.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "分区用的是新生成的 id",
    );

    // —— 首页指着分区自己，不是内容对象 ——
    assert.equal(
      getMeta(db, "home_board_id"),
      root!.id,
      "首页是分区对象，不是占着 id 的内容对象",
    );
    assert.notEqual(getMeta(db, "home_board_id"), "overview");
    assert.notEqual(getMeta(db, "home_board_id"), "board-1:overview");

    // —— 内容对象照常导入，没有被丢弃 ——
    const text = objectsOf(db).find((o) => o.id === "overview");
    assert.ok(text, "占着分区 id 的内容对象没有被丢弃");
    assert.equal(text!.type, "base.note");
    assert.equal(text!.data.body, "这是正文，不是分区");
    const holder = objectsOf(db).find((o) => o.id === "board-1:overview");
    assert.ok(holder, "占着备用名的内容对象也没有被丢弃");
    assert.equal(holder!.data.body, "这个正文占了分区改名的备用名");

    // —— 分区自己的展示绑在分区对象上 ——
    const link = presentationsOf(db).find((p) => p.id === "p-to-overview");
    assert.ok(link, "分区入口的展示导进来了");
    assert.equal(link!.objectId, root!.id, "展示绑在分区对象上");
    assert.notEqual(link!.objectId, "overview", "没有绑到占着 id 的内容对象上");
    assert.notEqual(link!.objectId, "board-1:overview");
    assert.equal(link!.boardId, "child", "展示仍挂在它原来所在的分区上");

    // —— 绑在内容对象上的展示没有被改绑 ——
    const bound = presentationsOf(db).find((p) => p.id === "p-text");
    assert.ok(bound, "绑内容对象的展示也导进来了");
    assert.equal(
      bound!.objectId,
      "overview",
      "绑内容对象的展示没有被改绑到分区上",
    );

    // —— 报告里看得见这次冲突与改名 ——
    const warnings = imported!.warnings.map((w) => `${w.what} ${w.reason}`);
    assert.ok(
      warnings.some(
        (line) =>
          line.includes("分区") &&
          line.includes("overview") &&
          line.includes("重名") &&
          line.includes(root!.id),
      ),
      "报告里写清分区改用了哪个 id",
    );
    assert.ok(
      warnings.some((line) => line.includes("重复") && line.includes(root!.id)),
      "报告里写清备用名被占了这件事",
    );
    db.close();
  } finally {
    s.close();
  }
});

test("导入失败时不留孤儿附件文件", () => {
  const first = createHash("sha256").update("hello").digest("hex");
  const second = createHash("sha256").update("world").digest("hex");
  const s = sceneFrom(
    {
      schemaVersion: 2,
      id: "blob-fail",
      title: "附件",
      revision: 1,
      boards: [
        {
          id: "board-1",
          title: "板",
          spaces: [{ id: "overview", title: "总览" }],
          presentations: [],
          assets: [
            {
              id: "asset-1",
              name: "a.txt",
              mime: "text/plain",
              dataUrl: "data:text/plain;base64,aGVsbG8=",
              bytes: 5,
            },
            {
              id: "asset-2",
              name: "b.txt",
              mime: "text/plain",
              dataUrl: "data:text/plain;base64,d29ybGQ=",
              bytes: 5,
            },
          ],
          groups: [],
          spaceLinks: [],
          guides: [],
          intents: [],
          proposals: [],
          validations: [],
        },
      ],
      objects: [],
      relations: [],
    },
    (dir) => {
      const blobs = join(dir, "blobs");
      mkdirSync(blobs);
      // 第二个附件写不下去：它的位置是一个指向不存在路径的符号链接。
      symlinkSync(join(dir, "no-such-dir", "b.txt"), join(blobs, second));
    },
  );
  try {
    assert.throws(
      () => openWorkspace(s.root, "mini", s.registry),
      /附件写不进/,
      "附件写不下去时导入失败",
    );
    assert.equal(
      existsSync(join(s.dir, "workspace.db")),
      false,
      "半成品数据库删掉了",
    );
    const blobs = join(s.dir, "blobs");
    const files = existsSync(blobs) ? readdirSync(blobs) : [];
    assert.equal(
      files.includes(first),
      false,
      "已经写出去的附件文件也删掉了，不留孤儿",
    );
  } finally {
    s.close();
  }
});

test("坏数据的错误信息写明是哪个文件、缺什么、下一步怎么做", () => {
  const s = sceneFrom({
    schemaVersion: 2,
    id: "broken-presentation",
    title: "坏数据",
    revision: 1,
    boards: [
      {
        id: "board-1",
        title: "板",
        spaces: [{ id: "overview", title: "总览" }],
        presentations: [
          {
            spaceId: "overview",
            type: "text",
            title: "缺 id 的展示",
            data: {},
            rect: { x: 0, y: 0, width: 10, height: 10, pinned: false },
            updatedAt: 1,
            author: "lin",
          },
        ],
      },
    ],
    objects: [],
    relations: [],
  });
  try {
    assert.throws(
      () => openWorkspace(s.root, "mini", s.registry),
      (error: Error) => {
        assert.match(error.message, /第 1 条展示实例/);
        assert.ok(
          error.message.includes(join(s.dir, "workspace.json")),
          `错误信息里有文件路径：${error.message}`,
        );
        assert.match(error.message, /另存一份/);
        assert.match(error.message, /缺 id/);
        return true;
      },
    );
  } finally {
    s.close();
  }
});

test("重复的对象 id：错误信息写明是哪个文件", () => {
  const s = sceneFrom({
    schemaVersion: 2,
    id: "dup",
    title: "重复 id",
    revision: 1,
    boards: [],
    objects: [
      { id: "same", type: "text", title: "甲", data: {} },
      { id: "same", type: "text", title: "乙", data: {} },
    ],
    relations: [],
  });
  try {
    assert.throws(
      () => openWorkspace(s.root, "mini", s.registry),
      (error: Error) => {
        assert.ok(
          error.message.includes(join(s.dir, "workspace.json")),
          `错误信息里有文件路径：${error.message}`,
        );
        assert.match(error.message, /重复的对象 id/);
        assert.match(error.message, /另存一份/);
        return true;
      },
    );
  } finally {
    s.close();
  }
});

test("openWorkspace 之后修订号是 2：导入算一次，内置包同步再算一次", () => {
  const s = scene("full.json");
  try {
    const { db } = openWorkspace(s.root, "demo", s.registry);
    assert.equal(getMeta(db, "revision"), "2");
    db.close();
  } finally {
    s.close();
  }
});

test("v1 的文件先升到 v2 的形状再导入", () => {
  const s = scene("v1.json");
  try {
    const { db, imported } = openWorkspace(s.root, "demo", s.registry);
    assert.ok(imported, "v1 的文件也导入了");
    const note = objectsOf(db, "base.note").find((o) => o.id === "obj-v1");
    assert.ok(note, "v1 文件里的对象导进来了");
    assert.equal(note!.data.body, "v1 时代写的");
    const shown = presentationsOf(db).find((p) => p.id === "p-v1");
    assert.ok(shown, "v1 文件里的展示也导进来了");
    assert.equal(shown!.boardId, "overview");
    assert.equal(getMeta(db, "home_board_id"), "overview");
    db.close();
  } finally {
    s.close();
  }
});
