// 代码领域包：向内核提供代码领域的类型、组件、关系、工具与模板。
//
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 2 节。
//
// 这一包是**纯数据 + 纯函数**：不依赖 store，不碰文件系统
// （文件系统的部分在同目录的 indexer.ts 与 python-indexer.ts 里）。
//
// 内核只认注册表（core/domains.ts）：注册之后，类型、组件、关系、工具、
// 模板都能被查到，领域校验也会自动接进 core/spaces.ts 的唯一校验入口。

import type { DomainPack } from "../../core/objects.ts";
import { registerDomainPack } from "../../core/domains.ts";

/** 代码片段：语言与正文。 */
const checkSnippet = (data: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  const language = data.language;
  if (language !== undefined) {
    if (typeof language !== "string")
      errors.push("代码片段的 language 必须是字符串。");
    else if (language.length > 40)
      errors.push("代码片段的 language 最多 40 个字符。");
  }
  const text = data.text;
  if (text !== undefined) {
    if (typeof text !== "string") errors.push("代码片段的 text 必须是字符串。");
    else if (text.length > 20000)
      errors.push("代码片段的 text 最多 20000 个字符。");
  }
  return errors;
};

/** 代码仓库：标签与当前提交。 */
const checkWorkspace = (data: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  for (const key of ["label", "head", "branch"] as const) {
    if (data[key] !== undefined && typeof data[key] !== "string")
      errors.push(`仓库的 ${key} 必须是字符串。`);
  }
  return errors;
};

/** 源文件：仓库内的相对路径与内容指纹。 */
const checkFile = (data: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  const file = data.path;
  if (file !== undefined) {
    if (typeof file !== "string") errors.push("源文件的 path 必须是字符串。");
    else if (file) {
      if (file.startsWith("/") || file.includes("\\"))
        errors.push("源文件的 path 必须是仓库内的相对路径。");
      else if (file.split("/").some((p) => p === ".." || p === "."))
        errors.push("源文件的 path 必须是仓库内的相对路径。");
      else if (file.length > 500)
        errors.push("源文件的 path 最多 500 个字符。");
    }
  }
  const hash = data.hash;
  if (hash !== undefined && hash !== null) {
    if (typeof hash !== "string") errors.push("源文件的 hash 必须是字符串。");
    else if (!/^[0-9a-f]{64}$/i.test(hash))
      errors.push("源文件的 hash 必须是内容指纹（64 位十六进制）。");
  }
  return errors;
};

/** 符号：名字与行号范围。 */
const checkSymbol = (data: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  const name = data.name;
  if (name !== undefined) {
    if (typeof name !== "string") errors.push("符号的 name 必须是字符串。");
    else if (name.length > 200) errors.push("符号的 name 最多 200 个字符。");
  }
  const start = data.startLine,
    end = data.endLine;
  if (
    start !== undefined &&
    (!Number.isInteger(start) || (start as number) < 1)
  )
    errors.push("符号的 startLine 必须是正整数。");
  if (end !== undefined && (!Number.isInteger(end) || (end as number) < 1))
    errors.push("符号的 endLine 必须是正整数。");
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) > (end as number)
  )
    errors.push("符号的 startLine 不能大于 endLine。");
  return errors;
};

/** 差异比较：两侧内容与所在文件。 */
const checkDiff = (data: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  const before = data.before,
    after = data.after;
  if (before === undefined && after === undefined)
    errors.push("差异比较至少要有一侧：before 或 after。");
  if (before !== undefined && before !== null && typeof before !== "string")
    errors.push("差异比较的 before 必须是字符串。");
  if (after !== undefined && after !== null && typeof after !== "string")
    errors.push("差异比较的 after 必须是字符串。");
  if (data.path !== undefined && typeof data.path !== "string")
    errors.push("差异比较的 path 必须是字符串。");
  return errors;
};

/** 运行状态：跑的命令、结果与输出。 */
const checkRun = (data: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  const state = data.state;
  if (
    state !== undefined &&
    !["running", "passed", "failed", "unknown"].includes(String(state))
  )
    errors.push(
      "运行状态的 state 只能是 running / passed / failed / unknown。",
    );
  const command = data.command;
  if (command !== undefined) {
    if (typeof command !== "string")
      errors.push("运行状态的 command 必须是字符串。");
    else if (command.length > 1000)
      errors.push("运行状态的 command 最多 1000 个字符。");
  }
  if (data.output !== undefined && typeof data.output !== "string")
    errors.push("运行状态的 output 必须是字符串。");
  return errors;
};

/**
 * 代码领域包。
 *
 * 说明：内置原生组件清单仍然住在 core/spaces.ts（产品规格第 2.3 节：
 * 「内置原生类型……来自 core/spaces.ts」）。本包声明的是**代码领域**的类型、
 * 组件、关系、工具与模板；`code` 这一项在这里被认领为代码片段，
 * 内置原生类型包不必再重复声明它。
 */
