# ADR 0005：绘图、原型预览与白板导出

日期：2026-11-19。任务：T54。状态：待评审。范围：技术验证，产品代码无改动。

## 决策

1. **白板上的基础图形使用原生对象。** 矩形、圆、线、箭头和文字沿用对象及展示、选择、撤销、命令事务。用内置 SVG 图元或受控图标渲染。
2. **复杂绘图由单独的 DSH 提供者持有。** 白板保留引用、版本和展示位置。优先移植或由上游发布兼容版 dsh-diagram，重用其 Excalidraw 编辑器和 scene 校验。固定版本 DSH 0.2.2-rc.1 拒绝加载 dsh-diagram 0.6.1。T81 可先验证提供者契约，真实插件联通还需要兼容制品和实测。
3. **交互原型首版可用静态预览，执行需要能独立终止的运行环境。** 同页 sandbox iframe 实测不能保证父 UI 及时停止脚本。运行环境也须从进程层限制网络，内嵌 CSP 继续保留。
4. **导出使用静态白板快照。** PNG 使用已验证可捕获内容或明确占位；PDF 使用同一静态表示打印；HTML 仅保留可安全重建的文本、图形、样式和解析过的附件。T56 视觉导出使用独立入口。T25 提供白板数据导出，T82 承担组合包内的原始可编辑资源和精确版本。

## 1. 白板图形与绘图资源

| 使用场景 | 原生图形对象 | 外部绘图资源 |
| --- | --- | --- |
| 选择 | 白板可单选、多选、框选、组合 | 白板只选择绘图的展示，元素选择在提供者内 |
| 撤销 | `app_edit` 的单事务和白板历史 | 编辑器维护自己的撤销，白板历史管理引用和位置 |
| AI 读写 | 白板既有工具与对象预期版本 | 用绘图提供者的摘要和修订，按提供者版本提交 |
| 更新与引用 | 同对象的多个展示保持独立布局 | 同一个引用可指向原文档新版，固定旧版本时明确判定可读性 |
| 导出 | 几何结构与文字可从静态快照重建 | 通过提供者获得指定版本的静态缩略图或原 scene |

原生图形用既有 frame 做分组。图形里的箭头和白板内的语义关系各有独立身份。需要表达依赖、因果或支持关系时，通过已有关系命令写入。

