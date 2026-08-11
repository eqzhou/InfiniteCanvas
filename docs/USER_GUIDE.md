# OpenBoard 用户指南：Agent Skills、视频生成与影视模式

这份指南面向实际使用 OpenBoard 的用户，覆盖本轮新增的两组能力：

- 在画布 Agent 中管理本机 Codex Agent Skills；
- 在视频工作台和视频配置节点中使用比例、清晰度、尺寸联动；
- 从原稿导入到分镜、生成、时间线、质检和交付的影视模式主链路。

工程验证和上游差异记录请看 [`FEATURE_PARITY.md`](FEATURE_PARITY.md) 与
[`UPSTREAM_GAP_PLAN_7.md`](UPSTREAM_GAP_PLAN_7.md)。

## 1. 最短可用路径

### 1.1 启动本地 Agent 服务

Agent Skills 和 Codex 会话由 Go 本地服务执行。先确认机器上已经安装并能在终端运行
`codex`，然后在仓库根目录打开一个终端：

```bash
cd server

# 可选但推荐：明确指定 Codex 可执行文件和 Skills 目录。
export OPENBOARD_CODEX_BIN="$(command -v codex)"
export OPENBOARD_CODEX_SKILLS_ROOT="$HOME/.codex/skills"

# 本机单用户模式。若你已有统一的 .env 启动方式，也可以使用其中的值。
export OPENBOARD_AUTH_MODE=off
export OPENBOARD_TOKEN="$(openssl rand -hex 32)"

go run ./cmd/server
```

默认地址是 `http://127.0.0.1:8790`。如果已经有长期运行的服务，不要重复启动；只要确认
该地址的 `/api/health` 可以访问即可。

### 1.2 启动网页并连接

另开一个终端启动网页：

```bash
cd web
bun run dev
```

打开 `http://localhost:5173`，在顶部打开“画布 Agent”：

1. “本地地址”填写 `http://127.0.0.1:8790`；
2. 如果服务设置了 `OPENBOARD_TOKEN`，把同一个值填入“连接令牌”；
3. 点击“连接”，确认状态显示“已连接”；
4. 切换到 `Codex`，点击“启动 Codex 会话”。

没有启动 Codex 会话时，Skills 仍然可以查看、编辑和启停，但不能点击“显式调用”。

> 安全提示：本地 Agent 会以运行 Go 服务的操作系统用户身份执行 CLI。个人电脑建议保持
> `OPENBOARD_ADDR` 为 loopback，不要把 `8790` 直接暴露到局域网或公网。

## 2. Agent Skills

### 2.1 它解决什么问题

Agent Skill 是一份可复用的 Markdown 工作流说明。例如可以把“审查代码并运行测试”、
“整理画布中的分镜”或“生成发布前检查清单”保存成 Skill，在不同画布或会话中重复使用。

OpenBoard 提供以下操作：

- 查看本机 Skills；
- 从当前画布和目标生成可编辑草稿；
- 新建或编辑 `SKILL.md`；
- 启用、停用和删除；
- 在当前 Codex 会话中显式调用。

“启用”表示该 Skill 的文件处于可用状态；真正把它用于当前请求时，请点击该行的播放按钮
“显式调用”。显式调用会把 Skill 内容作为工作流说明送入当前会话，不会提升权限，也不会
绕过当前会话的审批规则。

### 2.2 在界面中创建一个 Skill

1. 打开“画布 Agent”，连接本地 Agent 服务并切换到 `Codex`。
2. 展开“Agent Skills”区域。
3. 在“草稿目标或对话补充”中输入目标，例如：

   ```text
   检查当前项目的 TypeScript 类型、单测和生产构建，并按严重程度汇总问题
   ```

4. 点击“草稿”。草稿会读取当前画布名称、节点类型和上面的目标。
5. 检查生成的 `Skill id`、名称、描述和正文；需要时直接编辑文本。
6. 点击“保存”。新 Skill 默认启用。
7. 确认 Codex 会话已经启动后，点击播放按钮显式调用。

草稿只是起点。它不会自动猜测画布中没有提供的文件、凭据或业务规则；保存前应检查
`When to use`、`Workflow` 和 `Output` 三部分是否符合你的实际流程。

