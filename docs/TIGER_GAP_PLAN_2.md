# Tiger 差异复审与补齐计划（第二轮）

> 审查日期：2026-07-26
>
> 本地基准：`main@61444e1`
>
> 对照基准：`tigerowo/infinite-canvas main@64cb00a6da99a50017abcb2e443166a13364c6c1`（最新 tag `v0.4.4`，另含 Unreleased 分组）
>
> 输入来源：仅使用公开 README、CHANGELOG、`docs/overview/features.md`、`docs/canvas/*.md`、`docs/backend/*.md`。未使用上游源码、资产或视觉表达。

## 1. 本轮结论

`docs/TIGER_GAP_PLAN.md` 记录的 GAP-01..GAP-12 已完成，但那一轮以「渠道协议 / 管理后台 / 存储池 / 迁移」为主线。本轮改为逐条对照上游公开文档的**每一句可观察行为**，发现仍有 20 条未实现或部分实现的差异，集中在四个方向：

1. **全局默认与模型治理**：上游 `public.modelChannel` 提供全局可用模型白名单与各类默认模型；本地只有渠道级默认值，没有租户级白名单与兜底优先级。
2. **音频与视频的默认参数面**：音频缺 `speed`/`instructions`，音视频都缺全局默认配置项。
3. **后台管理面的检索与筛选**：提示词后台无搜索与分组/标签筛选，素材库后台无独立入口，服务器素材库标签筛选只接了一半。
4. **画布交互细节**：四角缩放只有一角，导演台缺天空颜色，节点缺结构化基础信息视图。

另有 2 条属于「有意不同」，需要补记决策而非实现。

## 2. 差异总表

> 状态列为 2026-07-26 实施后的复核结果。

### 2.1 初审判定「未实现」（12 条）

| ID | 差异 | 上游出处 | 状态 | 实现证据 |
|---|---|---|---|---|
| T2-01 | 音频 `speed`（语速）不可配置 | features「可配置项」 | ✅ 已实现 | `ai-client.ts` / `generation_media_client.go` 传 `speed`，0.25–4.0 校验，未设时省略 |
| T2-02 | 音频 `instructions`（指令）不可配置 | features「可配置项」 | ✅ 已实现 | 同上，空值省略以保留 provider 默认 |
| T2-03 | 无全局可用模型白名单 `availableModels` | features「AI 生成」、system-settings | ✅ 已实现 | `site_policy.go` 持久化 + `model-catalog.ts` 收窄，写入端校验默认模型必须在白名单内 |
| T2-04 | 白名单为空时按已启用渠道模型兜底 | features「AI 生成」 | ✅ 已实现 | `resolveSelectableModels`：空白名单或全不匹配时回退到渠道模型，避免零可选 |
| T2-05 | 无全局默认模型及失效兜底优先级 | system-settings | ✅ 已实现 | `resolveDefaultModel` 按 seedream/image/gpt-image、seedance/video 关键词兜底 |
| T2-06 | 视频默认参数不可全局配置 | features「可配置项」 | ✅ 已实现 | `generation-defaults.ts` + `applyGenerationDefaultsToNode`，新节点继承且不覆盖显式值 |
| T2-07 | 音频默认声音与格式不可全局配置 | features「可配置项」 | ✅ 已实现 | 同上，`audio-generation.ts` 统一解析节点值优先 |
| T2-08 | 后台提示词无关键词查询 | features「后台提示词管理」 | ✅ 已实现 | `filterAdminPrompts` + 搜索框 |
| T2-09 | 后台提示词无分组/标签筛选 | features「后台提示词管理」 | ✅ 已实现 | 分类/标签下拉，含「未分类」哨兵 |
| T2-10 | 管理后台无素材库面板 | features「账号和后台」 | ✅ 已实现 | `AdminLibraryPanel.tsx`，管理后台新增「素材库」栏目 |
| T2-11 | 节点四角缩放只实现右下角 | features「节点」 | ✅ 已实现 | `node-resize.ts` 锚定对角，四角手柄 + E2E |
| ~~T2-12~~ | ~~导演台缺天空颜色调节~~ | features「导演台」 | ⛔ 误报，已撤销 | 本地入口名为「环境颜色」→ `scene.background` → THREE 场景背景。初审按 `天空/sky` 检索未命中 |

