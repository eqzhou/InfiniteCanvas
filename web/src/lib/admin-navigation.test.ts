import { describe, expect, test } from "bun:test";
import { adminNavGroupsForCapabilities, adminTabsForCapabilities } from "./admin-navigation";

describe("admin navigation", () => {
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

  test("groups tenant and platform tabs for the sidebar", () => {
    expect(adminNavGroupsForCapabilities({ tenantOwner: true, platformAdmin: true }).map((group) => group.id))
      .toEqual(["tenant", "platform"]);
    expect(adminNavGroupsForCapabilities({ tenantOwner: true, platformAdmin: false })[0]?.tabs)
      .toContain("channels");
  });
});
