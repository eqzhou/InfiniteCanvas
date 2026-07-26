import { describe, expect, test } from "bun:test";
import { optionalLocalStateResources, summarizeMigrationCredentials } from "./local-migration-resources";

describe("local migration resource selection", () => {
  test("preserves missing assets and prompts instead of inventing empty resources", () => {
    expect(optionalLocalStateResources(undefined, undefined)).toEqual([]);
    expect(optionalLocalStateResources([], undefined)).toEqual([{ id: "assets", value: [] }]);
    expect(optionalLocalStateResources(undefined, [])).toEqual([{ id: "prompts", value: [] }]);
  });

  test("summarizes credential kinds without exposing credential values", () => {
    const summary = summarizeMigrationCredentials({
      apiKeys: { first: { image: "sk-image", video: "" }, second: { text: "sk-text" } },
      webdavPass: "dav-secret",
      objectStorageAccessKeyId: "access",
      objectStorageSecretAccessKey: "secret",
      objectStorageSessionToken: "session",
    });
    expect(summary).toEqual({
      present: true,
      labels: ["2 个 AI 渠道 API 密钥", "WebDAV 密码", "对象存储访问凭据", "对象存储会话令牌"],
    });
    expect(JSON.stringify(summary)).not.toContain("sk-image");
    expect(JSON.stringify(summary)).not.toContain("dav-secret");
  });
});
