import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeBrowser } from "./browser-probe.mjs";
import { probeLocalHost, probeSdk } from "./host-probe.mjs";
import { spikeRoot } from "./lib.mjs";
import { measure } from "./measure.mjs";

const resultsDir = join(spikeRoot, "results");
mkdirSync(resultsDir, { recursive: true });

const measured = await measure();
const { artifacts, ...sizes } = measured;
writeFileSync(
  join(resultsDir, "sizes.json"),
  JSON.stringify(sizes, null, 2) + "\n",
);

const browser = await probeBrowser(artifacts);
writeFileSync(
  join(resultsDir, "browser.json"),
  JSON.stringify(browser, null, 2) + "\n",
);
const localPdf = browser.cases.find((item) => item.name === "local-pdf");
if (!localPdf?.classicInline?.ok) {
  throw new Error("本地 CSP 下内联脚本没有执行，探针无效");
}
if (!localPdf.pdf?.ok || !String(localPdf.pdf.text).includes("Hello")) {
  throw new Error(`主线程 pdf.js 没有读出 Hello：${JSON.stringify(localPdf.pdf)}`);
}

const sdk = await probeSdk();
const localHost = await probeLocalHost();
const host = { sdk, localHost };
writeFileSync(join(resultsDir, "host.json"), JSON.stringify(host, null, 2) + "\n");
if (!localHost.boardRendered) throw new Error("本地宿主没有打开白板");

writeFileSync(
  join(resultsDir, "summary.json"),
  JSON.stringify({ sizes, browser, host }, null, 2) + "\n",
);
console.log("探针完成", join(resultsDir, "summary.json"));
