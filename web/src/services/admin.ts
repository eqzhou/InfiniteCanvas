import { AuthHttpError, authFetch } from "@/services/auth-session";
import { isLoopbackHostname } from "@/lib/loopback-host";

export type AdminUser = {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  status: "active" | "ban";
  credits: number;
};

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
export type AdminCreditLog = {
  id: number;
  userId: string;
  actorId?: string;
  jobId?: string;
  model?: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  idempotencyKey?: string;
  createdAt: string;
};
export type AdminModelCosts = {
  modelCosts: Array<{ model: string; credits: number }>;
  /** Cost used when a model has no exact entry. */
  defaultCredits: number;
  /** Opaque server version used to prevent silent concurrent overwrites. */
  revision?: string;
};
export type AdminTenantQuota = {
  generationThisMonth: number;
  generationQuotaMonthly: number;
};

const maxAdminQuotaValue = 1_000_000_000;

export function parseTenantQuotaDraft(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maxAdminQuotaValue ? parsed : null;
}

export function isCreditAdjustmentReady(delta: number, reason: string): boolean {
  return Number.isSafeInteger(delta) && delta !== 0 && Math.abs(delta) <= maxAdminQuotaValue && reason.trim().length > 0;
}

export type AdminStoragePoolProviderStatus = {
  id: string;
  kind: "s3" | "webdav" | string;
  weight: number;
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  healthy?: boolean;
  allowInsecureLoopback?: boolean;
  allowPrivate?: boolean;
  secretConfigured?: boolean;
  configuredSelectable: boolean;
  probeKnown: boolean;
  probeHealthy: boolean;
  capacityKnown: boolean;
  totalBytes?: number;
  availableBytes?: number;
  error?: string;
};

export type AdminChannelProtocol = "openai" | "gemini" | "apimart" | "kie" | "azure" | "edge";
export type AdminMediaKind = "image" | "video" | "audio";
export type AdminMediaMode = "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video" | "text_to_audio";
export type AdminMediaCapability = {
  model: string;
  kind: AdminMediaKind;
  modes: AdminMediaMode[];
  sizes: string[];
  durations: number[];
  maxReferences: number;
};
export type AdminChannel = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: AdminChannelProtocol;
  enabled: boolean;
  allowUserUse: boolean;
  weight: number;
  timeoutSeconds: number;
  /**
   * Optional per-channel model allow list. Empty means no restriction.
   * Shared-auto routing only picks channels whose list contains the requested
   * model (or whose list is empty).
   */
  models?: string[];
  mediaCapabilities?: AdminMediaCapability[];
  defaultTextModel: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  defaultAudioModel: string;
  secretConfigured: boolean;
	secretBindingId?: string;
};

const channelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const adminRevisionPattern = /^[a-f0-9]{64}$/;
const channelProtocols = new Set<AdminChannelProtocol>(["openai", "gemini", "apimart", "kie", "azure", "edge"]);
const adminMediaModes = new Set<AdminMediaMode>(["text_to_image", "image_to_image", "text_to_video", "image_to_video", "text_to_audio"]);
const mediaSizePattern = /^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|\d{3,4}p|[1248][Kk]|auto|adaptive)$/;

function readAdminRevision(response: Response): string {
  const revision = response.headers.get("X-OpenBoard-Revision") ?? "";
  if (!adminRevisionPattern.test(revision)) throw new Error("管理员配置版本响应无效");
  return revision;
}

/** Trim, drop blanks, and keep first-seen order (case-insensitive dedupe). */
export function cleanAdminChannelModels(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of values) {
    const model = raw.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(model);
  }
  return clean;
}

