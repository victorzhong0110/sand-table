// 本地 Git 仓库的只读访问：绑定根目录、读取工作树、核对提案。
//
// 这里不写目标文件。写入由宿主在人批准之后自己做，做完再用核对结果看真实工作树。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { CommandError } from "../../kernel/index.ts";

export type Binding = { id: string; label: string; root: string };

export type FileRef = { workspaceId: string; path: string };

export type ProposalFile = FileRef & {
  beforeHash: string | null;
  after: string | null;
  before: string | null;
  afterHash: string | null;
};

export type WorkspaceState = {
  workspaceId: string;
  head: string;
  files: Record<string, { hash: string; mode: number }>;
  omitted: string[];
  fingerprint: string;
};

export type Verification = {
  at: number;
  state: "not-applied" | "partial" | "matches" | "diverged" | "incomplete";
  files: (FileRef & {
    state: "before" | "after" | "unexpected";
    actualHash: string | null;
  })[];
  outsideChanges: FileRef[];
  omitted: string[];
  fingerprint: string;
};

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function gitText(
  root: string,
  args: string[],
  maxBuffer = 4_000_000,
): string {
  try {
    return execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", root, ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new CommandError(
        "INTERNAL",
        "本机没有可用的 git 命令。请先安装 Git，然后再导入仓库。",
        null,
      );
    throw new CommandError(
      "INVALID_DATA",
      "读取 Git 仓库失败。请确认这是仓库根目录，并且 Git 能正常运行，然后再试。",
      null,
    );
  }
}

export function validatePath(file: string): void {
  if (
    !file ||
    path.isAbsolute(file) ||
    file.includes("\\") ||
    file
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      ) ||
    file.length > 500
  )
    throw new CommandError(
      "INVALID_DATA",
      "路径必须留在仓库里面：不能是绝对路径，不能包含 .. 或 .git。请改成仓库内的相对路径。",
      null,
    );
}

export function boundPath(binding: Binding, file: string): string {
  validatePath(file);
  let cursor = binding.root;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new CommandError(
          "FORBIDDEN",
          "不跟随符号链接。请改用仓库里的真实文件路径。",
          null,
        );
    } catch (error) {
      if (error instanceof CommandError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return cursor === path.join(binding.root, file)
          ? cursor
          : path.join(binding.root, file);
      throw error;
    }
  }
  return cursor;
}

/** 读一个工作树文件。文件不存在时返回空内容和空指纹，不把它当成错误。 */
export function currentFile(
  bindings: Binding[],
  ref: FileRef,
): { text: string | null; hash: string | null } {
  const binding = bindings.find((item) => item.id === ref.workspaceId);
  if (!binding)
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个代码仓库。请先导入仓库，或改用已导入仓库的编号。",
      null,
    );
  const full = boundPath(binding, ref.path);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > 200000)
      throw new CommandError(
        "LIMIT",
        "提案只能针对 200 KB 以内的文本文件。请缩小范围后再提交。",
        null,
      );
    const text = readFileSync(full, "utf8");
    if (text.includes("\0") || Buffer.from(text).length !== stat.size)
      throw new CommandError(
        "INVALID_DATA",
        "这个文件不是受支持的文本。请换一个文本文件。",
        null,
      );
    return { text, hash: digest(text) };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { text: null, hash: null };
    throw error;
  }
}

