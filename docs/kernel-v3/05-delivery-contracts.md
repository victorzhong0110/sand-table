# 内核 v3：后续交付契约

本文件与 00–04 同为正式设计，负责跨任务卡接口。任务卡不得以 ADR 或历史 issue 覆盖这些边界。实现本文件各节的责任卡标在节内；未完成的实现不得宣称已可用。

## 1. 执行、文件与验收

- 从最新 main 创建分支；依赖必须已合并。先读 AGENTS、本文件、任务卡及其列出的代码。历史 issue 提供产品动机，不覆盖正式契约。
- 可自主处理路径移动、导出名调整、类型推断、私有函数拆分；在 PR 写明对应位置。不因这些机械差异暂停。真正改变存储权威、工具权限、用户语义时才请求架构修订。
- 每卡公共可改范围：本卡直接调用点/挂载点、对应 server 工具适配、kernel 导出与共享类型、注册表元 Schema、相应测试与自生成 fixtures、package.json 的测试脚本、构建入口、CI 对应测试步骤；仅限接通本卡功能，不授权无关重构或新能力。新增类型/关系/工具必须同步 01–03 的对应契约及此文件，不能只改代码。
- 必要的小范围联动写进该卡「可改文件」，指向已经存在的唯一来源，不要让执行者为了守清单复制一份。执行者发现漏写时停下来，在 PR 写「需要架构确认：需要改某文件，否则会复制已有来源」，不要先复制再解释。默认 MCP 桥接命令只在 `workbench/local/config.ts` 的 `defaultMcpEntry`。#76 的 T20 没列出这个文件，`local/service.ts` 的 `bridgeEntry` 复制了默认命令和参数；给默认条目补 `SAND_KERNEL` 时改 `config.ts`，`bridgeEntry` 只决定何时使用这份条目并补环境变量。
- T24 固定搬迁：server/v3 → server，board/v3 → board/data-client；core/host-bridge.ts 保留。后续卡按新路径。若已由别卡搬迁，用实际路径且记录映射，不复制第二份实现。
- 每卡交付 PR 必须给出：实现的公开接口/导出位置、Schema/迁移、依赖提交、验收逐条结果和未完成项。产品代码不得含“以后某卡才接入”的可点击虚假入口。阶段性的占位不计最终验收通过。
- 每个代码 PR 运行 format:check、typecheck、npm test、卡片浏览器测试和 build；缺测试脚本时本卡创建并接入 CI，不把不存在的命令写成通过。技术验证卡可在独立目录带固定版本依赖和 lockfile，并提供可重复命令。
- 技术验证只选择库和适配方式，不重新决定产品语义。ADR 必须包含精确版本/许可证、复现命令、数据、接口及失败回退。若候选都不满足，记录阻塞；不能将不支持能力悄悄删掉。需要人用真实设备的检查明确分离，夹具不替代真机。
- 并行卡可开发，但修改同一文件的 PR 顺序合并，后一个 rebase 后重跑检查；任务索引的依赖是开工下限，不代表共享文件无冲突。
- 新增持久字段必须有 Schema、上限、未设置语义、旧数据处理。一般文字 20,000 字、短标题 300 字、数组 200 项、对象序列化 1 MB；已有更小限制保留。版本迁移无损、纯函数、可重放，未知旧字段保留只读。类型版本不能与对象编辑版本混用。
- 一次交互最多 200 条命令；超过时在提交前拒绝并提示缩小选择，不能悄悄分批破坏原子撤销。批量导入是 §3 的专用新库路径。

## 2. 文字链接、关系与局部定位（T43、T51、T53、T60）

正文链接 `[标题](sand://object/<encodeURIComponent(id)>)` 是文字导航，Markdown 为唯一权威；不创建 base.mentions。UI、MCP、迁移、撤销只维护正文，不需要额外同步。链接仅在当前工作空间解析，禁止作为网络 URL 打开；对完整对象 id 编码一次、解析时解码一次，拒绝非法编码并保留未知目标原文。代码块/行内代码不转为链接。语义参与、支持等仍必须由关系槽显式建立。

id `人物/林#a%b` 必须写成 `[标题](sand://object/%E4%BA%BA%E7%89%A9%2F%E6%9E%97%23a%25b)`。`/`、`#`、`%`、中文都在这一次编码里。解码一次得到原 id，不能再解码。`%ZZ`、末尾单独的 `%` 这类非法编码保留原文，不转成链接。不要写成未编码的 `sand://object/<id>`。

