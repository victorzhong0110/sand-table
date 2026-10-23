# Sand Table 桌面版

Windows 上的 Sand Table：双击一个 exe 就能用，界面和功能与浏览器里那一版完全相同——
同一份前端、同一个本地工作台服务、同一份工作空间。

桌面版**不重写工作台**，它把应用自己的可执行文件当作 Node 运行时来跑
`workbench/local/main.ts`，再把本地工作台的页面装进一个原生窗口。

## 产物

| 文件 | 说明 |
|---|---|
| `SandTable-<版本>-x64-setup.exe` | 安装包：中文安装界面，可选安装目录，创建桌面与开始菜单快捷方式 |
| `SandTable-<版本>-portable.exe` | 单文件免安装版：双击即用，不写注册表 |

两个产物都没有代码签名，Windows SmartScreen 第一次会提示"未知发布者"。
点"更多信息 → 仍要运行"即可；想免掉提示需要自备代码签名证书。

## 安装后需要知道的三件事

1. **作品存在哪里**：`%USERPROFILE%\.sand-table\workspaces`，和 `npm start` 用的是同一个目录，
   两个版本看到的是同一批白板。
2. **AI 怎么接**：白板右上角"连接我的 AI"，复制通用 MCP JSON 装进你已有的 MCP 客户端。
   桌面版给出的是它自己的可执行文件作为 MCP 入口（带 `ELECTRON_RUN_AS_NODE=1`），
   因此**不需要另外装 Node.js**。MCP 客户端和桌面版必须同时在跑——桌面版是那个共享的工作台。
3. **外部工具**：导入代码仓库需要本机有 Git；Python 源码的符号索引需要本机有 Python 3
   （Windows 上 `python`、`py -3` 都能认，会自动找）。

## 从源码构建

```bash
# 1. 先把工作台构建出来（桌面版直接用它的产物）
cd workbench && npm ci && npm run build && cd ..

# 2. 整理打包资源并出 Windows 产物
cd desktop && npm ci && npm run dist
```

产物落在 `desktop/dist/`。`npm run dist:linux` 可以出 Linux 版（用于在本机验证同一份代码）。

### 交叉编译说明

在 Linux 上打 Windows 包需要 Wine（改 exe 图标与版本信息）：

```bash
apt-get install -y wine64 && ln -sf /usr/lib/wine/wine64 /usr/local/bin/wine
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

没有 Wine 也能出包，代价是 exe 用 Electron 默认图标：给 `build.win` 加
`"signAndEditExecutable": false` 即可。

## 目录

| 路径 | 作用 |
|---|---|
| `main/main.cjs` | Electron 主进程：起工作台、等它就绪、装窗口、管生命周期 |
| `scripts/prepare-assets.mjs` | 整理工作台源码与运行期依赖到 `.stage/workbench` |
| `scripts/smoke.mjs` | 用 Playwright 驱动真实应用做端到端检查 |
| `scripts/make-icon.py` | 生成应用图标 |
| `build/icon.*` | 图标（ICO 多尺寸 + PNG） |

## 为了桌面版改动的三处工作台代码

改动都很小，且保持默认行为不变（`npm start` 与既有测试不受影响）：

| 文件 | 改动 | 为什么 |
|---|---|---|
| `workbench/local/config.ts` | `connectionConfig` 可以接收一个 MCP 客户端条目 | 打包后 MCP 入口是应用自己的 exe，需要附带 `ELECTRON_RUN_AS_NODE=1` |
| `workbench/local/service.ts` | `startLocal` 可以指定子进程环境变量与 MCP 条目 | stdio 子进程只继承白名单环境变量，自定义变量必须显式传 |
| `workbench/local/main.ts` | 接受 `--runtime` / `SAND_RUNTIME`，把上面的设置传进去 | 让宿主决定怎么起工作台，而不是写死在工作台里 |
| `workbench/domains/code/python-indexer.ts` | 按 `python3` → `python` → `py -3` 顺序找解释器，可用 `SAND_PYTHON` 指定 | Windows 上通常没有 `python3` 这个名字 |

## 验证

```bash
cd desktop && npm run assets
xvfb-run -a node scripts/smoke.mjs   # Linux 上跑真实应用
```

冒烟检查会确认：窗口确实打开本地工作台、白板渲染出来、本地 API 可用、
MCP 配置指向桌面版自身。截图落在 `desktop/dist/smoke/`。


## 预览版验证边界

Windows 命令面向 PowerShell，全部配置格式带运行所需环境变量。便携版首次启动将 MCP 运行时复制到用户数据目录 mcp-runtime/<内容指纹>，增加约一份应用大小的占用；临时解压目录删除后已保存入口仍可用，旧版本副本保留。升级后可重新生成当前版本配置。

Windows CI 执行实际构建、安装与窗口检查。真人安装、保存重启及真实 Codex/Claude 客户端连接仍需记录；Linux交叉打包不代替Windows验收。
