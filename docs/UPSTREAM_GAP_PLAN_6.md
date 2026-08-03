# 双上游最新功能差异复审与实施记录（第六轮）

> 审查日期：2026-08-02
>
> Basket：最新 release `v0.12.1@6f1b6633b76e485312382f4d916d49af8a23afaa`
>
> Tiger：最新 release `v0.4.5@9435f1c`

## 审查边界

继续遵守 clean-room：只读取公开 README、文档、CHANGELOG、Release 说明和提交标题/元数据；不读取两个上游的实现源码、补丁、CSS、资产或截图。实现依据为用户可观察行为和官方协议。

## 本轮结论

| 上游公开增量 | 复核结果 | 本地实施 |
|---|---|---|
| Basket Agent 对话将同一轮连续命令合并为按数量折叠的命令组，默认隐藏冗长命令预览 | 原有进度时间线逐条展开每个命令，冗长命令占满进度区 | 纯函数 `groupCodexProgress` 将连续 ≥2 条命令类进度项折叠为单个命令组，展示“运行命令 · N”与运行/完成/失败计数，冗长的逐条命令预览默认隐藏在按组展开器后；单条命令与非命令项保持内联 |
| Tiger 宽高比失真修复 | 无本地对应缺陷 | 本地图像尺寸由冻结的 `IMAGE_ASPECT_PRESETS` 直接查表，`upscaleImage`/`fitMediaDisplaySize` 对两个维度使用同一缩放因子，从不各自取整，故不存在该失真 |
| Tiger 全景查看器 CORS 修复 | 无本地对应缺陷 | 本地全景为受管媒体，按 `storageKey` 解析为同源 `blob:`/受管 URL，查看器从不加载上游原始跨域地址，故无 CORS 缺陷 |
| Basket 代码块换行修复 | 无本地对应缺陷 | Codex/Claude 面板的 `MarkdownMessage` 使用 `whitespace-pre-wrap` 的 `<pre>`，无行号高亮改写换行，故无该缺陷 |
| MiniMax-H3 图像模型 | 本地缺失 | 阻塞在 fail-closed 契约上：仅在取得独立可核验的公开 API 契约（精确模型标识与限制）后方可以 `[verified]` 加入；否则维持 fail-closed，不臆造未文档化的模型名 |

## 安全与存储决策

- 命令分组为纯客户端呈现层变换，不改变服务端事件语义、不新增网络请求、不改变权限或审批流程。
- 未取得 MiniMax-H3 的公开契约前维持 fail-closed：未文档化的模型标识一律拒绝，绝不臆造。
- 本轮不接触两个上游源码，也不复制其视觉表达和实现结构。

## 独立实现与验证面

- Web：`web/src/services/codex-progress-groups.ts`（纯分组函数）、`web/src/components/agent/CodexProgressList.tsx`（呈现组件，从 `CodexPanel.tsx` 抽出以控制文件体积）。
- 单测：`web/src/services/codex-progress-groups.test.ts` 覆盖 ≥2 连续命令折叠、单条命令内联、非命令项打断分组、混合序列的有序分组结果与状态计数。
- 类型：`bun run typecheck` 通过。
- 回归：`bun test src benchmarks` 全量通过（新增 8 个分组测试）。
- 最终验证结果以本轮 `docs/FEATURE_PARITY.md` 和 CI 为准。

## 未复刻项与理由

- **Tiger 主页/首页重构**：与本地架构（受管媒体、PostgreSQL 权威存储、单一 `画布 Agent` 入口）不对应，非用户可观察行为缺口。
- **多数上游“修复”类增量**：如上表所述，描述的缺陷源于上游特定实现（各自取整、跨域原图、行号改写），本地架构从不产生对应缺陷，不为对齐 changelog 而人为制造缺陷再修复。
- **MiniMax-H3**：确为缺失能力，但受 fail-closed 契约约束，阻塞在取得公开 API 契约。
