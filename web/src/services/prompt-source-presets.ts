import type { PromptSourceConfig } from "@/types/board";
import { parsePromptSourceConfig } from "@/services/prompt-sources";

/**
 * Community catalog presets for one-click add.
 * These are independent OpenBoard mappings to public raw content; no upstream
 * source code or proprietary scripts are copied.
 */
export type PromptSourcePreset = {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  source: PromptSourceConfig;
};

export const COMMUNITY_PROMPT_SOURCE_PRESETS: PromptSourcePreset[] = [
  {
    id: "awesome-gpt-image",
    name: "Awesome GPT Image",
    description: "ZeroLu/awesome-gpt-image 中文 README 提示词合集",
    repositoryUrl: "https://github.com/ZeroLu/awesome-gpt-image",
    source: {
      id: "awesome-gpt-image",
      name: "Awesome GPT Image",
      url: "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.zh-CN.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    },
  },
  {
    id: "awesome-gpt4o-image",
    name: "Awesome GPT-4o Image Prompts",
    description: "ImgEdify/Awesome-GPT4o-Image-Prompts 中文 README 提示词合集",
    repositoryUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
    source: {
      id: "awesome-gpt4o-image",
      name: "Awesome GPT-4o Image Prompts",
      url: "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/README.zh-CN.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    },
  },
  {
    id: "awesome-gpt-image-2",
    name: "Awesome GPT Image 2",
    description: "YouMind-OpenLab/awesome-gpt-image-2 中文 README 提示词合集",
    repositoryUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
    source: {
      id: "awesome-gpt-image-2",
      name: "Awesome GPT Image 2",
      url: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README_zh.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    },
  },
  {
    id: "awesome-nano-banana-pro",
    name: "Awesome Nano Banana Pro",
    description: "YouMind-OpenLab/awesome-nano-banana-pro-prompts 中文 README 提示词合集",
    repositoryUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
    source: {
      id: "awesome-nano-banana-pro",
      name: "Awesome Nano Banana Pro",
      url: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main/README_zh.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    },
  },
  {
    id: "awesome-gpt-image2-prompts",
    name: "Awesome GPT Image 2 Prompts",
    description: "davidwuw0811-boop/awesome-gpt-image2-prompts 结构化 JSON 目录",
    repositoryUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts",
    source: {
      id: "awesome-gpt-image2-prompts",
      name: "Awesome GPT Image 2 Prompts",
      url: "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main/prompts.json",
      format: "json",
      enabled: true,
      refreshMinutes: 0,
      mapping: {
        idPath: "id",
        titlePath: "title_cn",
        bodyPath: "prompt",
        tagsPath: "category_cn",
        coverUrlPath: "cover",
      },
    },
  },
];

export function findPromptSourcePreset(id: string): PromptSourcePreset | undefined {
  return COMMUNITY_PROMPT_SOURCE_PRESETS.find((preset) => preset.id === id);
}

export function clonePresetSource(preset: PromptSourcePreset): PromptSourceConfig {
  // Validate and freeze a clean copy so callers cannot mutate catalog defaults.
  return parsePromptSourceConfig({
    ...preset.source,
    mapping: preset.source.mapping ? { ...preset.source.mapping } : undefined,
    html: preset.source.html ? { ...preset.source.html } : undefined,
  });
}

// Fail closed at module load if a catalog entry drifts from the source schema.
for (const preset of COMMUNITY_PROMPT_SOURCE_PRESETS) {
  clonePresetSource(preset);
}
