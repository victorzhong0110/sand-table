import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { BoardStore } from "../core/store.ts";
import { Spaces } from "../server/spaces.ts";
import { openView } from "../core/space-state.ts";
import { registerPackTools } from "../server/packs.ts";
import { parsePackManifest } from "../core/packs.ts";
import { checkComponentData } from "../core/spaces.ts";
import {
  assertPublicHttpsUrl,
  fetchPackManifest,
  type PackHttpClient,
} from "../core/pack-fetch.ts";
import type { Projection } from "../core/model.ts";
import type { RegisterTool } from "../server/tool-types.ts";

const projection: Projection = { workspaces: [], objects: [], relations: [] };

type Handler = (args: any) => unknown;

/** The same registration the MCP server does, with the argument schema
 * applied, so a test calls the tool the way the server calls it. The handler
 * is wrapped in an async function because that is what the server does: a
 * refusal comes back as a rejected promise, not a synchronous throw. */
function register(store: BoardStore) {
  const handlers = new Map<string, Handler>();
  const tool: RegisterTool = (name, description, shape, fn) => {
    const schema = z.object(shape);
    handlers.set(name, async (args: any) => fn(schema.parse(args)));
  };
  registerPackTools(tool, store);
  return handlers;
}

function setup() {
  const store = new BoardStore();
  const opened = store.open(projection, "unit");
  openView(store.get(opened.id), "view-a");
  const handlers = register(store);
  const rev = () => store.get(opened.id).revision;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    handlers.get(name)!(args) as any;
  const importJson = (json: string, revision = rev()) =>
    call("sand_import_component_pack", {
      boardId: opened.id,
      revision,
      viewId: "view-a",
      source: { json },
    });
  return { store, handlers, id: opened.id, rev, call, importJson };
}

const manifest = {
  protocol: "sand-table/component-pack",
  version: 1,
  id: "com.example.review",
  name: "评审包",
  components: [
    { key: "goal", type: "task", title: "目标与验收条件" },
    {
      key: "unknown",
      type: "reasoning",
      title: "未知项",
      data: { question: "哪些还没确认？" },
    },
  ],
};

test("a valid manifest imports and shows up in the pack list", async () => {
  const { id, rev, call, importJson } = setup();
  const before = rev();
  const result = await importJson(JSON.stringify(manifest));
  assert.equal(result.pack.id, "com.example.review");
  assert.equal(result.pack.name, "评审包");
  assert.equal(result.pack.version, 1);
  assert.equal(result.pack.componentCount, 2);
  assert.equal(result.pack.source, "json");
  assert.equal(result.replaced, false);
  assert.deepEqual(result.warnings, []);
  assert.ok(rev() > before, "the import is a board change: the revision moves");

  const listed = await call("sand_list_component_packs", { boardId: id });
  assert.equal(listed.packs.length, 1);
  assert.equal(listed.packs[0].id, "com.example.review");
  assert.equal(listed.packs[0].componentCount, 2);
  assert.deepEqual(
    listed.packs[0].components.map((c: any) => c.key),
    ["goal", "unknown"],
  );
  assert.deepEqual(
    listed.packs[0].components.map((c: any) => c.type),
    ["task", "reasoning"],
  );
});

test("a manifest with the wrong protocol is not a component pack", async () => {
  const { importJson } = setup();
  await assert.rejects(
    () => importJson(JSON.stringify({ ...manifest, protocol: "other/thing" })),
    /不是组件包/,
  );
});

test("an unknown version is refused by name", async () => {
  const { importJson } = setup();
  await assert.rejects(
    () => importJson(JSON.stringify({ ...manifest, version: 2 })),
    /版本/,
  );
});

test("a malformed id is refused", async () => {
  const { importJson } = setup();
  await assert.rejects(
    () => importJson(JSON.stringify({ ...manifest, id: "Not An Id" })),
    /id/,
  );
});

test("a type this version does not know is imported with a warning", async () => {
  const { store, id, importJson } = setup();
  const result = await importJson(
    JSON.stringify({
      ...manifest,
      components: [
        { key: "tl", type: "timeline", title: "时间线", data: { steps: [1, 2] } },
      ],
    }),
  );
  assert.equal(result.pack.componentCount, 1, "an unknown type still counts");
  assert.equal(result.replaced, false);
  assert.ok(
    result.warnings.some(
      (w: string) => w.includes("未知组件类型") && w.includes("timeline"),
    ),
    "the import says which type it did not know: " + result.warnings.join(" / "),
  );
  /* The data is kept, not dropped: the canvas shows the placeholder the
     renderer already shows for a type it does not know. */
  const stored = store.get(id).componentPacks![0].components[0];
  assert.equal(stored.type, "timeline");
  assert.deepEqual(stored.data, { steps: [1, 2] });
});