export function worktreeState(
  bindings: Binding[],
  extra: FileRef[] = [],
): WorkspaceState[] {
  return bindings.map((binding) => {
    const files: WorkspaceState["files"] = {};
    const omitted: string[] = [];
    const names = [
      ...new Set([
        ...gitText(binding.root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
          .split("\0")
          .filter(Boolean),
        ...extra
          .filter((ref) => ref.workspaceId === binding.id)
          .map((ref) => ref.path),
      ]),
    ].sort();
    let bytes = 0;
    for (const file of names) {
      try {
        const full = boundPath(binding, file);
        let stat;
        try {
          stat = lstatSync(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (
          !stat.isFile() ||
          stat.size > 2_000_000 ||
          bytes + stat.size > 64_000_000 ||
          Object.keys(files).length >= 10000
        )
          throw new CommandError(
            "LIMIT",
            "工作树太大或含有不支持的文件，无法完整核对。请缩小仓库范围后再试。",
            null,
          );
        const content = readFileSync(full);
        bytes += content.length;
        files[file] = { hash: digest(content), mode: stat.mode & 0o777 };
      } catch (error) {
        omitted.push(
          `${file}: ${error instanceof Error ? error.message : "unreadable"}`,
        );
      }
    }
    const head = gitText(binding.root, ["rev-parse", "HEAD"]).trim();
    return {
      workspaceId: binding.id,
      head,
      files,
      omitted,
      fingerprint: digest(JSON.stringify(files)),
    };
  });
}

/**
 * 核对真实工作树。
 *
 * 目标文件是不是已经写成目标内容、范围之外有没有被动过，一起回答。
 * 结果只有 matches / partial / not-applied / diverged / incomplete。
 */
export function observeWorktree(
  bindings: Binding[],
  files: ProposalFile[],
  baseline: WorkspaceState[],
): Verification {
  const states = worktreeState(bindings, files);
  const observed = files.map((file) => {
    let actual: string | null;
    try {
      actual = currentFile(bindings, file).hash;
    } catch {
      return {
        workspaceId: file.workspaceId,
        path: file.path,
        state: "unexpected" as const,
        actualHash: null,
      };
    }
    const beforeMode = baseline.find(
      (state) => state.workspaceId === file.workspaceId,
    )?.files[file.path]?.mode;
    const actualMode = states.find(
      (state) => state.workspaceId === file.workspaceId,
    )?.files[file.path]?.mode;
    const modeChanged =
      beforeMode !== undefined &&
      actualMode !== undefined &&
      beforeMode !== actualMode;
    return {
      workspaceId: file.workspaceId,
      path: file.path,
      state: modeChanged
        ? ("unexpected" as const)
        : actual === file.afterHash
          ? ("after" as const)
          : actual === file.beforeHash
            ? ("before" as const)
            : ("unexpected" as const),
      actualHash: actual,
    };
  });
  const outsideChanges: FileRef[] = [];
  for (const state of states) {
    const before = baseline.find(
      (item) => item.workspaceId === state.workspaceId,
    );
    if (!before) continue;
    for (const file of new Set([
      ...Object.keys(before.files),
      ...Object.keys(state.files),
    ])) {
      if (
        files.some(
          (item) =>
            item.workspaceId === state.workspaceId && item.path === file,
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
    ...baseline.flatMap((state) => state.omitted),
    ...states.flatMap((state) => state.omitted),
  ];
  const allAfter = observed.every((file) => file.state === "after");
  const allBefore = observed.every((file) => file.state === "before");
  const state =
    outsideChanges.length ||
    observed.some((file) => file.state === "unexpected")
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
        states.map((item) => ({
          workspaceId: item.workspaceId,
          fingerprint: item.fingerprint,
        })),
      ),
    ),
  };
}

/** 确认一个绝对路径是 Git 根目录，并给出稳定的仓库编号。 */
export function openRepo(label: string, input: string): Binding {
  if (!path.isAbsolute(input))
    throw new CommandError(
      "INVALID_DATA",
      "请填写本机 Git 仓库根目录的绝对路径。",
      null,
    );
  let root: string;
  try {
    root = realpathSync(input);
  } catch {
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个目录。请确认路径存在后再导入。",
      null,
    );
  }
  let top: string;
  try {
    top = realpathSync(gitText(root, ["rev-parse", "--show-toplevel"]).trim());
  } catch (error) {
    if (error instanceof CommandError && error.code === "INTERNAL") throw error;
    throw new CommandError(
      "INVALID_DATA",
      "这个目录不是 Git 仓库。请填写仓库根目录的绝对路径。",
      null,
    );
  }
  if (top !== root)
    throw new CommandError(
      "INVALID_DATA",
      "请填写 Git 仓库的根目录，而不是里面的子目录。",
      null,
    );
  const safe = /^[-\w]{1,40}$/.test(label) ? label : "project";
  return { id: digest(root).slice(0, 16), label: safe, root };
}