### 2.3 手动创建文件

OpenBoard 默认读取：

```text
$HOME/.codex/skills/<skill-id>/SKILL.md
```

例如，下面的 Skill 会要求 Codex 先检查测试，再给出风险分级：

```bash
export OPENBOARD_CODEX_SKILLS_ROOT="$HOME/.codex/skills"
mkdir -p "$OPENBOARD_CODEX_SKILLS_ROOT/review-code"

cat > "$OPENBOARD_CODEX_SKILLS_ROOT/review-code/SKILL.md" <<'EOF'
---
name: Review Code
description: 审查代码质量、测试覆盖和高风险问题。
---

# Review Code

## When to use

当用户要求审查或修复代码时使用。

## Workflow

1. 先读取相关文件和测试，确认问题可以复现。
2. 按正确性、安全性、可维护性和测试缺口分类检查。
3. 修改前说明范围；修改后运行相关测试和构建。
4. 输出文件、证据、剩余风险和验证命令。

## Output

先给结论，再给严重程度、文件位置和可复现证据；不要把未验证的推断写成事实。
EOF
```

创建或修改文件后，在 Skills 面板点击刷新。若同时存在同一目录下的
`SKILL.md` 和 `SKILL.md.disabled`，该 Skill 会被视为无效，不会显示在列表中。

### 2.4 Skills 目录和内容规则

| 项目 | 规则 |
|---|---|
| 根目录 | 默认 `$HOME/.codex/skills`；可用 `OPENBOARD_CODEX_SKILLS_ROOT` 指定一个绝对或相对路径 |
| Skill ID | 只能以字母或数字开头，后续使用字母、数字、`_`、`-`；最长 64 个 ASCII 字符 |
| 启用文件 | `<id>/SKILL.md` |
| 停用文件 | `<id>/SKILL.md.disabled` |
| 单个正文 | 最多 160 KiB，必须是有效 UTF-8，不能包含 NUL 字节 |
| 数量 | 最多 256 个 Skill |
| 总正文大小 | 最多 64 MiB |
| 文件安全 | 根目录、Skill 目录和 `SKILL.md` 必须是真实目录/普通文件，符号链接会被拒绝或跳过 |

`SKILL.md` 的 front matter 不是复杂 YAML 配置，只需要单行的 `name` 和 `description`：

```markdown
---
name: 画布分镜检查
description: 检查当前画布的镜头顺序、参考素材和生成参数。
---
```

如果没有 front matter，列表会使用 Skill ID 作为名称，并尝试使用第一个 Markdown 标题作为
描述。建议名称和描述保持单行，名称不超过 128 个 UTF-8 字节，描述不超过 512 个字节。

### 2.5 配置环境变量

在启动 Go 服务的同一个 shell 或服务管理器中设置：

```bash
# Codex CLI；未设置时服务会尝试使用 PATH 中的 codex。
OPENBOARD_CODEX_BIN=/absolute/path/to/codex

# OpenBoard 管理的本机 Skills 根目录；留空则使用 $HOME/.codex/skills。
OPENBOARD_CODEX_SKILLS_ROOT=/absolute/path/to/.codex/skills

# Codex 工作目录的允许根目录，与 Skills 根目录是两回事。
OPENBOARD_AGENT_WORKSPACE_ROOTS=/absolute/path/to/your/project
```

修改 `OPENBOARD_CODEX_SKILLS_ROOT` 后必须重启 Go 服务，因为根目录在服务启动时解析。
`OPENBOARD_AGENT_WORKSPACE_ROOTS` 只限制 Codex 工作目录，不会改变 Skills 的存储位置。

### 2.6 在 Agent 输入框引用 Skill 和画布素材

输入 `/` 会打开当前可用 Skill 建议，输入 `@` 会列出当前画布可引用的素材。选择后，引用会
作为结构化上下文随消息保存；重新打开历史任务仍能恢复，不依赖肉眼解析消息文本。若素材
已删除或不再属于当前项目，恢复时会明确忽略无效引用，不把它交给 Agent。