base.about 保持便签/讲解用途；base.note.about 为单值，不将其扩成任意对象的通用关系。T60 新内容的多方默认关联用 base.related；context → participants 用 base.involves。默认关联明确显示且允许删除；推测关系在结果里标明，不当作已确认事实。

T51 注册 base.comment（body Markdown、resolved 可选布尔，未设按未解决显示）、base.comments_on（comment → 任意对象）、base.reply_to（comment → comment）。根评论只有一条 comments_on，回复只有一条 reply_to，不同时有两种。内核校验数量、无回复环，回复继承根范围。comments_on.attributes 为 `{scope?: "object"|"presentation", presentationId?: string, anchor?: { fragment: string, version?: string, fingerprint?: string }}`；省略 scope 按 object；presentation scope 必须引用目标对象的展示。presentationId 是关系上的定位元数据，不能作为独立语义关系或写入对象 data。anchor 只描述对象内部位置，不写 uri，不写对象 id。T51 负责实现校验；T53 扩展 anchor 的 fragment 格式校验。删除展示保留局部批注，标“原展示已移除”；复制展示不复制局部批注；删除目标仍按 01 §8 软删除关联关系；评论及回复对象保留。详情可通过带删除标记的关系墓碑显示失效记录，不能把墓碑当有效绑定；撤销可恢复。

T45 注册 base.cites（引用对象 → 来源对象）。来源对象只由关系端点表示。内部锚点是 `attributes.anchor = { fragment, version?, fingerprint? }`，fragment 按 `03` §10；不包含 uri，不包含对象 id，不是 ExternalLocator，也不新增 kind `object`。外部资源仍用 ExternalLocator。T53 新建文字引用使用 base.note + base.cites，不重写来源。音视频换 blob、时段越界即失效；重复原文不能唯一定位则失效，不猜测。fragment 值里的百分号、分号、等号按 `03` §10 编码。

## 3. 写入口、导入和迁移（T25、T26、T62）

在线作品内容（objects/presentations/relations/settings/packs）只走命令事务；系统命令共享校验、revision、审计。撤销/重做是内核历史事务。views、activities、agent_reads、runs 属运行状态，由各自内核接口写，不进作品撤销；不以运行记录修改作品。meta、blobs 元数据及 schema 迁移只在内核生命周期/附件接口写。kernel 外禁止 SQL 写入。T25/T62 更新架构测试的具体允许文件和表，禁止放开整个目录。

T25 只可在未发布的新临时库中直接恢复内容行。只导出存活内容、所有被引用附件及隔离清单；不导出会话/运行记录/历史/审计。同一只读事务快照导出所有行，附件按 sha256 核实，避免多进程导出混合版本。保留对象 id/type_version/version/时间与来源；重建工作空间 revision 和所有行 rev 为同一个新基线，清空历史游标，不复制原 deleted_rev。内置包以本机注册表为准并恢复 enabled；未知类型数据无损保留。

导入先预检格式、大小、重复 ID、首页 container、展示/关系端点、父框同板与无环、数据包清单、附件字节/sha256/大小。结构损坏、缺附件或端点、IO 失败整份失败，删除临时目录，不留下部分工作空间，也不把这些失败记成「跳过」。仅未知类型与无效包允许降级，无效 manifest 存工作空间 `import-report.json` 并随再次导出携带。成功时的报告列出导入数量、降级条目及原因、未随包带走的外部资源。禁止从导入内容加载执行代码；T67 的视图另需本地信任。限制原始 JSON 300 MiB、解码附件合计 200 MiB；拒绝路径穿越，工作空间目录名由安全 id 生成。关闭 DB/WAL 后以不覆盖已有目录的发布方式落地，目标冲突重新分配后缀。任何失败删除临时目录，既有库不变。

T26 读迁移不写库，写迁移与字段修改在同一事务；只改标题且迁移失败时允许保留旧 data/type_version。返回 migrationError 和 typeVersion 的接口包括 read/query/board/changes；变更工具输出契约一并更新。每步验证返回普通对象和大小上限，最终通过当前 Schema（旧版本 Schema 不要求保留）；不可将未来类型版本降级。历史快照保存真实落盘 before/after，撤销恢复旧类型版本，不把读取投影当历史原值。

