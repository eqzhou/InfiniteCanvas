# Tiger v0.4.5 功能差异复审与实施计划（第四轮）

> 审查日期：2026-07-28
>
> 实施起始基准：`main@b701b7a35bf4303909c2e0b8194bd60c3a0b3c69`
>
> 对照基准：`tigerowo/infinite-canvas main@9435f1c76130448ed7c41357b7b8ec5b60046538`
>
> 对照版本：`v0.4.5`（tag 与 main 同一提交）

## 1. 审查边界

本轮继续遵守 clean-room：只使用 Tiger 的公开 README、公开功能文档、公开 CHANGELOG、Release 页面和提交标题作为行为证据；不把上游源码、目录结构、视觉资产、提示词内容或实现细节作为本项目的开发规格。

判定按用户可观察行为进行：

| 状态 | 含义 |
|---|---|
| 已覆盖 | 本地已有入口、实现和可重复测试证据 |
| 等价/更强 | 实现方式不同，但覆盖同一用户目标或具有更强安全/可靠性 |
| 待回归 | 静态证据存在，但缺少针对 Tiger 最新行为的独立回归 |
| 部分覆盖 | 通用能力存在，但精确模型或细节仍缺失 |
| 未实现 | 本地没有等价用户能力 |
| 有意不同 | 已有明确产品/架构决策，不机械追平 |

## 2. 最新版本确认

- Tiger 当前 `main`、`VERSION` 与最新 tag 均为 `v0.4.5@9435f1c`。
- `v0.4.5` 相对旧计划的 `v0.4.4` 新增/修复：组节点、未登录本地渠道生图任务、普通节点 `@` 引用输入、提示词库展开后的画布性能、连续鼠标拖动画布、提示词详情 Markdown 文本、悬浮工具栏和长模型名布局。
- 旧计划使用的 `main@64cb00a` 已过期，不能继续作为“最新功能”结论的依据。

## 3. Tiger v0.4.5 增量映射

| ID | Tiger v0.4.5 行为 | 本地状态 | 本地证据 / 结论 |
|---|---|---|---|
| T4R-01 | Ctrl/Cmd+G 创建组，组拖动/缩放/拖入拖出/复制删除 | 已覆盖 | `grouping.ts`、store 单测与 `canvas.spec.ts` 组操作 E2E |
| T4R-02 | 未登录使用本地渠道生图不再卡在生成中 | 等价且有意不同 | Auth-off 本地模式可直连；账号模式统一登录墙。有用户后不再允许匿名数据面访问，避免 UI 登录墙被 API 绕过 |
| T4R-03 | 普通节点提示词框 `@` 引用定位、缩略图和连续输入 | 已覆盖 | `PromptChipInput.tsx`、`prompt-references.test.ts`；节点条已接入共享渠道与持久任务门控 |
| T4R-04 | 展开多个提示词源后拖动画布不卡顿 | 已覆盖 | `CanvasPromptsPanel` 只订阅稳定的 prompts slice；1000 条目录回归证明无关画布状态不会改变 selector 结果，避免拖动期间重渲染整个目录 |
| T4R-05 | 连续鼠标按键后不会持续拖动画布 | 已覆盖 | `gesture.test.ts` 与 lost-pointer-capture / Escape E2E |
| T4R-06 | 提示词详情不显示 Markdown 原始标记 | 已覆盖 | 使用 `react-markdown` + GFM；禁用 raw HTML、危险协议和正文远程图片，复制/插入仍保留原始 body |
| T4R-07 | 节点悬浮工具栏样式和窄空间可用性 | 已覆盖 | 紧凑工具栏及窄视口 E2E |
| T4R-08 | 长模型名不挤压提示词发送按钮/摄像机面板 | 已覆盖 | compact node controls E2E；模型下拉和发送操作分区 |
| T4R-09 | SSRF、鉴权默认值、媒体访问与 CI P0 加固 | 本地更强 | 远程内容边界、短期媒体引用、optional 数据面登录要求、零用户 bootstrap token、CI 安全审计均已覆盖 |

## 4. 全量功能差异结论

### 4.1 已覆盖或本地更强

- 无限画布、多项目、组、撤销重做、节点连线、小地图、左右面板和素材拖入。
- 文本、图片、配置、视频、音频、全景与导演台节点。
- 全景生成/导入/查看、摄像机控制、3D 导演台、角色/姿势/群演/模型/机位/截图。
- 图片与视频工作台、多任务、分类、历史回填、重试、持久任务恢复。
- 画布助手、公开/个人工作流、AI 工作流草稿。
- 提示词来源、公共/个人提示词、图片预览和服务器素材库。
- 注册登录、Linux.do OAuth、管理员后台、用户/额度/模型成本/AI 日志。
- 共享渠道、模型拉取/测试、权重/超时、普通用户云渠道权限。
- 用户 S3/R2、租户存储池、登录迁移、PostgreSQL/Redis 正式存储。
- New API URL 自动配置；公网环境使用 fragment，legacy query 只允许 loopback，安全性强于直接在公网 query 携带 key。
- 本地额外提供插件 SDK、Browser Runtime/MCP、Codex/Claude 面板和 WebDAV 工作区备份。

