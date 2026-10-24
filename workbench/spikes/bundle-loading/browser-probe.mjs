import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  BLOB_SCRIPT_CSP,
  LOCAL_CSP,
  SPEC_CSP,
  WORKER_BLOB_CSP,
  spikeRoot,
} from "./lib.mjs";

const CASES = [
  {
    name: "local-pdf-without-worker",
    csp: LOCAL_CSP,
    sandbox: "allow-scripts",
    mode: "pdf-without-worker",
  },
  {
    name: "local-pdf",
    csp: LOCAL_CSP,
    sandbox: "allow-scripts",
    mode: "pdf",
  },
  {
    name: "spec-csp",
    csp: SPEC_CSP,
    sandbox: "allow-scripts",
    mode: "scripts",
  },
  {
    name: "worker-blob-csp",
    csp: WORKER_BLOB_CSP,
    sandbox: "allow-scripts",
    mode: "scripts",
  },
  {
    name: "blob-script-same-origin",
    csp: BLOB_SCRIPT_CSP,
    sandbox: "allow-scripts allow-same-origin",
    mode: "scripts",
  },
];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

export async function probeBrowser({ workerPath, runnerPath, pdfB64 }) {
  const worker = readFileSync(workerPath, "utf8");
  const runner = readFileSync(runnerPath, "utf8");
  const probeJs = readFileSync(join(spikeRoot, "iframe-probe.js"), "utf8");
  if (probeJs.includes("</")) throw new Error("探针脚本含有 </ ，不能放进 srcdoc");
  const sources = JSON.stringify({ worker, runner, pdfB64 });
  const server = createServer((req, res) => {
    if (req.url === "/sources.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(sources);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>probe</title><body></body>");
  });
  const port = await listen(server);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);
    await page.goto(`http://127.0.0.1:${port}/`);
    const cases = [];
    for (const item of CASES) {
      console.log("浏览器探针", item.name);
      const payload = await page.evaluate(
        async ({ csp, sandbox, mode, probeJs: source }) => {
          const packed = await (await fetch("/sources.json")).json();
          const iframe = document.createElement("iframe");
          iframe.setAttribute("sandbox", sandbox);
          const done = new Promise((resolve) => {
            const timer = setTimeout(
              () => resolve({ fatal: "parent timeout" }),
              80000,
            );
            window.addEventListener("message", (event) => {
              if (event.source !== iframe.contentWindow) return;
              if (event.data?.type !== "probe") return;
              clearTimeout(timer);
              resolve(event.data.payload);
            });
          });
          iframe.addEventListener("load", () => {
            iframe.contentWindow?.postMessage(
              {
                type: "sources",
                mode,
                worker: packed.worker,
                runner: packed.runner,
                pdfB64: packed.pdfB64,
              },
              "*",
            );
          });
          iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${source}</script></body></html>`;
          document.body.appendChild(iframe);
          const result = await done;
          let parentOrigin = "unread";
          try {
            parentOrigin = iframe.contentWindow?.location.origin ?? "missing";
          } catch (error) {
            parentOrigin = error instanceof Error ? error.message : String(error);
          }
          const sandboxAttr = iframe.getAttribute("sandbox");
          iframe.remove();
          return { ...result, parentOrigin, sandboxAttr };
        },
        { csp: item.csp, sandbox: item.sandbox, mode: item.mode, probeJs },
      );
      cases.push({
        name: item.name,
        sandbox: item.sandbox,
        mode: item.mode,
        ...payload,
      });
    }
    return { cases };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}
