// DSH 插件包的清单与语法检查。
//
// 契约见 docs/architecture/dsh-integration.zh-CN.md 的 X6（清单结构）与
// X7（两端代码语法可解析）。
//
// 这里**不启动 DSH**：本沙箱没有 DSH，装不了也跑不起来。
// 运行时行为（槽位注册、工具被模型调用、命令被客户端调到）一律未验证，
// 逐条清单在 dsh-plugin/README.md 的「未验证项」里。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const pluginDir = fileURLToPath(new URL("../dsh-plugin/", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(pluginDir, "package.json"), "utf8"),
) as Record<string, any>;

const readPlugin = (name: string) =>
  readFileSync(join(pluginDir, name), "utf8");

test("X6：清单声明 bundle 补丁与 Client 段", () => {
  assert.equal(manifest.name, "@sand-table/dsh-plugin");
  assert.equal(manifest.type, "module");
  assert.equal(typeof manifest.version, "string");
  assert.ok(manifest.version.length > 0);
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh?.client?.platform, "web");
  assert.equal(manifest.dsh?.client?.immediately, true);
  assert.ok(Array.isArray(manifest.dsh?.client?.inject));
  assert.ok(
    manifest.dsh.client.inject.length > 0,
    "Client 段要声明它依赖的客户端包",
  );
  assert.ok(
    typeof manifest.engines?.dsh === "string" &&
      manifest.engines.dsh.length > 0,
    "要声明支持的 DSH 版本区间",
  );
});

test("X6：exports 暴露 Host 半、Client 半、locale 与图标", () => {
  const exportsMap = manifest.exports as Record<string, string>;
  assert.equal(exportsMap["."], "./index.js");
  assert.equal(exportsMap["./client"], "./client.js");
  assert.equal(exportsMap["./locale/*.json"], "./locale/*.json");
  assert.equal(exportsMap["./icon"], "./icon.svg");
});

test("X6：files 列出要打包的全部文件，且都真实存在", () => {
  const files = manifest.files as string[];
  assert.ok(Array.isArray(files));
  for (const entry of [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
  ])
    assert.ok(files.includes(entry), `files 少了 ${entry}`);
  for (const entry of files) {
    if (entry.includes("*")) {
      const directory = entry.slice(0, entry.indexOf("*"));
      const pattern = entry.slice(entry.indexOf("*") + 1);
      const matches = existsSync(join(pluginDir, directory))
        ? readdirSync(join(pluginDir, directory)).filter((name) =>
            name.endsWith(pattern),
          )
        : [];
      assert.ok(matches.length > 0, `${entry} 没有匹配到文件`);
      continue;
    }
    assert.ok(existsSync(join(pluginDir, entry)), `files 里的 ${entry} 不存在`);
  }
});

test("X6：补丁层插入一行插件，行 id 与包名都唯一", () => {
  const patch = readPlugin("cordis.patch.yml");
  assert.ok(patch.trim().length > 0, "空补丁会让启动失败");
  assert.match(patch, /^\s*-\s*insert:/m);
  assert.match(patch, /id:\s*sand-table\b/);
  assert.match(patch, /name:\s*["']?@sand-table\/dsh-plugin["']?/);
  const ids = [...patch.matchAll(/^\s*id:\s*(\S+)/gm)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "补丁里的行 id 不能重复");
});

test("X6：locale 两种语言都带 meta.title 与 meta.description", () => {
  for (const locale of ["en", "zh"]) {
    const data = JSON.parse(readPlugin(`locale/${locale}.json`)) as Record<
      string,
      Record<string, string>
    >;
    assert.equal(typeof data.meta?.title, "string");
    assert.equal(typeof data.meta?.description, "string");
    assert.ok(data.meta.title.trim().length > 0, `${locale} 缺标题`);
    assert.ok(data.meta.description.trim().length > 0, `${locale} 缺描述`);
    assert.ok(
      !/my-decoration|My Decoration|示例|Example/i.test(
        `${data.meta.title}${data.meta.description}`,
      ),
      `${locale} 的文案还是模板文案`,
    );
  }
});

test("X6：图标存在、格式正确、体积在限制内", () => {
  const iconPath = join(pluginDir, "icon.svg");
  assert.ok(existsSync(iconPath));
  const icon = readFileSync(iconPath, "utf8");
  assert.match(icon, /<svg[\s>]/);
  assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!/<text[\s>]/i.test(icon), "插件图标只用几何图形，不带文字");
  const size = statSync(iconPath).size;
  assert.ok(size > 0 && size <= 256 * 1024, `图标体积 ${size} 字节超限`);
});

test("X7：Host 半与 Client 半的语法都能被 node 解析", () => {
  for (const file of ["index.js", "client.js", "tasks.js"]) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: pluginDir,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `${file} 语法有误：${result.stderr || result.stdout}`,
    );
  }
});

test("X7：Client 半用惰性工厂注册，工厂 id 等于包名", () => {
  const client = readPlugin("client.js");
  assert.match(client, /__ModuleLoader__\.load\(/);
  assert.match(
    client,
    new RegExp(`id:\\s*["']${manifest.name}["']`),
    "工厂 id 必须等于包名",
  );
  assert.match(client, /slots\.inject\(/);
  assert.match(client, /slots\.register\(/);
  assert.doesNotMatch(
    client,
    /document\.body\.appendChild/,
    "不能往 body 追加第二个应用",
  );
});

test("X7：Host 半导出 apply，并且不 import 宿主包", () => {
  const host = readPlugin("index.js");
  assert.match(host, /export function apply\(/);
  const specifiers = [...host.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0, "Host 半要 import node 内置模块");
  for (const specifier of specifiers)
    assert.ok(
      specifier.startsWith("node:") || specifier === "./tasks.js",
      `运行时代码不 import ${specifier}（不引宿主包、不引第三方包）`,
    );
});