### 4.2 确认未实现或部分覆盖

| GAP | 差异 | 状态 | 决策 |
|---|---|---|---|
| R4-GAP-01 | 已软删除的生成任务可被旧客户端更新复活 | 已修复 | 查询过滤墓碑，创建/更新返回 `ErrGone`，API 映射 410；清理仅处理 `status='deleted'` 的过期墓碑 |
| R4-GAP-02 | 提示词详情安全渲染 Markdown | 已覆盖 | GFM 安全渲染，原始 HTML、危险链接和正文远程图片均不执行/加载 |
| R4-GAP-03 | 图片工作台比例选择 | 已覆盖 | 1:1、3:2、2:3 预设按 provider capability 映射；自定义尺寸独立保留 |
| R4-GAP-04 | 工作台模型偏好 | 已覆盖 | `preferredModels[channelId][kind]` 分渠道与类型持久化，下架模型回落合法默认 |
| R4-GAP-05 | 管理渠道模型差异选取 | 已覆盖 | 拉取后展示新增/已有/移除，勾选确认前不修改现有配置 |
| R4-GAP-06 | 产品内用户帮助 | 已覆盖 | 新增 `/help` 及桌面/移动导航入口，内容基于本项目行为独立编写 |
| R4-GAP-07 | APIMart `doubao-seedream-5-0-pro` 精确适配 | 已覆盖 | 1K/2K、比例、单输出和最多 10 引用使用专用校验/JSON |
| R4-GAP-08 | APIMart `gemini-3.1-flash-lite-image` / `nano-banana-2-lite` | 已覆盖 | 精确别名、1K、比例、最多 14 引用及专用 JSON |
| R4-GAP-09 | APIMart `kling-3.0-turbo` 精确适配 | 已覆盖 | 3–15 秒、720p/1080p、最多一个首帧、3072 提示词上限；不继承 Kling v3 扩展字段 |
| R4-GAP-10 | APIMart `happyhorse-1.1` 精确适配 | 已覆盖 | 3–15 秒、五种比例、720P/1080P、首帧与 1–9 多图互斥 |
| R4-GAP-11 | APIMart `Agnes` 图片/视频最新参数 | 有意未支持 | 官方公开契约不足，前后端继续 exact fail-closed，不用相近模型冒充 |
| R4-GAP-12 | SQLite / MySQL 正式数据库后端 | 未实现、有意不同 | 不进入当前开发队列；正式部署继续 PostgreSQL + Redis，出现明确单文件/客户数据库需求后另立项 |
| R4-GAP-13 | 登录后按 `updatedAt` 自动覆盖式多设备合并 | 有意不同 | 保持指纹冲突 + 显式迁移；若要增强，做字段级/操作级合并，不做静默 last-write-wins |
| R4-GAP-14 | 账号模式仍允许未登录访客使用本地渠道和本地画布 | 有意不同 | 保持登录墙与服务端数据面一致；仅 auth-off 本地部署保留无账号模式 |

### 4.3 不应误列为缺口

- Tiger 功能文档明确写着“后端已有用户接口、前端尚无用户管理页”，本地已经有完整管理 UI。
- Tiger 服务器素材库也主要保存 URL/文本，尚无文件上传，因此本地不是落后项。
- Tiger 导演台截图默认只保存在当前浏览器；本地已有受保护的服务端 capture 存储，属于增强。
- Tiger 移动端触控尚未系统完善；本地已有移动视口和触控 E2E。
- 技术栈、视觉、品牌、默认提示词内容和内置资产不属于功能追平范围。

## 5. 实施计划

### Phase A — 生成任务墓碑正确性（P0，0.5–1 天）

- [x] PostgreSQL 回归覆盖删除后查询、旧客户端更新、同 ID 创建和清理条件。
- [x] `GetGenerationJob` 默认过滤 `deleted_at`，普通 API 不暴露墓碑。
- [x] `PutGenerationJob` / `CreateGenerationJob` / 服务端任务创建对墓碑返回 `ErrGone`，不提供隐式 undelete。
- [x] purge 同时要求 `status='deleted'` 与过期 `deleted_at`。
- [x] API 将 `ErrGone` 映射为 410；前端停止恢复轮询并清理本地状态。

验收：已删任务不能被恢复轮询、旧标签页或恶意 PUT 复活；保留期清理只处理真实墓碑。

### Phase B — v0.4.5 回归基线（P0，0.5–1 天）

