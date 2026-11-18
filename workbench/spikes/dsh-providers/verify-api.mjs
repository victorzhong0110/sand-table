import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SlotCore } from "@deepseek-ai/dsh-client-ui-slots";

const client = await readFile(
  new URL("../../dsh-plugin/client.js", import.meta.url),
  "utf8",
);
assert.match(client, /ctx\.slots\.inject\(/);
assert.equal(typeof SlotCore.prototype.inject, "undefined");
const rendererDeclaration = await readFile(
  new URL(
    "./node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts",
    import.meta.url,
  ),
  "utf8",
);
const rendererRuntime = await readFile(
  new URL(
    "./node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js",
    import.meta.url,
  ),
  "utf8",
);
assert.match(rendererDeclaration, /inject\(key: keyof SlotMap/);
assert.match(rendererRuntime, /inject\(key, callback\)/);
assert.match(rendererRuntime, /subscribeDeclaration\(key, changed\)/);
const names = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
];
const dependencies = new Map(
  await Promise.all(names.map(async (name) => [name, await import(name)])),
);
let renderer;
runInNewContext(rendererRuntime, {
  window: {
    __ModuleLoader__: {
      load({ factory }) {
        renderer = factory((name) => dependencies.get(name));
      },
    },
  },
  console,
  queueMicrotask,
  setTimeout,
  clearTimeout,
});
assert.equal(typeof renderer.SlotRegistry.prototype.inject, "function");
assert.equal(typeof renderer.SlotRegistry.prototype.register, "function");
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
        coreInjectAbsent: true,
        runtimeDeclarationInjectionAvailable: true,
        registerAvailable: true,
      },
      whiteboardClient: "published-runtime-api-matches",
      detail:
        "Corrected 2026-11-17: ctx.slots is the renderer-owned SlotRegistry, which provides declaration-lifecycle inject(key, callback) over SlotCore. register({inject: factory}) is a separate business-props API. This check inspects both published layers; browser integration is recorded separately.",
    },
    null,
    2,
  ),
);
