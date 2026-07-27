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
| T4-03 | 共享渠道无 per-channel 模型列表，按模型路由会选中不提供该模型的渠道 | system-settings `private.channels[].models` | ⏳ 待实现 | `sharedChannelSupports` 收了 `requestedModel` 却只判空，随后仅按 protocol+kind 返回（`admin_channels.go:165`）；加权选择不校验模型（`:203`）。`fetchAdminChannelModels`（`:686`）是实时拉取供 UI 展示，不参与路由。后果：请求 `gpt-image-2` 可能被路由到没有该模型的渠道，失败发生在上游调用时而非路由时 |
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
| T4-14 | 后台提示词无关键词查询、无分组/标签筛选 | features 后台提示词管理 | ⏳ 待实现 | 面板仅整表罗列，服务端 catalog 接口不接收筛选参数 |
| T4-15 | 服务器素材库按标签筛选接好一半 | features 素材 | ⏳ 待实现 | 后端与 service 层 tag 参数齐备，页面未传参也无控件 |
| T4-16 | 管理后台无素材库面板 | features 账号和后台：管理员后台包含提示词管理和素材库管理 | ⏳ 待实现 | CRUD 能力挂在前台素材库页的管理员分支上，`AdminPage.tsx` 无素材库入口 |
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

## 5. 质量门禁

沿用前三轮，并把第三轮新增的「已实现判定必须追完整调用链」保留为固定动作。本轮再加两条：

1. **覆盖度用上游自己的目录结构度量**，统计单位下沉到章节与条目，在每轮**开头和结尾各做一次**。自选关键词的命中率不构成覆盖度证据。
2. **新增的清理/维护函数必须当场接上调度或调用方**，并在同一次提交里给出「它确实会被执行」的证据。本轮 `DeleteExpiredMediaReferences` 的历史教训表明，「写了但没接」与「没写」对用户是等价的。

验证基线：`bun run typecheck`、`bun test src`（538 pass）、`go test ./...`、`go vet ./...`、Playwright chromium（104/104）、`audit:cleanroom`、`audit:vulnerabilities`、`audit:deployment-env` 全部通过。store 层的墓碑测试需要 PostgreSQL，通过 `OPENBOARD_TEST_DATABASE_URL` 提供，未设置时按既有约定跳过（CI 中缺失即失败）。
