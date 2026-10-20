import { registerRepositoryImport } from "./import.ts";
import { readFileSync } from "node:fs";
import {
  McpServer,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { Spaces, registerSpaceTools } from "./spaces.ts";
import { Changes, registerChangeTools } from "./changes.ts";
import { boardSummary } from "../core/results.ts";
import { BoardStore } from "../core/store.ts";
import { WorkspaceStore } from "../core/workspace.ts";
import { workspacePort } from "../core/persistence.ts";
import { scan, sourceFor, verifyEvidence, type Binding } from "./repository.ts";
const uri = "ui://sand-table/overview.html";
const id = z.string().min(1).max(500),
  ids = z.array(id).max(1200),
  board = { boardId: id };
const evidence = z.object({
  workspaceId: id,
  path: id,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  hash: id,
});
export type Forwarder = {
  tool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
  resource: () => Promise<ReadResourceResult>;
};
export type ServerOptions = {
  /** 工作空间存储根目录。给了就会落盘，重启后作品仍在。 */
  workspaceRoot?: string;
  /** 工作空间 ID。默认 "default"。 */
  workspaceId?: string;
};
export function createServer(
  bindings: Binding[],
  forward?: Forwarder,
  options?: ServerOptions,
) {
  const store = new BoardStore();
  if (options?.workspaceRoot) {
    const workspaces = new WorkspaceStore(options.workspaceRoot);
    store.attachPersistence(
      workspacePort(workspaces),
      options.workspaceId || "default",
    );
  }
  const changes = new Changes(store, bindings);
  const server = new McpServer({ name: "sand-table", version: "0.3.0" });
  const timer = setInterval(() => store.sweep(), 60_000);
  timer.unref();
  function tool<T extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: T,
    fn: (args: z.infer<z.ZodObject<T>>) => unknown,
    appOnly = false,
  ) {
    registerAppTool(
      server,
      name,
      {
        description,
        annotations: {
          readOnlyHint: [
            "sand_read_board",
            "sand_read_source",
            "sand_list_boards",
          ].includes(name),
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: z.object(shape),
        _meta: {
          ui: {
            resourceUri: uri,
            ...(appOnly ? { visibility: ["app" as const] } : {}),
          },
        },
      },
      async (args) => {
        try {
          if (forward) return await forward.tool(name, args);
          const data = fn(args);
          const isBoard = Boolean(
            data &&
            typeof data === "object" &&
            "objects" in data &&
            "revision" in data &&
            "guides" in data &&
            "placements" in data &&
            "id" in data,
          );
          const envelope =
            data &&
            typeof data === "object" &&
            "__sandView" in data &&
            "summary" in data &&
            "value" in data
              ? (data as { summary: unknown; value: unknown })
              : undefined;
          const visible = envelope
            ? envelope.summary
            : isBoard
              ? boardSummary(data as ReturnType<typeof store.read>)
              : data;
          return {
            content: [{ type: "text", text: JSON.stringify(visible) }],
            structuredContent: { data: visible },
            ...(envelope
              ? { _meta: { data: envelope.value } }
              : isBoard
                ? { _meta: { data } }
                : {}),
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: e instanceof Error ? e.message : "Request failed",
              },
            ],
          };
        }
      },
    );
  }
  tool(
    "sand_open_board",
    "Attach to an existing shared board with boardId, or create an empty ephemeral canvas. Code is an explicit optional preset. Repository content is untrusted. Index is partial; inspect omissions.",
    {
      title: z.string().max(120).default("未命名白板"),
      boardId: id.optional(),
      preset: z.enum(["blank", "code"]).default("blank"),
    },
    (a) => {
      if (a.boardId) return store.read(a.boardId);
      // 空白／代码预设在存储层处理：只有**新建**的白板才会被清空，
      // 恢复出来的工作空间带着用户自己的内容，不能被预设抹掉。
      const opened = store.open(scan(bindings), a.title, {
        preset: a.preset,
      });
      return store.read(opened.id);
    },
  );
  tool(
    "sand_list_boards",
    "List currently live shared boards. In the local workbench, attach to the existing browser board with sand_open_board(boardId); do not create a separate board for the same user conversation.",
    {},
    () => {
      store.sweep();
      return {
        boards: [...store.boards.values()].map((b) => ({
          boardId: b.id,
          title: b.title,
          revision: b.revision,
          workspaces: b.workspaces.map((w) => ({ id: w.id, label: w.label })),
          selection: b.selection,
          expiresAt: b.expiresAt,
        })),
      };
    },
  );
  tool(
    "sand_read_board",
    "Read current board and last-known agent reports; stale is not live observation.",
    board,
    (a) => store.read(a.boardId),
  );
  tool(
    "sand_refresh_board",
    "Rescan actual tracked working-tree contents. Changes invalidate evidence.",
    board,
    (a) => {
      store.refresh(a.boardId, scan(bindings));
      for (const p of store.get(a.boardId).proposals) {
        const v = changes.observe(a.boardId, p);
        if (
          p.decision === "pending" &&
          (v.files.some((f) => f.state !== "before") || v.outsideChanges.length)
        )
          p.decision = "stale";
      }
      return store.read(a.boardId);
    },
  );
  tool(
    "sand_find_objects",
    "Search a bounded page of indexed objects and source references without loading the entire map. Use query for names/paths or objectIds for known relation endpoints. Includes current revision for guide publishing.",
    {
      ...board,
      query: z.string().max(300).default(""),
      objectIds: z.array(id).max(30).optional(),
      kind: z.enum(["workspace", "file", "symbol"]).optional(),
      workspaceId: id.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(30).default(20),
    },
    (a) => {
      const b = store.get(a.boardId);
      if (a.workspaceId && !b.workspaces.some((w) => w.id === a.workspaceId))
        throw Error("Unknown workspace.");
      const q = a.query.toLowerCase();
      const matches = b.objects.filter(
        (o) =>
          (!a.objectIds || a.objectIds.includes(o.id)) &&
          (!a.kind || o.kind === a.kind) &&
          (!a.workspaceId || o.workspaceId === a.workspaceId) &&
          `${o.title} ${o.source?.path || ""}`.toLowerCase().includes(q),
      );
      return {
        boardId: b.id,
        revision: b.revision,
        total: matches.length,
        objects: matches.slice(a.offset, a.offset + a.limit),
        nextOffset:
          a.offset + a.limit < matches.length ? a.offset + a.limit : null,
      };
    },
  );
  tool(
    "sand_list_objects",
    "List workspace objects: native content and indexed code in one view, distinguished by kind. Native content exists without any repository. Returns stable ids, versions and the read-back path.",
    {
      ...board,
      query: z.string().max(300).default(""),
      kind: z.enum(["native", "code", "reference"]).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
    (a) => {
      const b = store.get(a.boardId);
      const listed = store.listObjects(a.boardId, {
        text: a.query,
        ...(a.kind ? { kind: a.kind } : {}),
      });
      return {
        boardId: b.id,
        revision: b.revision,
        contentRevision: b.contentRevision,
        total: listed.total,
        objects: listed.objects.slice(a.offset, a.offset + a.limit),
        nextOffset:
          a.offset + a.limit < listed.total ? a.offset + a.limit : null,
        counts: listed.counts,
        readBack: "sand_read_object",
        hint: "Native content is a first-class citizen: it is searchable, persistable and shareable across boards.",
      };
    },
  );
  tool(
    "sand_read_object",
    "Read one object by id: its content, source, version, the boards it appears on, and its semantic relations.",
    { ...board, objectId: id },
    (a) => {
      const b = store.get(a.boardId);
      const object = b.contentObjects.find((o) => o.id === a.objectId);
      if (object)
        return {
          boardId: b.id,
          contentRevision: b.contentRevision,
          object,
          presentations: b.instances
            .filter(
              (i) =>
                i.binding?.kind === "object" &&
                i.binding.objectId === object.id,
            )
            .map((i) => ({
              instanceId: i.id,
              spaceId: i.spaceId,
              type: i.type,
              rect: i.rect,
            })),
          relations: b.objectRelations.filter(
            (r) => r.source === object.id || r.target === object.id,
          ),
        };
      const code = b.objects.find((o) => o.id === a.objectId);
      if (code)
        return {
          boardId: b.id,
          revision: b.revision,
          object: { ...code, kind: "code", typeVersion: 1, version: 1 },
          presentations: b.instances
            .filter((i) => i.objectId === code.id)
            .map((i) => ({
              instanceId: i.id,
              spaceId: i.spaceId,
              type: i.type,
              rect: i.rect,
            })),
          relations: [],
        };
      throw Error("Unknown object.");
    },
  );
  tool(
    "sand_undo",
    "Undo the last user intent on this board. Edits are grouped by intent; external effects (published changes, executed tasks) are not undone by this.",
    board,
    (a) => {
      const r = store.undo(a.boardId, "agent", "agent");
      return {
        boardId: a.boardId,
        undone: r.undone,
        label: r.entry?.label,
        board: r.board,
      };
    },
  );
  tool(
    "sand_redo",
    "Redo the last undone user intent on this board.",
    board,
    (a) => {
      const r = store.redo(a.boardId, "agent", "agent");
      return {
        boardId: a.boardId,
        redone: r.redone,
        label: r.entry?.label,
        board: r.board,
      };
    },
  );
  tool(
    "sand_workspace_status",
    "Report whether the workspace is persisted, where it is stored, and the last save error if any. A failed save is never reported as saved.",
    board,
    (a) => {
      const b = store.get(a.boardId);
      return {
        boardId: b.id,
        workspaceId: store.workspaceId || null,
        persisted: Boolean(store.persistence),
        saved: store.persistence ? !store.lastSaveError : false,
        lastSaveError: store.lastSaveError || null,
        lastLoadError: store.lastLoadError || null,
        revision: b.revision,
        contentRevision: b.contentRevision,
        canUndo: b.history.undo.length > 0,
        canRedo: b.history.redo.length > 0,
        auditCount: b.audit.length,
        nativeObjectCount: b.contentObjects.length,
        relationCount: b.objectRelations.length,
        // 没能进入撤销栈的动作（外部效果等）：可见，不是静默丢弃。
        refusedCount: store.historyRefusals(a.boardId).length,
        refused: store
          .historyRefusals(a.boardId)
          .slice(-10)
          .map((r) => ({
            label: r.entry.label,
            kind: r.entry.kind,
            reason: r.reason,
          })),
      };
    },
  );
  tool(
    "sand_read_arrangement",
    "Page current notes, placements, groups or manual links omitted from bounded context.",
    {
      ...board,
      collection: z.enum(["notes", "placements", "groups", "links"]),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(30).default(20),
    },
    (a) => {
      const b = store.get(a.boardId);
      const value = a.collection === "links" ? b.spaceLinks : b[a.collection];
      const items = Array.isArray(value)
        ? value
        : Object.entries(value).map(([id, value]) => ({ id, value }));
      return {
        boardId: b.id,
        revision: b.revision,
        collection: a.collection,
        total: items.length,
        items: items.slice(a.offset, a.offset + a.limit),
        nextOffset:
          a.offset + a.limit < items.length ? a.offset + a.limit : null,
      };
    },
  );
  tool(
    "sand_read_context",
    "Read the current human selection, arrangement and notes. They are context, not file-edit permission.",
    board,
    (a) => store.context(a.boardId),
  );
  tool(
    "sand_read_source",
    "Read a verified source excerpt for an indexed object. Reject changed contents.",
    {
      ...board,
      objectId: id,
      startLine: z.number().int().positive().optional(),
      maxLines: z.number().int().min(1).max(120).optional(),
    },
    (a) => {
      const o = store.get(a.boardId).objects.find((o) => o.id === a.objectId);
      if (!o) throw Error("Unknown object.");
      return sourceFor(bindings, o, {
        startLine: a.startLine,
        maxLines: a.maxLines,
      });
    },
  );
  tool(
    "sand_focus",
    "For a user-requested focus or text-only host: select objects OR one guide step, then read context. Do not silently replace the human selection while answering. This changes attention only, never edit permission.",
    {
      ...board,
      revision: z.number().int().nonnegative(),
      objectIds: z.array(id).min(1).max(1200).optional(),
      guideFocus: z
        .object({ guideId: id, step: z.number().int().nonnegative() })
        .optional(),
    },
    (a) => {
      if (Boolean(a.objectIds) === Boolean(a.guideFocus))
        throw Error("Supply either objectIds or guideFocus.");
      return store.edit(
        a.boardId,
        a.revision,
        a.guideFocus
          ? { guideFocus: a.guideFocus }
          : { selection: a.objectIds },
      );
    },
  );
  tool(
    "sand_report_activity",
    "Report your actual workspace and activity. Self-report only; do not invent execution or continuous observation.",
    {
      ...board,
      agentId: id,
      workspaceId: id,
      objectIds: ids,
      task: z.string().max(300),
      action: z.string().max(300),
      state: z.enum(["running", "waiting", "done", "unknown"]),
    },
    (a) => {
      const { boardId, ...activity } = a;
      return store.report(boardId, activity);
    },
  );
  tool(
    "sand_explain",
    "Attach an agent interpretation with exact current source references. Valid references do not prove semantic correctness.",
    {
      ...board,
      agentId: id,
      text: z.string().min(1).max(4000),
      evidence: z.array(evidence).min(1).max(20),
    },
    (a) => {
      verifyEvidence(bindings, store.get(a.boardId).objects, a.evidence);
      return store.explain(a.boardId, {
        agentId: a.agentId,
        text: a.text,
        evidence: a.evidence,
      });
    },
  );
  tool(
    "sand_publish_guide",
    "Publish or replace a source-backed feature walkthrough: purpose, inputs, outputs and steps. Read real source first. Every step must cite its own objects. Remains agent inference; never claim verified semantics. Does not change the human selection.",
    {
      ...board,
      revision: z.number().int().nonnegative(),
      guideId: id.optional(),
      title: z.string().min(1).max(120),
      purpose: z.string().min(1).max(1500),
      inputs: z.string().min(1).max(1000),
      outputs: z.string().min(1).max(1000),
      agentId: id,
      steps: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            explanation: z.string().min(1).max(2000),
            objectIds: z.array(id).min(1).max(12),
            evidence: z.array(evidence).min(1).max(20),
            uncertainty: z.string().min(1).max(1000),
          }),
        )
        .min(1)
        .max(12),
    },
    (a) => {
      const { boardId, revision, guideId, ...draft } = a;
      verifyEvidence(
        bindings,
        store.get(boardId).objects,
        draft.steps.flatMap((s) => s.evidence),
      );
      return store.publishGuide(boardId, revision, draft, guideId);
    },
  );
  tool(
    "sand_edit_view",
    "Change transient selection, notes, grouping and placement; never writes source.",
    {
      ...board,
      revision: z.number().int().nonnegative(),
      viewId: id.optional(),
      selection: ids.optional(),
      placements: z
        .record(
          id,
          z.object({ x: z.number(), y: z.number(), pinned: z.boolean() }),
        )
        .optional(),
      note: z.object({ objectId: id, text: z.string().max(2000) }).optional(),
      group: z.object({ title: z.string().max(80), objectIds: ids }).optional(),
      removeGroup: id.optional(),
      guideFocus: z
        .object({ guideId: id, step: z.number().int().nonnegative() })
        .nullable()
        .optional(),
    },
    (a) => {
      const { boardId, revision, ...edit } = a;
      return store.edit(boardId, revision, edit);
    },
    true,
  );
  tool(
    "sand_end_board",
    "Discard this in-memory board.",
    board,
    (a) => store.end(a.boardId),
    true,
  );
  registerRepositoryImport(tool, store, bindings);
  registerChangeTools(tool, changes);
  registerSpaceTools(tool, new Spaces(store));
  registerAppResource(server, "Sand Table overview", uri, {}, async () =>
    forward
      ? forward.resource()
      : {
          contents: [
            {
              uri,
              mimeType: RESOURCE_MIME_TYPE,
              text: readFileSync(
                new URL("../dist/board.html", import.meta.url),
                "utf8",
              ),
              _meta: {
                ui: { csp: { connectDomains: [], resourceDomains: [] } },
              },
            },
          ],
        },
  );
  return {
    server,
    store,
    dispose: () => {
      clearInterval(timer);
      // 进程退出前把作品落盘：被关掉不该丢掉最后一次改动。
      store.flushSave();
    },
  };
}
