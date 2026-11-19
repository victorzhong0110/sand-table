import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = (
  await build({
    stdin: {
      contents: 'export { toPng } from "html-to-image";',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    write: false,
    bundle: true,
    format: "iife",
    globalName: "boardSnapshot",
    minify: true,
  })
).outputFiles[0].text;

const escape = (text) =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const whiteboardPolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'";
const prototypePolicy =
  whiteboardPolicy +
  "; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
const iframe = (id, content, attrs = "") =>
  `<iframe id="${id}" sandbox="allow-scripts" ${attrs} srcdoc="${escape(content)}"></iframe>`;

const prototype = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${prototypePolicy}">
<style>html { background:#e60037; color:white } label { display:block }</style>
<form><label>Sample input <input id="answer"></label><button type="button" id="apply">Apply</button></form>
<p id="label">Prototype only label</p><output id="output"></output>
<script>
  const host = parent;
  let hostBlocked;
  try { hostBlocked = !host.document; } catch { hostBlocked = true; }
  const send = (event) => host.postMessage({ ...event, type: "design.probe" }, "*");
  const blocked = [];
  addEventListener("securitypolicyviolation", (event) => blocked.push(event.effectiveDirective));
  document.querySelector("#apply").onclick = () => {
    document.querySelector("#output").textContent = document.querySelector("#answer").value;
  };
  addEventListener("message", (event) => {
    if (event.source !== host || event.data?.type !== "design.probe") return;
    if (event.data.action === "params" && typeof event.data.label === "string") {
      document.querySelector("#label").textContent = event.data.label;
    }
    if (event.data.action === "navigate") location.assign("/probe-net?navigation");
    if (event.data.action === "halt") while (true) { /* Dedicated, disposable browser only. */ }
    if (event.data.action === "spin") {
      const end = performance.now() + 1100;
      while (performance.now() < end) { /* Deliberately bounded. */ }
    }
  });
  void (async () => {
    let fetchBlocked = false;
    try { await fetch("/probe-net"); } catch { fetchBlocked = true; }
    await new Promise((done) => {
      const image = new Image();
      image.onload = image.onerror = done;
      image.src = "/probe-net?image";
    });
    document.querySelector("form").action = "/probe-net?form";
    document.querySelector("form").requestSubmit();
    setTimeout(() => send({ hostBlocked, fetchBlocked, blocked }), 50);
  })();
</script>`;

const parentHTML = `
<style>
  @page { size: 100mm 120mm; margin: 6mm }
  body { margin:0 }
  #export-root { background:#fff; width:340px; padding:10px; color:#0a2130 }
  iframe { display:block; border:0; width:300px; height:180px }
</style>
<main id="export-root"><h1>Board printable title</h1>
<svg width="300" height="40" aria-label="board native shape"><rect width="300" height="40" fill="navy"/></svg>
${iframe("prototype", prototype)}</main>
<button id="stop">Stop prototype</button>
<script>
  const frame = document.querySelector("#prototype");
  window.dispatchProbe = (action, other) =>
    frame.contentWindow.postMessage({ type:"design.probe", action, ...other }, "*");
  addEventListener("message", ({ source, origin, data }) => {
    if (source === frame.contentWindow && origin === "null" && data?.type === "design.probe")
      window.report = { ...data, origin };
  });
  document.querySelector("#stop").onclick = () => frame.remove();
</script>`;

const staticTitle =
  "<script>window.staticExecuted=true</script> Static HTML board";
let net = 0;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url.startsWith("/probe-net")) {
    net++;
    response.end("<!doctype html><p>benign probe endpoint</p>");
  } else if (request.url === "/nested") {
    response.end(
      iframe(
        "whiteboard",
        `<!doctype html>
      <meta http-equiv="Content-Security-Policy" content="${whiteboardPolicy}">
      ${parentHTML}`,
      ),
    );
  } else if (request.url === "/static-export") {
    response.end(`<!doctype html><meta charset="utf-8"><h1>${escape(staticTitle)}</h1>
      <svg width="30" height="30"><rect width="30" height="30" fill="navy"/></svg>
      <p>交互原型 · 静态占位</p>`);
  } else {
    response.end(`<!doctype html>${parentHTML}<script>${bundle}</script>`);
  }
});

const runtime = await mkdtemp(join(tmpdir(), "sand-design-"));
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  await page.goto(base);
  await page.waitForFunction(() => window.report);
  const report = await page.evaluate(() => window.report);
  assert.equal(report.origin, "null");
  assert.equal(report.hostBlocked, true);
  assert.equal(report.fetchBlocked, true);
  assert.ok(report.blocked.includes("connect-src"));
  assert.ok(report.blocked.includes("img-src"));
  const child = page.frameLocator("#prototype");
  await child.locator("#answer").fill("local answer");
  await child.locator("#apply").click();
  assert.equal(await child.locator("#output").textContent(), "local answer");
  const png = await page
    .locator("#export-root")
    .evaluate((root) => window.boardSnapshot.toPng(root, { pixelRatio: 1 }));
  const compositor = await page.locator("#export-root").screenshot();
  const trailingPixel = async (url) =>
    page.evaluate(async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return [...context.getImageData(260, image.height - 26, 1, 1).data];
    }, url);
  const domPixel = await trailingPixel(png);
  const screenPixel = await trailingPixel(
    "data:image/png;base64," + compositor.toString("base64"),
  );
  assert.notDeepEqual(domPixel, [230, 0, 55, 255]);
  assert.deepEqual(screenPixel, [230, 0, 55, 255]);
  const pdf = join(runtime, "board.pdf");
  const pdfBytes = (
    await page.pdf({
      path: pdf,
      printBackground: true,
      preferCSSPageSize: true,
    })
  ).length;
  const pdfText = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  assert.match(pdfText, /Board printable title/);
  await page.evaluate(() =>
    window.dispatchProbe("params", { label: "Update from parent" }),
  );
  await child.getByText("Update from parent", { exact: true }).waitFor();
  const stopMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        window.dispatchProbe("spin");
        setTimeout(() => {
          document.querySelector("#stop").click();
          resolve(Math.round(performance.now() - start));
        }, 100);
      }),
  );
  assert.equal(await page.locator("#prototype").count(), 0);
  const subresourceRequests = net;
  await page.goto(base + "/nested");
  const workbench = page.frameLocator("#whiteboard");
  const nested = workbench.frameLocator("#prototype");
  await nested.locator("#answer").fill("nested answer", { timeout: 3000 });
  await nested.locator("#apply").click();
  assert.equal(await nested.locator("#output").textContent(), "nested answer");
  await workbench
    .locator("#prototype")
    .evaluate((frame) =>
      frame.contentWindow.postMessage(
        { type: "design.probe", action: "navigate" },
        "*",
      ),
    );
  await page.waitForTimeout(350);
  const nestedNavigationRequests = net - subresourceRequests;

  await page.goto(base);
  const beforeStandaloneNav = net;
  await page.evaluate(() => window.dispatchProbe("navigate"));
  await page.waitForTimeout(350);
  const standaloneNavigationRequests = net - beforeStandaloneNav;
  await page.goto(base + "/static-export");
  assert.equal(await page.locator("h1").textContent(), staticTitle);
  assert.equal(await page.locator("script, iframe").count(), 0);
  assert.equal(subresourceRequests, 0);

  // The broker timeout stays outside the renderer. Closing the disposable browser
  // after this probe is the harness cleanup, not a capability of the prototype UI.
  await page.goto(base);
  await page.waitForFunction(() => window.report);
  await page.evaluate(() => {
    window.dispatchProbe("halt");
    setTimeout(() => document.querySelector("#stop").click(), 100);
  });
  let stoppedInfiniteLoop = true;
  try {
    await page
      .locator("#prototype")
      .waitFor({ state: "detached", timeout: 500 });
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    stoppedInfiniteLoop = false;
  }
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        node: process.version,
        sandbox: {
          origin: report.origin,
          hostBlocked: report.hostBlocked,
          networkDirectives: [...new Set(report.blocked)].sort(),
          subresourceRequests,
          nestedNavigationRequests,
          standaloneNavigationRequests,
          localControls: true,
          receivedParameters: true,
          nestedExecutes: true,
          stopScheduledMs: 100,
          boundedSpinMs: 1100,
          observedStopMs: stopMs,
          stoppedInfiniteLoopWithin500ms: stoppedInfiniteLoop,
        },
        export: {
          domPngPrototypePixel: domPixel,
          compositorPrototypePixel: screenPixel,
          pdfBytes,
          pdfContainsBoardText: true,
          pdfContainsPrototypeText: pdfText.includes("Prototype only label"),
          staticEscapesScripts: true,
        },
        dependency: {
          name: "html-to-image",
          version: "1.11.13",
          license: "MIT",
          probeBytes: Buffer.byteLength(bundle),
          probeGzipBytes: gzipSync(bundle).length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(runtime, { recursive: true, force: true });
}
