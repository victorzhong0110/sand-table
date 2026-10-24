// 改动链路：意图 → 提案 → 人批准 → 宿主写入 → 核对。
//
// 本模块不写目标文件。批准只接受 human。摘要按当前提案内容重算，不信任
// 对象里可能已经过期的 digest 字段。

import {
  applyCommands,
  boardContents,
  CommandError,
  getMeta,
  newId,
  readView,
  setMeta,
  toObjectRow,
  type Actor,
  type Command,
  type Db,
  type ObjectRow,
  type Registry,
} from "../../kernel/index.ts";
import {
  isBlobRef,
  readBlob,
  spillText,
  writeBlob,
  type BlobRef,
} from "./blobs.ts";
import {
  currentFile,
  digest,
  observeWorktree,
  openRepo,
  validatePath,
  worktreeState,
  type Binding,
  type FileRef,
  type ProposalFile,
  type Verification,
  type WorkspaceState,
} from "./git.ts";

const BATCH = 200;
const DATA_BUDGET = 1024 * 1024;

type StoredText = string | BlobRef | null;

type StoredFile = {
  workspaceId: string;
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  before: StoredText;
  after: StoredText;
};

type BaselineState = WorkspaceState & { filesBlob?: string };

const APPLY_INSTRUCTION =
  "Use the host file tools only. For each approved file, call code_change read_approved_file immediately before writing, compare its beforeHash with actual contents, write the exact after content, then call code_change verify. These checks are not an atomic write guarantee.";

function fail(
  code: ConstructorParameters<typeof CommandError>[0],
  message: string,
): never {
  throw new CommandError(code, message, null);
}

function loadObject(db: Db, id: string): ObjectRow {
  const raw = db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!raw) fail("NOT_FOUND", "找不到这个对象。请重新读取后再试。");
  const row = toObjectRow(raw);
  if (row.deleted)
    fail(
      "NOT_FOUND",
      `「${row.title || "这个对象"}」已经删除。请重新读取后再试。`,
    );
  return row;
}

function countType(db: Db, type: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM objects WHERE type = ? AND deleted_rev IS NULL",
    )
    .get(type) as { n: number };
  return Number(row.n);
}

function linkedIds(
  db: Db,
  column: "source_id" | "target_id",
  id: string,
  kind: string,
): string[] {
  const other = column === "source_id" ? "target_id" : "source_id";
  const rows = db
    .prepare(
      `SELECT ${other} AS id FROM relations
       WHERE ${column} = ? AND kind = ? AND deleted_rev IS NULL`,
    )
    .all(id, kind) as { id: string }[];
  return rows.map((row) => String(row.id));
}

function apply(db: Db, registry: Registry, actor: Actor, commands: Command[]) {
  if (commands.length > BATCH)
    fail(
      "LIMIT",
      "一次最多提交 200 条命令。请减少涉及的对象后再提交，不能拆成多次。",
    );
  if (!commands.length)
    return {
      revision: Number(getMeta(db, "revision") ?? "0"),
      created: {} as Record<string, string>,
    };
  return applyCommands(db, registry, { actor, commands });
}

function approvalKey(proposalId: string) {
  return `code.approval:${proposalId}`;
}

type Approval = { decision: "accepted" | "rejected"; digest: string };

function readApproval(db: Db, proposalId: string): Approval | null {
  const raw = getMeta(db, approvalKey(proposalId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Approval;
    if (parsed.decision !== "accepted" && parsed.decision !== "rejected")
      return null;
    if (typeof parsed.digest !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeApproval(db: Db, proposalId: string, approval: Approval) {
  setMeta(db, approvalKey(proposalId), JSON.stringify(approval));
}

function clearApproval(db: Db, proposalId: string) {
  setMeta(db, approvalKey(proposalId), "");
}

function approvedNow(db: Db, row: ObjectRow, intentId: string) {
  const approval = readApproval(db, row.id);
  return (
    approval?.decision === "accepted" &&
    approval.digest === currentDigest(db, row, intentId)
  );
}

function asFiles(value: unknown): FileRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is FileRef =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as FileRef).workspaceId === "string" &&
      typeof (item as FileRef).path === "string",
  );
}

function asStoredFiles(value: unknown): StoredFile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is StoredFile =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as StoredFile).workspaceId === "string" &&
      typeof (item as StoredFile).path === "string",
  );
}

