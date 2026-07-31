# Tiger Infinite Canvas 差异审查与补齐计划

> **历史归档（第一轮）**：本文保留当时的证据、版本和验收记录，
> 不代表当前实现状态。当前结论以
> [`TIGER_GAP_PLAN_4.md`](TIGER_GAP_PLAN_4.md) 和
> [`FEATURE_PARITY.md`](FEATURE_PARITY.md) 为准。

> 审查日期：2026-07-26
>
> 本地基准：`main@a85df47379039cd9878f8994c8527069ee09b4c1`
>
> 对照基准：`tigerowo/infinite-canvas main@64cb00a6da99a50017abcb2e443166a13364c6c1`
>
> 对照版本：最新 tag 为 `v0.4.4`；上述 `main` 另含 1 个 Unreleased 分组提交

## 1. 结论

本地与 Tiger 是两套无共同 Git 历史的独立实现，不能用普通 fork 的 ahead/behind 或文件名差异判断功能缺口。按公开 CHANGELOG、公开功能文档、代码入口和本地可重复证据做行为映射后：

- Tiger 的画布核心、左侧面板、节点分组、节点标题、双击添加、提示词换行、全景图、摄像机、3D 导演台、图片/视频工作台、持久化任务、工作流、账号和基础配额能力，本地均已有对应实现或更强实现。
- 当前确认需要补齐的重点是：KIE/APIMart 等渠道的模型级协议转译、Kling v2.6/v3 专属配置面板、完整管理后台 UI、共享后台渠道池、多存储提供商池、登录时本地数据迁移、图片快捷工具自定义及独立 AI 超分入口。
- Tiger HEAD 相对 `v0.4.4` 的 4 个 Unreleased 行为，本地有实现证据，但仍需要一次独立黑盒回归，不能只依赖 `docs/FEATURE_PARITY.md` 的自证。
- 本地还拥有 Tiger 没有的插件 SDK、浏览器 Agent/MCP、Codex/Claude 面板、WebDAV 全工作区备份、强制安全边界、Redis 缓存、跨浏览器 E2E 和发布审计；这些不是待删除差异。

## 2. 审查边界与判定规则

### 2.1 Clean-room 边界

- 本文只记录行为差异和验收结果，不把 Tiger 的源码、目录、数据结构、视觉资产或实现细节作为开发规格。
- 后续实现只能依据公开 README/CHANGELOG/用户文档、独立黑盒观察和本项目自己的设计。
- 不复制 Tiger 的品牌、文案、视觉表达、提示词内容、导演台资产或第三方仓库内容。

### 2.2 状态定义

| 状态 | 含义 |
|---|---|
| 已覆盖 | 本地已有入口、实现和测试证据，不进入开发队列 |
| 待回归 | 本地看似覆盖，但需对 Tiger HEAD 做黑盒行为验收 |
| 部分覆盖 | 通用能力存在，但缺 Tiger 的专属交互或协议细节 |
| 未实现 | 本地未找到对应用户入口或端到端实现 |
| 有意不同 | 架构或安全策略不同，不建议机械追平 |
| 本地增强 | 本地额外能力，不属于 Tiger 缺口 |

## 3. 差异总表

### 3.1 已覆盖，不进入开发队列