- [x] 固定 Tiger `v0.4.5@9435f1c` 的公开行为清单。
- [x] 增加 1000 条提示词的 selector 稳定性回归；画布拖动不再订阅/重渲染大目录。
- [x] 本地直连即时结果、异步任务、失败和恢复已有自动化契约覆盖。
- [x] `@` 引用连续输入、定位、删除 chip 和缩略图已有组件/E2E 覆盖。
- [x] 本轮状态同步到 `FEATURE_PARITY.md`，旧 `v0.4.4` 标为历史基准。

验收：所有 v0.4.5 新增行为均有本地自动化映射；性能用可重复数值判断，不用主观“感觉不卡”。

### Phase C — 提示词详情 Markdown（P1，0.5 天）

- [x] 测试覆盖标题、列表、粗体、删除线、代码和表格等 GFM 展示。
- [x] 使用 `react-markdown`；不启用 raw HTML。
- [x] 外链限制安全协议并带隔离属性；正文图片不远程加载。
- [x] 复制、插入画布和加入素材仍使用原始 prompt body。
- [x] 长内容/代码/表格使用有界滚动，弹窗沿用统一 Escape 层级。

验收：展示友好且不改变实际提示词内容；XSS/危险协议 fixture 全部被拒绝。

### Phase D — 创作与管理 UX 补齐（P1，1–2 天）

- [x] 图片工作台增加常用比例预设，并保留不被重渲染覆盖的自定义尺寸。
- [x] 增加 `preferredModels[channelId][kind]`，按渠道/类型记忆并处理模型下架回落。
- [x] 模型拉取显示新增/已有/移除差异，确认后才更新；空 API Key 继续沿用加密密钥。
- [x] 增加 `/help`，覆盖登录、画布、节点、提示词、素材、工作台、导演台和部署模式。
- [x] 补偏好迁移、渠道切换、模型下架、比例选择和可访问标签测试。

验收：用户不再靠记忆输入常用像素尺寸；模型偏好跨刷新恢复；管理员拉取模型不会无提示覆盖已有清单。

### Phase E — APIMart 精确模型契约（P1/P2，1–3 天/模型族）

- [x] 核验 Seedream 5 Pro、Gemini Flash Lite/Nano Banana 2 Lite、HappyHorse 1.1 与 Kling 3.0 Turbo 的官方精确契约。
- [x] 仅契约完整的模型进入前后端 capability；Agnes 保持 unsupported。
- [x] 精确 keyset/边界 fixture 叠加通用 adapter 的失败、限流、超时、取消、轮询、恢复与脱敏测试。
- [x] adapter 只做精确模型匹配，不使用包含/前缀模糊匹配。
- [x] 真实付费 smoke 保持 opt-in，不进入默认 CI。

优先级：官方契约最完整的模型先做；不要按 Tiger 的营销名称反推协议。

### Phase F — 产品差异守卫（P2，0.5 天）

- [x] 帮助页明确区分 `auth-off` 与 `optional/required` 账号模式。
- [x] optional 模式覆盖 projects/state/blobs/shared-channels 匿名 401 矩阵。
- [x] 本计划将 SQLite/MySQL 与静默时间戳覆盖合并记录为有意不同。
- [x] clean-room 审计通过，未引入 Tiger 源码、视觉资产、提示词内容或实现结构。

## 6. 推荐执行顺序

1. 先完成 Phase A；生成任务墓碑是数据正确性问题，优先级高于功能追平。
2. 再完成 Phase B，确认 v0.4.5 没有被静态审查漏掉的行为问题。
3. Phase C 与 Phase D 是明确、可独立交付的用户体验缺口。
4. Phase E 按官方契约成熟度逐模型推进，不追求“名称上全支持”。
5. Phase F 与文档收尾一起完成；SQLite/MySQL 和静默时间戳合并不进入本轮开发。

## 7. 完成定义

- Tiger `v0.4.5` 的每个公开新增行为都有本地自动化测试或明确的有意不同说明。
- 已删生成任务不能被旧客户端复活，也不会在“复活”后被保留期任务误删。
- 提示词详情不显示 Markdown 原始标记，且不存在 raw HTML/XSS 回归。
- 图片比例、最近模型和渠道模型差异选择可跨刷新稳定工作。
- 所有宣称支持的 APIMart 精确模型都有前后端一致 capability 和完整契约测试。
- 未核验模型继续 fail-closed，不以相近模型冒充。
- 文档基准、主干代码和 PM2 实际部署版本一致。

PM2 验证不是单独执行 `pm2:start`：先确认工作区干净且
`HEAD == origin/main`，再运行 `bun run pm2:build`，
再运行 `bun run pm2:start`，随后核对 `HEAD == origin/main`、两个 OpenBoard
进程均为 online、携带 `Authorization: Bearer $OPENBOARD_TOKEN` 的
`/api/health` 为 200，以及 5173 返回的入口 asset 与刚生成
的 `web/dist-local` 一致。`pm2:start` 本身只 reload 已有构建产物。