长提示词可以从节点工具栏打开大编辑器，修改会同步回节点草稿。多图结果可选择主图、展开、
逐项下载/复制/删除或重试失败项。选择与移动是持久工具；按住空格或 Control 只做临时反转，
焦点位于输入框、文本区或可编辑内容时不会触发画布快捷键。

默认根目录最好与 Codex CLI 的默认 Skills 目录保持一致。如果使用自定义根目录，OpenBoard
界面的“显式调用”仍然会读取并注入该目录中的内容；不要据此假设 Codex CLI 的其他自动发现
机制也会自动扫描这个自定义目录。

### 2.6 权限边界和账号模式

- 主机级 Skills 只对本机/guest Agent 连接开放；账号会话访问时会返回禁止访问。
- `OPENBOARD_AGENT_ACCOUNT_EXECUTION=true` 可以在受信任的账号部署中开放部分本机 CLI 能力，
  但不会让账号会话获得主机 Skills 读写权限。
- Skill 文本是工作流说明，不是系统指令，也不能把会话权限从只读改成完全访问。
- “完全访问”权限模式会允许 Codex 绕过沙箱访问工作区外文件，只有在明确理解风险时才使用。
- 不要把 API Key、密码、Cookie、个人令牌或生产数据写进 Skill；Skill 文件是本机明文文件。

### 2.7 常见问题

| 现象 | 处理方法 |
|---|---|
| Skills 列表为空 | 确认 Agent 已连接；确认根目录下是 `<id>/SKILL.md`，而不是直接放在根目录 |
| 保存时报目录无效 | 根目录不能是符号链接；先创建真实目录并重启 Go 服务 |
| 点击播放没有反应 | 先启动 Codex 会话；停用的 Skill 也不能调用 |
| 保存冲突 | 另一个窗口或外部编辑器修改过文件；点击刷新，重新打开后再保存 |
| 账号模式返回 403 | 这是主机 Skills 的设计边界；改用本机/guest 连接，不要把它当成租户数据存储 |
| 手动修改没有显示 | 点击面板刷新；同时检查是否同时存在 `SKILL.md` 和 `.disabled` 文件 |

### 2.8 高级 API（可选）

一般使用界面即可。需要脚本化时，可以调用本地服务的以下端点；命令行请求需要使用
`OPENBOARD_TOKEN`，同源浏览器请求则使用当前连接的认证边界。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/codex/skills` | 列出 Skills，不返回正文 |
| `GET` | `/api/codex/skills/{id}` | 读取一个 Skill 正文 |
| `POST` | `/api/codex/skills` | 创建，JSON 为 `{"id":"review-code","content":"..."}` |
| `PUT` | `/api/codex/skills/{id}` | 更新；必须带返回结果中的 `If-Match: <version>` |
| `POST` | `/api/codex/skills/{id}/toggle` | 启停；JSON 为 `{"enabled":true}`，也需要 `If-Match` |
| `POST` | `/api/codex/skills/{id}/invoke` | 读取启用的 Skill，返回显式调用内容 |
| `DELETE` | `/api/codex/skills/{id}` | 删除；需要 `If-Match` |

例如查看列表：

```bash
curl --fail \
  -H "Authorization: Bearer $OPENBOARD_TOKEN" \
  http://127.0.0.1:8790/api/codex/skills
```

更新、启停和删除必须使用最新版本值，避免一个窗口覆盖另一个窗口刚保存的内容；发生
`409` 时先重新获取详情。

## 3. 视频比例、清晰度和尺寸

### 3.1 配置渠道和模型

先在“设置”中为视频配置一个可用渠道、服务 URL、协议、密钥和模型。回到视频工作台后，
“渠道”和“模型”决定可选的比例与清晰度；已知模型会显示其能力表，未知或自定义模型会
保留当前值，但最终请求仍必须符合服务商契约。

### 3.2 使用视频工作台

打开 `/workbench/video` 或从顶部工作台入口进入：

1. 选择渠道和模型。
2. 填写提示词，必要时拖入参考图片、视频或音频。
3. 选择“比例”，例如 `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`21:9` 或“自适应”。
4. 选择“清晰度”，例如 `480p`、`720p`、`1080p` 或 `4K`；实际选项以模型能力为准。
5. 查看“自动尺寸”，确认它符合横屏、竖屏或方形交付要求。
6. 按需设置秒数、智能时长、生成声音、水印和参考模式，然后点击“开始生成”。

