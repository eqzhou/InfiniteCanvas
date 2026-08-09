import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  canManageAdmin,
  adjustAdminCredits,
  cleanAdminChannelModels,
  fetchAdminChannelModels,
  getAdminStoragePoolStatus,
  getAdminTenantQuota,
  listAdminCreditLogs,
  listAdminChannels,
  listAdminUsers,
  putAdminChannelSecret,
  putAdminChannels,
  putAdminModelCosts,
  putAdminTenantQuota,
  putAdminStoragePool,
  putAdminStoragePoolSecret,
  deleteAdminStoragePoolProvider,
  runDueAdminPromptSources,
  updateAdminPromptSource,
  updateAdminPromptCategory,
  updateAdminPrompt,
  testAdminChannel,
} from "./admin";
import { AuthHttpError, isAuthDisabledError } from "./auth-session";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("admin client", () => {
  test("treats auth-off open mode as local admin without granting authenticated members", () => {
    expect(canManageAdmin({ status: "open", localAdmin: true, user: null })).toBe(true);
    expect(canManageAdmin({ status: "open", localAdmin: false, user: null })).toBe(false);
    expect(canManageAdmin({ status: "authenticated", user: { role: "owner" } })).toBe(true);
    expect(canManageAdmin({ status: "authenticated", user: { role: "admin" } })).toBe(true);
    expect(canManageAdmin({ status: "authenticated", user: { role: "member" } })).toBe(false);
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
    expect(urls[0]).toContain("q=a&page=1&pageSize=100");
    expect(urls[1]).toContain("userId=user-1");
    expect(urls[1]).toContain("page=1&pageSize=100");
  });

  test("sends idempotent adjustments and validated model costs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ user: {}, log: {}, replayed: false }));
    }) as typeof fetch;
    await adjustAdminCredits("user/1", { delta: 5, reason: "repair", idempotencyKey: "op-1" });
    await putAdminModelCosts({ modelCosts: [{ model: "gpt-image-1", credits: 3 }], defaultCredits: 1 });
    expect(requests[0]?.url).toContain("users/user%2F1/credit-adjustments");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ delta: 5, reason: "repair", idempotencyKey: "op-1" });
    expect(requests[1]?.init?.method).toBe("PUT");
    expect(() => putAdminModelCosts({ modelCosts: [], defaultCredits: 0 })).toThrow("默认模型成本必须至少为 1 算力");
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
    expect(requests.map((item) => item.url)).toEqual(expect.arrayContaining([expect.stringContaining("prompt-categories/cat%2F1"), expect.stringContaining("admin/prompts/prompt%2F1")]));
    expect(requests.every((item) => item.init?.method === "PUT")).toBe(true);
  });

  test("keeps shared channel secrets write-only", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ models: ["gpt-4.1"] }));
      if (String(input).endsWith("/test")) return new Response(JSON.stringify({ ok: true, modelCount: 1 }));
      if (init?.method === "PUT" && String(input).endsWith("/channels")) return new Response(String(init.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const channel = {
      id: "shared-main", name: " Shared ", baseUrl: "https://api.example.com/v1/", protocol: "openai" as const,
      enabled: true, allowUserUse: true, weight: 2, timeoutSeconds: 30,
      models: [" gpt-image-1 ", "", "GPT-image-1", "seedream-4"],
      defaultTextModel: "gpt-4.1", defaultImageModel: "gpt-image-1", defaultVideoModel: "", defaultAudioModel: "",
		secretConfigured: true, secretBindingId: "binding-1",
    };
    await putAdminChannels([channel]);
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
    globalThis.fetch = mock(async () => new Response(JSON.stringify([{
      id: "shared-legacy", name: "Legacy", baseUrl: "https://api.example.com/v1", protocol: "openai",
      enabled: false, allowUserUse: false, weight: 1, timeoutSeconds: 60, secretConfigured: true,
    }]))) as typeof fetch;

    expect(await listAdminChannels()).toEqual([expect.objectContaining({
      defaultTextModel: "", defaultImageModel: "", defaultVideoModel: "", defaultAudioModel: "",
    })]);
  });

  test("accepts Azure and Edge shared audio channel protocols", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      return new Response(String(init?.body));
    }) as typeof fetch;
    const base = {
      id: "speech", name: "Speech", baseUrl: "https://speech.example.com",
      enabled: true, allowUserUse: true, weight: 1, timeoutSeconds: 60, models: [],
      defaultTextModel: "", defaultImageModel: "", defaultVideoModel: "",
      defaultAudioModel: "cloud-tts", secretConfigured: false,
    };
    await putAdminChannels([{ ...base, protocol: "azure" }, { ...base, id: "edge", protocol: "edge" }]);
    expect(JSON.parse(requests[0] ?? "[]").map((item: { protocol: string }) => item.protocol))
      .toEqual(["azure", "edge"]);
  });

  test("loads bounded read-only storage pool status", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("admin/storage-pool");
      expect(init?.method).toBeUndefined();
      return new Response(JSON.stringify([{
        id: "process-main", kind: "s3", weight: 3, configuredSelectable: true,
        probeKnown: false, probeHealthy: false, capacityKnown: false,
      }]));
    }) as typeof fetch;
    expect(await getAdminStoragePoolStatus()).toEqual([{
      id: "process-main", kind: "s3", weight: 3, configuredSelectable: true,
      probeKnown: false, probeHealthy: false, capacityKnown: false,
    }]);
  });

  test("validates and writes tenant storage pool configuration and write-only credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === "PUT" && String(input).endsWith("/secret")) return new Response(null, { status: 204 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify([]));
    }) as typeof fetch;
    await putAdminStoragePool([{ id: "tenant-main", endpoint: "https://s3.example.com/", bucket: "tenant-bucket", region: "", prefix: "", weight: 4, healthy: true, allowInsecureLoopback: false }]);
    await putAdminStoragePoolSecret("tenant-main", { accessKeyId: "access", secretAccessKey: "private" });
    await deleteAdminStoragePoolProvider("tenant-main");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual([{ id: "tenant-main", endpoint: "https://s3.example.com", bucket: "tenant-bucket", region: "auto", prefix: "openboard", weight: 4, healthy: true, allowInsecureLoopback: false }]);
    expect(requests[1]?.url).toContain("tenant-main/secret");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ accessKeyId: "access", secretAccessKey: "private" });
    expect(requests[2]?.init?.method).toBe("DELETE");
  });
});
