import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { pythonSymbols } from "./python.ts";
import type { Evidence, Projection, Item } from "../core/model.ts";
export type Binding = { id: string; label: string; root: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (root: string, args: string[]) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 2_000_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
    if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root)
      throw Error("Workspace must be a git root.");
    return { id: hash(root).slice(0, 16), label, root };
  });
  if (
    new Set(result.map((b) => b.root)).size !== result.length ||
    new Set(result.map((b) => b.label)).size !== result.length
  )
    throw Error("Workspace labels and roots must be distinct.");
  return result;
}
export function readFile(binding: Binding, file: string) {
  if (
    !file ||
    path.isAbsolute(file) ||
    file.split(/[\\/]/).some((p) => p === ".." || p === ".git" || !p)
  )
    throw Error("Invalid path");
  let cursor = binding.root;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw Error("Symlinks are not indexed.");
  }
  const stat = lstatSync(cursor);
  if (!stat.isFile() || stat.size > 200_000)
    throw Error("Not a supported text file (200 KB limit).");
  const content = readFileSync(cursor, "utf8");
  if (content.includes("\0")) throw Error("Binary file");
  return content;
}
export function scan(bindings: Binding[]): Projection {
  const p: Projection = { workspaces: [], objects: [], relations: [] };
  for (const b of bindings) {
    const tracked = git(b.root, ["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .sort();
    const eligible = tracked.filter(
      (f) =>
        /\.(?:[cm]?[jt]sx?|py|md)$/.test(f) &&
        !/(^|\/)(node_modules|dist|vendor|build)\//.test(f),
    );
    const priority = (f: string) =>
      /^readme(?:\.[^/]*)?\.md$/i.test(f)
        ? 0
        : /^(src|lib|packages)\//.test(f) && !f.endsWith(".md")
          ? 1
          : !f.includes("/") && !f.endsWith(".md")
            ? 2
            : f.endsWith(".md")
              ? 4
              : 3;
    eligible.sort(
      (a, b) => priority(a) - priority(b) || a.localeCompare(b, "en"),
    );
    const omitted = tracked
      .filter((f) => !eligible.includes(f))
      .map((f) => `${f}: unsupported or excluded`);
    const contents = new Map<string, string>();
    let bytes = 0;
    for (const f of eligible) {
      try {
        if (contents.size >= 120) throw Error("120-file index limit");
        const text = readFile(b, f);
        if (bytes + Buffer.byteLength(text) > 2_000_000)
          throw Error("2 MB index limit");
        contents.set(f, text);
        bytes += Buffer.byteLength(text);
      } catch (e) {
        omitted.push(`${f}: ${e instanceof Error ? e.message : "unreadable"}`);
      }
    }
    p.workspaces.push({
      id: b.id,
      label: b.label,
      head: git(b.root, ["rev-parse", "HEAD"]),
      branch: git(b.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      snapshot: hash(
        JSON.stringify([...contents].map(([f, t]) => [f, hash(t)])),
      ),
      files: contents.size,
      omitted,
    });
    p.objects.push({
      id: b.id,
      workspaceId: b.id,
      kind: "workspace",
      title: b.label,
    });
    const parsed = new Map<string, ts.SourceFile>();
    for (const [f, text] of contents) {
      const id = `${b.id}:${f}`,
        base = {
          workspaceId: b.id,
          path: f,
          startLine: 1,
          endLine: text.split("\n").length,
          hash: hash(text),
        };
      p.objects.push({
        id,
        workspaceId: b.id,
        kind: "file",
        title: f,
        parentId: b.id,
        source: base,
      });
      p.relations.push({ source: b.id, target: id, kind: "contains" });
      if (f.endsWith(".md")) continue;
      if (f.endsWith(".py")) {
        const result = pythonSymbols(f, text);
        if (result.error) omitted.push(`${f}: ${result.error}`);
        const added = new Map<string, string>();
        for (const symbol of result.symbols) {
          if (added.has(symbol.name)) continue;
          if (p.objects.length >= 1200) {
            if (!omitted.includes("symbols: 1200-object soft limit reached"))
              omitted.push("symbols: 1200-object soft limit reached");
            break;
          }
          const sid = `${id}#${symbol.name}`;
          added.set(symbol.name, sid);
          p.objects.push({
            id: sid,
            workspaceId: b.id,
            kind: "symbol",
            title: symbol.name,
            parentId: id,
            source: {
              ...base,
              startLine: symbol.startLine,
              endLine: symbol.endLine,
            },
          });
          p.relations.push({ source: id, target: sid, kind: "contains" });
        }
        for (const symbol of result.symbols)
          for (const call of symbol.calls) {
            const source = added.get(symbol.name),
              target = added.get(call);
            if (source && target)
              p.relations.push({ source, target, kind: "syntactic-call" });
          }
        continue;
      }
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
      parsed.set(f, sf);
      const symbols = new Map<string, { id: string; node: ts.Node }>();
      function add(name: string, node: ts.Node) {
        if (symbols.has(name)) {
          // Prefer a TypeScript overload implementation to its earlier signature.
          if (ts.isFunctionDeclaration(node) && node.body) {
            const old = symbols.get(name)!;
            symbols.set(name, { id: old.id, node });
            const object = p.objects.find((o) => o.id === old.id)!;
            object.source = {
              ...base,
              startLine:
                sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            };
          }
          return;
        }
        if (p.objects.length >= 1200) {
          if (!omitted.includes("symbols: 1200-object soft limit reached"))
            omitted.push("symbols: 1200-object soft limit reached");
          return;
        }
        const sid = `${id}#${name}`;
        symbols.set(name, { id: sid, node });
        p.objects.push({
          id: sid,
          workspaceId: b.id,
          kind: "symbol",
          title: name,
          parentId: id,
          source: {
            ...base,
            startLine:
              sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          },
        });
        p.relations.push({ source: id, target: sid, kind: "contains" });
      }
      for (const s of sf.statements) {
        if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name)
          add(s.name.text, s);
        if (ts.isVariableStatement(s))
          for (const d of s.declarationList.declarations)
            if (
              ts.isIdentifier(d.name) &&
              d.initializer &&
              (ts.isArrowFunction(d.initializer) ||
                ts.isFunctionExpression(d.initializer))
            )
              add(d.name.text, d);
      }
      for (const from of symbols.values()) {
        const targets = new Set<string>();
        function visit(n: ts.Node) {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
            const to = symbols.get(n.expression.text);
            if (to && to.id !== from.id) targets.add(to.id);
          }
          ts.forEachChild(n, visit);
        }
        visit(from.node);
        for (const target of targets)
          p.relations.push({ source: from.id, target, kind: "syntactic-call" });
      }
    }
    for (const [f, sf] of parsed)
      for (const s of sf.statements)
        if (
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text.startsWith(".")
        ) {
          const stem = path.posix.normalize(
            path.posix.join(path.posix.dirname(f), s.moduleSpecifier.text),
          );
          const target = [
            stem,
            ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"].map(
              (ext) => stem + ext,
            ),
          ].find((x) => contents.has(x));
          if (target)
            p.relations.push({
              source: `${b.id}:${f}`,
              target: `${b.id}:${target}`,
              kind: "imports",
            });
        }
  }
  return p;
}
export function sourceFor(
  bindings: Binding[],
  object: Item,
  options: { startLine?: number; maxLines?: number } = {},
) {
  const ref = object.source;
  if (!ref) throw Error("Object has no source.");
  const b = bindings.find((b) => b.id === ref.workspaceId);
  if (!b) throw Error("Unknown workspace.");
  if (!git(b.root, ["ls-files", "-z"]).split("\0").includes(ref.path))
    throw Error("Source no longer tracked.");
  const text = readFile(b, ref.path);
  if (hash(text) !== ref.hash)
    throw Error("Source changed. Refresh the board first.");
  const startLine = options.startLine ?? ref.startLine,
    maxLines = options.maxLines ?? 120;
  if (
    !Number.isInteger(startLine) ||
    startLine < ref.startLine ||
    startLine > ref.endLine ||
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > 120
  )
    throw Error("Excerpt must stay within the object (1–120 lines).");
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
export function verifyEvidence(
  bindings: Binding[],
  objects: Item[],
  refs: Evidence[],
) {
  for (const ref of refs) {
    const o = objects.find(
      (o) =>
        o.source &&
        o.source.workspaceId === ref.workspaceId &&
        o.source.path === ref.path &&
        o.source.hash === ref.hash &&
        ref.startLine >= o.source.startLine &&
        ref.endLine <= o.source.endLine &&
        ref.startLine <= ref.endLine,
    );
    if (!o) throw Error("Evidence must be within a current object reference.");
    sourceFor(bindings, o);
  }
}
