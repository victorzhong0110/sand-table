// 界面侧的数据缓存：v3 的行按 id 存，靠修订号做增量合并。
//
// 这一层只管「板面上现在是什么样」，不碰界面怎么画、不碰写入怎么翻译：
// 写入的翻译在 adapter.ts，缓存的合并在这里。
//
// 三处设计各有出处（只借设计，不抄代码）：
// - 按 id 存实体、upsert 覆盖、删除即移除：Redux Toolkit 的 entity adapter
//   （MIT）。它的 setOne/removeMany 就是这里 mergeRows 的两个动作。
// - 固定间隔拉一次、页面不可见时暂停、在飞的请求不重叠：TanStack Query 的
//   queryObserver（MIT）。它的 refetchInterval 与 focusManager 是这里
//   sync() 的节流与暂停的依据。
// - 远端与本地按 id 对账、旧的版本一律丢弃：Excalidraw 的 reconcileElements
//   （MIT）。它用 version 比较决定谁说了算，这里用 revision 做同一件事。

/** 界面调工具的入口：与 board/main.tsx 的 call 同签名。 */
export type V3Tool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<any>;

/** v3 的一行对象。字段与 01-data-model.md §5 的 ObjectRow 对应。 */
export type V3ObjectRow = {
  id: string;
  type: string;
  typeVersion: number;
  title: string;
  data: Record<string, unknown>;
  source: unknown;
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

/** v3 的一行展示。字段与 01-data-model.md §5 的 PresentationRow 对应。 */
export type V3PresentationRow = {
  id: string;
  boardId: string;
  objectId: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
  appearance: { detail?: string; coverBlob?: string; accent?: string };
  version: number;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

/** v3 的一行关系。字段与 01-data-model.md §5 的 RelationRow 对应。 */
export type V3RelationRow = {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  status: "confirmed" | "inferred";
  basis: string | null;
  attributes: Record<string, unknown>;
  evidence: unknown[];
  version: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  rev: number;
  deleted: boolean;
};

/** v3 的一行设置：键是 id。 */
export type V3SettingRow = {
  key: string;
  value: unknown;
  rev: number;
  deleted: boolean;
};

/** v3 的一行组件包：id 是主键。 */
export type V3PackRow = {
  id: string;
  kind: string;
  version: number;
  enabled: boolean;
  manifest: unknown;
  rev: number;
  deleted: boolean;
};

/** 界面这一侧的缓存。 */
export type V3Cache = {
  /** 工作空间修订号：增量同步的起点。 */
  revision: number;
  /** 当前显示的白板。 */
  boardId: string;
  objects: Map<string, V3ObjectRow>;
  presentations: Map<string, V3PresentationRow>;
  relations: Map<string, V3RelationRow>;
  settings: Map<string, V3SettingRow>;
  packs: Map<string, V3PackRow>;
};

/** 内核版本。界面按它决定用哪一套工具面。 */
export type KernelVersion = "v2" | "v3";

/**
 * 工具调用次数：测试要数「空闲时到底打了几次请求」，
 * 所以这里留一个可读的计数。
 */
export type V3Stats = {
  /** app_board：整块白板，只在装载与重置时用。 */
  board: number;
  /** app_changes：增量，每秒一次。 */
  changes: number;
};

const emptyCache = (boardId: string): V3Cache => ({
  revision: 0,
  boardId,
  objects: new Map(),
  presentations: new Map(),
  relations: new Map(),
  settings: new Map(),
  packs: new Map(),
});

/**
 * 合并一批行。
 *
 * 墓碑即删除：内核的软删除行带 deleted，界面这一侧直接把它从表里拿掉，
 * 免得画布上留下一个已经不存在的东西。
 *
 * 修订号没变的行保留原来的引用：内容没变就不该让界面重画。
 */
function mergeRows<T extends { rev: number; deleted: boolean }>(
  table: Map<string, T>,
  rows: T[],
  id: (row: T) => string,
): boolean {
  let changed = false;
  for (const row of rows) {
    const key = id(row);
    if (row.deleted) {
      if (table.delete(key)) changed = true;
      continue;
    }
    const before = table.get(key);
    if (before && before.rev === row.rev) continue;
    table.set(key, row);
    changed = true;
  }
  return changed;
}

/**
 * 把一个错误摊平成一段文字。
 *
 * 宿主与 SDK 会把原始原因包在几层里（cause、data、message），
 * 判「工具不存在」时不能只看最外面那一层。
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: any = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current.message === "string") parts.push(current.message);
    if (current.data !== undefined) {
      parts.push(
        typeof current.data === "string"
          ? current.data
          : JSON.stringify(current.data),
      );
    }
    current = current.cause ?? current.error ?? current.data;
  }
  return parts.join(" | ");
}

/**
 * 判断一个错误是不是「这个工具不存在」。
 *
 * 只有明确的「工具不存在 / 方法不存在」才回退到 v2：鉴权失败、断线、
 * 内部错误都要照实报错，不能误判成 v2（那会把人带到一个已经坏掉的服务端）。
 */
export function isUnknownToolError(error: unknown): boolean {
  const text = describeError(error);
  if (!text) return false;
  return (
    /tool\s+\S+\s+not found/i.test(text) ||
    /unknown tool/i.test(text) ||
    /unknown method/i.test(text) ||
    /method not found/i.test(text) ||
    /工具\s*\S*\s*不存在/.test(text) ||
    /未知工具/.test(text)
  );
}

/**
 * 认出内核版本。
 *
 * 优先由 bootstrap 明确给出（调用方拿到 kernelVersion 就直接用）；
 * 没有的话问一次 sand_status：v3 有这个工具，v2 没有。
 */
export async function detectKernel(
  tool: V3Tool,
  declared?: string,
): Promise<KernelVersion> {
  if (declared === "v3") return "v3";
  if (declared === "v2") return "v2";
  try {
    await tool("sand_status");
    return "v3";
  } catch (error) {
    if (isUnknownToolError(error)) return "v2";
    throw error;
  }
}

/**
 * 界面侧的数据缓存。
 *
 * 用法：先 load(boardId) 装一次，之后每秒 sync() 一次；
 * 自己写完立刻 sync() 一次，界面不用等下一个整秒。
 *
 * **工作空间隔离**：不同工作空间是不同的库，旧库的内容一条都不该留下。
 * 切工作空间时整块清缓存；在途的响应按「工作空间 + 加载代号 + 修订号」判过期，
 * 不能把旧库的增量合进新库（那会把新库的修订号也带偏，之后的增量就永远等不到了）。
 */
export class V3Store {
  readonly cache: V3Cache;
  /** 调用次数，测试用。 */
  readonly stats: V3Stats = { board: 0, changes: 0 };
  /** 当前工作空间。切换时整个缓存要清空。 */
  workspaceId: string | undefined;
  /**
   * 加载代号：每次 load 换一次。
   *
   * 在途的 sync 回来时代号已经变了 ⟹ 那条响应是给上一轮的，丢掉。
   * 光看工作空间不够：同一个工作空间里连续两次装载，或切走又切回来，
   * 都会出现「工作空间相同、但响应已过期」。
   */
  private generation = 0;
  private readonly tool: V3Tool;
  private loading: Promise<void> | undefined;

  constructor(tool: V3Tool) {
    this.tool = tool;
    this.cache = emptyCache("");
    /* 调用次数挂在全局上：测试要数「空闲时到底打了几次请求」。 */
    (globalThis as { __sandV3Stats?: V3Stats }).__sandV3Stats = this.stats;
  }

  /**
   * 整块装载一次白板：对象、展示、关系、设置与组件包。
   *
   * `workspaceId` 与当前的不一样 ⟹ 换库了，缓存整块清空再装。
   */
  async load(
    boardId: string,
    options: { workspaceId?: string } = {},
  ): Promise<void> {
    const next = options.workspaceId ?? this.workspaceId;
    if (next !== this.workspaceId) this.clear();
    this.workspaceId = next;
    this.loading = this.loadNow(boardId);
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  /** 缓存整块清空：换工作空间时旧库的内容一条都不该留下。 */
  private clear() {
    this.cache.objects.clear();
    this.cache.presentations.clear();
    this.cache.relations.clear();
    this.cache.settings.clear();
    this.cache.packs.clear();
    this.cache.revision = 0;
    this.cache.boardId = "";
  }

  private async loadNow(boardId: string): Promise<void> {
    const generation = ++this.generation;
    const workspaceId = this.workspaceId;
    const data = await this.tool("app_board", {
      boardId,
      ...(workspaceId ? { workspaceId } : {}),
    });
    this.stats.board += 1;
    if (!data || typeof data.revision !== "number")
      throw Error("服务端没有返回白板内容。请重新连接后再试。");
    /* 回来时已经不是这一轮了：丢掉。 */
    if (generation !== this.generation) return;
    if (!this.acceptWorkspace(data.workspaceId, workspaceId)) return;
    /* 合并而不是整块替换：进到子白板以后，父白板的对象还得留着，
       面包屑与「移动到白板」都要用它们。 */
    const fresh = new Set((data.presentations ?? []).map((p: any) => p.id));
    /* 白板对象本身也在缓存里：面包屑与标题要它。 */
    if (data.board?.id) this.cache.objects.set(data.board.id, data.board);
    for (const row of data.objects ?? []) this.cache.objects.set(row.id, row);
    for (const row of data.presentations ?? [])
      this.cache.presentations.set(row.id, row);
    /* 整块重装不带墓碑：这块白板上已经删掉的展示，
       缓存里也要拿掉，不然画布上还留着它。 */
    for (const [id, presentation] of this.cache.presentations)
      if (presentation.boardId === boardId && !fresh.has(id))
        this.cache.presentations.delete(id);
    /* 没有了展示的对象也一并拿掉。
       白板对象自己不在任何展示里（它是被进入的那块白板），要留着。 */
    const shown = new Set(
      [...this.cache.presentations.values()].map((p) => p.objectId),
    );
    for (const [id, object] of this.cache.objects)
      if (!shown.has(id) && object.type !== "base.board")
        this.cache.objects.delete(id);
    for (const row of data.relations ?? [])
      this.cache.relations.set(row.id, row);
    for (const row of data.settings ?? [])
      this.cache.settings.set(row.key, row);
    for (const row of data.packs ?? []) this.cache.packs.set(row.id, row);
    this.cache.boardId = boardId;
    this.cache.revision = data.revision;
  }

  /**
   * 核对工作空间，顺手把编号学过来。
   *
   * **两边都知道才比**：客户端不知道编号的时候，不能判成「不是同一个库」
   * （那会把服务端刚回带的编号当成不匹配，整条响应白丢）。
   * 客户端不知道、服务端回带了 ⟹ 采纳它（自愈），下次请求就带得上了。
   */
  private acceptWorkspace(
    returned: unknown,
    requested: string | undefined,
  ): boolean {
    if (typeof returned !== "string" || !returned) return true;
    if (typeof requested !== "string" || !requested) {
      this.workspaceId = returned;
      return true;
    }
    return returned === requested;
  }

  /**
   * 拉一次增量。
   *
   * 返回有没有变化：没变化就不该让界面重画。
   */
  async sync(): Promise<boolean> {
    if (!this.cache.boardId) return false;
    const generation = this.generation;
    const workspaceId = this.workspaceId;
    const data = await this.tool("app_changes", {
      since: this.cache.revision,
      ...(workspaceId ? { workspaceId } : {}),
    });
    this.stats.changes += 1;
    if (!data) return false;
    /* 这一轮已经过去了：这条响应是给上一轮的，丢掉。 */
    if (generation !== this.generation) return false;
    /* 别的工作空间的增量：不能合进来（会把修订号也带偏）。 */
    if (!this.acceptWorkspace(data.workspaceId, workspaceId)) return false;
    /* 墓碑已被内核清理：手里的数据已经不可信，整块重来。 */
    if (data.reset) {
      const boardId = this.cache.boardId;
      this.clear();
      this.workspaceId = workspaceId;
      await this.load(boardId, { workspaceId });
      return true;
    }
    if (typeof data.revision !== "number") return false;
    /* 过期响应：比手上的还旧，丢掉。 */
    if (data.revision < this.cache.revision) return false;
    let changed = false;
    changed =
      mergeRows(this.cache.objects, data.objects ?? [], (r) => r.id) || changed;
    changed =
      mergeRows(
        this.cache.presentations,
        data.presentations ?? [],
        (r) => r.id,
      ) || changed;
    changed =
      mergeRows(this.cache.relations, data.relations ?? [], (r) => r.id) ||
      changed;
    changed =
      mergeRows(this.cache.settings, data.settings ?? [], (r) => r.key) ||
      changed;
    changed =
      mergeRows(this.cache.packs, data.packs ?? [], (r) => r.id) || changed;
    this.cache.revision = data.revision;
    return changed;
  }

  /** 当前白板上的展示（不含墓碑）。 */
  presentationsOn(boardId: string): V3PresentationRow[] {
    return [...this.cache.presentations.values()].filter(
      (p) => p.boardId === boardId,
    );
  }
}