### 2.2 初审判定「部分实现」（8 条）

| ID | 差异 | 上游出处 | 状态 | 实现证据 |
|---|---|---|---|---|
| T2-13 | 参考视频/音频公开链接拉取 | features「AI 生成」 | ✅ 已实现 | `publicMediaReferenceURL` 铸造短期令牌 URL；无可达 base URL 时 Ark 适配器 fail-closed 并给出可执行提示 |
| T2-14 | AI 日志自动清理 | features「AI 生成」 | ✅ 已实现 | `ai_call_log_retention.go` 可配置保留期 + 每小时扫描；默认关闭，畸形策略不删除 |
| T2-15 | 服务器素材库按标签筛选 | features「素材」 | ✅ 已实现 | 前台补标签控件并传参 |
| T2-16 | 后台内置远程提示词源清单 | features「后台提示词管理」 | ✅ 已实现 | 后台一键添加内置源，已存在的置灰 |
| T2-17 | 工作流 Agent 独立系统提示词 | features「提示词库」 | ✅ 已实现 | `resolveWorkflowAgentSystemPrompt`：管理员可覆盖，留空回落内置默认 |
| T2-18 | 服务器素材库独立详情视图 | features「素材」 | ✅ 已实现 | `LibraryAssetDetailDialog.tsx` |
| T2-19 | 文本节点「编辑」按钮显式开合对话框 | 节点手册 | ⛔ 有意不同 | 本地选中即显示提示词条，少一次点击即可生成；上游的显式开合是交互偏好而非能力差异，追平会让常用路径变慢 |
| T2-20 | 节点结构化「基础信息」视图 | features「节点」 | ✅ 已实现 | `NodeInfoDialog.tsx` 可读摘要 + 原始文档切换，替代 `alert(JSON)` |

### 2.2.1 复审补充（2026-07-26 二次审计新增）

初审的四个分域报告中，有两处子代理明确声明「未做结论」（v0.4.2 模型转译细节、节点悬浮工具栏样式）。补查这些区域时发现一条此前各轮都漏掉的真实缺陷：

| ID | 差异 | 上游出处 | 状态 | 说明 |
|---|---|---|---|---|
| T2-23 | 云端局部编辑/超分对不支持的协议仍提供入口 | CHANGELOG v0.3.2「取消基于 `/images/edits` 的 Mask 方式，改成通用格式，所有图片模型均支持局部编辑」 | ✅ 已修复 | 本地云端 transform provider 对任意配置了 key 的渠道注册，却固定请求 `/images/edits` 与 `/images/upscales`。Gemini/APIMart/KIE/Ark/Template 并不提供这两个端点，用户会拿到一个注定失败的按钮，违反本项目「provider 不支持时禁用对应动作、不静默回退」的既定不变量。现按协议判定能力：非 OpenAI 协议不再注册云端 provider，`capabilities` 如实为 false，且调用前即失败并说明原因 |

### 2.3 有意不同，需补记决策（2 条）

| ID | 差异 | 决策 |
|---|---|---|
| T2-21 | 业务接口统一返回 `{ code, data, msg }`，失败也回 HTTP 200 | 不追平。本地用裸 JSON + HTTP 状态码表达失败，符合 REST 与既有测试契约；改为 envelope 会波及全部端点与前端错误处理，收益仅为形式一致 |
| T2-22 | `modelCosts` 未配置模型的扣费语义 | 保留本地 `defaultCredits` 兜底。上游为「未配置默认不扣除」，本地允许管理员为未知模型设默认价，`defaultCredits=0` 即等价于上游语义 |

### 2.4 明确不追平（沿用上一轮决策）

