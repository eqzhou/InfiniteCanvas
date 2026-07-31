import { AuthHttpError, authFetch } from "@/services/auth-session";

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
};

export type AdminStoragePoolProviderStatus = {
  id: string;
  kind: string;
  weight: number;
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  healthy?: boolean;
  allowInsecureLoopback?: boolean;
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
  defaultTextModel: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  defaultAudioModel: string;
  secretConfigured: boolean;
	secretBindingId?: string;
};

const channelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const channelProtocols = new Set<AdminChannelProtocol>(["openai", "gemini", "apimart", "kie", "azure", "edge"]);

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

function normalizeAdminChannel(channel: AdminChannel): Omit<AdminChannel, "secretConfigured"> {
  const models = cleanAdminChannelModels(channel.models);
  if (models.length > 200) throw new Error("共享渠道模型数量不能超过 200");
  if (models.some((model) => model.length > 500)) throw new Error("共享渠道模型无效");
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
    defaultTextModel: channel.defaultTextModel.trim(),
    defaultImageModel: channel.defaultImageModel.trim(),
    defaultVideoModel: channel.defaultVideoModel.trim(),
    defaultAudioModel: channel.defaultAudioModel.trim(),
  };
  if (!channelIdPattern.test(value.id) || !value.name || !channelProtocols.has(value.protocol) ||
      !Number.isSafeInteger(value.weight) || value.weight < 1 || value.weight > 100 ||
      !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 600) {
    throw new Error("共享渠道配置无效");
  }
  let parsed: URL;
  try { parsed = new URL(value.baseUrl); } catch { throw new Error("共享渠道地址无效"); }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
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
  if (!Number.isSafeInteger(input.delta) || input.delta === 0) throw new Error("额度变化必须是非零整数");
  if (!input.reason.trim() || !input.idempotencyKey.trim()) throw new Error("额度调整原因和幂等键不能为空");
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

export async function putAdminModelCosts(input: AdminModelCosts): Promise<AdminModelCosts> {
  const seen = new Set<string>();
  const modelCosts = input.modelCosts.map((item) => {
    const model = item.model.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key) || !Number.isSafeInteger(item.credits) || item.credits < 0) {
      throw new Error("模型成本配置无效或重复");
    }
    seen.add(key);
    return { model, credits: item.credits };
  });
  if (!Number.isSafeInteger(input.defaultCredits) || input.defaultCredits < 0) throw new Error("默认模型成本无效");
  return json(await authFetch("admin/models", {
    method: "PUT",
    body: JSON.stringify({ modelCosts, defaultCredits: input.defaultCredits }),
  }));
}

export async function getAdminStoragePoolStatus(): Promise<AdminStoragePoolProviderStatus[]> {
  const values = await json<unknown>(await authFetch("admin/storage-pool"));
  if (!Array.isArray(values)) throw new Error("存储池状态响应无效");
  return values.map((value) => {
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
    for (const key of ["healthy", "allowInsecureLoopback", "secretConfigured"] as const) {
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
      ...(typeof item.secretConfigured === "boolean" ? { secretConfigured: item.secretConfigured } : {}),
      ...(totalBytes === undefined ? {} : { totalBytes }),
      ...(availableBytes === undefined ? {} : { availableBytes }),
      ...(typeof item.error === "string" && item.error.length <= 500 ? { error: item.error } : {}),
    };
  });
}

export type AdminStoragePoolProviderInput = {
  id: string; endpoint: string; bucket: string; region: string; prefix: string;
  weight: number; healthy: boolean; allowInsecureLoopback: boolean;
};

function normalizeStorageProvider(item: AdminStoragePoolProviderInput): AdminStoragePoolProviderInput {
  const value = { ...item, id: item.id.trim(), endpoint: item.endpoint.trim().replace(/\/+$/, ""), bucket: item.bucket.trim().toLowerCase(), region: item.region.trim() || "auto", prefix: item.prefix.trim().replace(/^\/+|\/+$/g, "") || "openboard" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.id) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket) || !Number.isSafeInteger(value.weight) || value.weight < 0 || value.weight > 10_000) throw new Error("存储提供商配置无效");
  let parsed: URL; try { parsed = new URL(value.endpoint); } catch { throw new Error("存储端点无效"); }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback && value.allowInsecureLoopback))) throw new Error("存储端点必须使用 HTTPS（仅显式允许本机 HTTP）");
  return value;
}

export async function putAdminStoragePool(items: AdminStoragePoolProviderInput[]): Promise<AdminStoragePoolProviderStatus[]> {
  if (items.length > 64) throw new Error("存储提供商不能超过 64 个");
  const normalized = items.map(normalizeStorageProvider);
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error("存储提供商 ID 不能重复");
  return json(await authFetch("admin/storage-pool", { method: "PUT", body: JSON.stringify(normalized) }));
}

export async function putAdminStoragePoolSecret(id: string, credential: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }): Promise<void> {
  if (!credential.accessKeyId.trim() || !credential.secretAccessKey.trim()) throw new Error("Access Key 和 Secret Key 不能为空");
  const response = await authFetch(`admin/storage-pool/${encodeURIComponent(id)}/secret`, { method: "PUT", body: JSON.stringify(credential) });
  if (!response.ok) await json(response);
}

export async function deleteAdminStoragePoolProvider(id: string): Promise<void> {
  const response = await authFetch(`admin/storage-pool/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) await json(response);
}

export async function listAdminChannels(): Promise<AdminChannel[]> {
  return json(await authFetch("admin/channels"));
}

export async function putAdminChannels(channels: AdminChannel[]): Promise<AdminChannel[]> {
  if (channels.length > 100) throw new Error("共享渠道数量不能超过 100");
  const normalized = channels.map(normalizeAdminChannel);
  if (new Set(normalized.map((channel) => channel.id)).size !== normalized.length) throw new Error("共享渠道 ID 不能重复");
  return json(await authFetch("admin/channels", { method: "PUT", body: JSON.stringify(normalized) }));
}

export async function deleteAdminChannel(channelId: string): Promise<void> {
  const response = await authFetch(`admin/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
  if (!response.ok) await json(response);
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
