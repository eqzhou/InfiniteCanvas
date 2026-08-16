import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getPlatformPolicy,
  getSitePolicy,
  getTenantPolicy,
  updatePlatformPolicy,
  updateSitePolicy,
  updateTenantPolicy,
} from "./auth-session";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("scoped policy transport", () => {
  test("reads and writes platform, tenant, and compatibility policies on distinct endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "PUT") return new Response(String(init.body));
      if (url.endsWith("/tenant/policy")) {
        return new Response(JSON.stringify({
          allowCustomChannel: true,
          allowCloudChannel: false,
          availableModels: [" gpt-image-2 ", "gpt-image-2", "gpt-5.5"],
          defaultImageModel: "gpt-image-2",
        }));
      }
      if (url.endsWith("/platform/policy")) {
        return new Response(JSON.stringify({ allowRegister: false, linuxDoEnabled: true }));
      }
      return new Response(JSON.stringify({
        allowRegister: true,
        allowCustomChannel: false,
        allowCloudChannel: true,
      }));
    }) as typeof fetch;

    expect(await getTenantPolicy()).toEqual({
      allowCustomChannel: true,
      allowCloudChannel: false,
      availableModels: ["gpt-image-2", "gpt-5.5"],
      defaultModel: "",
      defaultTextModel: "",
      defaultImageModel: "gpt-image-2",
      defaultVideoModel: "",
      defaultAudioModel: "",
    });
    expect(await getPlatformPolicy()).toEqual({ allowRegister: false, linuxDoEnabled: true });
    expect(await getSitePolicy()).toMatchObject({
      allowRegister: true,
      allowCustomChannel: false,
      allowCloudChannel: true,
    });

    await updateTenantPolicy({ allowCustomChannel: true, allowCloudChannel: true });
    await updatePlatformPolicy({ allowRegister: false });
    await updateSitePolicy({ allowRegister: false, allowCustomChannel: false, allowCloudChannel: false });

    expect(requests.map((request) => request.url)).toEqual([
      "/api/tenant/policy",
      "/api/platform/policy",
      "/api/site-policy",
      "/api/tenant/policy",
      "/api/platform/policy",
      "/api/site-policy",
    ]);
    expect(requests.slice(3).every((request) => request.init?.method === "PUT")).toBe(true);
  });

  test("fails closed when the public compatibility policy cannot be loaded", async () => {
    globalThis.fetch = mock(async () => { throw new TypeError("offline"); }) as typeof fetch;
    expect(await getSitePolicy()).toEqual({
      allowRegister: false,
      allowCustomChannel: false,
      allowCloudChannel: false,
    });
  });
});