test("invalid data for a known type is refused by the editor's check", async () => {
  const { importJson } = setup();
  await assert.rejects(
    () =>
      importJson(
        JSON.stringify({
          ...manifest,
          components: [
            {
              key: "goal",
              type: "task",
              title: "目标",
              data: { goal: "g", items: [{ text: "a", done: "yes" }] },
            },
          ],
        }),
      ),
    /Checklist values are invalid/,
  );
});

test("a javascript: URL in the data is refused", async () => {
  const { importJson } = setup();
  await assert.rejects(
    () =>
      importJson(
        JSON.stringify({
          ...manifest,
          components: [
            {
              key: "doc",
              type: "resource",
              title: "材料",
              data: { url: "javascript:alert(1)", description: "x" },
            },
          ],
        }),
      ),
    /Resource URL must use HTTP\(S\)/,
  );
});

test("importing the same id again upgrades the pack", async () => {
  const { store, id, importJson } = setup();
  await importJson(JSON.stringify(manifest));
  const upgraded = await importJson(
    JSON.stringify({
      ...manifest,
      name: "评审包 2",
      components: [
        { key: "goal", type: "task", title: "目标与验收条件" },
        { key: "plan", type: "reasoning", title: "下一步" },
      ],
    }),
  );
  assert.equal(upgraded.replaced, true);
  assert.equal(upgraded.pack.name, "评审包 2");
  assert.equal(upgraded.pack.componentCount, 2);
  const packs = store.get(id).componentPacks!;
  assert.equal(packs.length, 1, "the pack is replaced, not added twice");
  assert.deepEqual(
    packs[0].components.map((c: any) => c.key),
    ["goal", "plan"],
    "the preset that is gone from the new pack is gone from the board too",
  );
});

