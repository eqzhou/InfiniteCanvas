import type { PromptSourceConfig } from "@/types/board";
import { parsePromptSourceConfig } from "@/services/prompt-sources";

/**
 * Community catalog presets for one-click add.
 * Built-in catalogs read the public Image Prompts unified JSON registry
 * (https://github.com/yukkcat/image-prompts) instead of per-canvas parsers.
 */
export type PromptSourcePreset = {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  source: PromptSourceConfig;
};

/** Public Image Prompts registry base used by community catalogs. */
export const IMAGE_PROMPTS_REGISTRY_BASE =
  "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources";

const IMAGE_PROMPTS_JSON_MAPPING = {
  idPath: "id",
  titlePath: "title",
  bodyPath: "prompt",
  tagsPath: "tags",
  coverUrlPath: "coverUrl",
  resultUrlsPath: "referenceImageUrls",
} as const;

function imagePromptsSource(
  id: string,
  name: string,
  homepage: string,
): PromptSourceConfig {
  return {
    id,
    name,
    url: `${IMAGE_PROMPTS_REGISTRY_BASE}/${id}.json`,
    format: "json",
    enabled: true,
    refreshMinutes: 0,
    homepage,
    builtIn: true,
    mapping: { ...IMAGE_PROMPTS_JSON_MAPPING },
  };
}

export const COMMUNITY_PROMPT_SOURCE_PRESETS: PromptSourcePreset[] = [
  {
    id: "banana-prompt-quicker",
    name: "Banana Prompt Quicker",
    description: "glidea/banana-prompt-quicker 统一 Image Prompts JSON",
    repositoryUrl: "https://github.com/glidea/banana-prompt-quicker",
    source: imagePromptsSource(
      "banana-prompt-quicker",
      "Banana Prompt Quicker",
      "https://glidea.github.io/banana-prompt-quicker/",
    ),
  },
  {
    id: "awesome-gpt-image",
    name: "Awesome GPT Image",
    description: "ZeroLu/awesome-gpt-image 统一 Image Prompts JSON",
    repositoryUrl: "https://github.com/ZeroLu/awesome-gpt-image",
    source: imagePromptsSource(
      "awesome-gpt-image",
      "Awesome GPT Image",
      "https://github.com/ZeroLu/awesome-gpt-image",
    ),
  },
  {
    id: "awesome-gpt4o-image-prompts",
    name: "Awesome GPT-4o Image Prompts",
    description: "ImgEdify/Awesome-GPT4o-Image-Prompts 统一 Image Prompts JSON",
    repositoryUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
    source: imagePromptsSource(
      "awesome-gpt4o-image-prompts",
      "Awesome GPT-4o",
      "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
    ),
  },
  {
    id: "youmind-gpt-image-2",
    name: "YouMind GPT Image 2",
    description: "YouMind-OpenLab/awesome-gpt-image-2 统一 Image Prompts JSON",
    repositoryUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
    source: imagePromptsSource(
      "youmind-gpt-image-2",
      "YouMind GPT Image 2",
      "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
    ),
  },
  {
    id: "youmind-nano-banana-pro",
    name: "YouMind Nano Banana Pro",
    description: "YouMind-OpenLab/awesome-nano-banana-pro-prompts 统一 Image Prompts JSON",
    repositoryUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
    source: imagePromptsSource(
      "youmind-nano-banana-pro",
      "YouMind Nano Banana Pro",
      "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
    ),
  },
  {
    id: "davidwu-gpt-image2-prompts",
    name: "DavidWu GPT Image 2",
    description: "davidwuw0811-boop/awesome-gpt-image2-prompts 统一 Image Prompts JSON",
    repositoryUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts",
    source: imagePromptsSource(
      "davidwu-gpt-image2-prompts",
      "DavidWu GPT Image 2",
      "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts",
    ),
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
    homepage: preset.source.homepage,
    builtIn: preset.source.builtIn,
  });
}

// Fail closed at module load if a catalog entry drifts from the source schema.
for (const preset of COMMUNITY_PROMPT_SOURCE_PRESETS) {
  clonePresetSource(preset);
}
