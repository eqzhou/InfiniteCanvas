/**
 * Tenant-level model governance.
 *
 * Administrators may publish an allow list that narrows which models ordinary
 * users can pick, plus a default model per generation kind. The allow list is a
 * convenience filter over what enabled channels actually provide: it can only
 * narrow that set, never introduce a model no channel serves. An empty allow
 * list means "no restriction" so a misconfiguration cannot strand users with
 * zero choices.
 */

export type ModelCatalogKind = "text" | "image" | "video" | "audio";

export type ModelCatalog = {
  availableModels?: string[];
  defaultModel?: string;
  defaultTextModel?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  defaultAudioModel?: string;
};

export const MODEL_CATALOG_LIMITS = {
  maxModels: 200,
  maxModelLength: 128,
} as const;

/** Keyword fallbacks used when a configured default is missing or no longer selectable. */
const KIND_KEYWORDS: Record<ModelCatalogKind, readonly string[]> = {
  image: ["seedream", "gpt-image", "image"],
  video: ["seedance", "video"],
  audio: ["tts", "audio", "speech"],
  text: [],
};

function cleanModel(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MODEL_CATALOG_LIMITS.maxModelLength ? trimmed : "";
}

function cleanModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value.slice(0, MODEL_CATALOG_LIMITS.maxModels * 4)) {
    const model = cleanModel(item);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    output.push(model);
    if (output.length >= MODEL_CATALOG_LIMITS.maxModels) break;
  }
  return output;
}

export function normalizeModelCatalog(value: unknown): Required<ModelCatalog> {
  const candidate = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    availableModels: cleanModelList(candidate.availableModels),
    defaultModel: cleanModel(candidate.defaultModel),
    defaultTextModel: cleanModel(candidate.defaultTextModel),
    defaultImageModel: cleanModel(candidate.defaultImageModel),
    defaultVideoModel: cleanModel(candidate.defaultVideoModel),
    defaultAudioModel: cleanModel(candidate.defaultAudioModel),
  };
}

/**
 * Models an ordinary user may select. `channelModels` is what the enabled
 * channels currently provide; the allow list can only narrow it.
 */
export function resolveSelectableModels(
  catalog: ModelCatalog | null | undefined,
  channelModels: readonly string[],
): string[] {
  const available = cleanModelList(catalog?.availableModels);
  const provided = cleanModelList(channelModels);
  if (!available.length) return provided;
  const allowed = new Set(available);
  const narrowed = provided.filter((model) => allowed.has(model));
  // An allow list that matches nothing on offer is treated as unset rather than
  // locking every model away.
  return narrowed.length ? narrowed : provided;
}

function configuredDefault(catalog: ModelCatalog | null | undefined, kind: ModelCatalogKind): string {
  switch (kind) {
    case "image": return cleanModel(catalog?.defaultImageModel);
    case "video": return cleanModel(catalog?.defaultVideoModel);
    case "audio": return cleanModel(catalog?.defaultAudioModel);
    default: return cleanModel(catalog?.defaultTextModel);
  }
}

function matchesKind(model: string, kind: ModelCatalogKind): boolean {
  const lowered = model.toLowerCase();
  if (kind === "text") {
    // A text model is one that is not clearly an image or video model.
    return ![...KIND_KEYWORDS.image, ...KIND_KEYWORDS.video]
      .some((keyword) => lowered.includes(keyword));
  }
  return KIND_KEYWORDS[kind].some((keyword) => lowered.includes(keyword));
}

/**
 * Default model for a generation kind. A configured default wins while it stays
 * selectable; otherwise fall back by kind keyword, then to the generic default,
 * then to the first selectable model. Returns "" rather than inventing a name.
 */
export function resolveDefaultModel(
  catalog: ModelCatalog | null | undefined,
  kind: ModelCatalogKind,
  selectableModels: readonly string[],
): string {
  const selectable = cleanModelList(selectableModels);
  if (!selectable.length) return "";
  const preferred = configuredDefault(catalog, kind);
  if (preferred && selectable.includes(preferred)) return preferred;
  const byKeyword = selectable.find((model) => matchesKind(model, kind));
  if (byKeyword) return byKeyword;
  const generic = cleanModel(catalog?.defaultModel);
  if (generic && selectable.includes(generic)) return generic;
  return selectable[0]!;
}
