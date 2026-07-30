import {
  Boxes,
  Clapperboard,
  KeyRound,
  LayoutDashboard,
  Library,
  MessageSquareText,
  ShieldCheck,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";

type HelpSection = {
  id: string;
  title: string;
  summary: string;
  steps: readonly string[];
  note?: string;
  links?: readonly { href: string; label: string }[];
  icon: LucideIcon;
};

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: "signin",
    title: "登录与开始使用",
    summary: "部署方式决定你会直接进入 OpenBoard，还是先看到登录墙。进入后，先创建画布并配置一个可用的 AI 渠道。",
    steps: [
      "账号部署：在登录墙完成登录；登录成功后会回到刚才访问的页面。",
      "首次进入画布时创建项目，并在设置中检查模型渠道、接口地址和密钥。",
      "画布、设置、生成记录和受保护媒体统一保存到服务端数据库；刷新或更换浏览器后会按当前账号重新加载。",
    ],
    note: "不要把 API 密钥写进提示词或可分享的画布内容。",
    links: [{ href: "/", label: "前往画布" }],
    icon: KeyRound,
  },
  {
    id: "canvas",
    title: "画布基础",
    summary: "画布是组织创作内容的空间。左侧面板管理项目、元素、素材和提示词，顶部工具栏用于添加内容。",
    steps: [
      "拖动画布空白处移动视野，使用滚轮或触控板缩放；通过项目列表切换不同画布。",
      "框选或逐个选择节点后，可移动、分组、导出或删除；常用操作也能从右键菜单进入。",
      "定期导出画布包作为便携备份；导入前确认文件来源可信。",
    ],
    note: "看不到内容时，先从元素列表定位节点，再检查画布缩放比例。",
    links: [{ href: "/", label: "打开画布" }],
    icon: LayoutDashboard,
  },
  {
    id: "nodes",
    title: "节点与连接",
    summary: "文本、图片、视频、音频、全景、配置和导演台都以节点存在。节点之间的连接表达输入与生成结果的关系。",
    steps: [
      "从工具栏或画布右键菜单添加节点，再通过选中状态编辑标题、尺寸和内容。",
      "将参考图片、文本或配置连接到生成节点，让输入关系保持可读且可复用。",
      "生成前核对当前节点使用的模型与参数；结果会保留在画布中，便于继续分支迭代。",
    ],
    note: "节点很多时先分组并命名；清晰的结构比依赖空间位置更容易维护。",
    icon: Boxes,
  },
  {
    id: "prompts",
    title: "提示词",
    summary: "提示库适合保存常用写法与可复用模板，画布提示面板则用于把它们快速带入当前创作。",
    steps: [
      "在提示词页面新建或整理条目，使用容易搜索的名称和标签。",
      "把提示词加入节点后再补充当前镜头、主体、风格和约束，不必每次从零编写。",
      "若配置了远程提示词来源，留意顶部刷新失败提示，并在使用前检查同步内容。",
    ],
    note: "提示词只描述意图；模型、比例和质量等执行参数应在对应生成设置中确认。",
    links: [{ href: "/prompts", label: "管理提示词" }],
    icon: MessageSquareText,
  },
  {
    id: "assets",
    title: "素材管理",
    summary: "素材页集中管理可复用文件；服务器素材库用于浏览部署端提供的共享资源。",
    steps: [
      "上传前检查文件格式和体积，给素材使用能说明内容的名称。",
      "从素材页或画布素材面板把资源加入当前项目，避免重复上传同一份大文件。",
      "删除素材前确认没有仍需使用它的项目；共享资源的可见范围由部署权限决定。",
    ],
    note: "本地文件、账号资源和服务器共享资源可能有不同的存储位置与访问权限。",
    links: [
      { href: "/assets", label: "打开素材" },
      { href: "/library", label: "浏览服务器素材" },
    ],
    icon: Library,
  },
  {
    id: "workbench",
    title: "图像、视频与工作流工作台",
    summary: "工作台提供更聚焦的生成界面：图像用于单图创作与编辑，视频用于镜头生成，工作流用于串联多步任务。",
    steps: [
      "选择输入素材和模型，填写提示词，再核对尺寸、比例、时长等参数。",
      "生成期间保留当前任务；失败时先查看页面错误和 AI 日志，再调整渠道或输入。",
      "将满意结果下载或带回画布，复杂的重复流程可保存为工作流模板。",
    ],
    note: "生成会消耗渠道额度并需要时间；重复提交前先确认上一任务的状态。",
    links: [
      { href: "/workbench/image", label: "图像工作台" },
      { href: "/workbench/video", label: "视频工作台" },
      { href: "/workbench/workflows", label: "工作流工作台" },
    ],
    icon: WandSparkles,
  },
  {
    id: "director",
    title: "3D 导演台",
    summary: "导演台用于在三维场景中安排人物、模型、环境和机位，并把截图送回画布作为后续生成参考。",
    steps: [
      "在画布工具栏添加导演台节点，选中节点后打开导演台。",
      "布置舞台元素，调整位置、旋转和人物姿态；添加机位并切换导演视角检查构图。",
      "截取候选画面，在截图托盘中选择需要的结果，然后发送回画布。",
    ],
    note: "导入 3D 模型或全景环境前确认来源与格式；关闭导演台前等待正在进行的模型操作完成。",
    links: [{ href: "/", label: "在画布中添加导演台" }],
    icon: Clapperboard,
  },
  {
    id: "auth-modes",
    title: "auth-off 与账号模式",
    summary: "两种模式的身份边界和数据归属不同。它们由部署管理员配置，不是在浏览器里切换的个人选项。",
    steps: [
      "auth-off：面向受信任的本地部署，不要求登录；工作区以本机开放范围运行，也不会显示账号登录入口。",
      "账号模式（optional 或 required）：未登录访问会停在登录墙；登录后数据按账号或租户范围隔离。",
      "auth-off 与账号模式都使用服务端数据库；切换部署模式前请由管理员确认租户和账号归属。",
    ],
    note: "账号模式下不要把“页面可打开”当成拥有权限；共享素材、管理页和额度仍由角色及服务端策略控制。",
    icon: ShieldCheck,
  },
];

