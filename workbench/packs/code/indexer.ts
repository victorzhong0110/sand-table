// 代码索引：TypeScript 语法树、Python 语法树、内容指纹。
//
// 只读工作树。不执行仓库里的代码，不跟随符号链接。

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CommandError } from "../../kernel/index.ts";
import { digest, gitText, type Binding } from "./git.ts";
import { pythonSymbols } from "./python-indexer.ts";

export type { Binding };

export type CodeSource = {
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
};

export type CodeItem = {
  id: string;
  workspaceId: string;
  kind: "workspace" | "file" | "symbol";
  title: string;
  parentId?: string;
  source?: CodeSource;
};

export type CodeLink = {
  source: string;
  target: string;
  kind: "contains" | "imports" | "syntactic-call";
};

export type CodeIndex = {
  workspaces: {
    id: string;
    label: string;
    head: string;
    branch: string;
    snapshot: string;
    files: number;
    omitted: string[];
  }[];
  objects: CodeItem[];
  relations: CodeLink[];
};

const git = (root: string, args: string[]) =>
  gitText(root, args, 2_000_000).trim();

export function readFile(binding: Binding, file: string): string {
  if (
    !file ||
    path.isAbsolute(file) ||
    file
      .split(/[\\/]/)
      .some((part) => part === ".." || part === ".git" || !part)
  )
    throw new CommandError(
      "INVALID_DATA",
      "路径必须留在仓库里面：不能是绝对路径，不能包含 .. 或 .git。请改成仓库内的相对路径。",
      null,
    );
  let cursor = binding.root;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw new CommandError(
        "FORBIDDEN",
        "不索引符号链接。请改用仓库里的真实文件。",
        null,
      );
  }
  const stat = lstatSync(cursor);
  if (!stat.isFile() || stat.size > 200_000)
    throw new CommandError(
      "LIMIT",
      "只索引 200 KB 以内的文本文件。这个文件超出了限制。",
      null,
    );
  const content = readFileSync(cursor, "utf8");
  if (content.includes("\0"))
    throw new CommandError(
      "INVALID_DATA",
      "不能索引二进制文件。请换一个文本文件。",
      null,
    );
  return content;
}