function resolveText(db: Db, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (isBlobRef(value)) return readBlob(db, value.blob);
  fail("INVALID_DATA", "提案里的文件内容格式不对。请重新发布提案。");
}

function repoRows(db: Db): ObjectRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM objects
         WHERE type = 'code.repository' AND deleted_rev IS NULL`,
      )
      .all() as Record<string, unknown>[]
  ).map(toObjectRow);
}

function bindingsOf(db: Db, ids: string[]): Binding[] {
  const wanted = new Set(ids);
  const bindings: Binding[] = [];
  for (const row of repoRows(db)) {
    if (!wanted.has(row.id)) continue;
    if (row.source?.origin !== "derived" || row.source.external?.kind !== "git")
      fail(
        "NOT_FOUND",
        "这个编号不是已导入的代码仓库。请先用 code_repo 导入，不要手写仓库地址。",
      );
    const root = row.source.external.uri;
    if (!root)
      fail("NOT_FOUND", "这个代码仓库没有可用的本地路径。请重新导入。");
    const label =
      typeof row.data.label === "string" ? row.data.label : "project";
    // 每次读文件前重新确认这是 Git 根目录，不信任对象里保存的原始字符串。
    const opened = openRepo(label, root);
    bindings.push({ id: row.id, label: opened.label, root: opened.root });
  }
  if (bindings.length !== wanted.size)
    fail("NOT_FOUND", "找不到提案里的代码仓库。请先导入仓库后再试。");
  return bindings;
}

function contentVersionOf(row: ObjectRow): number {
  const value = row.data.contentVersion;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 1;
}

function intentOf(db: Db, proposalId: string): string | undefined {
  for (const sourceId of linkedIds(
    db,
    "target_id",
    proposalId,
    "code.contains",
  )) {
    const raw = db
      .prepare("SELECT type FROM objects WHERE id = ? AND deleted_rev IS NULL")
      .get(sourceId) as { type: string } | undefined;
    if (raw?.type === "code.intent") return sourceId;
  }
  return undefined;
}

function proposalDigest(input: {
  id: string;
  version: number;
  intentId: string;
  intentVersion: number;
  title: string;
  explanation: string;
  testPlan: string;
  files: {
    workspaceId: string;
    path: string;
    beforeHash: string | null;
    afterHash: string | null;
  }[];
}): string {
  return digest(
    JSON.stringify({
      id: input.id,
      version: input.version,
      intentId: input.intentId,
      intentVersion: input.intentVersion,
      title: input.title,
      explanation: input.explanation,
      testPlan: input.testPlan,
      files: input.files.map((file) => ({
        workspaceId: file.workspaceId,
        path: file.path,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
      })),
    }),
  );
}

function normalizedFiles(db: Db, files: StoredFile[]): ProposalFile[] {
  return files.map((file) => {
    const before = resolveText(db, file.before);
    const after = resolveText(db, file.after);
    return {
      workspaceId: file.workspaceId,
      path: file.path,
      before,
      after,
      beforeHash: before === null ? null : digest(before),
      afterHash: after === null ? null : digest(after),
    };
  });
}

function currentDigest(db: Db, row: ObjectRow, intentId: string): string {
  const files = normalizedFiles(db, asStoredFiles(row.data.files));
  return proposalDigest({
    id: row.id,
    version: contentVersionOf(row),
    intentId,
    intentVersion: Number(row.data.intentVersion ?? 0),
    title: String(row.data.title ?? ""),
    explanation: String(row.data.explanation ?? ""),
    testPlan: String(row.data.testPlan ?? ""),
    files,
  });
}

function expandBaseline(db: Db, value: unknown): BaselineState[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const state = item as BaselineState;
    if (!state.filesBlob) return state;
    const parsed = JSON.parse(
      readBlob(db, state.filesBlob),
    ) as BaselineState["files"];
    return { ...state, files: parsed };
  });
}

function observe(db: Db, row: ObjectRow): Verification {
  const files = normalizedFiles(db, asStoredFiles(row.data.files));
  const bindings = bindingsOf(db, [
    ...new Set(files.map((file) => file.workspaceId)),
  ]);
  return observeWorktree(
    bindings,
    files,
    expandBaseline(db, row.data.baseline),
  );
}

function summaryOf(db: Db, row: ObjectRow, intentId: string) {
  const files = normalizedFiles(db, asStoredFiles(row.data.files));
  return {
    id: row.id,
    version: contentVersionOf(row),
    digest: currentDigest(db, row, intentId),
    intentId,
    intentVersion: Number(row.data.intentVersion ?? 0),
    title: String(row.data.title ?? row.title),
    agentId: String(row.data.agentId ?? ""),
    decision: String(row.data.decision ?? "pending"),
    files: files.map((file) => ({
      workspaceId: file.workspaceId,
      path: file.path,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
    })),
    verification: row.data.verification ?? null,
  };
}

function fitStored(
  db: Db,
  files: StoredFile[],
  baseline: BaselineState[],
  rest: Record<string, unknown>,
): { files: StoredFile[]; baseline: BaselineState[] } {
  const packedFiles = files.map((file) => ({
    ...file,
    before:
      typeof file.before === "string"
        ? spillText(db, file.before)
        : file.before,
    after:
      typeof file.after === "string" ? spillText(db, file.after) : file.after,
  }));
  let packedBaseline = baseline.map((state) => ({ ...state }));
  const payload = () => ({
    ...rest,
    files: packedFiles,
    baseline: packedBaseline,
  });
  const tooBig = () =>
    Buffer.byteLength(JSON.stringify(payload())) > DATA_BUDGET;
  const spillFileField = (key: "before" | "after") => {
    let chosen = -1;
    let size = 0;
    packedFiles.forEach((file, index) => {
      const value = file[key];
      if (typeof value !== "string") return;
      const bytes = Buffer.byteLength(value);
      if (bytes > size) {
        size = bytes;
        chosen = index;
      }
    });
    if (chosen < 0) return false;
    const value = packedFiles[chosen]![key];
    if (typeof value !== "string") return false;
    packedFiles[chosen] = {
      ...packedFiles[chosen]!,
      [key]: writeBlob(db, Buffer.from(value, "utf8")),
    };
    return true;
  };
  const spillBaseline = () => {
    let chosen = -1;
    let size = 0;
    packedBaseline.forEach((state, index) => {
      if (state.filesBlob) return;
      const bytes = Buffer.byteLength(JSON.stringify(state.files));
      if (bytes > size) {
        size = bytes;
        chosen = index;
      }
    });
    if (chosen < 0 || size === 0) return false;
    const state = packedBaseline[chosen]!;
    const written = writeBlob(
      db,
      Buffer.from(JSON.stringify(state.files), "utf8"),
    );
    packedBaseline[chosen] = { ...state, files: {}, filesBlob: written.blob };
    return true;
  };
  while (tooBig()) {
    if (spillBaseline()) continue;
    if (spillFileField("before")) continue;
    if (spillFileField("after")) continue;
    fail(
      "LIMIT",
      "提案超过 1 MB，无法保存。请减少文件数量或缩短内容后再提交。",
    );
  }
  return { files: packedFiles, baseline: packedBaseline };
}

function arrangementOf(
  db: Db,
  registry: Registry,
  boardId: string,
  viewId?: string,
) {
  const board = boardContents(db, registry, boardId);
  const view = viewId ? readView(db, viewId) : undefined;
  const presentations = board.presentations.map((item) => ({
    id: item.id,
    objectId: item.objectId,
    parentId: item.parentId,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
  }));
  const full = {
    viewId: view?.viewId ?? null,
    boardId,
    revision: Number(getMeta(db, "revision") ?? "0"),
    selection: view?.selection ?? [],
    presentationCount: presentations.length,
    presentations: presentations.slice(0, 200),
    truncated: presentations.length > 200,
  };
  if (Buffer.byteLength(JSON.stringify(full)) > 700_000)
    return { ...full, presentations: [], truncated: true };
  return full;
}

function requireObjects(db: Db, ids: string[]) {
  for (let index = 0; index < ids.length; index += 20) {
    const slice = ids.slice(index, index + 20);
    if (!slice.length) continue;
    const found = new Set<string>();
    const rows = db
      .prepare(
        `SELECT id FROM objects
         WHERE deleted_rev IS NULL AND id IN (${slice.map(() => "?").join(", ")})`,
      )
      .all(...slice) as { id: string }[];
    for (const row of rows) found.add(String(row.id));
    const missing = slice.find((id) => !found.has(id));
    if (missing)
      fail("NOT_FOUND", `找不到对象「${missing}」。请重新读取后再写入意图。`);
  }
}

export function createIntent(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: {
    boardId: string;
    revision: number;
    request: string;
    objectIds?: string[];
    allowedFiles: FileRef[];
    intentId?: string;
    viewId?: string;
  },
) {
  if (Number(getMeta(db, "revision") ?? "0") !== input.revision)
    fail(
      "VERSION_CONFLICT",
      "工作空间已经变了。请重新读取修订号后再提交意图。",
    );
  const objectIds = input.objectIds ?? [];
  if (objectIds.length > 1200)
    fail("LIMIT", "一条意图最多关联 1200 个对象。请减少数量后再提交。");
  if (input.allowedFiles.length < 1 || input.allowedFiles.length > 12)
    fail("LIMIT", "一条意图要指定 1 到 12 个允许修改的文件。");
  const keys = input.allowedFiles.map(
    (file) => `${file.workspaceId}:${file.path}`,
  );
  if (new Set(keys).size !== keys.length)
    fail("INVALID_DATA", "允许修改的文件有重复。请去掉重复项后再提交。");
  for (const file of input.allowedFiles) validatePath(file.path);
  bindingsOf(db, [
    ...new Set(input.allowedFiles.map((file) => file.workspaceId)),
  ]);
  requireObjects(db, objectIds);
  const arrangement = arrangementOf(db, registry, input.boardId, input.viewId);
  const existing = input.intentId ? loadObject(db, input.intentId) : undefined;
  if (existing && existing.type !== "code.intent")
    fail("NOT_FOUND", "找不到这条改动意图。请重新读取后再修改。");
  if (!existing && countType(db, "code.intent") >= 8)
    fail("LIMIT", "意图最多 8 条。请修改已有意图，或删除一条后再新建。");
  const data = {
    request: input.request,
    allowedFiles: input.allowedFiles,
    arrangement,
  };
  const commands: Command[] = [];
  if (!existing) {
    commands.push({
      op: "object.create",
      ref: "intent",
      type: "code.intent",
      title: Array.from(input.request).slice(0, 80).join("") || "改动意图",
      data,
      source: {
        origin: actor.kind === "human" ? "human" : "ai-generated",
      },
    });
    for (const objectId of objectIds)
      commands.push({
        op: "relation.create",
        kind: "base.related",
        sourceId: "@intent",
        targetId: objectId,
        status: "confirmed",
      });
  } else {
    commands.push({
      op: "object.update",
      id: existing.id,
      expectedVersion: existing.version,
      title: Array.from(input.request).slice(0, 80).join("") || existing.title,
      set: data,
    });
    const currentLinks = db
      .prepare(
        `SELECT id, target_id FROM relations
         WHERE source_id = ? AND kind = 'base.related' AND deleted_rev IS NULL`,
      )
      .all(existing.id) as { id: string; target_id: string }[];
    const wanted = new Set(objectIds);
    for (const link of currentLinks)
      if (!wanted.has(String(link.target_id)))
        commands.push({ op: "relation.delete", id: String(link.id) });
    const have = new Set(currentLinks.map((link) => String(link.target_id)));
    for (const objectId of objectIds)
      if (!have.has(objectId))
        commands.push({
          op: "relation.create",
          kind: "base.related",
          sourceId: existing.id,
          targetId: objectId,
          status: "confirmed",
        });
    for (const targetId of linkedIds(
      db,
      "source_id",
      existing.id,
      "code.contains",
    )) {
      const target = loadObject(db, targetId);
      if (target.type !== "code.proposal") continue;
      if (target.data.decision === "stale") continue;
      commands.push({
        op: "object.update",
        id: target.id,
        expectedVersion: target.version,
        set: { decision: "stale" },
      });
    }
  }
  const written = apply(db, registry, actor, commands);
  const id = existing?.id ?? written.created.intent;
  if (!id) fail("INTERNAL", "意图没有写成。请再提交一次。");
  const saved = loadObject(db, id);
  return {
    id: saved.id,
    version: saved.version,
    request: input.request,
    objectIds,
    allowedFiles: input.allowedFiles,
    createdAt: saved.createdAt,
    arrangement,
    revision: Number(getMeta(db, "revision") ?? "0"),
  };
}

export function readIntents(db: Db) {
  const rows = (
    db
      .prepare(
        `SELECT * FROM objects
         WHERE type = 'code.intent' AND deleted_rev IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as Record<string, unknown>[]
  ).map(toObjectRow);
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    request: row.data.request ?? "",
    objectIds: linkedIds(db, "source_id", row.id, "base.related"),
    allowedFiles: asFiles(row.data.allowedFiles),
    createdAt: row.createdAt,
    arrangement: row.data.arrangement ?? {},
  }));
}

