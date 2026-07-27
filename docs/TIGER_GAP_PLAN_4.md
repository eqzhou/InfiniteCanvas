# Tiger 差异复审与补齐计划（第四轮）

> 审查日期：2026-07-27
>
> 本地基准：`main@b75e0b6`
>
> 对照基准：`tigerowo/infinite-canvas main@64cb00a6da99a50017abcb2e443166a13364c6c1`（最新 tag `v0.4.4`）。本轮开始前用 `git ls-remote` 核对，上游 HEAD 与 tag 列表均未变化，第二轮的文档快照继续有效。
>
> 输入来源：仅使用 `/tmp/tiger-*.md`（公开 README、CHANGELOG、`docs/overview/features.md`、`docs/canvas/*.md`、`docs/backend/*.md` 的快照）。未使用上游源码、资产或视觉表达。

## 1. 本轮的起点是一次方法错误

第三轮结尾我写下「盲区已清空」。这个结论是错的，而且错在方法上：我用**自己挑的关键词**去统计覆盖度，挑出来的词当然都命中，这是循环论证。

改用**上游 README 自己声明的 8 份文档清单**逐份对账后，立刻发现三份文档在前三轮里从未被引用过一次：

| 上游文档 | 前三轮引用次数 |
|---|---|
| `docs/overview/features.md` | 27 |
| `docs/overview/docker.md` | 5 |
| `docs/canvas/canvas-shortcuts.md` | 3 |
| `docs/backend/system-settings.md` | 4（仅覆盖 availableModels 一条线） |
| **`docs/canvas/canvas-node-manual.md`** | **0** |
| **`docs/backend/backend-database.md`** | **0** |
| **`docs/backend/api-response.md`** | **0** |
| `docs/progress/todo.md` | 0（内容为空，无需审） |

把粒度再降一级、按**章节和条目**统计后，盲区还要大得多：

- `features.md` 共 14 节 147 条，前三轮逐条走过的只有 7 节，`AI 生成`(18)、`图片工作流`(15)、`导演台`(12)、`账号和后台`(11)、`后端能力`(6)、`全景图`(5) 合计 67 条从未逐条对照。
- `CHANGELOG` 共 36 个版本组 105 条，被点名引用过的只有 4 组，`v0.0.1`–`v0.3.13` 共 30 组 76 条从未比对。

**教训**：覆盖度必须用**上游自己的目录结构**来度量，不能用自选关键词。度量单位要下沉到章节与条目，「文档份数」这个粒度太粗，足以掩盖整节的空白。

## 2. 差异总表

