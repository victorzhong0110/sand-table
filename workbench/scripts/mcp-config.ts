import { fileURLToPath } from "node:url";
const roots = process.argv.slice(2);
if (!roots.length || roots.length > 4)
  throw Error("请给出 1 到 4 个「标签=/绝对路径」。");
for (const arg of roots) {
  const at = arg.indexOf("=");
  if (at < 1) throw Error("每一项都要写成「标签=/绝对路径」。");
}
console.log(
  JSON.stringify(
    {
      mcpServers: {
        "sand-table": {
          command: process.execPath,
          args: [
            "--experimental-strip-types",
            fileURLToPath(new URL("../server/main.ts", import.meta.url)),
            ...roots.flatMap((w) => ["--workspace", w]),
          ],
        },
      },
    },
    null,
    2,
  ),
);