export function readTarget(
  db: Db,
  input: {
    intentId: string;
    workspaceId: string;
    path: string;
    startLine?: number;
  },
) {
  const intent = loadObject(db, input.intentId);
  if (intent.type !== "code.intent")
    fail("NOT_FOUND", "找不到这条改动意图。请重新读取后再查看文件。");
  const allowed = asFiles(intent.data.allowedFiles);
  if (
    !allowed.some(
      (file) =>
        file.workspaceId === input.workspaceId && file.path === input.path,
    )
  )
    fail(
      "FORBIDDEN",
      "这个文件不在意图允许修改的范围内。请改意图，或换一个文件。",
    );
  validatePath(input.path);
  const bindings = bindingsOf(db, [input.workspaceId]);
  const file = currentFile(bindings, input);
  const startLine = input.startLine ?? 1;
  const lines = file.text?.split("\n");
  if (lines && startLine > lines.length)
    fail("INVALID_DATA", "起始行超出了文件末尾。请把起始行改小后再读。");
  return {
    workspaceId: input.workspaceId,
    path: input.path,
    hash: file.hash,
    startLine,
    text:
      lines
        ?.slice(startLine - 1, startLine + 119)
        .join("\n")
        .slice(0, 12000) ?? null,
    nextLine: lines && startLine + 120 <= lines.length ? startLine + 120 : null,
  };
}

