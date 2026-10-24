// Python 符号索引：只解析源码文本，不导入、不执行被检查的代码。

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type PythonSymbol = {
  name: string;
  startLine: number;
  endLine: number;
  calls: string[];
};

type Interpreter = { command: string; args: string[] };

// 解释器名在各平台不一样：Linux 与 macOS 上是 python3，
// Windows 上多半只有 python，或者只有 py -3 启动器。
const candidates = (): Interpreter[] => {
  const override = process.env.SAND_PYTHON?.trim();
  if (override) return [{ command: override, args: [] }];
  return [
    { command: "python3", args: [] },
    { command: "python", args: [] },
    { command: "py", args: ["-3"] },
  ];
};

let interpreter: Interpreter | undefined;

function resolveInterpreter(): Interpreter {
  if (interpreter) return interpreter;
  for (const candidate of candidates()) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.args, "-c", "import sys"],
      { stdio: "ignore", timeout: 5000, windowsHide: true },
    );
    if (!probe.error && probe.status === 0) {
      interpreter = candidate;
      return candidate;
    }
  }
  interpreter = { command: "python3", args: [] };
  return interpreter;
}

export function pythonSymbols(
  file: string,
  text: string,
): { symbols: PythonSymbol[]; parser?: string; error?: string } {
  const python = resolveInterpreter();
  try {
    return JSON.parse(
      execFileSync(
        python.command,
        [
          ...python.args,
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
          windowsHide: true,
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
