import { fileURLToPath } from "node:url";
import { bind } from "../connectors/git.ts";
const roots = bind(process.argv.slice(2));
console.log(
  JSON.stringify(
    {
      mcpServers: {
        "sand-table": {
          command: process.execPath,
          args: [
            "--experimental-strip-types",
            fileURLToPath(new URL("../server/main.ts", import.meta.url)),
            ...roots.flatMap((w) => ["--workspace", `${w.label}=${w.root}`]),
          ],
        },
      },
    },
    null,
    2,
  ),
);