export function publishProposal(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: {
    intentId: string;
    intentVersion: number;
    proposalId?: string;
    previousVersion?: number;
    agentId: string;
    title: string;
    explanation: string;
    testPlan: string;
    files: (FileRef & { beforeHash: string | null; after: string | null })[];
  },
) {
  const intent = loadObject(db, input.intentId);
  if (intent.type !== "code.intent")
    fail("NOT_FOUND", "找不到这条改动意图。请重新读取后再发布提案。");
  if (intent.version !== input.intentVersion)
    fail("VERSION_CONFLICT", "意图已经变了。请重新读取当前意图后再发布。");
  const allowed = asFiles(intent.data.allowedFiles);
  const key = (file: FileRef) => `${file.workspaceId}:${file.path}`;
  if (new Set(input.files.map(key)).size !== input.files.length)
    fail("INVALID_DATA", "提案里的文件路径有重复。请去掉重复项后再提交。");
  if (input.files.length < 1 || input.files.length > 12)
    fail("LIMIT", "一份提案要包含 1 到 12 个文件。");
  let bytes = 0;
  const bindings = bindingsOf(db, [
    ...new Set(input.files.map((file) => file.workspaceId)),
  ]);
  const prepared = input.files.map((file) => {
    if (!allowed.some((item) => key(item) === key(file)))
      fail(
        "FORBIDDEN",
        `「${file.path}」不在意图允许修改的范围内。请改意图，或从提案里去掉它。`,
      );
    validatePath(file.path);
    const before = currentFile(bindings, file);
    if (before.hash !== file.beforeHash)
      fail(
        "VERSION_CONFLICT",
        `「${file.path}」的内容和提案基线不一致。请重新读取文件后再提交。`,
      );
    if (file.after !== null) {
      if (file.after.includes("\0") || Buffer.byteLength(file.after) > 200000)
        fail("LIMIT", "目标内容必须是 200 KB 以内的文本。请缩短后再提交。");
      bytes += Buffer.byteLength(file.after);
    }
    if (before.text === file.after)
      fail(
        "INVALID_DATA",
        `「${file.path}」没有实际改动。请去掉它，或写上不同的目标内容。`,
      );
    return {
      workspaceId: file.workspaceId,
      path: file.path,
      beforeHash: before.hash,
      afterHash: file.after === null ? null : digest(file.after),
      before: before.text,
      after: file.after,
    };
  });
  if (bytes > 1_000_000)
    fail("LIMIT", "提案的目标内容合计超过 1 MB。请拆开后再提交。");
  const baseline = worktreeState(bindings, input.files) as BaselineState[];
  for (const file of prepared) {
    const observed =
      baseline.find((state) => state.workspaceId === file.workspaceId)?.files[
        file.path
      ]?.hash ?? null;
    if (observed !== file.beforeHash)
      fail(
        "VERSION_CONFLICT",
        "发布过程中工作树变了。请重新读取文件后再提交提案。",
      );
  }
  const previous = input.proposalId
    ? loadObject(db, input.proposalId)
    : undefined;
  if (previous && previous.type !== "code.proposal")
    fail("NOT_FOUND", "找不到这份提案。请重新读取后再替换。");
  if (previous) {
    if (
      input.previousVersion === undefined ||
      contentVersionOf(previous) !== input.previousVersion
    )
      fail("VERSION_CONFLICT", "提案版本冲突。请重新读取当前提案后再提交。");
    if (intentOf(db, previous.id) !== intent.id)
      fail("INVALID_DATA", "不能替换属于另一条意图的提案。请新建一份提案。");
  } else if (countType(db, "code.proposal") >= 12)
    fail("LIMIT", "提案最多 12 份。请替换已有提案，或删除一份后再发布。");
  const version = previous ? contentVersionOf(previous) + 1 : 1;
  const proposalId = previous?.id ?? newId();
  const digestValue = proposalDigest({
    id: proposalId,
    version,
    intentId: intent.id,
    intentVersion: intent.version,
    title: input.title,
    explanation: input.explanation,
    testPlan: input.testPlan,
    files: prepared,
  });
  const fitted = fitStored(db, prepared, baseline, {
    title: input.title,
    explanation: input.explanation,
    testPlan: input.testPlan,
    digest: digestValue,
    intentVersion: intent.version,
    agentId: input.agentId,
    decision: "pending",
    contentVersion: version,
  });
  const data = {
    title: input.title,
    explanation: input.explanation,
    testPlan: input.testPlan,
    digest: digestValue,
    intentVersion: intent.version,
    agentId: input.agentId,
    decision: "pending",
    contentVersion: version,
    files: fitted.files,
    baseline: fitted.baseline,
  };
  const commands: Command[] = [];
  if (!previous) {
    commands.push({
      op: "object.create",
      ref: "proposal",
      type: "code.proposal",
      title: input.title,
      data,
      source: { origin: actor.kind === "human" ? "human" : "ai-generated" },
    });
    commands.push({
      op: "relation.create",
      kind: "code.contains",
      sourceId: intent.id,
      targetId: "@proposal",
      status: "confirmed",
    });
  } else {
    commands.push({
      op: "object.update",
      id: previous.id,
      expectedVersion: previous.version,
      title: input.title,
      set: data,
      unset: ["decidedAt", "verification"],
    });
    for (const targetId of linkedIds(
      db,
      "source_id",
      previous.id,
      "code.contains",
    )) {
      const target = loadObject(db, targetId);
      if (target.type !== "code.validation") continue;
      commands.push({ op: "object.delete", id: target.id });
    }
  }
  const written = apply(db, registry, actor, commands);
  const id = previous?.id ?? written.created.proposal;
  if (!id) fail("INTERNAL", "提案没有写成。请再提交一次。");
  if (!previous && id !== proposalId) {
    // 内核分配的编号和摘要里用的编号不同：按真实编号重算摘要再写回去。
    const created = loadObject(db, id);
    const redigest = proposalDigest({
      id,
      version,
      intentId: intent.id,
      intentVersion: intent.version,
      title: input.title,
      explanation: input.explanation,
      testPlan: input.testPlan,
      files: prepared,
    });
    apply(db, registry, actor, [
      {
        op: "object.update",
        id,
        expectedVersion: created.version,
        set: { digest: redigest },
      },
    ]);
  }
  const saved = loadObject(db, id);
  clearApproval(db, saved.id);
  return summaryOf(db, saved, intent.id);
}

