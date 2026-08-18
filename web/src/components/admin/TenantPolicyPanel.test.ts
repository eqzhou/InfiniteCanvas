import { describe, expect, test } from "bun:test";
import { parseTenantModelList, tenantPolicyWritePayload } from "./TenantPolicyPanel";

describe("TenantPolicyPanel", () => {
  test("normalizes the tenant model allow list without changing first-seen order", () => {
    expect(parseTenantModelList(" gpt-image-2\n\ngpt-5.5\ngpt-image-2 ")).toEqual([
      "gpt-image-2",
      "gpt-5.5",
    ]);
  });

  test("keeps an unsaved allow-list draft on every policy write", () => {
    expect(tenantPolicyWritePayload(
      { allowCustomChannel: true, allowCloudChannel: false, availableModels: ["stale-model"] },
      " gpt-image-2\ngpt-5.5 ",
    )).toEqual({
      allowCustomChannel: true,
      allowCloudChannel: false,
      availableModels: ["gpt-image-2", "gpt-5.5"],
    });
  });
});
