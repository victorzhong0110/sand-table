import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { build } from "../../node_modules/esbuild/lib/main.js";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { themes } from "./config.mjs";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const report = {};
try {
  for (const name of ["echarts", "vega", "plot"]) {
    const page = await browser.newPage({
      viewport: { width: 320, height: 240 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setContent(
        `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'"><div id="chart" style="width:300px;height:200px"></div>`,
      );
      const { outputFiles } = await build({
        entryPoints: [new URL(name + ".mjs", import.meta.url).pathname],
        bundle: true,
        write: false,
        format: "iife",
        minify: true,
      });
      const asset = outputFiles[0];
      await page.addScriptTag({ content: asset.text });
      const charts = await page.evaluate(async (themes) => {
        const node = document.querySelector("#chart");
        const kinds = {};
        const samples = (count) =>
          Array.from({ length: count }, (_, x) => ({
            key: String(x),
            cells: { x, A: x % 17 ? (x % 50) + 5 : null, B: (x % 35) + 10 },
          }));
        const row = { mapping: { x: "x", y: ["A", "B"] }, kind: "scatter" };
        for (const kind of ["bar", "line", "scatter"]) {
          for (const theme of Object.values(themes)) {
            const chart = await globalThis.chartProbe(
              node,
              { ...row, kind },
              samples(24),
              theme,
            );
            const result = chart.inspect();
            kinds[kind] ??= { sample: [] };
            kinds[kind].sample.push(result);
            chart.dispose();
            node.replaceChildren();
          }
          const times = [];
          for (let i = 0; i < 4; i++) {
            const start = performance.now();
            const chart = await globalThis.chartProbe(
              node,
              { ...row, kind },
              samples(2000),
              themes.graphite,
            );
            await new Promise(requestAnimationFrame);
            if (i > 0)
              times.push(Number((performance.now() - start).toFixed(1)));
            chart.dispose();
            node.replaceChildren();
          }
          kinds[kind].medianMs = times.sort((a, b) => a - b)[1];
        }
        const demo = await globalThis.chartProbe(
          node,
          row,
          samples(24),
          themes.warm,
        );
        const interaction = await demo.interact();
        demo.dispose();
        return { kinds, interaction, chromium: navigator.userAgent };
      }, themes);
      assert.ok(!errors.length, errors.join("\n"));
      for (const kind of Object.values(charts.kinds)) {
        assert.ok(
          kind.sample.every(({ surface, missing }) => surface > 0 && missing),
        );
      }
      if (name === "echarts") {
        assert.ok(
          charts.kinds.line.sample.every(({ lineBreaks }) => lineBreaks === 2),
          "折线必须跳过两个缺失数据点",
        );
        assert.equal(charts.interaction.hovered, true, "提示事件未触发");
        assert.equal(charts.interaction.legend, true, "图例未切换");
        assert.equal(charts.interaction.brushed, 7, "框选返回了错误的范围");
        assert.equal(charts.interaction.highlight, true, "外部行未高亮");
      }
      report[name] = {
        bytes: asset.contents.length,
        gzip: gzipSync(asset.contents).length,
        ...charts,
      };
    } catch (error) {
      report[name] = { failure: error.message, errors };
      process.exitCode = 1;
    } finally {
      await page.close();
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser.close();
}