| ID | 差异 | 上游出处 | 状态 | 证据与说明 |
|---|---|---|---|---|
| T4-01 | 删除画布后，持有旧文档的标签页一次自动保存就能把它整个复活 | backend-database `canvas_projects`：软删除 + 延迟 7 天物理清理 | ✅ 已修复 | 见 §3 |
| T4-02 | 生成记录「删除」后成果 JSON 仍留在库里，且墓碑永不清理 | backend-database `*_generation_logs`：删除时清空 `payload_json`，墓碑保留 7 天 | ✅ 已修复 | 见 §3 |
| T4-03 | 共享渠道无 per-channel 模型列表，按模型路由会选中不提供该模型的渠道 | system-settings `private.channels[].models` | ✅ 已修复 | `adminChannelPublic.Models` + `cleanAdminChannelModels`/`channelModelsAllow`；`sharedChannelSupports` 在 protocol 判断前按 allow list 过滤。管理后台「可用模型」textarea + 拉取模型写入列表；保存后 `putAdminChannels` 序列化。测试：`TestSharedChannelRoutingHonorsPerChannelModelList`、`cleanAdminChannelModels` |
| T4-04 | 节点下方对话框没有模型下拉 | canvas-node-manual「用下方对话框生成或修改文本」 | ⏳ 待实现 | 拉取到的模型列表存在 `SettingsModal` 组件内 `useState`（`SettingsModal.tsx:60`），从未持久化或进 store，画布侧拿不到；`NodePromptBar` 无任何模型 UI，模型只靠 `node.metadata.model \|\| provider.model` 兜底 |
| T4-05 | 对话框内 `@` 唤起的是媒体引用而非提示词库 | canvas-node-manual：对话框输入「可手写，也可从提示词库选择」 | ⏳ 待实现 | 提示词库下拉只在文本节点正文（`BoardNodeView.tsx:228`），且选中会覆写 `metadata.content` 而非填入对话框 |
| T4-06 | 普通图片连到导演台会被当成球形全景渲染 | features 全景图：「普通图片仍按普通背景显示」 | ⏳ 待实现 | `isUsablePanoramaEnvironment` 的严格 2:1 校验对 image 节点不生效（`director-panorama.ts:34` 直接 `return true`）；`DirectorViewport.tsx:628` 无条件贴到 `BackSide` 球体，无按类型分流的分支；`panoramaProjection` 只有写入方无读取方。后果：16:9 照片被拉伸成 360° 天空盒 |
| T4-07 | 「上传素材」路径不提供 2:1 导入方式选择 | features 全景图：「上传素材」或拖入画布均可选择导入方式 | ⏳ 待实现 | 拖拽/工具栏/右键三个入口都走 `attachUploadedImage` 的 auto 探测；但素材面板「上传图片」绕过它（`CanvasAssetsPanel.tsx:35`），`insertAsset` 的 kind 恒为 image。`resolveLocalTwoToOneImageImportChoice` 排除测试后引用数为 **0** |
| T4-08 | 导演台同时只能连接一张全景/图片 | features 导演台：图片节点连上后成为「**可选择的**全景图」 | ⏳ 待实现 | `listDirectorEnvironmentOptions` 按多候选写、UI 按数组渲染，但 `bindDirectorPanorama` 在加新边前会过滤掉该导演台**所有** image/panorama 入边（`director-panorama.ts:83`），候选列表长度恒为 0 或 1 |
| T4-09 | 摄像机属性面板缺少「生成当前机位截图」入口 | features 导演台：「可在**摄像机属性或截图列表**生成当前机位截图」 | ⏳ 待实现 | 两个并列入口本地只有截图托盘一个（`DirectorCaptureTray.tsx:65`）；Inspector 活动机位区块（`DirectorDialog.tsx:593`–611）无拍摄按钮 |
| T4-10 | `/api/v1/media/references` 前端从未调用 | features AI 生成：本地上传素材先存服务端再由 `PUBLIC_BASE_URL` 生成公开链接 | ⏳ 待实现 | 服务端完整可用，但 `web/` 全仓对 `media/references` 引用数为 0；前端 `resolveMediaRefs` 只产出 data:/blob: URL。后果：本地直连做 Seedance 视频时参考素材被塞成 data: URL 发给火山，火山无法拉取 |
| T4-11 | 本地直连日志上报无上报通道与管理员开关 | features AI 生成：管理员可配置本地直连日志上报 | ⏳ 待实现 | `recordAICallLog` 两个非测试调用方都在服务端执行器；前端 `ai-call-logs.ts` 只有读/删接口，无 POST 上报。查过 11 个命名变体均零命中 |
| T4-12 | 图片比例无独立配置项 | features AI 生成可配置项：「图片比例」与「图片质量」并列 | 🔶 待决策 | 本地只有自由文本 `imageSize`（默认 `1024x1024`），无比例枚举。能力可达，仅交互形态不同：用户需自行记忆并手输像素串表达 16:9 |
| T4-13 | 提示词与提示词分组无独立数据表 | features 后端能力：数据库保存用户、提示词分组、提示词和服务器素材 | 🔶 待决策 | 用户与素材都有独立表，提示词目录整体序列化进 `openboard_state` KV。是否算缺陷取决于「手写迁移」这条既有决策的边界如何划 |
| ~~T4-14~~ | ~~后台提示词无关键词查询、无分组/标签筛选~~ | features 后台提示词管理 | ⛔ 误报，已撤销 | 三者都在：搜索框 `AdminPromptCatalogPanel.tsx:118`、分类下拉 `:119`、标签下拉 `:124`，过滤逻辑 `filterAdminPrompts`（`:90`）。`retainVisibleSelection`（`:95`）也已处理「筛选后批量删除误删隐藏项」 |
| ~~T4-15~~ | ~~服务器素材库按标签筛选接好一半~~ | features 素材 | ⛔ 误报，已撤销 | 前台有标签筛选输入并传参（`ServerLibraryPage.tsx:282`、查询 `:65`）；后台面板同样有（`AdminLibraryPanel.tsx:99`、`:44`） |
| ~~T4-16~~ | ~~管理后台无素材库面板~~ | features 账号和后台 | ⛔ 误报，已撤销 | `AdminPage.tsx:20` 的 Tab 联合类型含 `library`，`:41` 挂载 `AdminLibraryPanel`，面板本身在 `web/src/components/admin/AdminLibraryPanel.tsx` |
| T4-21 | 普通成员无法把直连渠道密钥与用户 S3/R2 凭据同步到账号 | features 账号和后台：登录用户可以同步本地直连模型渠道、画布偏好和用户 S3/R2 存储配置 | ⏳ 待实现（本轮最高优先级） | 写密钥的唯一路径 `PUT /secrets/config` 要求 `isTenantAdmin`（`auth.go:97`、`secrets.go:45`），member 直接 403；前端仅在「完全没有凭据」时吞掉该 403，真填了密钥就重新抛出（`storage.ts:598`）。后果：普通登录用户填好 API Key 点保存，保存流程抛错中断，换设备必须重填。非密钥字段则能正常落到 `__user_config_v1:<userID>`（`state.go:95`） |
| T4-22 | 系统提示词输入框对普通成员可见但保存无效 | features 账号和后台：管理后台支持系统提示词配置 | ⏳ 待实现 | 服务端读租户级 `config`（`generation_channel_snapshot.go:98`），但成员写入被重定向到 `__user_config_v1:`（`state.go:95`）。输入框未像站点策略那样用权限收起（对比 `SettingsModal.tsx:326`），成员修改后保存成功、无提示、服务端生成完全不受影响 |
| T4-23 | 渠道模型无「新获取／已有」分组选择器 | features 账号和后台 | 🔶 部分修复 | 拉取模型现写入渠道 `models` 列表（可编辑 textarea，保存后参与路由）。仍无「新获取／已有」分组选择器 UI。API Key 留空沿用已保存密钥本地成立 |
| T4-24 | 算力点余额与生成前预计消耗对用户完全不可见 | CHANGELOG v0.0.8：画布右上角展示算力点余额，生成按钮展示预计消耗 | ✅ 已修复 | 余额：顶栏 chip 展示「算力 N」。生成前：`estimateCredits` 调 `GET /api/billing/estimate`；`CreativeWorkbench` 主按钮展示「开始生成 · 预计 N 算力」，余额不足时提示。其余生成面可按需复用同一 helper |
| T4-25 | 非安全上下文下复制文本静默失败 | CHANGELOG v0.0.4：修复局域网 IP 访问时文本复制失败 | ✅ 已修复 | 新增 `writeTextWithFallback`：优先 `navigator.clipboard.writeText`，失败或不可用时回退 `document.execCommand("copy")`。五处复制入口均已改走该助手 |
| T4-26 | 四个模型无能力声明与参数转译 | CHANGELOG v0.3.13 Seedream 5 Pro、v0.3.11 Nano Banana 2 Lite、v0.3.7 Kling 3.0 Turbo / HappyHorse 1.1 | ⏳ 待实现 | 能力表只有 kling-v3 而无 turbo 变体；其余三个零命中。模型名是自由文本，用户仍可手填走通用协议，但没有能力声明、参数转译与校验（对比 Seedance 2.0 Mini 有完整能力表）。后果：专属参数不被正确转译，失败信息不友好 |
| T4-27 | 产品内无用户文档入口 | CHANGELOG v0.2.1：新增文档站点页面 | 🔶 待决策 | 换 7 种命名检索均零命中，路由无 docs 项，顶栏 HelpCircle 指向快捷键弹窗。仓库 `docs/` 是内部审计文档，不对外 |
| T4-28 | 模型选择不记住用户偏好 | CHANGELOG v0.2.1：优化模型选择用户偏好 | ⏳ 待实现 | 渠道偏好已持久化（`board.ts:379`），但模型输入框不回写，切换渠道即被重置为该渠道默认模型。查 `lastModel`/`preferredModel`/`rememberedModel` 均零命中 |
| T4-29 | 版本弹窗不检查最新版本 | CHANGELOG v0.0.5：展示当前版本、最新版本和时间线 | ⛔ 有意不同 | `checkLatest` 直接把 latest 设为 `APP_VERSION`，`hasNew` 恒 false（`VersionReleaseModal.tsx:44`）。代码注释写明「Self-hosted: prefer local VERSION/CHANGELOG assets first; no remote required」，是自托管不外联的有意取舍。时间线与当前版本展示均正常 |
| T4-30 | WebDAV 同步 | CHANGELOG v0.2.5 新增 → v0.3.7 上游自行移除 | ⛔ 本地超集 | 本地保留 `webdav.ts` 且有生产引用。上游最终态是删除，本地属「多一个功能」而非缺失，不跟进移除 |
| T4-31 | Apimart 兼容协议的模型覆盖面 | CHANGELOG v0.3.1 / v0.3.5：「全部」图片/视频模型 | 🔶 未做结论 | 协议骨架完整，图片 2 个、视频 3 系。上游模型清单在 clean-room 约束下不可见，无法量化差多少，不猜 |
| T4-17 | 工作流 Agent 系统提示词不可配置 | features 提示词库首条：管理员未填写时才用默认 | ⏳ 待实现 | 默认提示词是硬编码常量（`WorkflowWorkbench.tsx:33`），缺「可配置 + 未填写回落默认」这层 |
| T4-18 | 群众阵列人数有硬上限 | features 导演台：「想多少人就可以多少人」 | ⛔ 有意不同 | 单阵列 ≤1024、场景 ≤4096、渲染批次 ≤128，是浏览器性能保护 |
| T4-19 | 导演台截图在 server 存储模式下会跨设备同步 | features 导演台：「仅保存在当前浏览器…不随账号跨设备同步」 | ⛔ 有意不同（本地更强） | 默认部署为纯 IndexedDB，符合上游；仅 `VITE_OPENBOARD_STORAGE=server` 时切到服务端存储，属本地额外能力 |
| T4-20 | 接口响应 envelope | api-response 全文 | ⛔ 有意不同 | 沿用 T2-21 决策：本地用 HTTP 状态码。本轮补充核对了「业务失败也回 200」「前端按 code 判断」两条，均随该决策一并有意不同 |

