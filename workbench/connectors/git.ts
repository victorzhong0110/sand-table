// Git 连接器：连到本地 Git 仓库，读工作树，**在确认之后**允许写入。
//
// 搬迁自 server/worktree.ts 与 server/import.ts（#13：代码领域包与连接器）。
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 3.2–3.3 节。
//
// 写入能力带一条**不许简化**的确认链路：
//   明确意图 → 具体提案版本与摘要 → 人确认 → 宿主写入 → 实际内容与范围核对
// 内容指纹、脏工作树基线、范围外路径检查全部保留在这里。

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path, { basename } from "node:path";
import { z } from "zod";
import { openView } from "../core/space-state.ts";
import type { BoardStore } from "../core/store.ts";
import type { Projection } from "../core/model.ts";
import type {
  FileRef,
  Proposal,
  ProposalFile,
  WorkspaceState,
} from "../core/changes.ts";
import type { Operation, Spaces } from "../server/spaces.ts";
import type { RegisterTool } from "../server/tool-types.ts";
import type {
  Binding,
  Connector,
  ConnectorReadRequest,
  ConnectorReadResult,
  ConnectorVerification,
  ConnectorWritePlan,
  ConnectorWriteRequest,
} from "./types.ts";

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function validatePath(file: string) {
  if (
    !file ||
    path.isAbsolute(file) ||
    file.includes("\\") ||
    file
      .split("/")
      .some(
        (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
      ) ||
    file.length > 500
  )
    throw Error("Path must stay inside the configured worktree.");
}
export function boundPath(binding: Binding, file: string) {
  validatePath(file);
  let cursor = binding.root;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw Error("Symlink paths are not supported.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return cursor === path.join(binding.root, file)
          ? cursor
          : path.join(binding.root, file);
      throw e;
    }
  }
  return cursor;
}
export function currentFile(bindings: Binding[], ref: FileRef) {
  const binding = bindings.find((b) => b.id === ref.workspaceId);
  if (!binding) throw Error("Unknown workspace.");
  const full = boundPath(binding, ref.path);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > 200000)
      throw Error("Proposal files must be text files of at most 200 KB.");
    const text = readFileSync(full, "utf8");
    if (text.includes("\0") || Buffer.from(text).length !== stat.size)
      throw Error("Unsupported text encoding or binary file.");
    return { text, hash: digest(text) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: null, hash: null };
    throw e;
  }
}
const git = (root: string, args: string[]) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4_000_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
export function worktreeState(
  bindings: Binding[],
  extra: FileRef[] = [],
): WorkspaceState[] {
  return bindings.map((b) => {
    const files: WorkspaceState["files"] = {},
      omitted: string[] = [];
    const names = [
      ...new Set([
        ...git(b.root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
          .split("\0")
          .filter(Boolean),
        ...extra.filter((r) => r.workspaceId === b.id).map((r) => r.path),
      ]),
    ].sort();
    let bytes = 0;
    for (const file of names) {
      try {
        const full = boundPath(b, file);
        let stat;
        try {
          stat = lstatSync(full);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        if (
          !stat.isFile() ||
          stat.size > 2_000_000 ||
          bytes + stat.size > 64_000_000 ||
          Object.keys(files).length >= 10000
        )
          throw Error("Worktree observation limit or unsupported file.");
        const content = readFileSync(full);
        bytes += content.length;
        files[file] = { hash: digest(content), mode: stat.mode & 0o777 };
      } catch (e) {
        omitted.push(
          `${file}: ${e instanceof Error ? e.message : "unreadable"}`,
        );
      }
    }
    const head = git(b.root, ["rev-parse", "HEAD"]).trim();
    return {
      workspaceId: b.id,
      head,
      files,
      omitted,
      fingerprint: digest(JSON.stringify(files)),
    };
  });
}

/**
 * 绑定一个 Git 根目录。
 *
 * 绑定是**连接器**的职责：怎么连到外部系统由连接器负责，
 * 连上之后索引出什么才是代码领域的事（domains/code/indexer.ts）。
 */
export function bind(args: string[]): Binding[] {
  if (!args.length || args.length > 4)
    throw Error(
      "Configure 1–4 explicit --workspace label=/absolute/git/root arguments.",
    );
  const result = args.map((arg) => {
    const at = arg.indexOf("=");
    const label = arg.slice(0, at),
      input = arg.slice(at + 1);
    if (at < 1 || !/^[-\w]{1,40}$/.test(label) || !path.isAbsolute(input))
      throw Error("Expected label=/absolute/git/root");
    const root = realpathSync(input);
    if (
      realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root
    )
      throw Error("Workspace must be a git root.");
    return { id: digest(root).slice(0, 16), label, root };
  });
  if (
    new Set(result.map((b) => b.root)).size !== result.length ||
    new Set(result.map((b) => b.label)).size !== result.length
  )
    throw Error("Workspace labels and roots must be distinct.");
  return result;
}

/**
 * 实际内容与范围核对。
 *
 * 目标文件是不是已经是目标内容、范围之外有没有被动过——两个问题一起回答。
 * 核对结果只有五种，不允许「大概对」：matches / partial / not-applied /
 * diverged（范围外被动过或内容对不上）/ incomplete（有些文件读不到）。
 */
export function observeWorktree(
  bindings: Binding[],
  files: ProposalFile[],
  baseline: WorkspaceState[],
): NonNullable<Proposal["verification"]> {
  const states = worktreeState(bindings, files);
  const observed = files.map((f) => {
    let actual: string | null;
    try {
      actual = currentFile(bindings, f).hash;
    } catch {
      return {
        workspaceId: f.workspaceId,
        path: f.path,
        state: "unexpected" as const,
        actualHash: null,
      };
    }
    const beforeMode = baseline.find((s) => s.workspaceId === f.workspaceId)
      ?.files[f.path]?.mode;
    const actualMode = states.find((s) => s.workspaceId === f.workspaceId)
      ?.files[f.path]?.mode;
    const modeChanged =
      beforeMode !== undefined &&
      actualMode !== undefined &&
      beforeMode !== actualMode;
    return {
      workspaceId: f.workspaceId,
      path: f.path,
      state: modeChanged
        ? ("unexpected" as const)
        : actual === f.afterHash
          ? ("after" as const)
          : actual === f.beforeHash
            ? ("before" as const)
            : ("unexpected" as const),
      actualHash: actual,
    };
  });
  const outsideChanges: FileRef[] = [];
  for (const state of states) {
    const before = baseline.find((s) => s.workspaceId === state.workspaceId)!;
    for (const file of new Set([
      ...Object.keys(before.files),
      ...Object.keys(state.files),
    ])) {
      if (
        files.some(
          (f) => f.workspaceId === state.workspaceId && f.path === file,
        )
      )
        continue;
      if (
        JSON.stringify(before.files[file]) !== JSON.stringify(state.files[file])
      )
        outsideChanges.push({ workspaceId: state.workspaceId, path: file });
    }
  }
  const omitted = [
    ...baseline.flatMap((s) => s.omitted),
    ...states.flatMap((s) => s.omitted),
  ];
  const allAfter = observed.every((f) => f.state === "after"),
    allBefore = observed.every((f) => f.state === "before");
  const state =
    outsideChanges.length || observed.some((f) => f.state === "unexpected")
      ? "diverged"
      : omitted.length
        ? "incomplete"
        : allAfter
          ? "matches"
          : allBefore
            ? "not-applied"
            : "partial";
  return {
    at: Date.now(),
    state,
    files: observed,
    outsideChanges,
    omitted,
    fingerprint: digest(
      JSON.stringify(
        states.map((s) => ({
          workspaceId: s.workspaceId,
          fingerprint: s.fingerprint,
        })),
      ),
    ),
  };
}

/**
 * Git 连接器。
 *
 * 读：file 与 git（工作树与仓库状态）。
 * 写：file，**必须人确认**，外部影响范围是「仓库工作树」。
 */
export function createGitConnector(bindings: Binding[]): Connector {
  const connector: Connector = {
    id: "git",
    title: "Git 仓库",
    description:
      "连到本地 Git 仓库：读工作树；写入必须先由人确认具体提案版本与摘要。",
    descriptor() {
      return {
        id: "git",
        title: "Git 仓库",
        description:
          "连到本地 Git 仓库：读工作树；写入必须先由人确认具体提案版本与摘要。",
        capabilities: {
          read: {
            kinds: ["file", "git"],
            scopes: ["仓库工作树"],
          },
          write: {
            requiresConfirmation: true,
            externalScope: "仓库工作树",
            kinds: ["file"],
          },
        },
        available: bindings.length > 0,
        ...(bindings.length
          ? {}
          : { unavailableReason: "没有绑定任何仓库：Git 连接器当前不可用。" }),
      };
    },
    read(request: ConnectorReadRequest): ConnectorReadResult {
      // 只读已绑定的仓库：传入的绑定必须在连接器自己的绑定里。
      const binding = request.binding
        ? bindings.find((b) => b.id === request.binding!.id)
        : bindings[0];
      if (!binding)
        throw Error(
          request.binding
            ? `未绑定的仓库：${request.binding.id}`
            : "Git 连接器没有绑定仓库：没有工作树就没有可读的内容。",
        );
      const tracked = git(binding.root, ["ls-files", "-z"])
        .split("\0")
        .filter(Boolean)
        .sort();
      const wanted = request.paths?.length
        ? new Set(request.paths.map((p) => p.replace(/^\.\//, "")))
        : undefined;
      const files = wanted ? tracked.filter((f) => wanted.has(f)) : tracked;
      const omitted: string[] = [];
      const contents: ConnectorReadResult["contents"] = [];
      const references: ConnectorReadResult["references"] = [];
      let bytes = 0;
      const maxBytes = request.limit?.maxBytes ?? 2_000_000;
      for (const file of files) {
        try {
          const current = currentFile(bindings, {
            workspaceId: binding.id,
            path: file,
          });
          if (current.text === null) {
            omitted.push(`${file}: not tracked or missing`);
            continue;
          }
          if (bytes + Buffer.byteLength(current.text) > maxBytes) {
            omitted.push(`${file}: ${maxBytes}-byte limit reached`);
            continue;
          }
          bytes += Buffer.byteLength(current.text);
          contents.push({
            id: `${binding.id}:${file}`,
            text: current.text,
            fingerprint: current.hash,
          });
          references.push({
            id: `${binding.id}:${file}`,
            kind: "file",
            uri: file,
            title: file.split("/").at(-1),
            fingerprint: current.hash,
          });
        } catch (e) {
          omitted.push(
            `${file}: ${e instanceof Error ? e.message : "unreadable"}`,
          );
        }
      }
      return {
        references,
        contents,
        omitted,
        status: {
          workspaceId: binding.id,
          head: git(binding.root, ["rev-parse", "HEAD"]).trim(),
          branch: git(binding.root, [
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ]).trim(),
          files: references.length,
        },
      };
    },
    write: {
      /**
       * 准备写入：确认、范围、内容指纹、脏工作树基线——四道关都过了，
       * 才把「宿主该写什么」交出去。宿主写完还要用 verify 核对。
       */
      prepare(request: ConnectorWriteRequest): ConnectorWritePlan {
        const capabilities = connector.descriptor().capabilities.write!;
        if (capabilities.requiresConfirmation) {
          const confirmation = request.confirmation;
          if (!confirmation)
            throw Error(
              "写入未获人确认：必须先由人确认具体提案版本与摘要，才能写入外部工作树。",
            );
          if (confirmation.decision !== "accepted")
            throw Error(
              `写入未获人确认：人确认的结果是「${confirmation.decision}」，只有「accepted」才能写入。`,
            );
          if (request.proposal) {
            if (
              confirmation.version !== request.proposal.version ||
              confirmation.digest !== request.proposal.digest
            )
              throw Error(
                "写入未获人确认：确认绑定的提案版本与摘要和当前提案不一致。",
              );
          }
        }
        if (!request.files.length)
          throw Error("写入没有目标文件：没有要写的内容。");
        const refs: FileRef[] = request.files.map((f) => ({
          workspaceId: f.workspaceId ?? request.binding?.id ?? "",
          path: f.path,
        }));
        // 范围外路径检查：提案不允许写到声明范围之外。
        const scope = request.scope;
        for (const ref of refs) {
          if (scope && !scope.includes(ref.workspaceId))
            throw Error(
              `范围外路径：${ref.path} 不在声明的写入范围（${scope.join("、")}）里。`,
            );
          const binding = bindings.find((b) => b.id === ref.workspaceId);
          if (!binding) throw Error("Unknown workspace.");
          validatePath(ref.path);
        }
        // 内容指纹：提案针对的是哪个版本的文件，必须还对得上。
        for (const ref of refs) {
          const current = currentFile(bindings, ref);
          const expected = request.files.find(
            (f) => f.path === ref.path,
          )!.beforeHash;
          if (current.hash !== expected)
            throw Error(`内容已变化：${ref.path} 不是提案针对的那一版。`);
        }
        // 脏工作树基线：写之前把工作树状态记下来，写完要拿它核对。
        const baseline = worktreeState(bindings, refs);
        for (const ref of refs) {
          const observed =
            baseline.find((s) => s.workspaceId === ref.workspaceId)?.files[
              ref.path
            ]?.hash ?? null;
          const expected = request.files.find(
            (f) => f.path === ref.path,
          )!.beforeHash;
          if (observed !== expected)
            throw Error(`工作树已变化：${ref.path} 在提案之后被改过。`);
        }
        return {
          files: request.files.map((f) => ({
            path: f.path,
            beforeHash: f.beforeHash,
            afterHash:
              f.afterHash ?? (f.content === null ? null : digest(f.content)),
            content: f.content,
          })),
          baseline,
          instruction:
            "Use the host file tools only. For each approved file, compare its beforeHash with actual contents immediately before writing, write the exact after content, then verify the result. These checks are not an atomic write guarantee.",
        };
      },
      /** 实际内容与范围核对：写完之后看真实工作树，而不是看提案。 */
      verify(request: ConnectorWriteRequest): ConnectorVerification {
        const files: ProposalFile[] = request.files.map((f) => ({
          workspaceId: f.workspaceId ?? request.binding?.id ?? "",
          path: f.path,
          beforeHash: f.beforeHash,
          after: f.content,
          before: null,
          afterHash:
            f.afterHash ?? (f.content === null ? null : digest(f.content)),
        }));
        // 基线用写入前记下的那一份：拿现在的基线比，等于没比。
        const baseline = request.baseline ?? worktreeState(bindings, files);
        const result = observeWorktree(bindings, files, baseline);
        return {
          state: result.state,
          files: result.files.map((f) => ({
            path: f.path,
            state: f.state,
            actualHash: f.actualHash,
          })),
          outsideChanges: result.outsideChanges.map((f) => f.path),
          omitted: result.omitted,
        };
      },
    },
  };
  return connector;
}

/** 仓库导入工具需要的依赖：存储、白板操作入口与代码索引器。 */
export type RepositoryImportDeps = {
  store: BoardStore;
  bindings: Binding[];
  /** 代码领域的索引器：把仓库投影成对象与关系。 */
  scan: (bindings: Binding[]) => Projection;
  /** 白板操作入口。 */
  spaces: Spaces;
};

export function registerRepositoryImport(
  tool: RegisterTool,
  deps: RepositoryImportDeps,
) {
  const { store, bindings, scan, spaces } = deps;
  const id = z.string().min(1).max(500);
  tool(
    "sand_rename_board",
    "Rename the shared board.",
    {
      boardId: id,
      revision: z.number().int(),
      title: z.string().trim().min(1).max(120),
    },
    (a) => {
      const b = store.get(a.boardId);
      if (b.revision !== a.revision) throw Error("Board changed. Retry.");
      b.title = a.title;
      b.revision++;
      return store.read(b.id);
    },
    true,
  );
  tool(
    "sand_import_repository",
    "Human explicitly connects a local Git root and adds its file/folder scene inside a nested board. Never automatic on startup. Does not clone, install, execute or write target files.",
    {
      boardId: id,
      revision: z.number().int(),
      viewId: id,
      path: z.string().min(1).max(2000).optional(),
      workspaceId: id.optional(),
    },
    (a) => {
      const b = store.get(a.boardId);
      if (b.revision !== a.revision)
        throw Error("Board changed. Reload before importing.");
      if (Boolean(a.path) === Boolean(a.workspaceId))
        throw Error(
          "Choose an existing workspace or provide one absolute Git root.",
        );
      let binding: Binding;
      let next = [...bindings];
      if (a.workspaceId) {
        const found = bindings.find((w) => w.id === a.workspaceId);
        if (!found) throw Error("Unknown workspace.");
        binding = found;
      } else {
        const base =
          basename(a.path!)
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(0, 32) || "project";
        const label = bindings.some((w) => w.label === base)
          ? base + "-" + randomUUID().slice(0, 4)
          : base;
        const imported = bind([label + "=" + a.path!])[0];
        binding = bindings.find((w) => w.id === imported.id) || imported;
        if (!bindings.some((w) => w.id === binding.id)) next.push(binding);
        if (next.length > 4)
          throw Error("At most four connected workspaces per session.");
      }
      const projection = scan(next);
      const files = projection.objects.filter(
        (o) => o.workspaceId === binding.id && o.kind === "file",
      );
      const folders = [
        ...new Set(
          files
            .map((o) =>
              o.source!.path.includes("/") ? o.source!.path.split("/")[0] : "",
            )
            .filter(Boolean),
        ),
      ];
      if (
        b.spaces.length + 1 + folders.length > 80 ||
        b.instances.length + 1 + folders.length + files.length > 2200
      )
        throw Error("Not enough component/space capacity to import.");
      // All filesystem checks and capacity checks complete before mutating the shared model.
      bindings.splice(0, bindings.length, ...next);
      b.autoProjectSources = false;
      store.refresh(b.id, projection);
      const view = openView(b, a.viewId);
      const op = (operation: Operation) =>
        spaces.update(b.id, b.revision, a.viewId, operation, "human-import");
      op({
        kind: "create",
        type: "board",
        title: (basename(binding.root) || binding.label).slice(0, 120),
        data: {},
      });
      const container = b.instances.find((i) => i.id === view.selection[0])!,
        target = String(container.data.spaceId);
      op({ kind: "navigate", spaceId: target });
      const locations = new Map<string, string>([["", target]]);
      for (const folder of folders) {
        op({ kind: "create", type: "board", title: folder, data: {} });
        const entry = b.instances.find((i) => i.id === view.selection[0])!;
        locations.set(folder, String(entry.data.spaceId));
      }
      for (const [folder, spaceId] of locations) {
        op({ kind: "navigate", spaceId });
        for (const file of files.filter(
          (o) =>
            (o.source!.path.includes("/")
              ? o.source!.path.split("/")[0]
              : "") === folder,
        )) {
          op({
            kind: "create",
            type: "object",
            title: folder
              ? file.source!.path.slice(folder.length + 1)
              : file.title,
            objectId: file.id,
            data: {},
          });
        }
      }
      op({ kind: "navigate", spaceId: target });
      return store.read(b.id);
    },
    true,
  );
}