`base.shape` 数据 Schema 草案。位置、大小及父框均使用 Presentation；原始样式由对象持有。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["kind"],
  "properties": {
    "kind": { "enum": ["rectangle", "ellipse", "line", "arrow", "text", "icon"] },
    "label": { "type": "string", "maxLength": 280 },
    "icon": { "enum": ["document", "database", "person", "gear", "target", "warning"] },
    "stroke": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
    "fill": { "anyOf": [{ "const": "transparent" }, { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }] },
    "strokeWidth": { "type": "number", "minimum": 0, "maximum": 12 },
    "fontSize": { "type": "number", "minimum": 10, "maximum": 96 },
    "align": { "enum": ["left", "center", "right"] }
  }
}
```

### dsh-diagram 0.6.1

来源：[上游发布标签](https://github.com/hanzhangzzz/dsh-diagram/tree/v0.6.1)（`ea4279ef9a9b6a1751d1a06930ff4c140cd02f38`）、[包版本及完整性](../kernel-v3/07-plugin-reuse.md)、[浏览器探针证据](../../workbench/spikes/design/evidence/browser.json)、[宿主探针证据](../../workbench/spikes/design/evidence/provider.json)。npm 版本固定为 0.6.1，MIT，内置 Excalidraw 0.18.1。该 tarball 的 SHA-256 为 `def15df587c0abe04dd78f28b139db47d4f837911b36bd536ba9d51c8194d87a`。

- DSH 0.2.2-rc.1 的官方安装器明确拒绝，兼容约束声明止于 0.1.7-rc.2。DSH 0.1.7-rc.2 的临时 web profile 可安装同一包。脚本调用真实宿主的 `diagram_create` 和 `diagram_read`，保存修改后的 scene 后读回新版本和文字，使用旧版本保存触发冲突，第二个会话读不到原图。独立 CLI 进程重启后读回同一 scene 和版本。测试通过 Host API 写入编辑内容，编辑器交互和真实模型另行验收。保留新版宿主作为 Sand Table 基线。
- 包公开导出 `DiagramService`、`DiagramRepository` 和校验 Schema。宿主的 `list/get/save` 按会话生存期授权，`save` 检查 `expectedRevision`。`diagram_read` 提供有字符上限的当期场景摘要。手改的权威数据是 Excalidraw scene，初始生成描述是来源记录。
- 已发布接口按 ID 读取**当前**记录，旧版查询和原子场景复制没有公开入口。T81 有配套能力才展示可编辑副本或固定历史版本。引用以提供者、命名空间和不透明记录 ID 定位，版本及锚点独立；适配器逐次核对实际 revision，版本消失时返回 `version_unavailable`。会话分叉及会话导出未携带此 sidecar。
- 上游编辑器提供 .excalidraw、SVG、PNG 下载。下载动作与按指定版本导出能力分别验证。图片及 embeddable 不属于该版 scene 支持范围。T81 首版使用整个文档作为引用粒度。
- 兼容移植需要核对注册服务、技能、工具、会话元数据、storage domain、webServer 和客户端槽位的实际 ABI。固定 fork 或上游版本和完整性，继续用官方 profile 安装器验证。先复跑注册、创建、CAS、冷读，再跑 UI、停用重装、快照导出；缺少其中的能力时由资源接口给出原因。

## 2. 原型执行及参数

独立与嵌套两种测试均使用 `sandbox="allow-scripts"`。原型可处理局部按钮和输入，可从父页面接收参数；origin 为 `null`，读父页面 DOM 被拒。测试中的 sandbox 和 CSP 阻止 fetch、图片加载和表单发网。嵌套在现有白板 CSP 下，同框导航也被阻止。仅独立原型 iframe 时，同框导航触发一次回环 HTTP 请求。运行隔离要保留外层限制和验证脚本网络路径。

探针将子页面锁在忙循环 1100 ms，原定约 100 ms 的父页面停止动作约 1103 ms 执行。真正的无限循环开始后，父页面在 500 ms 观察窗口内无法移除子框。测试工具能关闭整个独立浏览器。生产执行选择可限制 CPU、内存与网络，且宿主可从进程外杀掉的运行环境；在落实前，产品交付静态预览。编辑/拖动画布时，静态预览接收画布指针事件；进入运行模式才将键盘和指针交给原型，并由宿主控制退出。

`base.prototype` 数据 Schema 草案沿用 [正式交付契约 §6](../kernel-v3/05-delivery-contracts.md#6-沙箱构建与导出t41t54t55t56t67t72)。附件读取复用白板资源授权。白板保存 `html` 或 `htmlBlob` 之一，`htmlBlob` 是附件 SHA-256。对象数据沿用 1 MB 上限。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["paramsSchema", "params"],
  "oneOf": [{ "required": ["html"] }, { "required": ["htmlBlob"] }],
  "properties": {
    "html": { "type": "string", "minLength": 1 },
    "htmlBlob": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "paramsSchema": { "type": "object" },
    "params": { "type": "object" }
  }
}
```

`paramsSchema` 必须是无代码 JSON Schema 子集。首版参数根节点为封闭对象，声明 `properties` 和可选的 `required`，字段支持字符串、数字、整数、布尔值、枚举及对应的范围和长度约束。未声明属性、外部引用与可执行扩展拒绝。宿主用该声明校验 `params` 并选择 T35 控件，编辑按对象期望版本提交。没有参数的原型也提交空的封闭 Schema 和空值对象。

每次启动生成新的 `viewSessionId`。每条消息带 `protocolVersion: 1`、`viewSessionId`、`requestId` 与 `type`。宿主先校验消息来源或专用进程端口、协议版本、会话、消息白名单及大小，再匹配请求。重复回执和已关闭会话的迟到消息直接丢弃。

