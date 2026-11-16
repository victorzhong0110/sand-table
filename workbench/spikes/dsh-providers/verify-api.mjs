import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SlotCore } from "@deepseek-ai/dsh-client-ui-slots";

const client = await readFile(
  new URL("../../dsh-plugin/client.js", import.meta.url),
  "utf8",
);
assert.match(client, /ctx\.slots\.inject\(/);
assert.equal(typeof SlotCore.prototype.inject, "undefined");
assert.equal(typeof SlotCore.prototype.register, "function");
const host = JSON.parse(
  await readFile(
    new URL("./node_modules/@deepseek-ai/dsh/package.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(host.version, "0.2.2-rc.1");
assert.equal(host.engines.node, ">=24.9.0");
console.log(
  JSON.stringify(
    {
      dsh: host.version,
      checks: {
        publishedSlotAPIInspected: true,
        legacyInjectMissing: true,
        registerAvailable: true,
      },
      whiteboardClient: "needs-adaptation",
      detail:
        "Current client calls slots.inject(); 0.2.2-rc.1 declares the business-face factory in slots.register({inject: ...}, Component). This is API inspection, not a browser integration pass.",
    },
    null,
    2,
  ),
);