| 能力 | 状态 | 本地证据 |
|---|---|---|
| 多项目、导入导出、批量删除 | 已覆盖 | `web/src/pages/HomePage.tsx`、项目 bundle/文档测试 |
| 平移缩放、小地图、背景、主题、框选、多选、连线、撤销重做 | 已覆盖 | `web/src/components/canvas/BoardCanvas.tsx`、canvas E2E |
| 双击空白添加节点/素材 | 已覆盖 | `BoardCanvas.tsx` 的 `onDoubleClick` 与上下文菜单 |
| 节点标题显示和双击编辑 | 已覆盖 | `web/src/components/canvas/BoardNodeView.tsx` |
| 左侧项目/元素/素材/提示词面板及素材拖入 | 已覆盖 | `HomePage.tsx`、`CanvasAssetsPanel.tsx`、`CanvasPromptsPanel.tsx` |
| 节点分组、拖动、缩放、拖入拖出、复制粘贴、撤销重做 | 已覆盖，待 HEAD 回归 | `web/src/lib/grouping.ts`、`use-board-store.ts`、相关单测/E2E |
| 文本、图片、配置、视频、音频、全景、导演台节点 | 已覆盖 | `web/src/types/board.ts`、`CanvasToolbar.tsx` |
| 图片裁剪、旋转、多角度、遮罩、放大、切分、反推提示词 | 已覆盖 | `NodeActions.tsx`、`ImageToolsDialog.tsx`、image-transform 测试 |
| 批量图片组、展开和主图 | 已覆盖 | BatchGroup 控件与 canvas E2E |
| 全景生成、严格 2:1 导入、360° 查看、导演台环境传递 | 已覆盖 | panorama 组件、lib 测试和 E2E |
| 摄像机/镜头/焦距/光圈结构化配置 | 已覆盖 | `CameraPromptPanel.tsx`、camera prompt 测试 |
| 3D 导演台、人物/姿势/群演/几何体/机位/截图回画布 | 已覆盖 | director 组件、scene v4、GLB/截图测试 |
| 图片/视频/音频持久化任务和恢复 | 已覆盖 | Go generation workers、job API、formal E2E |
| 图片/视频工作台、首尾帧、声音、水印、历史和重试 | 已覆盖 | `CreativeWorkbench.tsx`、生成服务测试 |
| 公开/个人创作工作流与 AI 草稿 | 已覆盖 | workflow 页面、服务、DAG 和 formal E2E |
| 统一画布 Agent、上下文、审批、附件、停止与结果插入 | 已覆盖 | `LocalAgentPanel.tsx` 与 Agent/runtime E2E |
| 注册登录、Linux.do OAuth、本地多租户、额度扣减/退款和模型成本读取基础 | 已覆盖 | auth/admin API、PostgreSQL store 测试 |
| 用户级 S3/R2 | 已覆盖 | Settings、blob S3、tenant storage 测试 |
| 提示词来源、个人提示词、素材和服务器素材库 | 已覆盖 | prompts/assets/library 页面和测试 |

### 3.2 确认未实现或部分覆盖

| ID | 差异 | 状态 | 影响 | 处理建议 |
|---|---|---|---|---|
| GAP-01 | KIE 图片/视频协议：专用上传、任务创建、轮询、错误和响应归一化 | 已实现 | 精确官方上传域映射、自定义渠道同信任域、上传/创建/有界重试轮询/恢复和脱敏测试已覆盖 | 保持精确 host allowlist；新增官方契约时扩展 fixture |
| GAP-02 | APIMart 图片/视频协议及模型级参数转译 | 已实现 | 专用 adapter、图片上传、异步任务、模型级参数与结果归一化已覆盖 | 未公开的本地视频/音频上传契约继续 fail-closed |
| GAP-03 | Tiger 已内置模型族的精确适配：Kling 2.6/3、Seedream 5 Pro、Nano Banana 2 Lite、HappyHorse 1.1、Agnes、Seedance 2.0 Mini 等 | 已收敛 | Kling 2.6/3、Seedance 2.0 standard/fast/mini 具有精确 capability/fixture；其余精确名称缺官方契约，明确保持 unsupported | 不以相近营销名或低版本冒充支持 |
| GAP-04 | Kling v2.6/v3 专属视频创作面板 | 已实现 | 负面提示词、多镜头、镜头时长、元素、引用、std/pro/4K/音频规则共享同一 capability/job snapshot | 真实付费 smoke 仍为用户 opt-in |
| GAP-05 | 图片悬浮快捷工具自定义（显示项、顺序、是否显示标签） | 已实现 | 用户可选择、排序、显示标签、恢复默认并持久化 | 保持 schema 迁移测试 |
| GAP-06 | 独立“AI 超分”工具入口与普通放大的明确区分 | 已实现 | 本地缩放、AI 超分和局部编辑已分离；AI 不支持时不静默回退 | 保持 lineage 与原图不覆盖规则 |
| GAP-07 | 完整管理后台前端：用户、角色/状态、额度调整、额度日志、全局模型成本 | 已实现 | owner/admin shell、用户/角色/状态、幂等额度、日志和模型成本 API/UI 已覆盖 | 最后 owner 和退款原子性继续由 PostgreSQL 并发测试保护 |
| GAP-08 | 全局后台 AI 渠道管理：共享渠道密钥、协议、权重、超时、模型拉取/测试、普通用户使用开关 | 已实现 | 加权共享渠道、模型拉取/测试、公开安全目录、任务不可变快照、目标绑定 write-only secret 与 CAS 生命周期已覆盖 | destination/protocol 变化必须重录 secret |
| GAP-09 | 后台提示词分类/条目集中 CRUD、批量删除、单源/全部同步与定时任务管理 UI | 已实现 | 集中 CRUD、批量操作、手动/周期同步、跨实例租约、公共目录 ETag/cache 与个人目录合并已覆盖 | 远程内容继续使用 SSRF/大小/MIME/重定向边界 |
| GAP-10 | 多 S3/R2 提供商池、权重/轮询、容量检测、全局/用户存储策略 | 已实现 | 单存储偏好 → tenant 加权池 → process fallback；稳定 placement、tombstone、安全故障切换、健康/容量状态和管理 UI 已覆盖 | 无通用容量 API 的 S3 提供商明确显示 unknown |
| GAP-11 | 用户登录后的浏览器本地数据按用户迁移/合并到账号 | 已实现 | 预检、统计、冲突/容量、条件写 CAS、取消/恢复、历史/媒体及凭据显式 opt-in 已覆盖 | 失败或竞态绝不清理唯一的本地副本 |
| GAP-12 | SQLite/MySQL 作为正式数据库后端 | 有意不同 | 正式模式继续 PostgreSQL + Redis；没有已批准的 SQLite/MySQL 需求和维护预算 | 不实施，出现明确部署需求后另立项 |