export function readProposal(db: Db, proposalId: string) {
  const row = loadObject(db, proposalId);
  if (row.type !== "code.proposal")
    fail("NOT_FOUND", "找不到这份提案。请重新读取后再查看。");
  const intentId = intentOf(db, row.id);
  if (!intentId) fail("NOT_FOUND", "这份提案没有关联意图。请重新发布。");
  const summary = summaryOf(db, row, intentId);
  return {
    ...summary,
    baseline: expandBaseline(db, row.data.baseline).map((state) => ({
      workspaceId: state.workspaceId,
      head: state.head,
      omitted: state.omitted,
      fingerprint: state.fingerprint,
      files: {},
    })),
  };
}

export function decideProposal(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: { proposalId: string; decision: "approve" | "reject"; digest: string },
) {
  if (actor.kind !== "human")
    fail("FORBIDDEN", "只有人能批准或拒绝提案。请在界面上操作。");
  const row = loadObject(db, input.proposalId);
  if (row.type !== "code.proposal")
    fail("NOT_FOUND", "找不到这份提案。请重新读取后再决定。");
  const intentId = intentOf(db, row.id);
  if (!intentId) fail("NOT_FOUND", "这份提案没有关联意图。请重新发布。");
  if (currentDigest(db, row, intentId) !== input.digest)
    fail("INVALID_DATA", "摘要和当前提案对不上。请重新读取提案后再决定。");
  if (row.data.decision === "stale")
    fail("INVALID_DATA", "提案已过期。请让助手按当前意图重新提交。");
  const decision = input.decision === "approve" ? "accepted" : "rejected";
  if (decision === "accepted") {
    const intent = loadObject(db, intentId);
    if (intent.version !== Number(row.data.intentVersion ?? 0))
      fail("VERSION_CONFLICT", "意图已经变了。请让助手按新意图重新提交提案。");
    const observation = observe(db, row);
    if (
      observation.files.some((file) => file.state !== "before") ||
      observation.outsideChanges.length
    ) {
      apply(db, registry, actor, [
        {
          op: "object.update",
          id: row.id,
          expectedVersion: row.version,
          set: { decision: "stale", verification: observation },
        },
      ]);
      clearApproval(db, row.id);
      fail("INVALID_DATA", "实际工作树已经变了。请重新查看提案后再决定。");
    }
  }
  const savedVersion = loadObject(db, row.id).version;
  apply(db, registry, actor, [
    {
      op: "object.update",
      id: row.id,
      expectedVersion: savedVersion,
      set: { decision, decidedAt: Date.now() },
    },
  ]);
  // 批准记在 meta 里。sand_edit 改得到提案数据，改不到这里。
  writeApproval(db, row.id, { decision, digest: input.digest });
  return summaryOf(db, loadObject(db, row.id), intentId);
}

