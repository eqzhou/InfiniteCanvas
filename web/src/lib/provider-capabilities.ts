export type ProviderCapabilityKind = "image" | "video" | "audio" | "text";

export type VideoProviderCapability = Readonly<{
  modes: readonly ("std" | "pro" | "4k")[];
  durations?: readonly number[];
  minDuration?: number;
  maxDuration?: number;
  aspectRatios: readonly string[];
  resolutions?: readonly string[];
  maxImageReferences: number;
  maxVideoReferences?: number;
  maxAudioReferences?: number;
  audioModes: readonly ("std" | "pro" | "4k")[];
  lastFrameModes: readonly ("std" | "pro" | "4k")[];
  maxShots: number;
  maxElements: number;
}>;

export type ProviderCapability = Readonly<{
  protocol: string;
  kind: ProviderCapabilityKind;
  model: string;
  family: string;
  maxImageReferences: number;
  maxOutputs?: number;
  sizes?: readonly string[];
  resolutions?: readonly string[];
  qualities?: readonly string[];
  video?: VideoProviderCapability;
}>;

const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  ...(["gpt-image-1", "gpt-image-1.5", "gpt-image-2"] as const).map((model) => ({
    protocol: "openai" as const,
    kind: "image" as const,
    model,
    family: model,
    maxImageReferences: 16,
    maxOutputs: 4,
    sizes: ["1:1", "2:3", "3:2"] as const,
    qualities: ["auto", "low", "medium", "high"] as const,
  })),
  {
    protocol: "apimart",
    kind: "video",
    model: "kling-v2-6",
    family: "kling-2.6",
    maxImageReferences: 2,
    video: {
      modes: ["std", "pro"],
      durations: [5, 10],
      aspectRatios: ["16:9", "9:16", "1:1"],
      maxImageReferences: 2,
      audioModes: ["pro"],
      lastFrameModes: ["pro"],
      maxShots: 0,
      maxElements: 0,
    },
  },
  {
    protocol: "apimart",
    kind: "video",
    model: "happyhorse-1.1",
    family: "happyhorse-1.1",
    maxImageReferences: 9,
    video: {
      modes: ["std"],
      minDuration: 3,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
      resolutions: ["720p", "1080p"],
      maxImageReferences: 9,
      audioModes: [],
      lastFrameModes: [],
      maxShots: 0,
      maxElements: 0,
    },
  },
  {
    protocol: "apimart",
    kind: "video",
    model: "kling-3.0-turbo",
    family: "kling-3.0-turbo",
    maxImageReferences: 1,
    video: {
      modes: ["std"],
      minDuration: 3,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["720p", "1080p"],
      maxImageReferences: 1,
      audioModes: [],
      lastFrameModes: [],
      maxShots: 0,
      maxElements: 0,
    },
  },
  ...(["doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"] as const).map((model) => ({
    protocol: "apimart" as const,
    kind: "video" as const,
    model,
    family: "seedance-2.0",
    maxImageReferences: 9,
    video: {
      modes: ["std"] as const,
      minDuration: 5,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const,
      resolutions: model === "doubao-seedance-2.0" ? ["480p", "720p", "1080p", "4k"] as const : ["480p", "720p"] as const,
      maxImageReferences: 9,
      maxVideoReferences: 0,
      maxAudioReferences: 0,
      audioModes: ["std"] as const,
      lastFrameModes: ["std"] as const,
      maxShots: 0,
      maxElements: 0,
    },
  })),
  {
    protocol: "apimart",
    kind: "video",
    model: "kling-v3",
    family: "kling-3",
    maxImageReferences: 2,
    video: {
      modes: ["std", "pro", "4k"],
      minDuration: 3,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1"],
      maxImageReferences: 2,
      audioModes: ["std", "pro", "4k"],
      lastFrameModes: ["std", "pro", "4k"],
      maxShots: 6,
      maxElements: 3,
    },
  },
  {
    protocol: "apimart", kind: "image", model: "gpt-image-1-official", family: "gpt-image-1",
    maxImageReferences: 15, maxOutputs: 4, sizes: ["1:1", "2:3", "3:2"], qualities: ["auto", "low", "medium", "high"],
  },
  {
    protocol: "apimart", kind: "image", model: "gpt-image-1.5-official", family: "gpt-image-1.5",
    maxImageReferences: 15, maxOutputs: 4, sizes: ["1:1", "2:3", "3:2"], qualities: ["auto", "low", "medium", "high"],
  },
  {
    protocol: "apimart", kind: "image", model: "doubao-seedream-5-0-pro", family: "seedream-5.0-pro",
    maxImageReferences: 10, maxOutputs: 1,
    sizes: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "auto"],
    resolutions: ["1K", "2K"],
  },
  ...(["gemini-3.1-flash-lite-image", "nano-banana-2-lite"] as const).map((model) => ({
    protocol: "apimart" as const, kind: "image" as const, model, family: "gemini-3.1-flash-lite-image",
    maxImageReferences: 14, maxOutputs: 4,
    sizes: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9"] as const,
    resolutions: ["1K"] as const,
  })),
];

function freezeCapability(value: ProviderCapability): ProviderCapability {
  const video = value.video
    ? Object.freeze({
        ...value.video,
        modes: Object.freeze([...value.video.modes]),
        durations: value.video.durations ? Object.freeze([...value.video.durations]) : undefined,
        aspectRatios: Object.freeze([...value.video.aspectRatios]),
        resolutions: value.video.resolutions ? Object.freeze([...value.video.resolutions]) : undefined,
        audioModes: Object.freeze([...value.video.audioModes]),
        lastFrameModes: Object.freeze([...value.video.lastFrameModes]),
      })
    : undefined;
  return Object.freeze({
    ...value,
    sizes: value.sizes ? Object.freeze([...value.sizes]) : undefined,
    resolutions: value.resolutions ? Object.freeze([...value.resolutions]) : undefined,
    qualities: value.qualities ? Object.freeze([...value.qualities]) : undefined,
    video,
  });
}

/**
 * Resolve only explicitly verified protocol/model pairs. Unknown names fail closed;
 * callers must not infer paid-provider support from a substring.
 */
export function resolveProviderCapability(
  protocol: string,
  kind: ProviderCapabilityKind,
  model: string,
): ProviderCapability | undefined {
  const normalizedProtocol = protocol.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const match = PROVIDER_CAPABILITIES.find((entry) =>
    entry.protocol === normalizedProtocol && entry.kind === kind && entry.model === normalizedModel);
  return match ? freezeCapability(match) : undefined;
}
