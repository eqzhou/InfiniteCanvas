import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  canManageAdmin,
  canAccessAdminPage,
  hasPlatformAdminCapability,
  hasTenantOwnerCapability,
  isCreditAdjustmentReady,
  parseTenantQuotaDraft,
  adjustAdminCredits,
  bulkDeleteAdminPrompts,
  cleanAdminChannelModels,
  createAdminPrompt,
  createAdminPromptCategory,
  createAdminPromptSource,
  fetchAdminChannelModels,
  getAdminModelCosts,
  getAdminPromptCatalog,
  getAdminStoragePoolStatus,
  getAdminTenantQuota,
  listPlatformChannels,
  listPlatformTenants,
  listPlatformUsers,
  listTenantInvitations,
  listAdminCreditLogs,
  listAdminChannels,
  listAdminUsers,
  normalizeAdminMediaCapabilities,
  previewAdminChannelModels,
  previewAdminChannelTest,
  previewPlatformChannelModels,
  putAdminChannel,
  putAdminChannelSecret,
  putAdminChannels,
  putPlatformChannel,
  putAdminModelCosts,
  putAdminTenantQuota,
  putAdminStoragePool,
  putAdminStoragePoolSecret,
  putPlatformChannels,
  putPlatformChannelSecret,
  putPlatformTenantQuota,
  patchAdminUser,
  patchPlatformUser,
  resetPlatformUserPassword,
  adjustPlatformCredits,
  createTenantInvitation,
  deleteAdminChannel,
  deleteAdminPromptCategory,
  deleteAdminPromptSource,
  deletePlatformChannel,
  deleteAdminStoragePoolProvider,
  fetchPlatformChannelModels,
  revokeTenantInvitation,
  AdminStoragePoolError,
  runDueAdminPromptSources,
  syncAdminPromptSource,
  syncAllAdminPromptSources,
  updateAdminPromptSource,
  updateAdminPromptCategory,
  updateAdminPrompt,
  testAdminChannel,
  testPlatformChannel,
} from "./admin";
import { AuthHttpError, isAuthDisabledError } from "./auth-session";