function requireExact(
  db: Db,
  proposalId: string,
  version: number,
  hash: string,
) {
  const row = loadObject(db, proposalId);
  if (row.type !== "code.proposal")
    fail("NOT_FOUND", "找不到这份提案。请重新读取后再继续。");
  const intentId = intentOf(db, row.id);
  if (!intentId) fail("NOT_FOUND", "这份提案没有关联意图。请重新发布。");
  if (
    contentVersionOf(row) !== version ||
    currentDigest(db, row, intentId) !== hash
  )
    fail(
      "VERSION_CONFLICT",
      "提案内容已经变了。请重新读取当前版本和摘要后再继续。",
    );
  return { row, intentId };
}

export function prepareApply(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: { proposalId: string; version: number; digest: string },
) {
  const { row, intentId } = requireExact(
    db,
    input.proposalId,
    input.version,
    input.digest,
  );
  if (!approvedNow(db, row, intentId))
    fail(
      "FORBIDDEN",
      "这个提案还没有被批准，或批准之后内容又变了。请在界面上重新批准这一版。",
    );
  const verification = observe(db, row);
  apply(db, registry, actor, [
    {
      op: "object.update",
      id: row.id,
      expectedVersion: row.version,
      set: { verification },
    },
  ]);
  if (verification.state === "diverged")
    fail(
      "INVALID_DATA",
      "实际工作树和已确认的提案不一致。请查看核对结果，让助手重新提交。",
    );
  const saved = loadObject(db, row.id);
  return {
    proposal: summaryOf(db, saved, intentId),
    ready: verification.state !== "matches",
    coverageComplete: verification.omitted.length === 0,
    instruction: APPLY_INSTRUCTION,
  };
}