export function HelpPage() {
  return (
    <div className="h-full overflow-y-auto bg-[var(--ob-bg)]" aria-labelledby="help-title">
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 sm:py-9 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10 lg:px-8">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ob-accent)]">OpenBoard 指南</p>
          <h1 id="help-title" className="mt-2 text-2xl font-bold tracking-tight text-[var(--ob-ink)] sm:text-3xl">
            使用帮助
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--ob-muted)]">
            从首次进入到组织画布、生成内容和使用导演台的快速参考。
          </p>
          <nav aria-label="帮助主题" className="ob-card mt-5 flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
            {HELP_SECTIONS.map(({ id, title }) => (
              <a
                key={id}
                href={`#${id}`}
                className="shrink-0 rounded-lg px-3 py-2 text-sm text-[var(--ob-muted)] transition-colors hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ob-accent)]"
              >
                {title}
              </a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-5">
          <section aria-label="快速开始" className="ob-card overflow-hidden p-5 sm:p-7">
            <div className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ob-ink)]">第一次使用？</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ob-muted)]">
                  建议先创建一个试验画布，添加文本和图片节点，完成一次小规模生成，再逐步引入素材库、工作流和导演台。
                </p>
              </div>
              <Link to="/" className="ob-btn-primary justify-center whitespace-nowrap px-4 py-2 text-sm font-medium">
                进入画布
              </Link>
            </div>
          </section>

          {HELP_SECTIONS.map(({ id, title, summary, steps, note, links, icon: Icon }) => (
            <section key={id} id={id} aria-labelledby={`${id}-title`} className="ob-card scroll-mt-6 p-5 sm:p-7">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
                  <h2 id={`${id}-title`} className="text-lg font-semibold text-[var(--ob-ink)]">{title}</h2>
                  <p className="mt-1.5 text-sm leading-6 text-[var(--ob-muted)]">{summary}</p>
                </div>
              </div>
              <ol className="mt-5 space-y-3 pl-1">
                {steps.map((step, index) => (
                  <li key={step} className="flex gap-3 text-sm leading-6 text-[var(--ob-ink)]">
                    <span aria-hidden="true" className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--ob-accent-soft)] text-xs font-semibold text-[var(--ob-accent)]">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              {note ? (
                <p className="mt-5 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] px-3.5 py-3 text-sm leading-6 text-[var(--ob-muted)]">
                  <strong className="font-semibold text-[var(--ob-ink)]">注意：</strong>{note}
                </p>
              ) : null}
              {links?.length ? (
                <div className="mt-5 flex flex-wrap gap-2" aria-label={`${title}相关页面`}>
                  {links.map((link) => (
                    <Link key={link.href} to={link.href} className="ob-btn px-3 py-1.5 text-sm">
                      {link.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