## 4. 受控绑定与公共视图服务（T34、T40、T49）

T34 的 ViewProps.dispatch 只允许更新自身对象；创建评论、引用、图表、关系等由外壳明确的用户动作服务执行，不能放宽沙箱 dispatch。T34 提供 actions（宿主注入）：focusObject、openObjectPicker、createLinkedComponent；实现复用 app_edit，校验类型、范围和 expectedVersion。沙箱不获得这些跨对象动作。

T40 的 readBindings/readVersion 必须带读取者 objectId 与槽 slot，服务端按实际绑定校验，不能仅让 UI 检查。readVersion 参数 `{objectId,slot,targetId,version}`，禁止裸 id 任意读；当前对象自读可显式用 self。历史搜索 before 和 after，限定对象 id/version；多个快照不一致时报歧义，找不到报不可用，绝不回退当前值假装旧版本。返回版本、来源、unavailable 和 revision。删除目标仍级联软删除关系；仅当来源存活且目标已删除时，可读取该槽的关系墓碑用于“来源已删除”；用户单独删绑定关系不能因此恢复授权，不授予其他对象访问权；物理裁剪后明确不可用。

readBindings 字段必须属于被绑定目标的声明或当前可读数据，不回传宿主会话/凭据。取消订阅、卸载、包停用和工作空间切换均释放状态；并发响应按 workspaceId+请求代号+revision 拒绝过期结果。

T49 的 expandBindings 是独立有界能力：只允许内置关系图类型，从 focus 槽出发 BFS，深度 1–3、最多 200 节点/1000 边、按 id 稳定排序、visited 防环，返回 truncated。普通组件和第三方不能借此任意遍历。server app_bindings 增加 expand，ViewProps 的图专用服务包装它。

## 5. 数据组件与过程视图（T47、T48、T50、T73）

T47 行列 key 在创建时生成、迁移使用确定性 c1/r1；改名/排序不变，复制独立表格可保留内部 key。列类型迁移只对全部非空值可无损转换的列转换，空值不计入数字推断。手动改列类型先预览，失败值保留且标错，不清零。旧图表 points 保留为 legacyPoints，切换绑定前提示；无数字列时不自动猜 y。

T48 统一 deriveTable 纯函数供表格/图表/指标调用。配置顺序：计算列→所有明确连接的筛选器 AND→本表筛选→稳定排序→分组/聚合；原始 rows 不变。计算列引用存列 key，编辑器显示标签；重名标签必须选择 key，列删除显示错误。算式支持有限数字/四则/比较/括号和 SUM/AVG/MIN/MAX/COUNT/ROUND/IF；IF 惰性求值，COUNT 计非空，聚合忽略 null，其他数值计算遇 null 返回缺值错误。最多 2000 token、嵌套 32、列依赖无环；不执行任意 JS。

筛选配置 `{column,op,value?,upper?}`，op=eq/contains/gt/lt/between/empty/not_empty；空值仅匹配 empty；非法类型显示错误。排序 null 最后、相等保持原顺序。base.filter 数据 `{kind:"select"|"range"|"text",column,op,value?,upper?}`，targets 槽用 base.filters。base.highlights / base.filters 的图间联动只适用于同一源表，以 row key 匹配；不同源表拒绝并说明，不按行号猜。配置持久化、悬停临时；过滤联动由用户显式启用，清除不改源数据。

T48 补齐 base.metric v2：槽 source(base.data_source → table)，data 为 `{column?,aggregate:"count"|"sum"|"avg"|"min"|"max",unit?,legacy?}`；旧手填值移入 legacy 保持显示，未绑定时显示手填值。与图表用同一 deriveTable 和聚合，清楚显示筛选、列、单位及来源版本。图表单独导出复用 T56；T56 将导出入口同时挂在图表右键。

T50 时间轴 dimension 明确标 kind=number/date，date 只解析 ISO 日期按 UTC 日；混合或非法值列入未排序；end<start 标错误，不偷偷交换。过程范围筛选与观察者/分支由 T73 接入，只改视图查询，不回滚作品。

## 6. 沙箱、构建与导出（T41、T54、T55、T56、T67、T72）

T41 选方案，T72 实现构建/资源加载/worker/CSP 并在所有后续重依赖前完成。能力未证实的宿主记录未测，不推断支持；无法按需加载时选择经测量的全内联回退并给出预算与限制。