| 发起方 | 消息 | 数据及用途 |
| --- | --- | --- |
| 宿主 | `prototype.init` | 传入初始参数及对象版本，进入等待就绪状态 |
| 原型 | `prototype.ready` | 回显 init 的 requestId，宿主进入可交互状态 |
| 宿主 | `prototype.params` | 就绪后发送已校验的新参数及版本，使用新的 requestId |
| 原型 | `prototype.status` | 回显待处理请求的 requestId，返回有限的完成状态或错误 |
| 宿主 | 停止 | 关闭连接并在可独立终止的宿主上终止进程，清空待处理请求 |

初始化 5 秒内未收到匹配的 ready 时提示「原型未响应」，释放本次连接并回到静态预览。计时依赖宿主事件循环可运行，进程失去响应时由独立运行器强制终止。

原型接口只接收已授权的参数。创建对象、执行任务和访问白板正文仍由现有宿主能力控制。

## 3. 图像、PDF 与静态 HTML

| 格式 | 实测 | T56 接法 |
| --- | --- | --- |
| PNG | html-to-image 导出的隔离子框采样为白色；Chromium 合成器截图同一位置为原型红色 | 常规对象用 DOM 浅克隆或静态投影。隔离内容用已固定版本的缩略图或带原因的占位。宿主能控制合成截图时单独提供截图能力 |
| PDF | Chromium 打印产生有效 PDF，`pdftotext` 读取了白板及该夹具 iframe 的文字 | 用可打印静态快照固定分页和内容。记录暂缺画面的视频或原型，覆盖 PDF、文本及分页边界 |
| 静态 HTML | 含标签样式字符的标题作为文本显示，导出页无 script 与 iframe | 通过有界类型转换生成 HTML。附件按来源及权限读取后内嵌或随导出提供。图形和预览可使用受控 SVG/PNG |

探针只验证示例文档与本地 Chromium。其他 MCP 客户端、浏览器的打印和异源字体、视频帧捕获组合需要各自验证。

## 4. 依赖与体积

gzip 使用 Node zlib 默认级别。Chrome Headless Shell 153.0.8010.0 与 pdftotext 只运行探针。

| 依赖与许可证 | 原始字节 | gzip 字节 | 加载方式 |
| --- | ---: | ---: | --- |
| html-to-image 1.11.13，MIT，独立 `toPng` IIFE | 13,308 | 5,369 | 低于 T41 的主包新增预算，仍可延后加载到导出入口 |
| dsh-diagram 0.6.1，MIT，发布包编辑器 JS/CSS 合计 | 8,138,112 | 2,678,904（逐文件相加） | 在提供者内按需打开编辑器。整个编辑器目录 21,327,629 字节，含本地字体 |
| 上一行最大单块，`subset-shared.chunk-DW8LK4hF.js` | 1,823,616 | 736,913 | 超出 T41 单块 1,600,000 / 450,000 上限 |
| 原生 SVG、静态 HTML、宿主浏览器打印 | 0 新库字节 | 0 | 依赖现有平台能力 |

已锁定依赖不进入 Workbench 主包。T55/T56/T81 遵循 [ADR 0002](0002-bundle-loading.md) 的 CSP 与体积预算。

## 复现

从仓库根目录运行。准备 Chromium、pdftotext 和 Node ≥24.9。DSH 两个 CLI 参数均指向各自 npm 安装目录的 `@deepseek-ai/dsh/lib/bin.js`；两处 `.bin` 均提供 `pnpm@10.32.1`。当前宿主可按 T77 的锁文件安装，旧宿主单独安装 `@deepseek-ai/dsh@0.1.7-rc.2`。

```sh
npm ci --prefix workbench --ignore-scripts
npm ci --prefix workbench/spikes/design --ignore-scripts
CHROMIUM_PATH=/path/to/chromium node workbench/spikes/design/browser.mjs
node workbench/spikes/design/provider.mjs /path/to/old/lib/bin.js /path/to/current/lib/bin.js
```

宿主探针只使用临时 profile、会话和存储目录，不发起模型调用。其重启验证直接检查实际宿主与插件的持久化读取。浏览器探针仅访问回环 HTTP，最后用一次性浏览器进程测试终止限制。