#### GAP-03 官方契约审计（2026-07-26）

模型支持必须以精确公开契约为准，不把相近营销名称、模糊匹配或 Tiger 的内部实现当作 provider 协议证据：

| Tiger/需求名称 | 官方公开证据 | 本地决策 |
|---|---|---|
| Seedance 2.0 Mini | APIMart 官方文档明确列出 `doubao-seedance-2.0`、`doubao-seedance-2.0-fast`、`doubao-seedance-2.0-mini`，共享 `duration`、`size`、`resolution`、`generate_audio`、`image_urls` / `image_with_roles` 和异步任务结果契约 | 支持三个精确模型；5–15 秒；标准版 480p/720p/1080p/4K，fast/mini 480p/720p；普通参考图和首尾帧使用官方图片上传。官方只公开图片上传接口，因此本地二进制参考视频/音频在存在可验证上传或公共签名 URL 管道前保持 fail-closed |
| Seedream 5 Pro | APIMart 当前公开的是 `doubao-seedream-5-0-lite` / Seedream-5.0-Lite，不是 “Seedream 5 Pro” | 不把 Lite 冒充 Pro；精确 Pro 名称保持 unsupported |
| Nano Banana 2 Lite | APIMart 当前公开的是 Gemini 3.1 Flash Image Preview（Nano Banana2）等精确模型，没有 “Nano Banana 2 Lite” 契约 | 保持 unsupported；待出现精确模型名、字段、限制和结果契约后再加入 |
| HappyHorse 1.1 | APIMart 当前公开的是 `happyhorse-1.0`，没有 1.1 契约 | 不以 1.0 推断 1.1；保持 unsupported |
| Agnes | APIMart 官方文档索引和公开模型页未找到可核验的 Agnes 请求/结果契约 | 保持 unsupported |