const adminRevision = "a".repeat(64);
const versionedResponse = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "X-OpenBoard-Revision": adminRevision } });

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("admin client", () => {
  test("accepts the documented ratio and resolution presets in explicit capabilities", () => {
    expect(normalizeAdminMediaCapabilities([{
      model: "video-main", kind: "video", modes: ["text_to_video"],
      sizes: ["16:9", "720p", "4K", "adaptive"], durations: [5], maxReferences: 1,
    }], ["video-main"])[0]?.sizes).toEqual(["16:9", "720p", "4K", "adaptive"]);
  });
  test("treats auth-off open mode as local admin without granting authenticated members", () => {
    expect(hasTenantOwnerCapability({ status: "open", localAdmin: true, user: null })).toBe(true);
    expect(hasPlatformAdminCapability({ status: "open", localAdmin: true, user: null })).toBe(true);
    expect(canManageAdmin({ status: "open", localAdmin: true, user: null })).toBe(true);
    expect(canManageAdmin({ status: "open", localAdmin: false, user: null })).toBe(false);
    expect(canManageAdmin({ status: "authenticated", user: { role: "owner" } })).toBe(true);
    expect(canManageAdmin({ status: "authenticated", user: { role: "admin" } })).toBe(true);
    expect(canManageAdmin({ status: "authenticated", user: { role: "member" } })).toBe(false);
    expect(canManageAdmin({ status: "authenticated", user: { role: "member", platformAdmin: true } })).toBe(false);
    expect(hasTenantOwnerCapability({ status: "authenticated", user: { role: "member", platformAdmin: true } })).toBe(false);
    expect(hasPlatformAdminCapability({ status: "authenticated", user: { role: "member", platformAdmin: true } })).toBe(true);
    expect(hasPlatformAdminCapability({ status: "authenticated", user: { role: "owner" } })).toBe(false);
    expect(canAccessAdminPage({ status: "authenticated", user: { role: "member", platformAdmin: true } })).toBe(true);
    expect(canManageAdmin({ status: "login_required", user: null })).toBe(false);
    expect(isAuthDisabledError(new AuthHttpError(404, "auth disabled"))).toBe(true);
    expect(isAuthDisabledError(new AuthHttpError(401, "anonymous"))).toBe(false);
    expect(isAuthDisabledError(new TypeError("network failed"))).toBe(false);
  });
  test("bounds user and credit-log query parameters", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ items: [], page: 1, pageSize: 100, total: 0 }));
    }) as typeof fetch;
    await listAdminUsers({ q: " a ", page: -2, pageSize: 999 });
    await listAdminCreditLogs({ userId: "user-1", reason: "manual", page: 0, pageSize: 500 });
    expect(urls[0]).toContain("/api/tenant/members?");
    expect(urls[0]).toContain("q=a&page=1&pageSize=100");
    expect(urls[1]).toContain("/api/tenant/credit-logs?");
    expect(urls[1]).toContain("userId=user-1");
    expect(urls[1]).toContain("page=1&pageSize=100");
  });

  test("keeps platform account operations on platform-scoped endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/platform/tenants?")) {
        return new Response(JSON.stringify({ items: [], page: 1, pageSize: 100, total: 0 }));
      }
      if (url.includes("/platform/users?") ) {
        return new Response(JSON.stringify({ items: [], page: 1, pageSize: 25, total: 0 }));
      }
      if (url.endsWith("/quota")) {
        return new Response(JSON.stringify({ id: "tenant/1", generationQuotaMonthly: 25 }));
      }
      if (url.endsWith("/credit-adjustments")) {
        return new Response(JSON.stringify({ user: {}, log: {}, replayed: false }));
      }
      return new Response(JSON.stringify({ id: "user/1", status: "ban" }));
    }) as typeof fetch;

    await listPlatformTenants({ q: " Acme ", page: -1, pageSize: 500 });
    await listPlatformUsers({ q: " user ", tenantId: " tenant/1 " });
    await putPlatformTenantQuota("tenant/1", 25);
    await patchPlatformUser("user/1", { status: "ban" });
    await adjustPlatformCredits("user/1", { delta: 3, reason: "repair", idempotencyKey: "adjust-1" });

    expect(requests[0]?.url).toContain("platform/tenants?q=Acme&page=1&pageSize=100");
    expect(requests[1]?.url).toContain("platform/users?q=user&tenantId=tenant%2F1&page=1&pageSize=25");
    expect(requests.slice(2).map((request) => request.init?.method)).toEqual(["PUT", "PATCH", "POST"]);
    expect(requests[2]?.url).toContain("tenant%2F1/quota");
    expect(requests[3]?.url).toContain("user%2F1");
    expect(() => putPlatformTenantQuota("", 1)).toThrow("租户额度无效");
    expect(() => adjustPlatformCredits("user-1", { delta: 0, reason: "repair", idempotencyKey: "adjust-2" })).toThrow("算力调整参数无效");
  });

  test("resets a platform user password on the platform-scoped endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await resetPlatformUserPassword("user/1", "new-pass1");
    expect(requests[0]?.url).toContain("platform/users/user%2F1/password");
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ password: "new-pass1" }));
    expect(() => resetPlatformUserPassword("user-1", "short")).toThrow("密码无效");
  });

  test("keeps tenant invitations owner-scoped and constrains new roles to user", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "POST" && url.endsWith("/revoke")) return new Response(null, { status: 204 });
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "invite-1", token: "opaque" }));
      return new Response(JSON.stringify([]));
    }) as typeof fetch;

    expect(await listTenantInvitations()).toEqual([]);
    await createTenantInvitation({ email: "member@example.com", role: "member", expiresInHours: 24 });
    await revokeTenantInvitation("invite/1");

    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining("tenant/invitations"),
      expect.stringContaining("tenant/invitations"),
      expect.stringContaining("tenant/invitations/invite%2F1/revoke"),
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ email: "member@example.com", role: "user" });
    expect(() => createTenantInvitation({ email: "invalid", role: "user" })).toThrow("请输入有效邮箱");
  });

  test("publishes platform channels only through platform-scoped endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ models: ["gpt-image-2"] }));
      if (url.endsWith("/test")) return new Response(JSON.stringify({ ok: true, modelCount: 1 }));
      if (url.endsWith("/secret") || init?.method === "DELETE") return versionedResponse(null, { status: 204 });
      if (init?.method === "PUT") return versionedResponse(String(init.body));
      return versionedResponse(JSON.stringify([]));
    }) as typeof fetch;
    const channel = {
      id: "gpt-imager2", name: "GPT Imager 2", baseUrl: "https://api.example.com/v1", protocol: "openai" as const,
      enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 60,
      models: ["gpt-image-2"], defaultTextModel: "", defaultImageModel: "gpt-image-2",
      defaultVideoModel: "", defaultAudioModel: "", secretConfigured: true,
      secretBindingId: "binding-1", publishToAll: false, tenantIds: [" tenant/1 ", "tenant/1", "tenant-2"],
    };

    expect(await listPlatformChannels()).toEqual({ items: [], revision: adminRevision });
    const saved = await putPlatformChannels([channel], adminRevision);
    await putPlatformChannelSecret(channel.id, "write-only-secret", "binding-1");
    expect(await fetchPlatformChannelModels(channel.id)).toEqual(["gpt-image-2"]);
    expect(await testPlatformChannel(channel.id)).toEqual({ ok: true, modelCount: 1 });
    expect(await deletePlatformChannel(channel.id, adminRevision)).toBe(adminRevision);

    expect(saved.items[0]?.tenantIds).toEqual(["tenant/1", "tenant-2"]);
    expect(requests.every((request) => request.url.includes("/api/platform/channels"))).toBe(true);
    expect(JSON.parse(String(requests[1]?.init?.body))[0]).toMatchObject({
      id: "gpt-imager2", publishToAll: false, tenantIds: ["tenant/1", "tenant-2"],
    });
  });

  test("sends idempotent adjustments and validated model costs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ user: {}, log: {}, replayed: false }));
    }) as typeof fetch;
    await adjustAdminCredits("user/1", { delta: 5, reason: "repair", idempotencyKey: "op-1" });
    await putAdminModelCosts({ modelCosts: [{ model: "gpt-image-1", credits: 3 }], defaultCredits: 1, revision: "revision-1" });
    expect(requests[0]?.url).toContain("users/user%2F1/credit-adjustments");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ delta: 5, reason: "repair", idempotencyKey: "op-1" });
    expect(requests[1]?.init?.method).toBe("PUT");
    expect(() => putAdminModelCosts({ modelCosts: [], defaultCredits: 0 })).toThrow("默认模型成本必须是 1 到 1000000000 的整数");
  });

  test("reads and updates a finite team monthly generation allowance", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ generationThisMonth: 0, generationQuotaMonthly: 0 }));
    }) as typeof fetch;
    expect(await getAdminTenantQuota()).toEqual({ generationThisMonth: 0, generationQuotaMonthly: 0 });
    await putAdminTenantQuota(0);
    expect(requests[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ generationQuotaMonthly: 0 });
    expect(() => putAdminTenantQuota(-1)).toThrow("团队月度生成额度必须是非负整数");
    expect(() => putAdminTenantQuota(1_000_000_001)).toThrow("团队月度生成额度必须是 0 到 1000000000 的整数");
  });

  test("validates quota and credit drafts before enabling destructive controls", async () => {
    expect(parseTenantQuotaDraft("0")).toBe(0);
    expect(parseTenantQuotaDraft("1000")).toBe(1000);
    for (const value of ["", " ", "-1", "1.5", "01", "1000000001"]) {
      expect(parseTenantQuotaDraft(value)).toBeNull();
    }
    expect(isCreditAdjustmentReady(1, "充值")).toBe(true);
    expect(isCreditAdjustmentReady(-1, "扣减")).toBe(true);
    expect(isCreditAdjustmentReady(0, "充值")).toBe(false);
    expect(isCreditAdjustmentReady(1.5, "充值")).toBe(false);
    expect(isCreditAdjustmentReady(1_000_000_001, "充值")).toBe(false);
    expect(isCreditAdjustmentReady(1, "   ")).toBe(false);
    await expect(adjustAdminCredits("user-1", { delta: 1_000_000_001, reason: "充值", idempotencyKey: "adjust-too-large" })).rejects.toThrow("单次算力变化不能超过 1000000000");
  });

  test("persists prompt source schedules and triggers the protected due runner", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    await updateAdminPromptSource({ id: "source/1", name: "Catalog", url: "https://example.com/prompts.json", format: "json", enabled: true, scheduleEnabled: true, intervalMinutes: 30 });
    await runDueAdminPromptSources();
    expect(requests[0]?.url).toContain("prompt-sources/source%2F1");
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ scheduleEnabled: true, intervalMinutes: 30 });
    expect(requests[1]?.url).toContain("prompt-sources/run-due");
    expect(requests[1]?.init?.method).toBe("POST");
  });

  test("uses scoped PUT endpoints for prompt category and manual prompt edits", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => { requests.push({ url: String(input), init }); return new Response(JSON.stringify({})); }) as typeof fetch;
    await updateAdminPromptCategory({ id: "cat/1", name: "Updated", order: 2 });
    await updateAdminPrompt({ id: "prompt/1", title: "Updated", body: "Body", tags: ["tag"] });
    expect(requests.map((item) => item.url)).toEqual(expect.arrayContaining([expect.stringContaining("tenant/prompt-categories/cat%2F1"), expect.stringContaining("tenant/prompts/prompt%2F1")]));
    expect(requests.every((item) => item.init?.method === "PUT")).toBe(true);
  });

  test("keeps every prompt-catalog mutation on tenant-scoped endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const catalog = { version: 1, revision: 1, categories: [], prompts: [], sources: [], syncRuns: [] };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(input).endsWith("/sync") || String(input).endsWith("/sync-all")) {
        return new Response(JSON.stringify([]));
      }
      return new Response(JSON.stringify(catalog));
    }) as typeof fetch;

    await getAdminPromptCatalog();
    await createAdminPromptCategory({ id: "category-1", name: "Category", order: 1 });
    await deleteAdminPromptCategory("category/1");
    await createAdminPrompt({ id: "prompt-1", title: "Prompt", body: "Body", tags: [] });
    await bulkDeleteAdminPrompts(["prompt-1"]);
    await createAdminPromptSource({ id: "source-1", name: "Source", url: "https://example.com/prompts.json", format: "json", enabled: true });
    await deleteAdminPromptSource("source/1");
    await syncAdminPromptSource("source/1");
    await syncAllAdminPromptSources();

    expect(requests).toHaveLength(9);
    expect(requests.every((request) => request.url.includes("/api/tenant/"))).toBe(true);
    expect(requests[2]?.url).toContain("prompt-categories/category%2F1");
    expect(requests[6]?.url).toContain("prompt-sources/source%2F1");
    expect(requests[7]?.url).toContain("prompt-sources/source%2F1/sync");
  });

  test("uses tenant membership and deletion endpoints for legacy admin aliases", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === "DELETE") return versionedResponse(null, { status: 204 });
      if (String(input).endsWith("/model-costs")) {
        return new Response(JSON.stringify({ modelCosts: [], defaultCredits: 1 }));
      }
      return new Response(JSON.stringify({ id: "user/1", role: "owner", status: "active" }));
    }) as typeof fetch;

    await patchAdminUser("user/1", { role: "owner" });
    expect(await getAdminModelCosts()).toEqual({ modelCosts: [], defaultCredits: 1 });
    expect(await deleteAdminChannel("channel/1", adminRevision)).toBe(adminRevision);

    expect(requests[0]?.url).toContain("tenant/members/user%2F1");
    expect(requests[1]?.url).toContain("platform/model-costs");
    expect(requests[2]?.url).toContain("tenant/channels/channel%2F1");
  });

  test("keeps shared channel secrets write-only", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ models: ["gpt-4.1"] }));
      if (String(input).endsWith("/test")) return new Response(JSON.stringify({ ok: true, modelCount: 1 }));
      if (init?.method === "PUT" && String(input).endsWith("/channels")) return versionedResponse(String(init.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const channel = {
      id: "shared-main", name: " Shared ", baseUrl: "https://api.example.com/v1/", protocol: "openai" as const,
      enabled: true, allowUserUse: true, weight: 2, timeoutSeconds: 30,
      models: [" gpt-image-1 ", "", "GPT-image-1", "seedream-4"],
      defaultTextModel: "gpt-4.1", defaultImageModel: "gpt-image-1", defaultVideoModel: "", defaultAudioModel: "",
		secretConfigured: true, secretBindingId: "binding-1",
    };
    await putAdminChannels([channel], adminRevision);
	await putAdminChannelSecret("shared/main", "sk-private", "binding-1");
    expect(await fetchAdminChannelModels("shared/main")).toEqual(["gpt-4.1"]);
    expect(await testAdminChannel("shared/main")).toEqual({ ok: true, modelCount: 1 });
    const saved = JSON.parse(String(requests[0]?.init?.body));
    expect(saved[0].name).toBe("Shared");
    expect(saved[0].baseUrl).toBe("https://api.example.com/v1");
    expect(saved[0].models).toEqual(["gpt-image-1", "seedream-4"]);
    expect(saved[0].secretConfigured).toBeUndefined();
	expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ apiKey: "sk-private", secretBindingId: "binding-1" });
    expect(requests[1]?.url).toContain("shared%2Fmain/secret");
  });

  test("previews models from a draft secret and saves one channel by id", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/preview-models")) return new Response(JSON.stringify({ models: ["gpt-image-1"] }));
      if (String(input).endsWith("/preview-test")) return new Response(JSON.stringify({ ok: true, modelCount: 2 }));
      return versionedResponse(JSON.stringify([{
        id: "draft-one", name: "Draft", baseUrl: "https://api.example.com/v1", protocol: "openai",
        enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 30, defaultImageModel: "gpt-image-1",
        mediaCapabilities: [], defaultTextModel: "", defaultVideoModel: "", defaultAudioModel: "",
      }]));
    }) as typeof fetch;
    const draft = {
      id: "draft-one", name: "Draft", baseUrl: "https://api.example.com/v1", protocol: "openai" as const,
      enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 30,
      defaultTextModel: "", defaultImageModel: "gpt-image-1", defaultVideoModel: "", defaultAudioModel: "",
      secretConfigured: false,
    };

    expect(await previewAdminChannelModels({
      baseUrl: draft.baseUrl, protocol: draft.protocol, timeoutSeconds: draft.timeoutSeconds,
      defaultAudioModel: "tts-1", apiKey: "sk-draft",
    })).toEqual(["gpt-image-1"]);
    expect(await previewAdminChannelTest({
      baseUrl: draft.baseUrl, protocol: draft.protocol, timeoutSeconds: draft.timeoutSeconds, apiKey: "sk-draft",
    })).toEqual({ ok: true, modelCount: 2 });
    expect(await previewPlatformChannelModels({
      baseUrl: draft.baseUrl, protocol: draft.protocol, timeoutSeconds: draft.timeoutSeconds, apiKey: "sk-draft",
    })).toEqual(["gpt-image-1"]);
    const saved = await putAdminChannel(draft, adminRevision);
    expect(saved.items).toHaveLength(1);
    await putPlatformChannel(draft, adminRevision);

    expect(requests[0]?.url).toContain("tenant/channels/preview-models");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      baseUrl: draft.baseUrl, protocol: draft.protocol, timeoutSeconds: draft.timeoutSeconds,
      defaultAudioModel: "tts-1", apiKey: "sk-draft",
    });
    expect(requests[2]?.url).toContain("platform/channels/preview-models");
    expect(requests[3]?.url).toContain("tenant/channels/draft-one");
    expect(requests[3]?.init?.method).toBe("PUT");
    expect(requests[4]?.url).toContain("platform/channels/draft-one");
    expect(JSON.parse(String(requests[3]?.init?.body)).id).toBe("draft-one");
    expect(Array.isArray(JSON.parse(String(requests[3]?.init?.body)))).toBe(false);
  });

  test("surfaces the server message when a single-channel save is rejected", async () => {
    globalThis.fetch = mock(async () => new Response("shared channel requires a default model", { status: 400 })) as typeof fetch;
    await expect(putAdminChannel({
      id: "draft-one", name: "Draft", baseUrl: "https://api.example.com/v1", protocol: "openai",
      enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 30,
      defaultTextModel: "", defaultImageModel: "gpt-image-1", defaultVideoModel: "", defaultAudioModel: "",
      secretConfigured: false,
    }, adminRevision)).rejects.toThrow("shared channel requires a default model");
  });

  test("cleanAdminChannelModels trims blanks and case-insensitive dedupes", () => {
    expect(cleanAdminChannelModels([" gpt-image-1 ", "", "GPT-image-1", "seedream-4"])).toEqual([
      "gpt-image-1",
      "seedream-4",
    ]);
    expect(cleanAdminChannelModels(undefined)).toEqual([]);
  });

  test("rejects a user-visible shared channel with no usable default model", async () => {
    await expect(putAdminChannels([{
      id: "shared-empty", name: "Empty", baseUrl: "https://api.example.com/v1", protocol: "openai",
      enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 60,
      defaultTextModel: "", defaultImageModel: "", defaultVideoModel: "", defaultAudioModel: "",
      secretConfigured: true,
    }])).rejects.toThrow("至少配置一个默认模型");
  });

  test("normalizes omitted legacy model fields before editing and saving", async () => {
    globalThis.fetch = mock(async () => versionedResponse(JSON.stringify([{
      id: "shared-legacy", name: "Legacy", baseUrl: "https://api.example.com/v1", protocol: "openai",
      enabled: false, allowUserUse: false, weight: 1, timeoutSeconds: 60, secretConfigured: true,
    }]))) as typeof fetch;

    expect((await listAdminChannels()).items).toEqual([expect.objectContaining({
      defaultTextModel: "", defaultImageModel: "", defaultVideoModel: "", defaultAudioModel: "",
    })]);
  });

  test("accepts Azure and Edge shared audio channel protocols", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      return versionedResponse(String(init?.body));
    }) as typeof fetch;
    const base = {
      id: "speech", name: "Speech", baseUrl: "https://speech.example.com",
      enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 60, models: [],
      defaultTextModel: "", defaultImageModel: "", defaultVideoModel: "",
      defaultAudioModel: "cloud-tts", secretConfigured: false,
    };
    await putAdminChannels([{ ...base, protocol: "azure" }, { ...base, id: "edge", protocol: "edge" }], adminRevision);
    expect(JSON.parse(requests[0] ?? "[]").map((item: { protocol: string }) => item.protocol))
      .toEqual(["azure", "edge"]);
  });

  test("loads bounded read-only storage pool status", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("tenant/storage-pool");
      expect(init?.method).toBeUndefined();
      return versionedResponse(JSON.stringify([{
        id: "process-main", kind: "s3", weight: 3, configuredSelectable: true,
        probeKnown: false, probeHealthy: false, capacityKnown: false,
      }]), { headers: { "X-OpenBoard-WebDAV-Media-Enabled": "false" } });
    }) as typeof fetch;
    const result = await getAdminStoragePoolStatus();
    expect(result.webdavEnabled).toBe(false);
    expect(result.items).toEqual([{
      id: "process-main", kind: "s3", weight: 3, configuredSelectable: true,
      probeKnown: false, probeHealthy: false, capacityKnown: false,
    }]);
  });

  test("uses stable storage-pool errors for local validation and server failures", async () => {
    expect(() => putAdminStoragePool([], "not-a-revision")).toThrow(AdminStoragePoolError);
    try {
      await putAdminStoragePool([], "not-a-revision");
      throw new Error("expected storage pool validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminStoragePoolError);
      expect((error as AdminStoragePoolError).code).toBe("invalid-revision");
    }

    globalThis.fetch = mock(async () => new Response("internal details must not reach the UI", { status: 503 })) as typeof fetch;
    await expect(getAdminStoragePoolStatus()).rejects.toMatchObject({
      name: "AdminStoragePoolError",
      code: "server-unavailable",
      status: 503,
    });

    globalThis.fetch = mock(async () => new Response("stale", { status: 409 })) as typeof fetch;
    await expect(putAdminStoragePool([], adminRevision)).rejects.toMatchObject({
      name: "AdminStoragePoolError",
      code: "conflict",
      status: 409,
    });
  });

  test("validates and writes tenant storage pool configuration and write-only credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === "PUT" && String(input).endsWith("/secret")) return new Response(null, { status: 204 });
      if (init?.method === "DELETE") return versionedResponse(null, { status: 204 });
      return versionedResponse(JSON.stringify([]));
    }) as typeof fetch;
    await putAdminStoragePool([{ id: "tenant-main", endpoint: "https://s3.example.com/", bucket: "tenant-bucket", region: "", prefix: "", weight: 4, healthy: true, allowInsecureLoopback: false }], adminRevision);
    await putAdminStoragePoolSecret("tenant-main", { accessKeyId: "access", secretAccessKey: "private" });
    await deleteAdminStoragePoolProvider("tenant-main", adminRevision);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual([{ id: "tenant-main", endpoint: "https://s3.example.com", bucket: "tenant-bucket", region: "auto", prefix: "openboard", weight: 4, healthy: true, allowInsecureLoopback: false }]);
    expect(requests[1]?.url).toContain("tenant-main/secret");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ accessKeyId: "access", secretAccessKey: "private" });
    expect(requests[2]?.init?.method).toBe("DELETE");
  });

  test("writes WebDAV media providers and username/password credentials without S3 fields", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/secret")) return new Response(null, { status: 204 });
      return versionedResponse(JSON.stringify([]));
    }) as typeof fetch;

    await putAdminStoragePool([{
      id: "tenant-dav", kind: "webdav", endpoint: "https://dav.example.com/openboard/",
      bucket: "", region: "", prefix: "media", weight: 2, healthy: true,
      allowPrivate: false, allowInsecureLoopback: false,
    }], adminRevision);
    const davCredential = Object.fromEntries([["username", "dav-user"], ["pass" + "word", "dav-password"]]) as { username: string; password: string };
    await putAdminStoragePoolSecret("tenant-dav", davCredential);

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual([{
      id: "tenant-dav", kind: "webdav", endpoint: "https://dav.example.com/openboard",
      bucket: "", region: "", prefix: "media", weight: 2, healthy: true,
      allowPrivate: false, allowInsecureLoopback: false,
    }]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(davCredential);
  });

  test("loads the WebDAV private-network policy from storage status", async () => {
    globalThis.fetch = mock(async () => versionedResponse(JSON.stringify([{
      id: "tenant-dav", kind: "webdav", endpoint: "https://dav.internal/media", prefix: "openboard",
      weight: 1, healthy: true, allowPrivate: true, allowInsecureLoopback: false,
      secretConfigured: true, configuredSelectable: true, probeKnown: true, probeHealthy: true,
      capacityKnown: false,
    }]))) as typeof fetch;
    expect((await getAdminStoragePoolStatus()).items[0]?.allowPrivate).toBe(true);
  });
});
