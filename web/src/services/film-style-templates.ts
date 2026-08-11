import type { FilmStyleTemplate } from "@/types/film";
import { createFilmAsset, createFilmProduction, type FilmStatus } from "./film-client";

export const FILM_STYLE_TEMPLATES: readonly FilmStyleTemplate[] = [
  {
    id: "mist-harbor-documentary",
    origin: "openboard-original",
    title: "雾港纪实",
    description: "OpenBoard 原创的克制港口纪实方案，适合悬疑、人物观察和现实题材。",
    stylePrompt: "自然主义电影摄影，潮湿海雾与低饱和青灰色调，真实环境纹理，柔和漫射晨光，克制构图，人物表演优先，保留适度胶片颗粒与空气透视",
    aspectRatio: "16:9",
    palette: ["#9AA7A8", "#52666B", "#D5C8AA"],
    lighting: "阴天漫射光与少量暖色实景灯",
    cameraLanguage: "稳定观察镜头、缓慢推进、留白构图",
  },
  {
    id: "neon-paper-shadow",
    origin: "openboard-original",
    title: "霓虹纸影",
    description: "OpenBoard 原创的纸艺层叠与城市霓虹结合方案，适合音乐、奇幻和青年叙事。",
    stylePrompt: "层叠纸艺空间与电影级霓虹照明结合，清晰剪影边缘，洋红和深蓝互补色，细腻纸张纤维，体积光穿过分层布景，节奏鲜明但保持角色面部可读",
    aspectRatio: "2.39:1",
    palette: ["#E447A1", "#223B78", "#F3C96B"],
    lighting: "高反差霓虹轮廓光与柔和面部补光",
    cameraLanguage: "横向调度、几何转场、宽银幕层次",
  },
  {
    id: "warm-day-handcraft",
    origin: "openboard-original",
    title: "暖昼手作",
    description: "OpenBoard 原创的温暖生活化方案，适合家庭、手作、美食和轻喜剧内容。",
    stylePrompt: "温暖自然日光，蜂蜜色木材与柔和奶油色背景，真实手作细节，干净肤色，轻微浅景深，生活化陈设，明快但不过度饱和，画面具有可触摸的材质感",
    aspectRatio: "16:9",
    palette: ["#D9A566", "#F2E4C9", "#77916F"],
    lighting: "窗边柔光、暖色反射与自然阴影",
    cameraLanguage: "中近景动作覆盖、细节插入、轻缓手持",
  },
  {
    id: "vertical-night-pulse",
    origin: "openboard-original",
    title: "夜行脉冲",
    description: "OpenBoard 原创的竖屏夜间动势方案，适合短剧、城市动作和移动端叙事。",
    stylePrompt: "竖屏电影构图，夜间城市反射与冷暖分区照明，主体始终保持清晰轮廓，快速运动中保留方向感，真实街道材质，紧凑景别变化，避免过度光污染",
    aspectRatio: "9:16",
    palette: ["#1B2748", "#E96B4C", "#56B8B0"],
    lighting: "街灯、车灯与店铺实景光的方向性组合",
    cameraLanguage: "纵深跟拍、快速切换、竖向前后景遮挡",
  },
] as const;

type CreateAsset = typeof createFilmAsset;

function findTemplate(templateId: string): FilmStyleTemplate {
  const template = FILM_STYLE_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error("影视风格模板不存在");
  return template;
}

function templateAssetInput(template: FilmStyleTemplate) {
  return {
    kind: "style" as const,
    title: template.title,
    description: `${template.description}\n光线：${template.lighting}\n镜头语言：${template.cameraLanguage}`,
    stylePrompt: template.stylePrompt,
    aspectRatio: template.aspectRatio,
  };
}

export function applyFilmStyleTemplate(
  projectId: string,
  templateId: string,
  dependencies: { createAsset?: CreateAsset } = {},
): Promise<FilmStatus> {
  const template = findTemplate(templateId);
  return (dependencies.createAsset ?? createFilmAsset)(projectId, templateAssetInput(template));
}

export type FilmTemplateProjectHost = {
  createProject: (title: string, kind: "film") => string;
  persistProjects: () => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  createProduction?: typeof createFilmProduction;
  createAsset?: CreateAsset;
};

export async function copyFilmStyleTemplateAsProject(templateId: string, host: FilmTemplateProjectHost): Promise<string> {
  const template = findTemplate(templateId);
  const projectId = host.createProject(`${template.title} 影片`, "film");
  try {
    await host.persistProjects();
    await (host.createProduction ?? createFilmProduction)(projectId);
    await applyFilmStyleTemplate(projectId, templateId, { createAsset: host.createAsset });
    return projectId;
  } catch (cause) {
	try {
		await host.removeProject(projectId);
	} catch (rollbackCause) {
		throw new AggregateError([cause, rollbackCause], `影视模板项目初始化失败，且回滚失败：${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`);
	}
    throw cause;
  }
}
