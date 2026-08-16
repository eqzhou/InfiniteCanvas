import { describe, expect, test } from "bun:test";
import { adminTabsForCapabilities } from "./AdminPage";

describe("admin role architecture", () => {
  test("keeps tenant and platform management surfaces independent", () => {
    expect(adminTabsForCapabilities({ tenantOwner: true, platformAdmin: false })).toEqual([
      "quota", "users", "credits", "policy", "channels", "prompts", "library", "storage",
    ]);
    expect(adminTabsForCapabilities({ tenantOwner: false, platformAdmin: true })).toEqual([
      "platform", "models",
    ]);
    expect(adminTabsForCapabilities({ tenantOwner: true, platformAdmin: true })).toEqual([
      "quota", "users", "credits", "policy", "channels", "prompts", "library", "storage",
      "platform", "models",
    ]);
    expect(adminTabsForCapabilities({ tenantOwner: false, platformAdmin: false })).toEqual([]);
  });
});