export function normalizeAdminMediaCapabilities(
  values: readonly AdminMediaCapability[] | undefined,
  allowedModels: readonly string[],
): AdminMediaCapability[] {
  if (!values?.length) return [];
  if (values.length > 200) throw new Error("媒体模型能力数量不能超过 200");
  const allowed = new Set(allowedModels.map((model) => model.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  return values.map((raw) => {
    const model = raw.model.trim();
    if (!model || model.length > 500 || (allowed.size > 0 && !allowed.has(model.toLowerCase()))) {
      throw new Error("媒体能力模型必须来自渠道可用模型");
    }
    const kind = raw.kind;
    const validForKind: Record<AdminMediaKind, Set<AdminMediaMode>> = {
      image: new Set(["text_to_image", "image_to_image"]),
      video: new Set(["text_to_video", "image_to_video"]),
      audio: new Set(["text_to_audio"]),
    };
    if (kind !== "image" && kind !== "video" && kind !== "audio") throw new Error("媒体能力类型无效");
    const modes = [...new Set(raw.modes)];
    if (!modes.length || modes.some((mode) => !adminMediaModes.has(mode) || !validForKind[kind].has(mode))) throw new Error("媒体生成模式无效");
    const sizes = [...new Set(raw.sizes.map((size) => size.trim().replaceAll("X", "x")).filter(Boolean))];
    const durations = [...new Set(raw.durations)];
    if (sizes.length > 100 || sizes.some((size) => !mediaSizePattern.test(size)) || durations.length > 100 ||
        durations.some((duration) => !Number.isSafeInteger(duration) || duration < 1 || duration > 900) ||
        !Number.isSafeInteger(raw.maxReferences) || raw.maxReferences < 0 || raw.maxReferences > 16) {
      throw new Error("媒体模型尺寸、时长或参考素材限制无效");
    }
    const key = `${model.toLowerCase()}:${kind}`;
    if (seen.has(key)) throw new Error("同一模型和媒体类型的能力不能重复");
    seen.add(key);
    return { model, kind, modes, sizes, durations, maxReferences: raw.maxReferences };
  });
}

function normalizeAdminChannel(channel: AdminChannel): Omit<AdminChannel, "secretConfigured"> {
  const models = cleanAdminChannelModels(channel.models);
  if (models.length > 200) throw new Error("共享渠道模型数量不能超过 200");
  if (models.some((model) => model.length > 500)) throw new Error("共享渠道模型无效");
  const defaultModels = [channel.defaultImageModel, channel.defaultVideoModel, channel.defaultAudioModel]
    .filter((model): model is string => typeof model === "string" && Boolean(model.trim()));
  const mediaCapabilities = normalizeAdminMediaCapabilities(channel.mediaCapabilities, [...models, ...defaultModels]);
  const value = {
    id: channel.id.trim(),
    name: channel.name.trim() || channel.id.trim(),
    baseUrl: channel.baseUrl.trim().replace(/\/+$/, ""),
    protocol: channel.protocol,
    enabled: Boolean(channel.enabled),
    allowUserUse: Boolean(channel.allowUserUse),
    weight: channel.weight,
    timeoutSeconds: channel.timeoutSeconds,
    ...(models.length ? { models } : {}),
    ...(mediaCapabilities.length ? { mediaCapabilities } : {}),
    defaultTextModel: typeof channel.defaultTextModel === "string" ? channel.defaultTextModel.trim() : "",
    defaultImageModel: typeof channel.defaultImageModel === "string" ? channel.defaultImageModel.trim() : "",
    defaultVideoModel: typeof channel.defaultVideoModel === "string" ? channel.defaultVideoModel.trim() : "",
    defaultAudioModel: typeof channel.defaultAudioModel === "string" ? channel.defaultAudioModel.trim() : "",
  };
  if (!channelIdPattern.test(value.id) || !value.name || !channelProtocols.has(value.protocol) ||
      !Number.isSafeInteger(value.weight) || value.weight < 1 || value.weight > 100 ||
      !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 600) {
    throw new Error("共享渠道配置无效");
  }
  if (value.enabled && value.allowUserUse && !value.defaultTextModel && !value.defaultImageModel &&
      !value.defaultVideoModel && !value.defaultAudioModel) {
    throw new Error("允许用户使用的共享渠道至少配置一个默认模型");
  }
  let parsed: URL;
  try { parsed = new URL(value.baseUrl); } catch { throw new Error("共享渠道地址无效"); }
  const loopback = isLoopbackHostname(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("共享渠道地址必须使用 HTTPS，且不能包含凭据、查询或片段");
  }
  return value;
}

export type AdminPromptCategory = { id: string; name: string; order: number };
export type AdminPromptEntry = { id: string; categoryId?: string; title: string; body: string; tags: string[]; sourceId?: string; updatedAt?: string };
export type AdminPromptSource = {
  id: string; name: string; url: string; format: "json" | "markdown"; enabled: boolean;
  lastSyncAt?: string; lastSuccessAt?: string; lastError?: string; itemCount?: number;
  scheduleEnabled?: boolean; intervalMinutes?: number; nextRunAt?: string; scheduleStatus?: string;
};
export type AdminPromptSyncRun = { id: string; sourceId: string; sourceUrl: string; status: "running" | "succeeded" | "failed"; startedAt: string; completedAt?: string; itemCount: number; error?: string };
export type AdminPromptCatalog = { version: 1; revision: number; categories: AdminPromptCategory[]; prompts: AdminPromptEntry[]; sources: AdminPromptSource[]; syncRuns: AdminPromptSyncRun[] };

export function canManageAdmin(auth: { status?: string; localAdmin?: boolean; user?: { role?: string } | null } | null | undefined): boolean {
  if (auth?.localAdmin === true) return true;
  const role = auth?.user?.role?.toLowerCase() ?? "";
  return role === "owner" || role === "admin";
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AuthHttpError(response.status, detail || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function pageValue(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 1;
}

function pageSizeValue(value: number | undefined): number {
  return Math.min(100, Math.max(1, Number.isSafeInteger(value) ? value! : 25));
}

export async function listAdminUsers(query: { q?: string; page?: number; pageSize?: number } = {}): Promise<Page<AdminUser>> {
  const params = new URLSearchParams({
    q: query.q?.trim() ?? "",
    page: String(pageValue(query.page)),
    pageSize: String(pageSizeValue(query.pageSize)),
  });
  return json(await authFetch(`admin/users?${params}`));
}

export async function patchAdminUser(
  userId: string,
  patch: Partial<Pick<AdminUser, "displayName" | "role" | "status">>,
): Promise<AdminUser> {
  return json(await authFetch(`admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }));
}

export async function adjustAdminCredits(
  userId: string,
  input: { delta: number; reason: string; idempotencyKey: string },
): Promise<{ user: AdminUser; log: AdminCreditLog; replayed: boolean }> {
  if (!Number.isSafeInteger(input.delta) || input.delta === 0) throw new Error("算力变化必须是非零整数");
  if (Math.abs(input.delta) > maxAdminQuotaValue) throw new Error(`单次算力变化不能超过 ${maxAdminQuotaValue}`);
  if (!input.reason.trim() || !input.idempotencyKey.trim()) throw new Error("算力调整原因和幂等键不能为空");
  return json(await authFetch(`admin/users/${encodeURIComponent(userId)}/credit-adjustments`, {
    method: "POST",
    body: JSON.stringify({ ...input, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() }),
  }));
}

export async function listAdminCreditLogs(query: {
  userId?: string;
  reason?: string;
  model?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<Page<AdminCreditLog>> {
  const params = new URLSearchParams({
    userId: query.userId?.trim() ?? "",
    reason: query.reason?.trim() ?? "",
    model: query.model?.trim() ?? "",
    page: String(pageValue(query.page)),
    pageSize: String(pageSizeValue(query.pageSize)),
  });
  return json(await authFetch(`admin/credit-logs?${params}`));
}

export async function getAdminModelCosts(): Promise<AdminModelCosts> {
  return json(await authFetch("admin/models"));
}

export async function getAdminTenantQuota(): Promise<AdminTenantQuota> {
  return json(await authFetch("admin/tenant-quota"));
}

export function putAdminTenantQuota(generationQuotaMonthly: number): Promise<AdminTenantQuota> {
  if (!Number.isSafeInteger(generationQuotaMonthly) || generationQuotaMonthly < 0) {
    throw new Error("团队月度生成额度必须是非负整数");
  }
  if (generationQuotaMonthly > maxAdminQuotaValue) {
    throw new Error(`团队月度生成额度必须是 0 到 ${maxAdminQuotaValue} 的整数`);
  }
  return authFetch("admin/tenant-quota", {
    method: "PUT",
    body: JSON.stringify({ generationQuotaMonthly }),
  }).then(json<AdminTenantQuota>);
}

export async function putAdminModelCosts(input: AdminModelCosts): Promise<AdminModelCosts> {
  const seen = new Set<string>();
  const modelCosts = input.modelCosts.map((item) => {
    const model = item.model.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key) || !Number.isSafeInteger(item.credits) || item.credits < 1 || item.credits > maxAdminQuotaValue) {
      throw new Error("模型成本配置无效或重复");
    }
    seen.add(key);
    return { model, credits: item.credits };
  });
  if (!Number.isSafeInteger(input.defaultCredits) || input.defaultCredits < 1 || input.defaultCredits > maxAdminQuotaValue) throw new Error("默认模型成本必须是 1 到 1000000000 的整数");
  if (!input.revision) throw new Error("请先重新加载模型算力成本再保存");
  const response = await authFetch("admin/models", {
    method: "PUT",
    body: JSON.stringify({ modelCosts, defaultCredits: input.defaultCredits, revision: input.revision }),
  });
  if (response.status === 409) throw new Error("模型算力成本已被其他管理员修改，请刷新页面后重试");
  return json(response);
}

export async function getAdminStoragePoolStatus(): Promise<{ items: AdminStoragePoolProviderStatus[]; revision: string; webdavEnabled: boolean }> {
  const response = await authFetch("admin/storage-pool");
  const revision = readAdminRevision(response);
  const webdavEnabled = response.headers.get("X-OpenBoard-WebDAV-Media-Enabled") === "true";
  const values = await json<unknown>(response);
  if (!Array.isArray(values)) throw new Error("存储池状态响应无效");
  const items = values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("存储池状态响应无效");
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !channelIdPattern.test(item.id) || typeof item.kind !== "string" ||
        item.kind.length > 64 || !Number.isSafeInteger(item.weight) || Number(item.weight) < 0 || Number(item.weight) > 10_000 ||
        typeof item.configuredSelectable !== "boolean" || typeof item.probeKnown !== "boolean" ||
        typeof item.probeHealthy !== "boolean" || typeof item.capacityKnown !== "boolean") {
      throw new Error("存储池状态响应无效");
    }
    const totalBytes = item.totalBytes === undefined ? undefined : Number(item.totalBytes);
    const availableBytes = item.availableBytes === undefined ? undefined : Number(item.availableBytes);
    if ((totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes < 0)) ||
        (availableBytes !== undefined && (!Number.isSafeInteger(availableBytes) || availableBytes < 0)) ||
        (item.capacityKnown && (totalBytes === undefined || availableBytes === undefined || availableBytes > totalBytes))) {
      throw new Error("存储池容量响应无效");
    }
    for (const [key, max] of [["endpoint", 8 * 1024], ["bucket", 63], ["region", 64], ["prefix", 256]] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || item[key].length > max)) throw new Error("存储池配置响应无效");
    }
    for (const key of ["healthy", "allowInsecureLoopback", "allowPrivate", "secretConfigured"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "boolean") throw new Error("存储池配置响应无效");
    }
    return {
      id: item.id,
      kind: item.kind,
      weight: Number(item.weight),
      configuredSelectable: item.configuredSelectable,
      probeKnown: item.probeKnown,
      probeHealthy: item.probeHealthy,
      capacityKnown: item.capacityKnown,
      ...(typeof item.endpoint === "string" ? { endpoint: item.endpoint } : {}),
      ...(typeof item.bucket === "string" ? { bucket: item.bucket } : {}),
      ...(typeof item.region === "string" ? { region: item.region } : {}),
      ...(typeof item.prefix === "string" ? { prefix: item.prefix } : {}),
      ...(typeof item.healthy === "boolean" ? { healthy: item.healthy } : {}),
      ...(typeof item.allowInsecureLoopback === "boolean" ? { allowInsecureLoopback: item.allowInsecureLoopback } : {}),
      ...(typeof item.allowPrivate === "boolean" ? { allowPrivate: item.allowPrivate } : {}),
      ...(typeof item.secretConfigured === "boolean" ? { secretConfigured: item.secretConfigured } : {}),
      ...(totalBytes === undefined ? {} : { totalBytes }),
      ...(availableBytes === undefined ? {} : { availableBytes }),
      ...(typeof item.error === "string" && item.error.length <= 500 ? { error: item.error } : {}),
    };
  });
  return { items, revision, webdavEnabled };
}

export type AdminStoragePoolProviderInput = {
  kind?: "s3" | "webdav";
  id: string; endpoint: string; bucket: string; region: string; prefix: string;
  weight: number; healthy: boolean; allowInsecureLoopback: boolean; allowPrivate?: boolean;
};

function normalizeStorageProvider(item: AdminStoragePoolProviderInput): AdminStoragePoolProviderInput {
  const kind = item.kind ?? "s3";
  const value = {
    ...item,
    ...(item.kind === undefined ? {} : { kind }),
    id: item.id.trim(), endpoint: item.endpoint.trim().replace(/\/+$/, ""),
    bucket: kind === "s3" ? item.bucket.trim().toLowerCase() : "",
    region: kind === "s3" ? item.region.trim() || "auto" : "",
    prefix: item.prefix.trim().replace(/^\/+|\/+$/g, "") || "openboard",
    ...(item.allowPrivate === undefined ? {} : { allowPrivate: kind === "webdav" && item.allowPrivate }),
  };
  const validBucket = kind === "webdav" || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket);
  if ((kind !== "s3" && kind !== "webdav") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.id) || !validBucket || !Number.isSafeInteger(value.weight) || value.weight < 0 || value.weight > 10_000) throw new Error("存储提供商配置无效");
  let parsed: URL; try { parsed = new URL(value.endpoint); } catch { throw new Error("存储端点无效"); }
  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback && value.allowInsecureLoopback))) throw new Error("存储端点必须使用 HTTPS（仅显式允许本机 HTTP）");
  return value;
}

export async function putAdminStoragePool(items: AdminStoragePoolProviderInput[], revision: string): Promise<{ items: AdminStoragePoolProviderStatus[]; revision: string }> {
  if (items.length > 64) throw new Error("存储提供商不能超过 64 个");
  const normalized = items.map(normalizeStorageProvider);
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error("存储提供商 ID 不能重复");
  if (!adminRevisionPattern.test(revision)) throw new Error("请先重新加载存储池配置再保存");
  const response = await authFetch("admin/storage-pool", { method: "PUT", headers: { "X-OpenBoard-Revision": revision }, body: JSON.stringify(normalized) });
  if (response.status === 409) throw new Error("存储池配置已被其他管理员修改，请重新加载后重试");
  const nextRevision = readAdminRevision(response);
  const values = await json<AdminStoragePoolProviderStatus[]>(response);
  return { items: values, revision: nextRevision };
}

export type AdminStoragePoolCredential =
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { username: string; password: string };

export async function putAdminStoragePoolSecret(id: string, credential: AdminStoragePoolCredential): Promise<void> {
  if ("username" in credential) {
    if (!credential.username.trim() || !credential.password) throw new Error("WebDAV 用户名和密码不能为空");
  } else if (!credential.accessKeyId.trim() || !credential.secretAccessKey.trim()) {
    throw new Error("Access Key 和 Secret Key 不能为空");
  }
  const response = await authFetch(`admin/storage-pool/${encodeURIComponent(id)}/secret`, { method: "PUT", body: JSON.stringify(credential) });
  if (!response.ok) await json(response);
}

export async function deleteAdminStoragePoolProvider(id: string, revision: string): Promise<string> {
  if (!adminRevisionPattern.test(revision)) throw new Error("请先重新加载存储池配置再删除");
  const response = await authFetch(`admin/storage-pool/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-OpenBoard-Revision": revision } });
  if (!response.ok) await json(response);
  return readAdminRevision(response);
}

export async function listAdminChannels(): Promise<{ items: AdminChannel[]; revision: string }> {
  const response = await authFetch("admin/channels");
  const revision = readAdminRevision(response);
  const channels = await json<AdminChannel[]>(response);
  return { revision, items: channels.map((channel) => ({
    ...channel,
    mediaCapabilities: Array.isArray(channel.mediaCapabilities) ? channel.mediaCapabilities : [],
    defaultTextModel: typeof channel.defaultTextModel === "string" ? channel.defaultTextModel : "",
    defaultImageModel: typeof channel.defaultImageModel === "string" ? channel.defaultImageModel : "",
    defaultVideoModel: typeof channel.defaultVideoModel === "string" ? channel.defaultVideoModel : "",
    defaultAudioModel: typeof channel.defaultAudioModel === "string" ? channel.defaultAudioModel : "",
  })) };
}

export async function putAdminChannels(channels: AdminChannel[], revision: string): Promise<{ items: AdminChannel[]; revision: string }> {
  if (channels.length > 100) throw new Error("共享渠道数量不能超过 100");
  const normalized = channels.map(normalizeAdminChannel);
  if (new Set(normalized.map((channel) => channel.id)).size !== normalized.length) throw new Error("共享渠道 ID 不能重复");
  if (!adminRevisionPattern.test(revision)) throw new Error("请先重新加载共享渠道再保存");
  const response = await authFetch("admin/channels", { method: "PUT", headers: { "X-OpenBoard-Revision": revision }, body: JSON.stringify(normalized) });
  if (response.status === 409) throw new Error("共享渠道已被其他管理员修改，请重新加载后重试");
  const nextRevision = readAdminRevision(response);
  return { items: await json<AdminChannel[]>(response), revision: nextRevision };
}

export async function deleteAdminChannel(channelId: string, revision: string): Promise<string> {
  if (!adminRevisionPattern.test(revision)) throw new Error("请先重新加载共享渠道再删除");
  const response = await authFetch(`admin/channels/${encodeURIComponent(channelId)}`, { method: "DELETE", headers: { "X-OpenBoard-Revision": revision } });
  if (!response.ok) await json(response);
  return readAdminRevision(response);
}

export async function putAdminChannelSecret(channelId: string, apiKey: string, secretBindingId: string): Promise<void> {
  if (!apiKey.trim() || apiKey.length > 64 * 1024) throw new Error("渠道密钥不能为空或过长");
	if (!secretBindingId.trim()) throw new Error("渠道配置已过期，请刷新后重试");
  const response = await authFetch(`admin/channels/${encodeURIComponent(channelId)}/secret`, {
	method: "PUT", body: JSON.stringify({ apiKey, secretBindingId }),
  });
  if (!response.ok) await json(response);
}

export async function fetchAdminChannelModels(channelId: string): Promise<string[]> {
  const result = await json<{ models: string[] }>(await authFetch(`admin/channels/${encodeURIComponent(channelId)}/models`, { method: "POST" }));
  return result.models;
}

export async function testAdminChannel(channelId: string): Promise<{ ok: boolean; modelCount: number }> {
  return json(await authFetch(`admin/channels/${encodeURIComponent(channelId)}/test`, { method: "POST" }));
}

async function adminPromptRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  return json(await authFetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

export const getAdminPromptCatalog = () => adminPromptRequest<AdminPromptCatalog>("admin/prompt-catalog");
export const createAdminPromptCategory = (input: AdminPromptCategory) => adminPromptRequest<AdminPromptCatalog>("admin/prompt-categories", "POST", input);
export const updateAdminPromptCategory = (input: AdminPromptCategory) => adminPromptRequest<AdminPromptCatalog>(`admin/prompt-categories/${encodeURIComponent(input.id)}`, "PUT", input);
export const deleteAdminPromptCategory = async (id: string) => { const response = await authFetch(`admin/prompt-categories/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!response.ok) throw new AuthHttpError(response.status, await response.text()); };
export const createAdminPrompt = (input: AdminPromptEntry) => adminPromptRequest<AdminPromptCatalog>("admin/prompts", "POST", input);
export const updateAdminPrompt = (input: AdminPromptEntry) => adminPromptRequest<AdminPromptCatalog>(`admin/prompts/${encodeURIComponent(input.id)}`, "PUT", input);
export const bulkDeleteAdminPrompts = (ids: string[]) => adminPromptRequest<AdminPromptCatalog>("admin/prompts/bulk-delete", "POST", { ids });
export const createAdminPromptSource = (input: AdminPromptSource) => adminPromptRequest<AdminPromptCatalog>("admin/prompt-sources", "POST", input);
export const updateAdminPromptSource = (input: AdminPromptSource) => adminPromptRequest<AdminPromptCatalog>(`admin/prompt-sources/${encodeURIComponent(input.id)}`, "PUT", input);
export const deleteAdminPromptSource = async (id: string) => { const response = await authFetch(`admin/prompt-sources/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!response.ok) throw new AuthHttpError(response.status, await response.text()); };
export const syncAdminPromptSource = (id: string) => adminPromptRequest<AdminPromptSyncRun>(`admin/prompt-sources/${encodeURIComponent(id)}/sync`, "POST");
export const syncAllAdminPromptSources = () => adminPromptRequest<AdminPromptSyncRun[]>("admin/prompt-sources/sync-all", "POST");
export const runDueAdminPromptSources = () => adminPromptRequest<AdminPromptSyncRun[]>("admin/prompt-sources/run-due", "POST");