iframe sandbox=allow-scripts 隔离权限，不承诺 CPU 隔离；同进程死循环可能冻结宿主，父页面 setTimeout 不能证明可恢复。T54 必须测宿主是否具备独立进程隔离与终止能力。未证实时仅用户显式启动受信任作品，第三方代码视图保持禁用，静态/通用视图仍可用；T67 验收不得伪造“所有恶意代码都不卡白板”。

消息校验 source、协议版本、白名单、大小、requestId 和视图会话代号；固定 init→ready 握手及 5 秒无响应提示（只对父事件循环可运行时有效）。CSP 禁网络/表单/弹窗/导航权限，宿主只接受自身对象 update。第三方信任按包 id+version+代码 sha256 存本地权限状态，升级/导入另一工作空间需重新确认，不跟随作品导出；包停用立即卸载。

T55 图形的吸附锚点放 presentation.appearance 的 `anchors`（source/target 各含 presentationId、边和 0–1 偏移），是布局引用，非对象 data/事实关系。目标移除则冻结最后坐标并提示；仅同板有效。T55 同步 Appearance Schema 与内核校验。原型 data 为 html 或 htmlBlob 二选一、paramsSchema、params；Schema 是无代码 JSON Schema 子集，大小沿用 1 MB 限制；纯展示不取得任何宿主工具。

T56 静态 HTML 从白名单数据构造并转义，不直接复制运行 DOM。禁止脚本、事件属性、javascript URL、iframe、外链执行资源和会话内容；图片内联，原型/视频无可用截图时明确占位，不能谎称截图成功。PDF 可通过浏览器打印对话框完成，验收实际页尺寸/内容；PNG 验收像素尺寸和可见内容，不仅非空。含评论时遵循当前展示 scope。

## 7. 宿主执行与运行可靠性（T62–T66、T68）

宿主接口以 core/host-bridge.ts、真实能力协商及 T66 记录为准。若 DSH 不支持任务提交，T66 标阻塞及版本，T64 仍可完成普通 MCP 读写和隐藏运行入口，但执行功能不得标完成。不要自建 Agent 循环。

运行由 server 服务层发起和接收事件，浏览器仅通过 app_runs 请求/订阅，禁止 UI 直接 import kernel/runs。T62 提供 list/get，T64 增加 start/cancel/retry；MCP 模型不能伪造宿主状态。host adapter 传 requestId、runId、ruleId、inputVersions、params、outputBoardId；事件带 runId、taskId、单调序号和实际状态；校验所属工作空间/任务，重复事件幂等，迟到事件不复活终态。T64 负责服务侧适配及重启后的断线核对，T66 记录实际可用能力。

rules data 增加可选 condition（参数/输入字段的有限 eq/gt/lt/exists 比较）、steps（最多 20 条说明，仅交给宿主，不自建步骤执行器）、timeoutMs（1000–3600000，运行缺省 600000）。规则可复制为独立对象或应用模板；输入/输出用关系槽，禁止在 data 存对象 id。模板保留内部连线并要求重新确认外部输入。每次运行快照固定输入版本、条件和参数，空或失败条件只记录“未触发”的可解释原因，不发任务。

runs 增加 request_id UNIQUE、root_run_id、chain_depth、last_event_seq、cancel_requested、lease_owner/lease_until；版本化 schema。输入/规则删除不级联删运行记录；物理裁剪规则墓碑前保留运行关联可读信息。终态不可回退；waiting 可到 running/done/failed/cancelled。活跃记录不裁剪。运行状态通过 app_runs 每秒刷新，不靠作品 revision 轮询发现。

自动执行以规则 id+输入 id/版本（排序）+规范化参数生成幂等键；同一活跃键只一条。不同手动点击不同 requestId，可排队；同一次请求重试相同 requestId 不重复。服务层 SQLite 事务领取 lease 保证多窗口/多进程同规则只有一个执行者；网络提交不持 DB 锁，崩溃后先查宿主 taskId/requestId，不盲目重发。无法确认的运行留 waiting 并显示状态未知，用户明确选择后再重试。

