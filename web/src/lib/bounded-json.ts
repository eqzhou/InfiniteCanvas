const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type JsonObject = Record<string, unknown>;

export type JsonLimits = {
  maxBytes: number;
  maxDepth: number;
  maxEntries: number;
  label: string;
};

function visitJson(
  value: unknown,
  depth: number,
  limits: JsonLimits,
  seen: WeakSet<object>,
  count: { value: number },
): void {
  if (depth > limits.maxDepth) throw new Error(`${limits.label} exceeds maximum depth`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${limits.label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${limits.label} must contain only JSON values`);
  if (seen.has(value)) throw new Error(`${limits.label} must not contain cycles`);
  seen.add(value);

  if (Array.isArray(value)) {
    count.value += value.length;
    if (count.value > limits.maxEntries) throw new Error(`${limits.label} has too many entries`);
    value.forEach((item) => visitJson(item, depth + 1, limits, seen, count));
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${limits.label} contains a non-JSON object`);
  }
  const entries = Object.entries(value);
  count.value += entries.length;
  if (count.value > limits.maxEntries) throw new Error(`${limits.label} has too many entries`);
  for (const [key, item] of entries) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${limits.label} contains unsafe key ${key}`);
    visitJson(item, depth + 1, limits, seen, count);
  }
  seen.delete(value);
}

export function validateJsonObject(value: unknown, limits: JsonLimits): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${limits.label} must be an object`);
  }
  visitJson(value, 0, limits, new WeakSet(), { value: 0 });
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > limits.maxBytes) {
    throw new Error(`${limits.label} exceeds ${Math.floor(limits.maxBytes / 1024)} KiB`);
  }
  return value as JsonObject;
}
