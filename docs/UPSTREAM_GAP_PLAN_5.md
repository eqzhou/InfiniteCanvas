# 双上游最新功能差异复审与实施记录（第五轮）

> 审查日期：2026-08-01
>
> Basket：最新 release `v0.12.1@6f1b6633b76e485312382f4d916d49af8a23afaa`；current main `ee5804e586a95a3cc127caa37f2b87e6ade5c28f`
>
> Tiger：最新 release `v0.4.5@9435f1c`；current main `2fad4630d7478b630169e85ca35cc678ec57c7c1`

## 审查边界

继续遵守 clean-room：只读取公开 README、文档、CHANGELOG、Release 和提交标题/元数据；不读取两个上游的实现源码、补丁、CSS、资产或截图。实现依据为用户可观察行为和官方协议。

## 本轮结论

| 上游公开增量 | 复核结果 | 本地实施 |
|---|---|---|
| Basket v0.12.1 当前账号模型与推理强度 | 原有界面缺少 | 通过官方 Codex App Server 分页 `model/list` 拉取并严格验证账号可用范围；选择随 `turn/start` 发送，合法偏好写入按租户/用户/profile 隔离的数据库记录；目录失败、为空或偏好失效时由 Codex 使用默认值 |
| Basket current-main 结构化诊断 | 原有日志仅为平铺文本 | Codex/Claude 共用固定筛选、独立滚动、可展开详情和连续重复事件折叠 |
| Basket current-main 日志跟随 | 原有对话有跳转但诊断区不一致 | 对话和诊断统一为“位于底部时自动跟随、向上浏览时暂停、居中回到底部” |
| Tiger v0.4.5 后续增量 | 无新增缺口 | current main 仅明确包含已经覆盖的 Creative Agent 收敛，不重复实现第二套入口 |

## 安全与存储决策

- 模型与推理强度只能来自 app-server 的分页有界目录；请求边界再次校验，拒绝任意长值、重复模型、重复推理强度和不属于对应模型的组合；目录读取采用短期缓存、请求合并和全局并发上限。
- 模型目录不可用不阻断 Codex，会省略覆盖字段并使用 Codex 默认设置。
- 仅保存非敏感偏好，使用按租户/用户/Codex profile 隔离的数据库记录；不增加 `localStorage`、浏览器迁移或新的密钥副本。
- 本轮不接触两个上游源码，也不复制其视觉表达和实现结构。

## 独立实现与验证面

- Web：`CodexModelControls.tsx`、`AgentDiagnosticLog.tsx`、`AgentJumpToLatest.tsx`。
- 协议：`local-agent.ts` 与 Go Codex bridge 的 `model/list` / `turn/start` 边界。
- 单测：模型分页目录与选择、数据库作用域隔离、诊断分类/折叠/跟随阈值、Go app-server 转发。
- E2E：Codex 模型切换、推理强度、结构化重复事件和请求载荷。
- 最终验证结果以本轮 `docs/FEATURE_PARITY.md` 和 CI 为准。
