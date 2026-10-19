import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { bind } from "./repository.ts";
import { createServer } from "./server.ts";
const args = process.argv.slice(2),
  roots: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--workspace" || !args[i + 1])
    throw Error(
      "Usage: --workspace label=/absolute/git/root (repeat up to four)",
    );
  roots.push(args[++i]);
}
const { server } = createServer(bind(roots));
await server.connect(new StdioServerTransport());
