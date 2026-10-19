// A portable MCPB bridge. Contains no model runtime, repository or session token.
import { build } from "esbuild";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const target = resolve(process.argv[2] || "artifacts/sand-table.mcpb");
const root = mkdtempSync(join(tmpdir(), "sand-mcpb-"));
const variable = (name: string) => "$" + "{" + name + "}";
try {
  mkdirSync(join(root, "server"));
  const bundled = await build({
    metafile: true,
    entryPoints: ["local/bridge.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: join(root, "server/bridge.mjs"),
    banner: {
      js: 'import {createRequire as sandCreateRequire} from "node:module"; const require=sandCreateRequire(import.meta.url); const __filename=import.meta.filename; const __dirname=import.meta.dirname;',
    },
    logLevel: "warning",
  });
  const packages = [
    ...new Set(
      Object.keys(bundled.metafile!.inputs).flatMap((file) => {
        const parts = file.split("/");
        if (parts[0] !== "node_modules") return [];
        return [
          parts[1].startsWith("@") ? parts[1] + "/" + parts[2] : parts[1],
        ];
      }),
    ),
  ];
  const notices: unknown[] = [];
  mkdirSync(join(root, "third-party"));
  for (const name of packages) {
    const packageRoot = resolve("node_modules", name);
    const info = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    const files = readdirSync(packageRoot).filter((file) =>
      /^(license|notice|copying)([.\\-]|$)/i.test(file),
    );
    const folder = join(root, "third-party", name.replaceAll("/", "-"));
    mkdirSync(folder);
    for (const file of files)
      copyFileSync(join(packageRoot, file), join(folder, file));
    notices.push({
      name: info.name,
      version: info.version,
      license: info.license,
      files,
    });
  }
  writeFileSync(
    join(root, "third-party", "packages.json"),
    JSON.stringify(notices, null, 2) + "\n",
  );
  const manifest = {
    manifest_version: "0.3",
    name: "sand-table",
    display_name: "Sand Table",
    version: "0.3.0",
    description:
      "Connect your AI to the same local Sand Table spatial workbench.",
    author: {
      name: "victorzhong0110",
      url: "https://github.com/victorzhong0110",
    },
    repository: {
      type: "git",
      url: "https://github.com/victorzhong0110/sand-table",
    },
    license: "Apache-2.0",
    server: {
      type: "node",
      entry_point: "server/bridge.mjs",
      mcp_config: {
        command: "node",
        args: [
          variable("__dirname") + "/server/bridge.mjs",
          "--session-file",
          variable("user_config.connection_file"),
        ],
      },
    },
    compatibility: {
      platforms: ["darwin", "linux", "win32"],
      runtimes: { node: ">=22.18" },
    },
    user_config: {
      connection_file: {
        type: "string",
        title: "Local connection file",
        description:
          "Copy the absolute --session-file path from Sand Table's generated MCP JSON. Start the workbench first; never paste the session token.",
        required: true,
      },
    },
  };
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  copyFileSync("../LICENSE", join(root, "LICENSE"));
  copyFileSync("../NOTICE", join(root, "NOTICE"));
  writeFileSync(
    join(root, "README.txt"),
    "Start the Sand Table workbench, copy the connection-file path from its generated MCP JSON, then configure this bundle in an MCPB-compatible client. This bundle only forwards to that local session. It does not launch an Agent or write source files. Actual client installation must be checked separately.\n",
  );
  mkdirSync(dirname(target), { recursive: true });
  execFileSync("python3", [
    "-c",
    "import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root)) for p in sorted(root.rglob('*')) if p.is_file()]; z.close()",
    root,
    target,
  ]);
  console.log(
    JSON.stringify({
      file: target,
      bytes: readFileSync(target).length,
      manifestVersion: manifest.manifest_version,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
