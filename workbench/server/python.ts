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
