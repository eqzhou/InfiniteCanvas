import { describe, expect, test } from "bun:test";
import { TenantConfigAdminRequiredError } from "@/services/server-storage";
import { saveWorkspaceReplacementConfig } from "./use-board-store";

describe("workspace replacement permissions", () => {
	test("keeps the current tenant config when a member restores a workspace", async () => {
		expect(await saveWorkspaceReplacementConfig(async () => {
			throw new TenantConfigAdminRequiredError();
		})).toBe(false);
	});

	test("does not hide unrelated persistence failures", async () => {
		await expect(saveWorkspaceReplacementConfig(async () => {
			throw new Error("storage offline");
		})).rejects.toThrow("storage offline");
	});
});
