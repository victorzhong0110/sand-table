// Python 符号索引：解析源码文本，从不导入或执行被检查的代码。
//
// 搬迁自 server/python.ts（#13：代码领域包与连接器）。
// 契约见 docs/architecture/domain-packs.zh-CN.md 第 4 节。

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export type PythonSymbol = {
  name: string;
  startLine: number;
  endLine: number;
  calls: string[];
};
export function pythonSymbols(
  file: string,
  text: string,
): { symbols: PythonSymbol[]; parser?: string; error?: string } {
  try {
    return JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-S",
          fileURLToPath(new URL("./python_index.py", import.meta.url)),
        ],
        {
          input: JSON.stringify({ path: file, text }),
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 1_000_000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
  } catch (e) {
    return {
      symbols: [],
      error:
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "Python 3 is not installed; file is readable but symbols are not indexed."
          : "Python AST analysis unavailable for this file; no repository code was executed.",
    };
  }
}
