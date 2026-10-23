# T44 媒体：图片、音视频、文件与链接

| 项 | 内容 |
|---|---|
| 执行 | minimax |
| 依赖 | T72、T35、T26 |
| 分支 | `task/T44-media` |
| 关联 issue | #38 |

## 目标

图片、音频、视频、普通文件可以粘贴或拖进白板，成为可直接操作的组件：图片可查看、裁剪（不损坏原图）；音视频可播放但不自动播放；文件可打开或下载；链接可打开。附件随工作空间保存和导出。

## 先读

- `AGENTS.md`
- `docs/kernel-v3/05-delivery-contracts.md`（本阶段公共契约与交接规则）
- issue #38 第一阶段
- `docs/adr/0002-bundle-loading.md`
- `docs/kernel-v3/01-data-model.md` §2（`blobs/`）、`03-types-and-extensions.md` §3.2（`blob` 控件）、§8.1（`base.media`、`base.link`）
- `docs/kernel-v3/02-commands-and-tools.md` §3.4（`app_asset`）
- `workbench/board/widgets/blob.tsx`（T35）

## 开工前核对

确认 `app_asset upload` / `read` 可用，`base.media` 的字段有 `blob`、`mime`、`caption`、`alt`。依赖未完成则等待；机械差异按 05 §1 适配，语义冲突只暂停受影响部分。

## 可改文件

- 新建 `workbench/board/media/`（`ImageView.tsx`、`AudioView.tsx`、`VideoView.tsx`、`FileView.tsx`、`LinkView.tsx`、`crop.ts`、`drop.ts`）
- `workbench/board/views/registry.ts`（登记这些自定义视图）
- `workbench/packs/base/index.ts`（`base.media` 加 `crop` 字段并升版本，提供迁移；`display.view` 指向媒体视图）
- `workbench/board/style.css`
- 新建 `workbench/tests/media.test.ts`，修改 `workbench/tests/blank.ts`

## 不要做

- 不做专业图像编辑和视频剪辑。
- PDF 是 T45 的事；区域、时间点锚点是 T53 的事。

## 做法

1. **放入**（`drop.ts`）：画布上粘贴图片、拖入文件 → `app_asset upload` 拿到 sha256 → 一次 `app_edit` 建 `base.media` 对象和展示。单个文件超过上传上限时提示具体上限，不建对象。
2. **图片**：显示原图；双击打开查看器（缩放、平移、Escape 关闭）；裁剪框调整后把 `crop: { x, y, w, h }`（0–1 小数）存进对象数据，原图字节不变；“恢复原图”清除 `crop`。
3. **音频、视频**：原生播放控件；**不自动播放**；控件区域加 `nodrag nowheel nopan`，点播放不会拖动卡片；视频卡片封面用第一帧截图，不做动态封面。
4. **文件**：显示文件名、类型、大小；“打开”用宿主的打开或下载能力。
5. **链接**（`base.link`）：显示标题和域名；点击用宿主的打开链接能力，只允许 http(s)。
6. **封面**：任何声明 `cover` 能力的类型（如人物），可以从图片组件或本地文件设置封面（`appearance.coverBlob`），并沿用图片的裁剪。
7. **失效**：附件文件在磁盘上找不到时，组件显示“附件缺失”，数据和关系保留。

## 验收

- `workbench/tests/media.test.ts`：裁剪坐标计算；`base.media` 旧版本数据迁移后通过新 Schema。
- `workbench/tests/blank.ts`：
  1. 粘贴一张图片，出现图片组件，导出工作空间（T25）再导入后图片仍在。
  2. 裁剪后显示变化，`blob` 未变；恢复原图后 `crop` 消失。
  3. 视频组件不自动播放；点击播放按钮时卡片位置不变。
  4. 删除磁盘上的附件文件后，组件显示“附件缺失”且对象仍在。
- 构建后体积符合 ADR 0002 的预算。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。

## 交接与边界验收

补 base.media 的 filename/size 可选字段并无损迁移；上传返回元数据供文件显示。外部资源引用保留 source.external 并标明“外部引用”，不冒充已随作品保存；缺失不自动删除。coverBlob/crop 是展示外观而非对象语义引用，更新 Appearance 校验并测独立展示封面。