export const codePack: DomainPack = {
  id: "code",
  title: "代码",
  version: 1,
  description:
    "源码索引产出的代码对象（仓库、文件、符号），以及代码专用组件、关系、工具与模板。",
  objectTypes: [
    {
      type: "code",
      title: "代码片段",
      fields: [
        { key: "language", label: "语言", kind: "text" },
        { key: "text", label: "代码", kind: "longtext" },
      ],
      defaultData: { language: "text", text: "" },
      check: checkSnippet,
    },
    {
      type: "workspace",
      title: "代码仓库",
      fields: [
        { key: "label", label: "名称", kind: "text" },
        { key: "head", label: "当前提交", kind: "text" },
        { key: "branch", label: "分支", kind: "text" },
      ],
      defaultData: { label: "" },
      check: checkWorkspace,
    },
    {
      type: "file",
      title: "源文件",
      fields: [
        { key: "path", label: "路径", kind: "text" },
        { key: "hash", label: "内容指纹", kind: "text" },
      ],
      defaultData: { path: "" },
      check: checkFile,
    },
    {
      type: "symbol",
      title: "符号",
      fields: [
        { key: "name", label: "名字", kind: "text" },
        { key: "startLine", label: "起始行", kind: "number" },
        { key: "endLine", label: "结束行", kind: "number" },
      ],
      defaultData: { name: "" },
      check: checkSymbol,
    },
    {
      type: "code-diff",
      title: "差异比较",
      fields: [
        { key: "path", label: "路径", kind: "text" },
        { key: "before", label: "改前", kind: "longtext" },
        { key: "after", label: "改后", kind: "longtext" },
      ],
      defaultData: { path: "", before: "", after: "" },
      check: checkDiff,
    },
    {
      type: "code-run",
      title: "运行状态",
      fields: [
        { key: "command", label: "命令", kind: "text" },
        { key: "state", label: "结果", kind: "text" },
        { key: "output", label: "输出", kind: "longtext" },
      ],
      defaultData: { command: "", state: "unknown", output: "" },
      check: checkRun,
    },
  ],
  componentTypes: [
    {
      type: "code",
      title: "代码片段",
      icon: "code",
      material: "grid",
      objectType: "code",
    },
    {
      type: "code-diff",
      title: "差异比较",
      icon: "code",
      material: "grid",
      objectType: "code-diff",
    },
    {
      type: "code-run",
      title: "运行状态",
      icon: "ai",
      material: "glass",
      objectType: "code-run",
    },
  ],
  relationTypes: [
    { kind: "contains", title: "包含", allowsInferred: false },
    { kind: "imports", title: "导入", allowsInferred: false },
    { kind: "syntactic-call", title: "语法调用", allowsInferred: true },
    { kind: "calls", title: "调用", allowsInferred: true },
  ],
  tools: [
    {
      name: "sand_read_source",
      title: "读取源码片段",
      description:
        "读取一个已索引代码对象的源码片段。内容指纹对不上就拒绝，不给过期内容。",
      inputSchema: {
        type: "object",
        properties: {
          boardId: { type: "string" },
          objectId: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          maxLines: { type: "integer", minimum: 1, maximum: 120 },
        },
        required: ["boardId", "objectId"],
      },
    },
    {
      name: "sand_import_repository",
      title: "导入仓库",
      description:
        "人明确要求后，把一个本地 Git 根目录作为只读场景导入白板。不克隆、不安装、不执行、不写目标文件。",
      inputSchema: {
        type: "object",
        properties: {
          boardId: { type: "string" },
          revision: { type: "integer" },
          viewId: { type: "string" },
          path: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["boardId", "revision", "viewId"],
      },
    },
    {
      name: "sand_refresh_board",
      title: "重扫工作树",
      description:
        "重扫实际的工作树内容。工作树变了，既有证据随之失效，必须重新读。",
      inputSchema: {
        type: "object",
        properties: { boardId: { type: "string" } },
        required: ["boardId"],
      },
    },
  ],
  templates: [
    {
      id: "code-tour",
      title: "代码导览",
      description:
        "从仓库到文件再到符号的三层结构。模板只是起点，用户可以从空白开始。",
      objects: [
        { type: "workspace", title: "仓库" },
        { type: "file", title: "入口文件" },
        { type: "symbol", title: "关键符号" },
      ],
      relations: [
        { source: 0, target: 1, kind: "contains", status: "confirmed" },
        { source: 1, target: 2, kind: "contains", status: "confirmed" },
      ],
    },
    {
      id: "code-change-impact",
      title: "改动影响面",
      description: "一个文件牵出哪些导入与调用：改动之前先看清影响范围。",
      objects: [
        { type: "file", title: "改动的文件" },
        { type: "file", title: "被导入的文件" },
        { type: "symbol", title: "受影响的符号" },
      ],
      relations: [
        { source: 0, target: 1, kind: "imports", status: "confirmed" },
        { source: 1, target: 2, kind: "contains", status: "confirmed" },
      ],
    },
  ],
};

/** 把代码领域包注册进注册表。启动时调用一次。 */
export function registerCodeDomain(): void {
  registerDomainPack(codePack);
}