## 3. 已修复：删除语义的两个数据正确性缺陷

这两条是本轮唯一的**数据正确性**问题——不是「功能少一块」，而是「已删的东西会回来」和「已删的东西没真删」，所以优先处理。

### 3.1 已删画布会被陈旧标签页复活（T4-01）

`DeleteProject` 是硬删除，`PutProject` 是无条件 upsert。两者组合下，一个仍持有删除前文档的标签页只要触发一次普通自动保存，就会把项目原样写回，且没有任何东西能拦住它。上游用 `deleted_at` 软删除加 7 天延迟清理，正是为了这个场景。

做法：新增迁移 v13，给 `openboard_projects` 加 `deleted_at`。删除改为写墓碑并清空 document（墓碑只需拦截写入，不必留着画布内容）；`PutProject` 的 upsert 加 `WHERE deleted_at IS NULL` 条件，写不进去就回 `ErrGone`；`GetProject` 与 `ListProjects` 同步过滤墓碑。`CompareAndSwapProject` 的 `expected == nil` 分支同样会建行，因此一并加了守卫。

API 层把 `ErrGone` 映射成 HTTP 410 而不是 500——这个区别很重要：500 会让客户端当成服务器故障无限重试，410 才表达「这东西没了，别再试」。前端 `saveServerProjects` 收到 410 后把该 id 当作已结算返回，store 据此把本地副本一并丢弃，而真正的服务端错误仍然照常抛出。

