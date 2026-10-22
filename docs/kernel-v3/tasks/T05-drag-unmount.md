# T05 拖动时卡片不被卸载重挂

| 项 | 内容 |
|---|---|
| 执行 | grok |
| 依赖 | 无 |
| issue | #29 |
| 分支 | `task/T05-drag-unmount` |
| 时间上限 | 1 个工作日。画布会在 Phase 3 换成 React Flow，这里只做最小修复 |

## 目标

拖动或调整尺寸期间，被拖动的卡片不会被 React 卸载再挂载（这是肉眼看到“闪”的已知原因之一）。

## 现状与线索

`workbench/board/SpaceCanvas.tsx`：

- 拖动时 `onPointerMove` 每帧 `setDraft({...})`，整个画布子树每帧重渲染。
- `const visible = filtered.filter(...)` 用 `displayRect(c, draft[c.id] || c.rect)` 判断是否在视口内。被拖动的卡片一旦被算到视口外，就从 `visible` 消失被卸载，拖回来再挂载。

工具箱也会闪，原因未定位（见 #29 原始记录：项目里没有 `backdrop-filter` / `will-change`，工具箱条目的 key 是稳定的）。

## 先读

- `AGENTS.md`
- `workbench/board/SpaceCanvas.tsx`（`draft`、`visible`、`onPointerMove`）
- `workbench/tests/blank.ts`

## 可改文件

- `workbench/board/SpaceCanvas.tsx`
- `workbench/board/style.css`（仅当工具箱闪烁的原因确认在样式上）
- `workbench/tests/blank.ts`

## 不要做

- 不重写画布、不引入新依赖、不改拖动的数据流（仍然拖动结束才写服务端）。
- 不凭猜测加 `will-change`、`translateZ(0)` 之类的样式；只有拿到证据才改。

## 做法

1. `visible` 过滤时，`draft` 里有的组件（正在拖动或调整尺寸的）一律保留，不参与视口裁剪。
2. 其余组件的可见性判断改用已提交的位置 `c.rect`，不用 `draft`。
3. 工具箱闪烁：用 Chrome DevTools 的 Performance 面板（开启 “Paint flashing” / “Layer borders”）录一次拖动，最多花半天。找到原因且修复只涉及上面可改文件时就修；找不到就把观察到的现象和录屏结论写进 PR 描述，留给 Phase 3。

## 验收

- `workbench/tests/blank.ts` 增加断言：拖动前给某张卡片的 DOM 节点设置 `dataset.probe = "1"`；把它拖到视口边缘以外再拖回来，松手后同一个节点上 `dataset.probe` 仍为 `"1"`（证明没有被卸载重挂），且服务端记录的位置等于松手位置。
- `npm run format:check`、`npm run typecheck`、`npm test`、`npm run test:blank` 全部通过。
- PR 描述写明工具箱闪烁的调查结论。