工作台会把比例、清晰度和派生尺寸一起写入生成历史。历史记录可以重试、回填设置，或
把结果插入当前画布。

### 3.3 使用视频配置节点

画布中的视频节点和视频配置节点也使用相同的比例/清晰度能力表：

1. 选中节点，确认它使用的渠道和模型。
2. 设置“视频比例”和“清晰度”。
3. 默认“自定义尺寸”为空时，尺寸由这两个值自动推导。
4. 如果必须使用服务商要求的特殊尺寸，在“自定义尺寸”中输入，例如 `720x1280`。
5. 想恢复自动联动时，清空“自定义尺寸”，再修改比例或清晰度确认尺寸已重新计算。

当用户手动填写过尺寸后，再改变比例或清晰度不会覆盖这个明确值；没有手动覆盖时，改变
任一选择会自动更新尺寸。这避免了用户已经指定的特殊尺寸被下拉选择意外覆盖。

### 3.4 自动尺寸示例

下面是模板/像素尺寸语义下的常见推导示例：

| 比例 | 清晰度 | 自动尺寸 |
|---|---:|---:|
| `16:9` | `720p` | `1280x720` |
| `16:9` | `1080p` | `1920x1080` |
| `9:16` | `720p` | `720x1280` |
| `9:16` | `1080p` | `1080x1920` |
| `1:1` | `1080p` | `1080x1080` |
| `4:3` | `720p` | `960x720` |
| `3:4` | `720p` | `720x960` |
| `21:9` | `1080p` | `2520x1080` |

`adaptive` 或无法识别的比例不会被错误地当成 `16:9`；此时界面显示“由模型决定”。
如果当前模型不支持保存的比例或清晰度，已知能力表会把它归一化为该模型的第一个可用值；
未知模型会暂时保留自定义值，服务商可能在请求时拒绝它。

### 3.5 不同协议的尺寸语义

通常不需要手动关心协议转换，但排查请求参数时可以按下面理解：

| 协议 | OpenBoard 发送方式 |
|---|---|
| APIMart | `size` 保留服务商的原生比例语义，例如 `9:16`；清晰度单独传递 |
| Ark/Seedance | 直接传 `ratio` 和 `resolution`，`size` 不承担尺寸语义 |
| Template 及其他像素尺寸适配器 | 使用比例和清晰度推导的像素值，例如 `720x1280` |

因此，同一个界面选择在不同协议下可能产生不同的底层 `size` 字段，这是适配器行为，不是
画布尺寸被改写。

### 3.6 推荐设置

```text
竖屏短视频预览：比例 9:16，清晰度 720p，时长 5 秒
竖屏交付成片：比例 9:16，清晰度 1080p，按模型限制设置时长
横屏分镜预览：比例 16:9，清晰度 480p 或 720p
方形社交素材：比例 1:1，清晰度 720p 或 1080p
```

先用较低清晰度验证提示词、参考图和镜头运动，再提高到目标清晰度，可以减少失败请求和
不必要的额度消耗。

## 4. 影视模式完整主链路

### 4.1 开关与能力诊断

影视模式默认启用。`OPENBOARD_FILM_MODE=false` 会关闭所有 `/api/film/*`
业务路由，但不会删除已有影视项目。MP4 是单独的可选能力：

```bash
bun run diagnose:media
curl --fail http://127.0.0.1:8790/api/film/capabilities \
  -H "Authorization: Bearer $OPENBOARD_TOKEN"
```

本地/PM2 会优先使用 `.env` 中的 `OPENBOARD_FFMPEG_PATH` 和
`OPENBOARD_FFPROBE_PATH`，未设置时从 `PATH` 发现，并把符号链接解析为真实的可执行绝对
路径。两个 `-version` 探针都通过才启用 MP4；任一个缺失或失败时，启动继续，只把
`mp4Export` 置为不可用并返回 `mp4Diagnostic`。文本导入、项目编辑、Provider 生成、清单、
SRT、资产包和 OpenBoard 其他服务不受影响。容器镜像已固定并设置
`/usr/bin/ffmpeg`、`/usr/bin/ffprobe`。

