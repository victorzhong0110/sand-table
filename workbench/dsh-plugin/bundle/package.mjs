import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../node_modules/esbuild/lib/main.js";

const bundle = dirname(fileURLToPath(import.meta.url));
const workbench = resolve(bundle, "../..");
const target = resolve(process.argv[2] || "artifacts/dsh-bundle");
const root = await mkdtemp(join(tmpdir(), "sand-dsh-package-"));
const packagePath = join(root, "package");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const release = "0.2.2-rc.1";
const banner = {
  js: 'import {createRequire as sandCreateRequire} from "node:module"; const require=sandCreateRequire(import.meta.url); const __filename=import.meta.filename; const __dirname=import.meta.dirname;',
};
const json = (path) => readFile(path, "utf8").then(JSON.parse);
async function put(path, data) {
  const file = join(packagePath, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}
try {
  await mkdir(target, { recursive: true });
  const built = await build({
    entryPoints: {
      "local/app": join(bundle, "app.mjs"),
      "local/bridge": join(workbench, "local/bridge.ts"),
      "server/main": join(workbench, "server/main.ts"),
    },
    outdir: packagePath,
    outExtension: { ".js": ".mjs" },
    banner,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["pdfjs-dist/*"],
    logLevel: "warning",
    metafile: true,
  });
  await cp(join(workbench, "dist"), join(packagePath, "dist"), {
    recursive: true,
  });
  await cp(
    join(workbench, "packs/code/python_index.py"),
    join(packagePath, "server/python_index.py"),
  );
  const source = join(workbench, "dsh-plugin");
  for (const file of ["client.js", "locale", "icon.svg", "README.md"])
    await cp(join(source, file), join(packagePath, file), { recursive: true });
  for (const file of ["LICENSE", "NOTICE"])
    await cp(resolve(workbench, "..", file), join(packagePath, file));
  const packages = new Set(
    Object.keys(built.metafile.inputs).flatMap((file) => {
      const path = resolve(file)
        .replaceAll("\\", "/")
        .split("/node_modules/")
        .at(-1);
      if (!file.includes("node_modules/")) return [];
      const [scope, name] = path.split("/");
      return [scope.startsWith("@") ? scope + "/" + name : scope];
    }),
  );
  const notices = [];
  for (const name of packages) {
    const folder = join(workbench, "node_modules", name);
    const info = await json(join(folder, "package.json"));
    const files = (await readdir(folder)).filter((file) =>
      /^(license|notice|copying)([.\-]|$)/i.test(file),
    );
    for (const file of files)
      await put(
        join("third-party", name, file),
        await readFile(join(folder, file)),
      );
    notices.push({
      name: info.name,
      version: info.version,
      license: info.license,
    });
  }
  await put(
    "third-party/packages.json",
    JSON.stringify(notices, null, 2) + "\n",
  );
  const manifest = await json(join(source, "package.json"));
  const product = await json(join(workbench, "package.json"));
  const packed = {
    ...manifest,
    version: product.version,
    private: false,
    license: "Apache-2.0",
    exports: { ...manifest.exports, ".": "./local/app.mjs" },
    files: [
      "local",
      "server",
      "dist",
      "client.js",
      "locale",
      "icon.svg",
      "cordis.patch.yml",
      "NOTICE",
      "third-party",
    ],
    engines: { dsh: release, node: ">=24.9.0" },
    dependencies: { "pdfjs-dist": product.dependencies["pdfjs-dist"] },
    dsh: {
      ...manifest.dsh,
      compatibility: { dshReleases: { [release]: "unknown" } },
    },
  };
  await put("package.json", JSON.stringify(packed, null, 2) + "\n");
  await put(
    "cordis.patch.yml",
    '- insert:\n    - id: sand-table\n      name: "@sand-table/dsh-plugin"\n',
  );
  const { filename } = JSON.parse(
    execFileSync(
      npm,
      [
        "pack",
        packagePath,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        target,
      ],
      { encoding: "utf8" },
    ),
  )[0];
  const sourceTar = process.argv[3] && resolve(process.argv[3]);
  const drawing = execFileSync(
    process.execPath,
    [
      join(source, "drawing/prepare.mjs"),
      target,
      ...(sourceTar ? [sourceTar] : []),
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .at(-1);
  const required = await Promise.all(
    [drawing, join(target, filename)].map(async (file) => ({
      file: basename(file),
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    })),
  );
  await writeFile(
    join(target, "bundle.json"),
    JSON.stringify(
      {
        format: "sand-table-dsh-bundle",
        version: 1,
        dsh: release,
        profile: "web",
        required,
        optional: ["dsh-context@0.85.1"],
      },
      null,
      2,
    ) + "\n",
  );
  await cp(join(bundle, "install.mjs"), join(target, "install.mjs"));
  console.log(join(target, "bundle.json"));
} finally {
  await rm(root, { recursive: true, force: true });
}