顺带确认了一个边界：`importProject` 会为导入的项目生成**新 id**，所以墓碑不会误伤「删除后重新导入同一份画布」。

### 3.2 已删生成记录仍留着成果 JSON（T4-02）

`DeleteGenerationJob` 只把 `status` 改成 `deleted`，`result` 原封不动，而 `includeDeleted=1` 还能把它读回来。上游在删除时会清空 `payload_json`。

做法：单条删除与批量删除两条 SQL 都改为同时 `result='{}'::jsonb` 并写 `deleted_at`；迁移 v13 对存量 `status='deleted'` 的行做一次回溯清空。

### 3.3 墓碑必须会过期

加墓碑就等于制造了一类永不消失的行。上游给的是 7 天，本地照做：`PurgeExpiredTombstones` 按 `tombstoneRetention` 删掉过期的项目与任务墓碑。

这里刻意避开了本轮审查反复抓到的那个反模式——**写完清理函数却没人调用**。`DeleteExpiredMediaReferences` 就是前车之鉴：store 层实现了，api 层零调用，只靠读时惰性删除。所以 `PurgeExpiredTombstones` 直接挂进既有的保留期调度器，与 AI 调用日志清理、媒体令牌清理同一个 ticker。

## 4. 实施记录

### Phase A — 删除语义（P0，已完成）

- [x] 先写失败测试（真实跑出 RED：`ErrGone` 与 `PurgeExpiredTombstones` 都未定义，编译失败）
- [x] 迁移 v13：两张表加 `deleted_at` 与部分索引，回溯清空存量已删记录的 result
- [x] `DeleteProject` 改软删除并清空 document；`PutProject` / `CompareAndSwapProject` 加墓碑守卫；`GetProject` / `ListProjects` 过滤墓碑
- [x] 单条与批量删除生成任务时清空 result 并写 `deleted_at`
- [x] `PurgeExpiredTombstones` 实现并**接入既有保留期调度器**
- [x] API 层把 `ErrGone` 映射为 HTTP 410（普通写入与迁移 CAS 两条路径）
- [x] 前端把 410 当作已结算：`saveServerProjects` 返回被墓碑的 id，store 丢弃本地副本；真实错误仍然抛出