export function readApprovedFile(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: {
    proposalId: string;
    version: number;
    digest: string;
    fileIndex: number;
  },
) {
  const { row, intentId } = requireExact(
    db,
    input.proposalId,
    input.version,
    input.digest,
  );
  if (!approvedNow(db, row, intentId))
    fail(
      "FORBIDDEN",
      "这个提案还没有被批准，或批准之后内容又变了。请在界面上重新批准这一版。",
    );
  const verification = observe(db, row);
  apply(db, registry, actor, [
    {
      op: "object.update",
      id: row.id,
      expectedVersion: row.version,
      set: { verification },
    },
  ]);
  if (verification.state === "diverged")
    fail(
      "INVALID_DATA",
      "工作树已经和确认过的范围不一致。请停止写入并重新核对。",
    );
  const files = normalizedFiles(db, asStoredFiles(row.data.files));
  const file = files[input.fileIndex];
  if (!file) fail("NOT_FOUND", "提案里没有这个文件。请核对文件序号后再读。");
  const current = currentFile(bindingsOf(db, [file.workspaceId]), file);
  if (current.hash !== file.beforeHash && current.hash !== file.afterHash)
    fail(
      "VERSION_CONFLICT",
      "当前文件既不是批准时的基线，也不是目标内容。请停止写入并重新核对。",
    );
  return { ...file, alreadyMatchesTarget: current.hash === file.afterHash };
}