T65 完成前禁用自动执行。自动链携带 rootRunId/depth，最多三层；第四层留待手动，禁止自动 dequeue；检测所有已启用规则的环而非仅两节点。自动触发与手动排队分开。取消请求不等于已取消：有宿主确认才标 cancelled，未确认保留状态及 cancel_requested。超时可标 failed 并发取消，但说明外部任务可能仍在执行；迟到产出仍可追溯，不复活终态。

产出默认新增对象，不原位覆盖输入。真正更新现有对象必须带提交时 expectedVersion，冲突则保留为新建议；不得去掉版本条件强写。运行结果写回经 sand_edit，使用 run:<id> 的 intentId；不保证非连续跨批写入合成一步，PR 必须按实际历史规则验收。撤销作品不撤销外部任务。

T68 修改原型也先产生新候选对象，与原对象比较；接受时以提交前原对象 expectedVersion 写回，冲突要求重新比较；拒绝只移除候选展示，保留任务/审计。不用“撤销最近一步”拒绝，避免撤销人的其他编辑。

## 8. 时间、分支与观察者的最小可交付模型（T61、T70、T71、T73）

T61 验证下面已定模型与有界查询，不再把实现卡留待未来编写。无需推导人物心理或自动合并剧情。

- base.branch：container，data.description；单值 parent 槽（base.branch_parent → branch），无环，最多 16 层；无 branch 绑定表示主线。分支是语义层，不复制整个工作空间。
- base.state_record：data `{field:string,value:JSON,dimension:"story"|"narrative"|"date",start:number|string,end?:number|string,certainty:"confirmed"|"inferred",basis?:string}`；subject 槽（base.state_subject，单值任意对象）、branch 槽（base.in_branch，单值 branch）、observer 槽（base.observed_by，单值任意对象）、anchors 槽（base.state_anchor，多值事件/章节等对象）。field 是主体的字段 key，不是对象 id；value 仅值，不另藏引用；关系变化用下项独立记录。
- base.relation_state：data 与 state_record 相同但用 relationKind 代替 field/value，并加 active:boolean；subject/target 槽（base.state_subject/base.state_target）分别指向参与对象；同样支持 branch/observer/anchors。不改全局 relations 表来表示只在某时有效的关系。
- 推测必须有 basis；confirmed 是用户当前记录的断言，不是系统证实。Observer 记录表示该观察者的认知，绝不写回主线事实。章节锚点不自动转换时间，start/end 由人明确指定；范围为闭区间，省略 end 表示向后持续，end<start 拒绝。
- stateAt({subjectId,dimension,at,branchId?,observerId?,limit?,cursor?}) 返回候选记录及其来源链，limit 默认 50 最大 200。只读，不补造记录。先选择时间包含 at 的记录，再按 branch 从当前到祖先再主线、observer 精确匹配过滤；未指定 observer 只返回没有 observer 的事实层，指定 observer 只返回其认知层，不隐式混入客观事实。同一字段在最近有记录的分支层覆盖祖先；同层重叠冲突全部返回并标 conflict，不能按最后编辑时间选赢家。relationAt 同理按 subject+target+relationKind 分组。certainty 原样返回，不能推测升级为 confirmed。
- base.suggestion：body、status(pending/accepted/rejected)，用 base.suggests_about 引用冲突对象/记录。Agent 只新增 pending 建议，不自动修改 confirmed 记录。人接受打开预填编辑表单，提交 expectedVersion 批次与建议状态更新；拒绝只改建议状态。失败整批回滚。
- 查询由 kernel 的类型无关关系/字段过滤机制实现，base 包提供词表与规则；kernel 不 import packs，不硬编码 novel。T70 提供服务 app_state_query（UI），模型通过 sand_query 的 stateAt/relationAt 可选过滤访问，不新增核心模型工具。T70 同步文档和参数互斥校验。查询排除删除行、停用类型只读标不可用，返回截断和稳定游标，不宣称全量。
- 分支复制只创建新的分支对象和 parent 关系；祖先内容通过查询继承。局部新记录覆盖同一字段的祖先记录，删除局部记录恢复继承；不会复制/改写主线。

## 9. 已合并卡的补齐规则

本修订不把已合并的 T17/T20 等重新标为未完成。T74 对当前 main 做差距审计并实施 05 对早期接口新增的要求，T24 等 T74。T17 的相对坐标、T20 的元数据/活动读接口及已有实现以测试证据核对，已满足的直接记录通过，缺的在 T74 补齐。