test("removing a pack takes it off the board", async () => {
  const { store, id, rev, call, importJson } = setup();
  await importJson(JSON.stringify(manifest));
  const before = rev();
  const removed = await call("sand_remove_component_pack", {
    boardId: id,
    revision: before,
    packId: "com.example.review",
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.packId, "com.example.review");
  assert.equal((store.get(id).componentPacks ?? []).length, 0);
  assert.ok(rev() > before, "removing a pack is a board change too");
  const listed = await call("sand_list_component_packs", { boardId: id });
  assert.deepEqual(listed.packs, []);
});

test("removing a pack that is not there says so", async () => {
  const { id, rev, call } = setup();
  await assert.rejects(
    () =>
      call("sand_remove_component_pack", {
        boardId: id,
        revision: rev(),
        packId: "com.example.nope",
      }),
    /没有这个组件包/,
  );
});

test("a stale revision is refused the way every other write is", async () => {
  const { id, call, importJson } = setup();
  await importJson(JSON.stringify(manifest));
  await assert.rejects(
    () =>
      call("sand_import_component_pack", {
        boardId: id,
        revision: 0,
        viewId: "view-a",
        source: { json: JSON.stringify(manifest) },
      }),
    /Board changed/,
  );
});

test("an exported pack can be imported again as it is", async () => {
  const { id, call, importJson } = setup();
  await importJson(JSON.stringify(manifest));
  const exported = await call("sand_export_component_pack", {
    boardId: id,
    packId: "com.example.review",
  });
  assert.equal(exported.packId, "com.example.review");
  assert.equal(exported.manifest.protocol, "sand-table/component-pack");
  assert.equal(exported.manifest.version, 1);
  const again = await importJson(JSON.stringify(exported.manifest));
  assert.equal(again.replaced, true);
  assert.equal(again.pack.componentCount, 2);
  assert.deepEqual(again.warnings, []);
});

test("unknown data keys are dropped with a warning, the import still works", () => {
  const { manifest: parsed, warnings } = parsePackManifest(
    JSON.stringify({
      ...manifest,
      components: [
        {
          key: "note",
          type: "text",
          title: "便签",
          data: { text: "hi", nonsense: 1 },
        },
      ],
    }),
  );
  assert.equal(parsed.components[0].data!.text, "hi");
  assert.equal("nonsense" in parsed.components[0].data!, false);
  assert.ok(warnings.some((w) => w.includes("nonsense")));
});

test("a size outside the canvas range is clamped with a warning", () => {
  const { manifest: parsed, warnings } = parsePackManifest(
    JSON.stringify({
      ...manifest,
      components: [
        { key: "wide", type: "text", title: "太宽", width: 5000, height: 10 },
      ],
    }),
  );
  assert.equal(parsed.components[0].width, 2000);
  assert.equal(parsed.components[0].height, 70);
  assert.equal(warnings.length, 2);
});

test("data that is left out falls back to the type's default", () => {
  const { manifest: parsed } = parsePackManifest(JSON.stringify(manifest));
  assert.equal(parsed.components[0].data, undefined);
  assert.equal(parsed.components[1].data!.question, "哪些还没确认？");
});

test("a board holds at most 20 packs", async () => {
  const { importJson } = setup();
  for (let i = 0; i < 20; i++)
    await importJson(
      JSON.stringify({
        ...manifest,
        id: `com.example.pack${i}`,
        name: `包 ${i}`,
      }),
    );
  await assert.rejects(
    () =>
      importJson(
        JSON.stringify({
          ...manifest,
          id: "com.example.pack20",
          name: "包 20",
        }),
      ),
    /最多 20 个组件包/,
  );
});

test("an icon this version does not know is dropped, not refused", async () => {
  const { store, id, importJson } = setup();
  const result = await importJson(
    JSON.stringify({
      ...manifest,
      components: [
        { key: "note", type: "text", title: "便签", icon: "sparkle" },
      ],
    }),
  );
  assert.equal(result.pack.componentCount, 1, "the pack still imports");
  assert.ok(
    result.warnings.some((w: string) => w.includes("sparkle")),
    "the import says the icon was not used: " + result.warnings.join(" / "),
  );
  const stored = store.get(id).componentPacks![0].components[0];
  assert.equal(stored.icon, undefined, "the icon falls back to the type's own");
});

test("a known type in a pack goes through checkComponentData", async () => {
  const { importJson } = setup();
  const data = { goal: "g", items: [{ text: "a", done: "yes" }] };
  /* The one function the editor uses. */
  assert.throws(
    () => checkComponentData("task", data),
    /Checklist values are invalid/,
  );
  /* And the pack path refuses the same data with the same reason. */
  await assert.rejects(
    () =>
      importJson(
        JSON.stringify({
          ...manifest,
          components: [
            { key: "goal", type: "task", title: "目标", data },
          ],
        }),
      ),
    /Checklist values are invalid/,
  );
});

test("the pack and the editor agree on every data", () => {
  /* Both paths call the same checkComponentData from core/spaces.ts. This
     pins the two routes together: a pack may not be a way around the check
     the editor applies. */
  const editor = (type: string, data: Record<string, unknown>) => {
    const store = new BoardStore();
    const opened = store.open(projection, "unit");
    openView(store.get(opened.id), "view-a");
    const spaces = new Spaces(store);
    try {
      spaces.update(
        opened.id,
        store.get(opened.id).revision,
        "view-a",
        { kind: "create", type, title: "t", data },
        "human",
      );
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const shared = (type: string, data: Record<string, unknown>) => {
    try {
      checkComponentData(type, data);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const cases: { type: string; data: Record<string, unknown> }[] = [
    { type: "task", data: { goal: "g", items: [{ text: "a", done: true }] } },
    { type: "task", data: { goal: "g", items: [{ text: "a", done: "yes" }] } },
    { type: "task", data: { goal: "g" } },
    { type: "task", data: { goal: "g", items: [] } },
    { type: "chart", data: { kind: "bar", points: [] } },
    { type: "chart", data: { kind: "bar", points: [{ label: "a", value: 1 }] } },
    { type: "chart", data: { kind: "bar", points: [{ label: "a", value: "x" }] } },
    { type: "table", data: { columns: ["a"], rows: [["x"]] } },
    { type: "table", data: { columns: ["a"], rows: [["x", "y"]] } },
    { type: "table", data: { columns: ["a"], rows: "no" } },
    { type: "resource", data: { url: "https://example.com" } },
    { type: "resource", data: { url: "javascript:alert(1)" } },
    { type: "status", data: { sourceUrl: "file:///etc/passwd" } },
    { type: "status", data: { sourceUrl: "https://example.com" } },
    { type: "events", data: { events: [] } },
    { type: "events", data: { events: new Array(101).fill({ at: "x" }) } },
    { type: "text", data: { text: "hello" } },
    { type: "timeline", data: { anything: 1 } },
  ];
  for (const c of cases) {
    assert.equal(
      shared(c.type, c.data),
      editor(c.type, c.data),
      `the pack check and the editor check must agree on ${c.type}`,
    );
  }
});

test("a host that resolves to a private address is refused", async () => {
  /* The real request resolves the host itself, so the address that is checked
     is the address that is connected to. localhost resolves to the loopback
     and is refused before a socket is opened. */
  await assert.rejects(
    () => fetchPackManifest("https://localhost/pack.json"),
    /回环/,
  );
});

test("only https and public hosts are fetched", () => {
  assert.throws(
    () => assertPublicHttpsUrl("http://example.com/pack.json"),
    /只允许 https/,
  );
  assert.throws(
    () => assertPublicHttpsUrl("https://127.0.0.1/pack.json"),
    /回环/,
  );
  assert.throws(
    () => assertPublicHttpsUrl("https://10.0.0.5/pack.json"),
    /私有网段/,
  );
  assert.throws(
    () => assertPublicHttpsUrl("https://172.16.0.1/pack.json"),
    /私有网段/,
  );
  assert.throws(
    () => assertPublicHttpsUrl("https://192.168.1.1/pack.json"),
    /私有网段/,
  );
  assert.throws(
    () => assertPublicHttpsUrl("https://169.254.169.254/latest"),
    /链路本地/,
  );
  assert.throws(() => assertPublicHttpsUrl("https://[::1]/pack.json"), /回环/);
  assert.throws(
    () => assertPublicHttpsUrl("https://[fd00::1]/pack.json"),
    /私有网段/,
  );
  assert.doesNotThrow(() =>
    assertPublicHttpsUrl("https://example.com/pack.json"),
  );
});

test("every redirect hop is checked again", async () => {
  const hop: PackHttpClient = async () => ({
    status: 302,
    headers: { location: "https://127.0.0.1/pack.json" },
    body: Buffer.from(""),
  });
  await assert.rejects(
    () => fetchPackManifest("https://203.0.113.10/pack.json", hop),
    /回环/,
  );
  const downgraded: PackHttpClient = async () => ({
    status: 302,
    headers: { location: "http://203.0.113.10/pack.json" },
    body: Buffer.from(""),
  });
  await assert.rejects(
    () => fetchPackManifest("https://203.0.113.10/pack.json", downgraded),
    /只允许 https/,
  );
});

test("a fetched manifest has to be JSON", async () => {
  const html: PackHttpClient = async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from("<html></html>"),
  });
  await assert.rejects(
    () => fetchPackManifest("https://203.0.113.10/pack.json", html),
    /Content-Type/,
  );
  const json: PackHttpClient = async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(manifest)),
  });
  const fetched = await fetchPackManifest("https://203.0.113.10/pack.json", json);
  assert.equal(fetched.text, JSON.stringify(manifest));
  assert.equal(fetched.url, "https://203.0.113.10/pack.json");
});

test("an imported pack is a board change, so it can be undone", async () => {
  const { store, id, importJson } = setup();
  await importJson(JSON.stringify(manifest));
  assert.equal((store.get(id).componentPacks ?? []).length, 1);
  const spaces = new Spaces(store);
  spaces.undo(id, undefined, "human");
  assert.equal(
    (store.get(id).componentPacks ?? []).length,
    0,
    "the pack goes with the undo",
  );
});

test("a url that is not https never reaches the network", async () => {
  const { id, rev, call } = setup();
  await assert.rejects(
    () =>
      call("sand_import_component_pack", {
        boardId: id,
        revision: rev(),
        viewId: "view-a",
        source: { url: "http://example.com/pack.json" },
      }),
    /只允许 https/,
  );
  await assert.rejects(
    () =>
      call("sand_import_component_pack", {
        boardId: id,
        revision: rev(),
        viewId: "view-a",
        source: { url: "https://127.0.0.1/pack.json" },
      }),
    /回环/,
  );
});
