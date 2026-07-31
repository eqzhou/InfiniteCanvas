export type AICallReferenceDetail = {
  index: number;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  sourceKnown: boolean;
};

export type AICallRequestDetail = {
  endpoint?: string;
  method?: string;
  referenceCount: number;
  references: AICallReferenceDetail[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max = 2_048): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function referenceDetail(value: unknown, fallbackIndex: number): AICallReferenceDetail {
  if (typeof value === "string") {
    const storageKey = boundedString(value, 512);
    return { index: fallbackIndex, storageKey, sourceKnown: Boolean(storageKey) };
  }
  if (!isRecord(value)) return { index: fallbackIndex, sourceKnown: false };
  const index = positiveInteger(value.index) ?? fallbackIndex;
  const storageKey = boundedString(value.storageKey, 512);
  const mimeType = boundedString(value.mimeType, 128);
  const bytes = positiveInteger(value.bytes);
  return { index, storageKey, mimeType, bytes, sourceKnown: Boolean(storageKey) };
}

/**
 * Extracts the trace fields added to a sanitized AI request summary.
 * Unknown/legacy logs remain readable and show an explicit missing-source
 * marker instead of guessing an endpoint or silently losing reference count.
 */
export function readAICallRequestDetail(value: unknown): AICallRequestDetail {
  if (!isRecord(value)) return { referenceCount: 0, references: [] };
  const referenceCount = positiveInteger(value.referenceCount) ?? 0;
  const endpoint = boundedString(value.endpoint);
  const method = boundedString(value.method, 16)?.toUpperCase();
  const rawReferences = Array.isArray(value.referenceImages)
    ? value.referenceImages
    : Array.isArray(value.referenceMedia)
      ? value.referenceMedia
      : null;
  const references = rawReferences
    ? rawReferences.map((item, index) => referenceDetail(item, index + 1))
    : Array.from({ length: referenceCount }, (_, index) => referenceDetail(undefined, index + 1));
  return {
    endpoint,
    method,
    referenceCount: Math.max(referenceCount, references.length),
    references,
  };
}