export function scan(bindings: Binding[]): CodeIndex {
  const index: CodeIndex = { workspaces: [], objects: [], relations: [] };
  for (const binding of bindings) {
    const tracked = git(binding.root, ["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .sort();
    const eligible = tracked.filter(
      (file) =>
        /\.(?:[cm]?[jt]sx?|py|md)$/.test(file) &&
        !/(^|\/)(node_modules|dist|vendor|build)\//.test(file),
    );
    const priority = (file: string) =>
      /^readme(?:\.[^/]*)?\.md$/i.test(file)
        ? 0
        : /^(src|lib|packages)\//.test(file) && !file.endsWith(".md")
          ? 1
          : !file.includes("/") && !file.endsWith(".md")
            ? 2
            : file.endsWith(".md")
              ? 4
              : 3;
    eligible.sort(
      (left, right) =>
        priority(left) - priority(right) || left.localeCompare(right, "en"),
    );
    const omitted = tracked
      .filter((file) => !eligible.includes(file))
      .map((file) => `${file}: unsupported or excluded`);
    const contents = new Map<string, string>();
    let bytes = 0;
    for (const file of eligible) {
      try {
        if (contents.size >= 120)
          throw new CommandError("LIMIT", "单次索引最多 120 个文件。", null);
        const text = readFile(binding, file);
        if (bytes + Buffer.byteLength(text) > 2_000_000)
          throw new CommandError("LIMIT", "单次索引最多 2 MB。", null);
        contents.set(file, text);
        bytes += Buffer.byteLength(text);
      } catch (error) {
        omitted.push(
          `${file}: ${error instanceof Error ? error.message : "unreadable"}`,
        );
      }
    }
    index.workspaces.push({
      id: binding.id,
      label: binding.label,
      head: git(binding.root, ["rev-parse", "HEAD"]),
      branch: git(binding.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      snapshot: digest(
        JSON.stringify(
          [...contents].map(([file, text]) => [file, digest(text)]),
        ),
      ),
      files: contents.size,
      omitted,
    });
    index.objects.push({
      id: binding.id,
      workspaceId: binding.id,
      kind: "workspace",
      title: binding.label,
    });
    const parsed = new Map<string, ts.SourceFile>();
    for (const [file, text] of contents) {
      const id = `${binding.id}:${file}`;
      const base: CodeSource = {
        workspaceId: binding.id,
        path: file,
        startLine: 1,
        endLine: text.split("\n").length,
        hash: digest(text),
      };
      index.objects.push({
        id,
        workspaceId: binding.id,
        kind: "file",
        title: file,
        parentId: binding.id,
        source: base,
      });
      index.relations.push({
        source: binding.id,
        target: id,
        kind: "contains",
      });
      if (file.endsWith(".md")) continue;
      if (file.endsWith(".py")) {
        const result = pythonSymbols(file, text);
        if (result.error) omitted.push(`${file}: ${result.error}`);
        const added = new Map<string, string>();
        for (const symbol of result.symbols) {
          if (added.has(symbol.name)) continue;
          if (index.objects.length >= 1200) {
            if (!omitted.includes("symbols: 1200-object soft limit reached"))
              omitted.push("symbols: 1200-object soft limit reached");
            break;
          }
          const symbolId = `${id}#${symbol.name}`;
          added.set(symbol.name, symbolId);
          index.objects.push({
            id: symbolId,
            workspaceId: binding.id,
            kind: "symbol",
            title: symbol.name,
            parentId: id,
            source: {
              ...base,
              startLine: symbol.startLine,
              endLine: symbol.endLine,
            },
          });
          index.relations.push({
            source: id,
            target: symbolId,
            kind: "contains",
          });
        }
        for (const symbol of result.symbols)
          for (const call of symbol.calls) {
            const source = added.get(symbol.name);
            const target = added.get(call);
            if (source && target)
              index.relations.push({
                source,
                target,
                kind: "syntactic-call",
              });
          }
        continue;
      }
      const sourceFile = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      parsed.set(file, sourceFile);
      const symbols = new Map<string, { id: string; node: ts.Node }>();
      function add(name: string, node: ts.Node) {
        if (symbols.has(name)) {
          // 同名重载保留带函数体的实现，行号也改到实现上。
          if (ts.isFunctionDeclaration(node) && node.body) {
            const old = symbols.get(name)!;
            symbols.set(name, { id: old.id, node });
            const object = index.objects.find((item) => item.id === old.id)!;
            object.source = {
              ...base,
              startLine:
                sourceFile.getLineAndCharacterOfPosition(
                  node.getStart(sourceFile),
                ).line + 1,
              endLine:
                sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line +
                1,
            };
          }
          return;
        }
        if (index.objects.length >= 1200) {
          if (!omitted.includes("symbols: 1200-object soft limit reached"))
            omitted.push("symbols: 1200-object soft limit reached");
          return;
        }
        const symbolId = `${id}#${name}`;
        symbols.set(name, { id: symbolId, node });
        index.objects.push({
          id: symbolId,
          workspaceId: binding.id,
          kind: "symbol",
          title: name,
          parentId: id,
          source: {
            ...base,
            startLine:
              sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              ).line + 1,
            endLine:
              sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          },
        });
        index.relations.push({
          source: id,
          target: symbolId,
          kind: "contains",
        });
      }
      for (const statement of sourceFile.statements) {
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name
        )
          add(statement.name.text, statement);
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer))
            )
              add(declaration.name.text, declaration);
      }
      for (const from of symbols.values()) {
        const targets = new Set<string>();
        function visit(node: ts.Node) {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const to = symbols.get(node.expression.text);
            if (to && to.id !== from.id) targets.add(to.id);
          }
          ts.forEachChild(node, visit);
        }
        visit(from.node);
        for (const target of targets)
          index.relations.push({
            source: from.id,
            target,
            kind: "syntactic-call",
          });
      }
    }
    for (const [file, sourceFile] of parsed)
      for (const statement of sourceFile.statements)
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.startsWith(".")
        ) {
          const stem = path.posix.normalize(
            path.posix.join(
              path.posix.dirname(file),
              statement.moduleSpecifier.text,
            ),
          );
          const target = [
            stem,
            ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"].map(
              (extension) => stem + extension,
            ),
          ].find((candidate) => contents.has(candidate));
          if (target)
            index.relations.push({
              source: `${binding.id}:${file}`,
              target: `${binding.id}:${target}`,
              kind: "imports",
            });
        }
  }
  return index;
}

export function sourceFor(
  bindings: Binding[],
  object: CodeItem,
  options: { startLine?: number; maxLines?: number } = {},
) {
  const ref = object.source;
  if (!ref)
    throw new CommandError(
      "INVALID_DATA",
      "这个对象没有源码位置。请换一个文件或符号。",
      null,
    );
  const binding = bindings.find((item) => item.id === ref.workspaceId);
  if (!binding)
    throw new CommandError(
      "NOT_FOUND",
      "找不到这个代码仓库。请先导入仓库，或改用已导入仓库的编号。",
      null,
    );
  if (!git(binding.root, ["ls-files", "-z"]).split("\0").includes(ref.path))
    throw new CommandError(
      "NOT_FOUND",
      "这个文件已经不在 Git 跟踪列表里。请先刷新索引。",
      null,
    );
  const text = readFile(binding, ref.path);
  if (digest(text) !== ref.hash)
    throw new CommandError(
      "INVALID_DATA",
      "源码已经变了。请先刷新索引，再读取。",
      null,
    );
  const startLine = options.startLine ?? ref.startLine;
  const maxLines = options.maxLines ?? 120;
  if (
    !Number.isInteger(startLine) ||
    startLine < ref.startLine ||
    startLine > ref.endLine ||
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > 120
  )
    throw new CommandError(
      "INVALID_DATA",
      "摘录必须落在这个对象的行号范围内，一次 1 到 120 行。请改好起始行或行数后再读。",
      null,
    );
  const endLine = Math.min(ref.endLine, startLine + maxLines - 1);
  const excerpt = text
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
  return {
    reference: { ...ref, startLine, endLine },
    text: excerpt.slice(0, 12000),
    verification:
      "Reference content matches. This does not prove an explanation.",
    truncated: endLine < ref.endLine || excerpt.length > 12000,
    characterTruncated: excerpt.length > 12000,
    nextLine: endLine < ref.endLine ? endLine + 1 : null,
  };
}