- 邀请码体系（`aff_code`/`aff_count`/`inviter_id`）：属增长运营功能，不在创作工作台的行为 parity 范围。
- GitHub / 微信登录：本地已有 Linux.do OAuth 与本地账号；新增第三方身份源需要各自的应用注册与密钥治理，无明确部署需求。
- `last_login_at`：无产品需求驱动。
- SQLite / MySQL：见 `docs/TIGER_GAP_PLAN.md` GAP-12。
- 本地直连日志上报：本地直连的定位是「密钥不出浏览器」，把直连调用回传服务端与该定位冲突。
- 画布按表分片存储：本地已通过「autosave 只 upsert 当前标签页存在的项目」达成同等的多标签页安全性（见 `docs/FEATURE_PARITY.md` Multi-tab project catalog isolation），无需改存储结构。

## 3. 实施计划

### Phase A — 模型治理与默认参数（P0，已完成）

- [x] 定义租户级公开模型配置：`availableModels` 白名单、`defaultModel`/`defaultTextModel`/`defaultImageModel`/`defaultVideoModel`/`defaultAudioModel`。
- [x] 实现失效兜底优先级：白名单为空时按已启用渠道模型兜底；默认模型失效时按上游规定的关键词顺序回退。
- [x] 音频链路补 `speed` 与 `instructions`，前后端同构，并做边界校验（speed 0.25–4.0）。
- [x] 音频默认声音/格式、视频默认比例/清晰度/时长/生成声音/水印进入全局配置并可在设置面板编辑。
- [x] 先写失败测试再实现；覆盖白名单收窄、兜底、参数透传与非法值拒绝。

验收：管理员设置白名单后，前台模型选择被收窄；白名单为空时仍可用已启用渠道模型；音频 speed/instructions 到达 provider 请求体；全局默认值被新节点继承。

### Phase B — 后台检索与素材库入口（P1，已完成）

- [x] 后台提示词列表支持关键词查询与分组/标签筛选。目录本就整份取回用于编辑，因此筛选在客户端完成，未新增服务端参数。
- [x] 管理后台新增素材库面板，复用既有 CRUD API。
- [x] 服务器素材库前台补标签筛选控件并传参。
- [x] AI 日志保留策略持久化 + 每小时清理调度，复用提示词调度器的生命周期。

验收：后台可按关键词/分组/标签定位提示词；素材库在管理后台可管理；日志按配置的保留期自动清理，且多实例不重复执行。

### Phase C — 参考素材公开链接（P1，已完成）

- [x] 由服务端在解析任务参数时铸造短期令牌 URL（比前端调用更可靠：持久化任务重启后仍需要可拉取链接）。
- [x] 无法生成公开链接时 fail-closed 并给出可执行提示，不再静默内联大体积 base64。
- [x] 覆盖不可达 base URL、loopback/非 HTTPS 拒绝与令牌不泄露 storage key 的测试。

验收：Ark/Seedance 参考视频/音频通过公开链接传递；不可达部署下明确失败而非超限。

### Phase D — 画布交互细节（P2，已完成）

- [x] 节点四角缩放，锚定对角并保持等比/自由切换语义。
- [x] ~~导演台天空/背景颜色调节~~ —— 复核后确认本地已有（「环境颜色」），无需实现。
- [x] 节点结构化基础信息视图，与原始文档切换并列。
- [x] ~~文本节点对话框显式开合~~ —— 转为「有意不同」，见 T2-19。
- [x] 服务器素材库独立详情视图；后台内置提示词源预置清单；工作流 Agent 系统提示词可配置。

验收：四角均可缩放且不破坏分组与撤销（E2E 已覆盖锚定不动）；上述入口均可键盘访问。

## 4. 横向质量门禁

每个 Phase 均需满足：先 RED 后 GREEN 的 TDD；单元/集成/E2E 齐全；所有外部输入 schema 校验；密钥不进客户端、日志与导出；不可变更新；通过 Bun test/typecheck/build、Go race/vet、Playwright、formal E2E、clean-room、OSV 与 SBOM 审计。

## 5. 实施后验证证据（2026-07-26）

- Web：504 项 Bun 单元/集成测试通过；根目录 typecheck 与 production build 通过。
- Go：`go test ./...`、`go vet ./...` 通过。
- 浏览器：production Chromium 101/101 通过，含四角缩放与节点信息两个新场景。
- Formal：本机 PostgreSQL/Redis 隔离 run 7/7 通过。
- 供应链：clean-room 标识扫描与 OSV 226 包审计通过。