证据入口：[Seedance 2.0](https://docs.apimart.ai/en/api-reference/videos/doubao-seedance-2-0/generation)、[Seedream 5.0 Lite](https://docs.apimart.ai/en/api-reference/images/seedream-5-lite/generation)、[Nano Banana2](https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation)、[HappyHorse 1.0](https://docs.apimart.ai/en/api-reference/videos/happyhorse-1.0/generation)、[APIMart 文档索引](https://docs.apimart.ai/llms.txt)。

### 3.3 Tiger HEAD 增量：必须回归，不应重复开发

对 `main@64cb00a` 做独立黑盒检查，全部通过后把结果固化到 E2E：

- [x] Cmd/Ctrl+G 创建组；组整体拖动和缩放。
- [x] 节点同帧拖入/拖出组；边界附近无抖动或错误归属。
- [x] 组删除、复制粘贴、撤销重做、保存重载。
- [x] 连续 pointer 操作、丢失 pointer capture、Escape 后不会持续拖动。
- [x] 节点悬浮工具栏在窄视口和多按钮场景不遮挡主要操作。
- [x] 超长模型名不会挤压或覆盖提示词发送操作。
- [x] 左侧面板素材拖入位置、配置节点多行/空行粘贴行为与公开说明一致。

### 3.4 有意不同，默认不追平

| 差异 | 决策 |
|---|---|
| Tiger：Next.js + Gin/GORM；本地：Vite SPA + chi/PostgreSQL/Redis | 保持本地架构，按行为对齐，不迁移技术栈 |
| Tiger 的品牌、中文文案、Ant Design 视觉、导演台预构建资产 | 不复制；保持 OpenBoard 独立产品身份和视觉系统 |
| Tiger 内置的远程提示词仓库和内容 | 不复制；只维护兼容的独立来源机制和用户主动安装 |
| Tiger 本地直连时浏览器保存 API Key | 正式模式继续服务端加密；仅离线兼容模式允许浏览器配置 |
| Tiger 的本地/云端手动媒体同步语义 | 本地正式模式保持服务端保护存储；只补清晰状态和迁移体验 |
| Tiger 支持 SQLite/MySQL | 暂不追平，除非出现明确部署需求 |
| Tiger 的弱默认管理员/JWT 配置 | 不追平；继续 fail-fast、随机/强密钥和最小暴露策略 |

### 3.5 本地增强，保留并避免回归

- 插件 manifest v2、权限沙箱、SDK 和 5 个内置示例。
- Browser Runtime、WebSocket、多标签页原子操作、MCP、Codex/Claude 会话。
- WebDAV 项目与完整工作区备份/恢复。
- PostgreSQL 权威存储、Redis 缓存、租户隔离、加密 secrets、受保护文件/S3。
- 音频节点和持久化音频任务；注意当前没有独立音频工作台页面。
- 跨浏览器/移动端 Playwright、formal PostgreSQL/Redis E2E、Go race/vet、OSV、SBOM、许可证和容器安全门禁。

## 4. 实施计划

### Phase 0 — 基线与文档可信度（P0）

- [x] 把 Tiger 对照基准固定为 `main@64cb00a`，记录公开 CHANGELOG/文档快照，不把临时 clone 纳入仓库。
- [x] 将 `docs/FEATURE_PARITY.md` 的 Tiger 长句拆为独立、可验收条目，并把“自述 verified”改成“测试证据 + 最近验证基准”。
- [x] 修正 README 的“single-user/no login”描述，使其与当前 AuthGate、多租户和站点策略一致。
- [x] 修正文档中的 coverage 数字漂移。
- [x] 修正“image/video/audio workbenches”表述：当前只有图片和视频工作台，音频仅有节点与任务能力。
- [x] 为 3.3 的 7 类 HEAD 行为补/更新 Playwright 回归。

验收：文档中每个 parity 状态都能指向具体测试；`README.md`、`FEATURE_PARITY.md`、实际路由不再互相矛盾。

### Phase 1 — Provider 能力模型与契约测试（P0）

- [x] 先写失败测试：provider capability、引用上限、首尾帧、视频/音频引用、时长/比例/清晰度、结果轮询、错误脱敏。
- [x] 定义不可变的 provider/model capability schema，避免 UI 和服务端分别猜测模型名称。
- [x] 实现 KIE adapter：安全 URL 构造、上传、创建、状态轮询、取消、结果归一化。
- [x] 实现 APIMart adapter：图片/视频参数转译、引用上传、异步任务、结果归一化。
- [x] 为 GAP-03 的每个模型族增加固定 fixture；真实付费 smoke 使用用户密钥且默认不进 CI。
- [x] 所有密钥只在服务端解密；日志、错误和测试快照不得出现密钥或原始二进制。

验收：unit/integration 覆盖率不低于 80%；每个已声明支持的模型都有成功、失败、超时、取消、重启恢复和密钥脱敏测试。

### Phase 2 — Kling 专属工作台（P0）

- [x] 先写组件/状态测试：Kling 2.6 与 v3 的能力差异。
- [x] 实现负面提示词、多镜头、镜头时长、元素列表及参考素材限制。
- [x] 实现 std/pro/4K、比例、时长、音频开关的模型约束和即时校验。
- [x] 与通用视频节点、配置节点、历史重试共享同一 capability 和 job snapshot。
- [x] 增加 reload、retry、cancel、跨页面恢复和正式存储 E2E。

验收：重试严格复用原渠道/模型/所有专属参数；不支持的组合在网络请求前失败并给出用户可理解的提示。

### Phase 3 — 管理后台与共享渠道（P1）

- [x] 新增受 owner/admin 保护的管理后台 shell 和导航。
- [x] 用户管理：搜索、分页、角色、状态、额度调整、最后 owner 保护。
- [x] 额度日志：筛选、分页、调整原因、幂等扣费/退款链路。
- [x] 模型成本和共享渠道：协议、模型、权重、超时、启停、连通性测试。
- [x] 共享渠道 secret 使用现有 AES-GCM envelope；响应仅返回是否已配置，不返回明文。
- [x] 提示词/分类集中管理与同步任务状态；远程内容仍经过 URL、大小、类型和重定向限制。
- [x] 增加普通用户、admin、owner 三类权限集成/E2E。

验收：未授权请求全部 401/403；前端没有隐藏即授权的假设；最后 owner、余额和扣费幂等规则均有并发测试。

### Phase 4 — 存储池与登录迁移（P1）

- [x] 设计 tenant 级多 provider 配置和不可变路由决策：用户偏好 → tenant pool → process fallback。
- [x] 实现权重/轮询、健康检查、容量检测、失败切换和删除 tombstone。
- [x] 保持对象 key 租户隔离、私有读代理、配额补偿和引用计数。
- [x] 实现登录迁移预检：统计画布、素材、历史和媒体，展示冲突与所需空间。
- [x] 实现幂等分批迁移、取消/恢复、失败回滚和明确的冲突策略。
- [x] 增加双标签页 CAS、断网重试、重复登录、跨租户和配额不足的单元/集成覆盖，并验证迁移对话框交互。

验收：迁移重复运行不产生重复对象；任何失败都不会清空唯一的本地副本；跨租户读取和覆盖不可发生。

### Phase 5 — 图片工具 UX（P2）

- [x] 增加快捷工具选择、排序、标签显示和恢复默认。
- [x] 区分“本地尺寸放大”“AI 放大/超分”“局部编辑”，显示 provider capability。
- [x] provider 不支持时禁用对应动作；若允许回退，必须在执行前明确展示回退路径。
- [x] 增加窄视口、键盘操作、重载持久化和多节点工具栏 E2E。

验收：工具偏好持久化且 schema 可迁移；所有操作可键盘访问；失败不会覆盖原图片节点。

### Phase 6 — 可选兼容项决策（P3）

- [x] SQLite：当前没有明确单文件正式部署需求，决定不进入本轮实现。
- [x] MySQL：当前没有明确客户环境需求，决定不进入本轮实现。
- [x] 保留统一 store contract 原则；未来若批准新数据库，再运行同一套数据库集成测试，不在 PostgreSQL 查询中散落方言分支。

验收：只有明确需求和维护预算时才进入实现；否则在文档中维持“有意不同”。

## 5. 横向质量门禁

每个 Phase 都必须满足：

- [x] TDD：先 RED，再最小 GREEN，最后重构。
- [x] 单元、集成、关键 E2E 齐全；Bun 覆盖率 81.94% lines / 86.00% functions。
- [x] 所有外部输入使用 schema/边界校验；URL 禁止凭据、危险重定向和非受控内网访问。
- [x] provider 响应设置大小、MIME、解码和超时限制。
- [x] API Key、S3 secret、JWT、OAuth secret 不进入客户端、日志、错误和导出包。
- [x] 生成任务支持幂等、取消、租约恢复、孤儿媒体回收和额度退款。
- [x] 使用不可变更新，不直接修改 Zustand/store 中的既有对象。
- [x] 通过 Bun test/typecheck/build、Go race/vet、Playwright、formal E2E、OSV、SBOM 和容器 smoke。

### 2026-07-26 验收证据

- 上游基准复核：`git ls-remote` 仍为 Tiger `main@64cb00a6da99a50017abcb2e443166a13364c6c1`、tag `v0.4.4@0bb25f0`。
- Web：486 项 Bun 单元/集成测试通过；coverage 81.94% lines / 86.00% functions；根目录 typecheck 与 production build 通过。
- Go：`go test ./...`、`go test -race ./...`、`go vet ./...`、server/MCP 两个 binary build 通过；真实 PostgreSQL 退款回滚/并发 exactly-once 测试通过。
- 浏览器：production Chromium 在 production Vite build 与隔离 Go 数据目录下完整顺序复跑 99/99 通过；Tiger HEAD 关键映射、管理端、Kling、图片工具、共享渠道和存储池均包含在该套件。
- Formal：本机 PostgreSQL/Redis 隔离 run、Redis DB 14 与临时媒体目录下 7/7 通过，测试数据库名与 Redis DB 残留检查通过。
- 供应链/发布基础：clean-room scan、manifest-driven direct-license audit、198-package SPDX SBOM、OSV 226-package/import-path audit 通过；React Router 升级到官方修复版 8.3.0。
- 容器：CI 同构 image build、PostgreSQL/Redis compose 启动、`postgresql+redis` health、非 root UID 101、12 张 public schema tables、Redis PONG 均通过，随后删除 volumes/orphans。

### 2026-07-26 复核补充（提交前独立回归）

对未提交实现做独立复跑时，`99/99 通过` 的旧记录已失效，实际发现并修复两个真实缺陷：

- 图片双击预览失效：画布在 `pointerdown` 阶段就调用 `setPointerCapture`，浏览器随后把 `click`/`dblclick`
  重定向到捕获元素（画布根节点），因此图片节点的 `onDoubleClick` 从不触发，反而由根节点的
  `onDoubleClick` 打开了新建节点菜单。修复方式：把指针捕获延迟到真正发生 `pointermove` 时再应用
  （`web/src/components/canvas/BoardCanvas.tsx`），拖拽/平移/框选行为保持不变。该缺陷在 HEAD 版本的
  `BoardCanvas.tsx` 与 `BoardNodeView.tsx` 下同样复现，属于既有缺陷而非本轮改动引入。
- 管理后台共享渠道 E2E 与真实契约不一致：mock 渠道缺少 `secretBindingId`，导致写入密钥前的
  CAS 绑定校验直接失败。已按服务端与 `admin.test.ts` 的 write-only 绑定契约修正 E2E mock 与断言。

独立安全复审又发现并修复了两个本轮改动引入的问题：

- 共享渠道目录缓存是进程级全局状态，登录/登出只重置存储作用域，不清理该缓存。租户在 30 秒 TTL 内切换时，
  新租户会先读到上一租户的渠道名称与模型元数据，并可能选中失效的跨租户渠道。修复方式：新增
  `resetSharedChannelCatalog()` 并挂到 `resetWorkspaceScopeRuntime`，在凭据/作用域变化时清空缓存、快照与
  定时器，并补充跨租户回归测试。
- 图片工具栏偏好没有 schema 版本，且会遍历未设上限的持久化数组。已加入 `version: 1`、拒绝未知/未来版本、
  限制数组长度，并补充版本迁移与超长输入的测试。

### 2026-07-26 提交后安全复审（第二轮）

对 `bd51ad0` 再做一轮独立 Go/Web 审查，两方都给出 block 结论。已修复的问题：

- 生成结果下载 SSRF（既有边界，本轮 KIE/APIMart 扩大了暴露面）：provider 返回的结果 URL 是不可信输入，
  但此前与「运营方配置的 provider 端点」共用同一校验，因而允许 `http://127.0.0.1`。新增
  `validateGenerationResultURL(rawURL, providerBaseURL)`：只有当 provider 端点本身就是 loopback
  （本地开发/测试）时才允许结果 URL 指向 loopback，其余一律拒绝。
- 预签名下载 URL 经日志泄露（既有边界）：`client.Do` 的原始错误是 Go `*url.Error`，内含完整 URL 与查询串，
  而 worker 以 `%v` 记录。现在所有结果下载失败统一返回不含 URL 的 `errGenerationDownloadFailed`。
- APIMart 公共引用 URL 缺少内网校验（本轮引入）：`elements[].imageUrls` 会被转发给 APIMart 由其服务端抓取，
  此前只做语法校验。现拒绝 loopback、私网、link-local、CGNAT 等字面内网地址。
- 定时提示词同步永不执行（本轮引入的时钟耦合缺陷）：调度用注入时钟写入租约到期时间，而同步执行与 HTTP
  变更路径都用 `time.Now()` 校验租约，导致刚认领的租约立即被判过期，任务被静默丢弃。租约到期时间改为始终
  使用真实时钟（它本就是「实例崩溃后可被其他实例接管」的墙钟语义），注入时钟仅用于判定到期与排下一次。
  仓库中已有的 `TestDuePromptSourceRunnerIsDeterministicAndPersistsNextRun` 此前一直是红的，被 Go 测试缓存掩盖。

第三轮复审（approve-with-nits）又修复两项：

- `validateAPIMartPublicURL` 的非规范写法绕过：`localhost` 与八进制/十进制/十六进制 IP 字面量此前仍能通过。
  现已一并拒绝，并修正注释——这些 URL 由 APIMart 在其自身网络抓取，因此该校验保护的是伙伴方而非本部署边界。

复审后证据：Bun 486/486（coverage 81.94% lines / 86.00% functions）、typecheck、production build、
`go test ./...`、`go test -race ./...`、`go vet ./...` 全绿；production Chromium 99/99 通过；
formal PostgreSQL/Redis 7/7 通过；clean-room 扫描与 OSV 226 包审计通过。

## 6. 不属于 Tiger 差异、但需单独跟踪的问题

- 当前没有独立音频工作台；Tiger 也没有独立音频工作台，因此不是对 Tiger 的缺口，但需修正文档误述或另立产品需求。
- Claude Agent SDK adapter、Hosted SaaS marketplace、外部支付、组织级 SSO 是本地明确 not targeted 项，不应混入 Tiger parity。
- Director 当前只接受受限 GLB v2；项目 ZIP 读取仅支持 STORE method 0。这些是本地互操作边界，只有在对照黑盒确认 Tiger 支持更广格式后，才升级为 Tiger 缺口。
- ~~生成结果下载允许显式 loopback 主机，且下载传输错误按原样向上传播。~~ 已在 2026-07-26 第二轮安全复审中收敛：
  新增 `validateGenerationResultURL` 区分「运营方配置的 provider 端点」与「provider 返回的不可信结果 URL」，
  并把下载失败统一为不含 URL 的稳定错误。
- 商业发布仍受 `docs/RELEASE_AUDIT.md` 中未完成的安全、许可、来源、资产、品牌和法律审查阻断；功能 parity 完成不等于可商业发布。

## 7. Tiger 行为收敛完成定义

当以下条件全部满足，才可以宣布与本次 Tiger 基准完成行为收敛：

- [x] GAP-01 至 GAP-11 已实现或有明确、批准的“不追平”决策；GAP-12 已作产品决策。
- [x] Tiger `main@64cb00a` 的公开用户行为全部有独立 E2E 映射。
- [x] 真实 provider 支持清单只包含通过契约测试的模型；未验证模型不使用“已支持”表述。
- [x] `README.md`、`FEATURE_PARITY.md`、路由、API 和测试证据一致。
- [x] Clean-room 标识扫描、许可证清单、SBOM 和依赖漏洞检查通过。

商业发布仍需另行完成 `docs/RELEASE_AUDIT.md` 中的资产、品牌、贡献者权利和法律审查；它不是宣告 Tiger 功能行为收敛的前置条件。