`OPENBOARD_FILM_IMPORT_MAX_BYTES` 控制原稿上传边界（样例默认 50 MiB），
`OPENBOARD_FILM_RENDER_TIMEOUT_SECONDS` 控制一次 MP4 组装的超时（样例默认 900 秒，
接受 1–3600）。修改后重启服务，并重新查看 capability；不要把这两个资源边界当作
绕过 Provider 自身限制的手段。

### 4.2 原稿导入：文本、DOCX 与 PDF 文本层

从首页“新建”选择“影片制作”，或打开已有 `/film/<project-id>` 项目。原稿区支持直接
粘贴文本，也支持受大小/结构限制的文本、Markdown、DOCX 和 PDF 导入：

- DOCX 读取 OOXML 主文档中的文本，不执行宏、脚本或外部关系；损坏、路径不安全、重复
  条目、异常压缩比或展开超限的文件会被拒绝。
- PDF 只提取已有文本层。扫描件或没有可用文本层的 PDF 会提示先 OCR；OpenBoard 不会
  在服务端静默做 OCR，也不会把任意 PDF 交给外部 Provider。
- PDF 文本层由本机 Poppler `pdftotext` 在隔离临时目录中解析。容器已固定安装对应版本；
  容器通过 Bubblewrap 禁网、只读挂载并限制资源。本地/PM2 必须通过
  `OPENBOARD_PDF_SANDBOX_PATH` 指向可信的受限执行包装器；缺失时只关闭 PDF 导入并显示诊断。
- 先在可信工具中完成 OCR，再导入新的带文本层 PDF；保留原件和 OCR 版本用于追溯。

粘贴文本或选择 TXT/Markdown 后，先点“预检原稿”。预检只显示集数、场数、字符数、摘要
和警告，不写入影视事实；确认后再点“采用确定性拆解”。DOCX/PDF 在服务端完成受限解析。
导入成功后，“拆解”进入 `needs_review`。检查集、场、镜头和顺序，再批准该阶段。上游
原稿或拆解结果发生变化时，下游阶段会按依赖关系回到待复核状态，避免沿用过期交付物。

需要更完整的故事理解时，在“AI 故事拆解”中选择管理员提供的共享文字渠道和模型。AI
结果会冻结原稿修订、渠道、模型、提示词与输出结构，只保存为候选；先查看摘要和实体数量，
再“采用这个候选”。原稿已变化的候选会标记为过期，不能覆盖新修订。故事结构批准后，
“AI 分集剧本”可按集生成另一组候选，同样需要采用和阶段审批。Provider 失败不会静默
回退为确定性结果。

### 4.3 阶段顺序、Provider 依赖与人工复核

主链路为：

```text
原稿 → decompose → script → storyboard ─┬→ audio ─┐
                                        └→ video ─┴→ compose → delivery
```

`audio` 与 `video` 都依赖已批准的 `storyboard`，可以分别推进；`compose` 同时依赖两者。
每个阶段都应检查修订号、状态和质量报告后再批准。镜头级生成支持只跑选定范围、幂等键、
失败子任务重试和 `needs_review` 回收，不应把“Provider 已返回”视为自动批准。

图片、视频和音频生成模型必须来自“媒体能力目录”。目录由管理员已启用的共享渠道生成，
同时给出模型、生成模式、尺寸、时长和参考素材数量；目录加载失败或模型未声明时，入口保持
关闭，不会猜测兼容性。费用预估、GenerationJob 和恢复数据都会记录当时的目录版本。
普通用户选择共享渠道时不需要、也不能重复填写管理员已经配置的密钥。

Provider 依赖按能力分开：

