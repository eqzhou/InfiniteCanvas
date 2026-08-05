# 双上游最新功能差异复审与实施记录（第七轮）

> 审查日期：2026-08-05
>
> Basket：公开 CHANGELOG 当前为 `Unreleased`，最近稳定版本为 `v0.13.0`
>
> Tiger：公开 CHANGELOG 当前为 `v0.5.1`

## 审查边界

继续遵守 clean-room：只读取公开 README、文档、CHANGELOG、Release 说明和提交标题/元数据；不读取两个上游的实现源码、补丁、CSS、资产或截图。实现依据为用户可观察行为和已核验的协议，不复制上游实现或视觉表达。

## 本轮结论

| 上游公开增量 | 本地判断 | 决策 |
|---|---|---|
| Basket v0.13.0 的 Agent 预热、结构化诊断、命令分组、初始化门控、代码块换行、事件归属和缩放稳定性 | 本地已有对应实现，上一轮已验证 | 保持现状，不重复实现 |
| Tiger v0.5.0 的 Agent 收敛、首页入口、全景跨域和比例修复 | Agent 与产品能力已有对应实现；全景使用受管媒体，图片尺寸采用统一缩放因子 | 无对应缺口，不为对齐 changelog 人为制造修复 |
| Tiger v0.5.1 的视频尺寸随比例/清晰度预设联动 | 本地视频工作台和视频配置节点已接入精确能力表；未知服务仍保留自定义值 | 本轮已实现并验证；APIMart 保留原生比例语义，模板服务使用像素预设，Ark 继续直接传比例/清晰度；未知比例不再错误假设 16:9，配置节点的手动尺寸覆盖会保留 |
| Basket 当前 Unreleased 的 Agent Skills 查看、创建、编辑、删除、启停、显式调用和草稿确认 | 本地 Codex 面板和 API 已实现；主机级 Skills 不与账号租户共享 | 本轮已实现并验证；本机/guest 可管理，保存/启停/删除要求版本匹配，调用复用当前 Codex 会话权限与审批 |
| Tiger v0.5.1 的 WebDAV 云端媒体存储 | 本地 WebDAV 只负责项目/工作区备份，媒体后端为文件系统或 S3/R2 | 仅在明确需要 Nextcloud/ownCloud 等自托管媒体存储时投入；不作为本轮快改 |
| MiniMax-H3 转译 | 本地缺失，且当前官方公开文档未提供可独立核验的完整 H3 模型契约 | 维持 fail-closed；取得精确模型标识、字段、限制和错误语义后再接入 |

## 本轮新增：可见画布 PNG 导出

这是独立于两个上游的效率增强：

- 画布工具栏新增“导出画布”，下载当前可见画布为带时间戳的 PNG。
- 新增 `Ctrl/Cmd + Shift + E` 快捷键，并在快捷键帮助中登记。
- 导出复用 Agent 的画布快照渲染器，统一背景、像素比和错误处理。
- 小地图、右键菜单和遮罩层等瞬时控件通过导出过滤标记排除，不会出现在成图中。
- Agent 的 `board.export_snapshot` 也复用同一过滤逻辑，避免两种快照出现不一致。

## 安全与存储决策

- 导出只读取当前画布并触发浏览器本地下载，不新增网络请求，也不改变项目持久化数据。
- 文件名经过现有 MIME 扩展和安全文件名处理；导出失败只在当前浏览器显示错误。
- Agent Skills 本轮实现为主机本地能力：默认目录为 `~/.codex/skills`，可由进程启动环境覆盖；账号会话被拒绝访问，避免把全局目录错误地当成租户资源。Skill 内容和元数据受大小、UTF-8、符号链接、真实目录/文件复核、版本和消息边界约束。
- 提交前依赖审计发现 Vite 间接锁定的 `postcss@8.5.19` 存在[路径穿越公告](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)，已通过 Bun 的直接版本约束和 override 统一到 `postcss@8.5.25`；OSV 审计已重新通过。
- WebDAV 媒体后端后续实现必须额外验证 SSRF、凭据加密、配额、断点/大文件和写入原子性。

## 独立实现与验证面

- Web：`web/src/lib/canvas-export.ts`、`web/src/components/canvas/CanvasToolbar.tsx`、`web/src/components/canvas/BoardCanvas.tsx`。
- Agent Skills：`server/internal/api/codex_skills.go`、`web/src/components/agent/CodexSkillsPanel.tsx`、`web/src/services/codex-skills.ts`、`web/src/services/local-agent.ts`。
- Video presets：`web/src/lib/video-generation-options.ts`、`web/src/components/workbench/CreativeWorkbench.tsx`、`web/src/components/canvas/BoardNodeView.tsx`。
- 单测：`canvas-export.test.ts`、`CanvasToolbar.test.tsx`。
- 浏览器回归：`canvas.spec.ts` 验证工具栏导出 PNG 签名和文件扩展名。
- 类型与全量单测：以本轮命令结果和 CI 为准。
