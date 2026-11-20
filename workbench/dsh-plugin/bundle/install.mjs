import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(join(directory, "bundle.json"), "utf8"),
);
const cli = process.platform === "win32" ? "dsh.cmd" : "dsh";
const run = (args, options) => execFileSync(cli, args, options);
if (
  manifest.format !== "sand-table-dsh-bundle" ||
  manifest.version !== 1 ||
  manifest.profile !== "web" ||
  manifest.dsh !== "0.2.2-rc.1" ||
  manifest.required.length !== 2
)
  throw Error("无法识别安装目录中的工作台清单。");
const hostVersion = run(["--version"], { encoding: "utf8" }).trim();
if (!hostVersion.split(/\s+/).includes(manifest.dsh))
  throw Error(`本组合需要 DSH ${manifest.dsh}，当前版本为 ${hostVersion}。`);
for (const { file, sha256 } of manifest.required) {
  if (basename(file) !== file || !/^[a-z0-9.\-]+\.tgz$/i.test(file))
    throw Error("安装清单中的插件文件名无效。");
  const actual = createHash("sha256")
    .update(await readFile(join(directory, file)))
    .digest("hex");
  if (actual !== sha256)
    throw Error(`安装包 ${file} 完整性校验失败，请重新下载。`);
}
run(["web", "--dump-config"], { stdio: "ignore" });
for (const { file } of manifest.required)
  run(["plugin", "--profile", manifest.profile, "add", join(directory, file)], {
    stdio: "inherit",
  });