export function verifyProposal(
  db: Db,
  registry: Registry,
  actor: Actor,
  proposalId: string,
) {
  const row = loadObject(db, proposalId);
  if (row.type !== "code.proposal")
    fail("NOT_FOUND", "找不到这份提案。请重新读取后再核对。");
  const verification = observe(db, row);
  apply(db, registry, actor, [
    {
      op: "object.update",
      id: row.id,
      expectedVersion: row.version,
      set: { verification },
    },
  ]);
  return verification;
}

export function reportValidation(
  db: Db,
  registry: Registry,
  actor: Actor,
  input: {
    proposalId: string;
    version: number;
    digest: string;
    agentId: string;
    workspaceId: string;
    command: string;
    environment: string;
    outcome: "passed" | "failed" | "not-run";
    output: string;
  },
) {
  const { row } = requireExact(
    db,
    input.proposalId,
    input.version,
    input.digest,
  );
  const verification = observe(db, row);
  if (verification.state !== "matches")
    fail(
      "INVALID_DATA",
      "实际内容和范围还没有完全符合提案。请先核对，再报告验证结果。",
    );
  const files = normalizedFiles(db, asStoredFiles(row.data.files));
  if (!files.some((file) => file.workspaceId === input.workspaceId))
    fail(
      "INVALID_DATA",
      "验证结果的仓库不在这份提案里。请改用提案中的仓库编号。",
    );
  const commands: Command[] = [
    {
      op: "object.update",
      id: row.id,
      expectedVersion: row.version,
      set: { verification },
    },
  ];
  if (countType(db, "code.validation") >= 40) {
    const oldest = db
      .prepare(
        `SELECT id FROM objects
         WHERE type = 'code.validation' AND deleted_rev IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (oldest) commands.push({ op: "object.delete", id: String(oldest.id) });
  }
  const reportedAt = Date.now();
  commands.push({
    op: "object.create",
    ref: "validation",
    type: "code.validation",
    title: input.outcome,
    data: {
      command: input.command,
      environment: input.environment,
      outcome: input.outcome,
      output: input.output,
      reportedAt,
      workspaceId: input.workspaceId,
      fingerprint: verification.fingerprint,
      digest: input.digest,
      agentId: input.agentId,
      source: "agent-report",
    },
    source: { origin: "ai-generated" },
  });
  commands.push({
    op: "relation.create",
    kind: "code.contains",
    sourceId: row.id,
    targetId: "@validation",
    status: "confirmed",
  });
  const written = apply(db, registry, actor, commands);
  return {
    id: written.created.validation,
    proposalId: row.id,
    version: contentVersionOf(row),
    digest: input.digest,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    command: input.command,
    environment: input.environment,
    outcome: input.outcome,
    output: input.output,
    reportedAt,
    fingerprint: verification.fingerprint,
    source: "agent-report" as const,
  };
}