| 工作 | 必需依赖 | 无依赖时的行为 |
|---|---|---|
| 原稿导入、拆解、编辑、质量检查 | PostgreSQL/受保护媒体存储 | 正常可用，不需要 Provider 密钥 |
| 分镜图生成 | 活跃渠道的图片模型与有效凭据 | 仅 storyboard 生成不可用 |
| 音频生成 | 活跃渠道的音频模型与有效凭据 | 仅 audio 生成不可用 |
| 视频生成 | 活跃渠道的视频模型与有效凭据 | 仅 video 生成不可用 |
| manifest/SRT/asset bundle | 已保存的影视文档和媒体 | 不需要 FFmpeg 或 Provider |
| MP4 时间线成片 | FFmpeg + FFprobe 探针、足够 `/data` 空间 | 仅 MP4 关闭，并显示诊断 |

真实 Provider 调用可能收费、受区域/配额/内容策略影响，凭据只在部署端配置。CI 的影视
Chromium 主链路使用本地隔离数据和 mock，不要求也不读取真实 Provider 凭据。

### 4.4 Director 构图与画布往返

在场景列表选择一个影视场景后，可创建或定位对应的受管 Director 节点。该动作只管理带稳定
投影键的系统节点，不覆盖用户自建节点、布局或 Director 内容。完成机位、角色站位、环境和
截图后，从同步截图中选择正式版本，并采用为目标镜头的分镜或首帧。

采用时服务端会校验租户、项目、Director 节点、场景/镜头修订、PNG 内容、摘要与对象版本，
然后复制到稳定的 Film 媒体命名空间。删除临时截图不会破坏已采用镜头；manifest、质量检查、
项目恢复与后续生成仍保留场景、相机、截图和任务来源版本。

### 4.5 时间线、质量与交付

在“时间线”检查 video、dialogue、music、sfx、subtitle 五轨。轨道区提供刻度、播放头、
拖动、边缘缩放、吸附和键盘微调；精确表单仍用于确认入点早于出点、裁剪、音量、淡入淡出、
字幕文本和输出尺寸/帧率。移动端使用可横向滚动的轨道，避免不可靠的精细手势。拖动结束后
才形成一次草稿变更；保存冲突时刷新最新修订再合并，不要覆盖另一窗口的新版本。

交付前运行质量检查并处理阻断项，然后按需生成：

- `manifest`：结构化制作清单；
- `srt`：字幕文件；
- `asset_bundle`：受保护资产包；
- `mp4`：按当前时间线本地组装的成片，仅在 capability 允许时可用。

交付请求使用新的幂等键；同一键不能复用于不同内容。下载后核对文件大小、摘要记录、字幕
同步和实际播放。FFmpeg 超时、空间不足或输入容器不合规时，保留其他交付物，修复诊断后
重试 MP4，不需要重建项目。

### 4.6 影视项目的备份与恢复边界

影视文档、阶段状态和交付索引在 PostgreSQL；源媒体、生成结果和交付文件在 `/data` 或
配置的 S3/R2；Provider/对象存储秘密依赖 `OPENBOARD_MASTER_KEY` 解密。完整恢复必须使用
同一时点的数据库、媒体存储和 master key。Redis 只是缓存。WebDAV 工作区备份会省略
Provider 凭据，不能替代部署级备份。Compose/PM2 的停写、备份、恢复和版本回滚命令见
根目录 [`README.md`](../README.md#deployment-runbook-capability-backup-restore-and-rollback)。

## 5. 导出或迁移前的检查清单

- Agent 服务仍在运行，且连接地址和令牌没有写入画布内容或截图。
- Skill 中没有秘密信息；要迁移时单独备份本机 Skills 根目录。
- 视频节点的“自定义尺寸”是否有意覆盖了自动联动；不需要时清空它。
- 生成历史中的渠道、模型、比例、清晰度和参考素材是否仍然可用。
- 影视项目的下游阶段是否因原稿/镜头变更回到待复核，质量报告是否已处理。
- MP4 交付前是否确认 `mp4Export=true`、`/data` 余量以及 FFmpeg/FFprobe 诊断。
- 部署迁移是否同时备份 PostgreSQL、媒体存储和 `OPENBOARD_MASTER_KEY`；不要把 Redis 或
  省略凭据的 WebDAV 包误当成完整备份。
- 变更环境变量后已重启 Go 服务，并在 Agent 面板点击刷新。