验收：5 个 store 层测试覆盖陈旧写回被拒、CAS 复活被拒、单条与批量删除都清空成果、墓碑在保留期内不清理且过期后物理消失；2 个前端测试分别覆盖 410 结算与 500 仍报错。

## 5. 本轮覆盖记录（供下一轮度量用）

按 §1 的教训，覆盖度必须可被后续轮次复算。本轮实际逐条走过的范围如下，**未列入差异总表 = 已核对且无缺口**，不是「没审」：

| 范围 | 条目数 | 结论 |
|---|---|---|
| `features.md` / AI 生成 | 18 条 + 6 段正文 | 逐条追到生产调用链，缺口见 T4-10、T4-11、T4-12 |
| `features.md` / 图片工作流 | 15 | 缺口见 T4-06、T4-07；其余 13 条已实现 |
| `features.md` / 全景图 | 5 | 全部已实现 |
| `features.md` / 导演台 | 12 + 节首正文 | 缺口见 T4-08、T4-09、T4-18、T4-19；含「8 种人物/20 种姿势」精确吻合 |
| `features.md` / 账号和后台 | 11 | 缺口见 T4-21、T4-22、T4-23 |
| `features.md` / 当前限制 | 6 | 5 条一致，1 条本地更严格（T4-21 的副作用） |
| `features.md` / 后端能力 | 6 | 均为既有决策，另见 T4-13 |
| `canvas-node-manual.md` | 6 小节 | 缺口见 T4-04、T4-05 |
| `backend-database.md` | 11 张表 | 缺口见 T4-01、T4-02；另有 progress 字段等中低度差异 |
| `system-settings.md` | 22 个字段 | 缺口见 T4-03 |
| `api-response.md` | 全文 | 见 T4-20，随既有 envelope 决策一并有意不同 |
| `CHANGELOG` v0.0.1–v0.3.13 | 30 组 76 条 | 缺口见 T4-24 至 T4-31。其余条目分三类：已实现、本地不存在该 bug、或纯样式/未描述可观察行为而未做结论 |

**度量陷阱提醒**：本轮收尾复算时，`v0.0.2`、`v0.3.4` 等 22 个版本号在计划文档里搜不到，看起来像盲区——实际它们都已逐条审过，只是无缺口所以没被写进差异表。**「文档里搜不到版本号」不等于「没审过」**。下一轮如要复算覆盖度，请以本表为准，不要重复用 grep 版本号的方式判断。

`CHANGELOG` 未做结论的条目及原因已在审计中逐条记录，主要是三类：条目未描述具体 bug 表现（v0.3.11、v0.2.5）、纯视觉样式在 clean-room 下不可判等价（v0.3.2、v0.0.7、v0.0.2 移动端）、以及属结构性选择而非缺口（v0.0.6 代理路径形态）。

## 6. 质量门禁

沿用前三轮，并把第三轮新增的「已实现判定必须追完整调用链」保留为固定动作。本轮再加两条：

1. **覆盖度用上游自己的目录结构度量**，统计单位下沉到章节与条目，在每轮**开头和结尾各做一次**。自选关键词的命中率不构成覆盖度证据。
2. **新增的清理/维护函数必须当场接上调度或调用方**，并在同一次提交里给出「它确实会被执行」的证据。本轮 `DeleteExpiredMediaReferences` 的历史教训表明，「写了但没接」与「没写」对用户是等价的。
3. **判「缺失」要以当前工作树为准，不能沿用上一轮的结论**。本轮初稿的 T4-14/15/16 三条全是误报：后台提示词的搜索框与分类、标签下拉，前台与后台素材库的标签筛选，管理后台的素材库页签，代码里全都存在，其中一部分正是上一轮自己加的（`1d61da0 feat: add admin catalog filters, library console...`）。误报的成因是把上一轮的旧结论当成了已知前提直接转述，而没有重新读代码——这与 §1 的循环论证是同一类错误，只是把「自选关键词」换成了「自选的历史结论」。

验证基线：`bun run typecheck`、`bun test src`（538 pass）、`go test ./...`、`go vet ./...`、Playwright chromium（104/104）、`audit:cleanroom`、`audit:vulnerabilities`、`audit:deployment-env` 全部通过。store 层的墓碑测试需要 PostgreSQL，通过 `OPENBOARD_TEST_DATABASE_URL` 提供，未设置时按既有约定跳过（CI 中缺失即失败）。
