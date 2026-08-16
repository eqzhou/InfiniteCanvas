import { describe, expect, test } from "bun:test";
import { parseTenantModelList } from "./TenantPolicyPanel";

describe("TenantPolicyPanel", () => {
  test("normalizes the tenant model allow list without changing first-seen order", () => {
    expect(parseTenantModelList(" gpt-image-2\n\ngpt-5.5\ngpt-image-2 ")).toEqual([
      "gpt-image-2",
      "gpt-5.5",
    ]);
  });
});
