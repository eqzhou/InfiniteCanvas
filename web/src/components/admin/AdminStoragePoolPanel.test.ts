import { describe, expect, test } from "bun:test";
import {
  blankStorageProvider,
  newStorageProviderDraft,
  persistedStorageProviderDrafts,
  storageCapacityLabel,
  storageCredentialKind,
  storageDeleteTarget,
  storagePoolErrorMessage,
  storageDraftStatus,
  storageProbeLabel,
} from "./AdminStoragePoolPanel";
import type { AdminStoragePoolProviderStatus } from "@/services/admin";
import { AdminStoragePoolError } from "@/services/admin";

const status = (patch: Partial<AdminStoragePoolProviderStatus> = {}): AdminStoragePoolProviderStatus => ({
  id: "pool", kind: "s3", weight: 1, configuredSelectable: true,
  probeKnown: false, probeHealthy: false, capacityKnown: false, ...patch,
});

describe("admin storage pool provider forms", () => {
  test("starts new providers as explicit S3 providers", () => {
    expect(blankStorageProvider().kind).toBe("s3");
  });

  test("selects credentials from the provider kind", () => {
    expect(storageCredentialKind("s3")).toBe("access-key");
    expect(storageCredentialKind("webdav")).toBe("username-password");
  });

  test("does not let an unsaved draft impersonate or delete a persisted provider", () => {
    const persisted = status({ id: "existing", endpoint: "https://storage.example.com" });
    const [existingDraft] = persistedStorageProviderDrafts([persisted]);
    const newDraft = newStorageProviderDraft("draft-1", { ...blankStorageProvider(), id: "existing" });

    expect(storageDraftStatus(existingDraft!, [persisted])).toEqual(persisted);
    expect(storageDeleteTarget(existingDraft!)).toBe("existing");
    expect(storageDraftStatus(newDraft, [persisted])).toBeUndefined();
    expect(storageDeleteTarget(newDraft)).toBeUndefined();
  });
});

describe("admin storage pool status labels", () => {
  test("does not present unknown probes or capacity as healthy/empty", () => {
    expect(storageProbeLabel(status())).toBe("未知（权限中立）");
    expect(storageCapacityLabel(status())).toBe("未知（提供商未暴露）");
  });

  test("formats known health and capacity independently", () => {
    const known = status({ probeKnown: true, probeHealthy: true, capacityKnown: true, totalBytes: 1024 ** 3, availableBytes: 512 * 1024 ** 2 });
    expect(storageProbeLabel(known)).toBe("探测正常");
    expect(storageCapacityLabel(known)).toContain("512 MB 可用");
    expect(storageProbeLabel(status({ probeKnown: true, probeHealthy: false }))).toBe("探测失败");
  });
});

describe("admin storage pool error presentation", () => {
  test("localizes known stable errors and never exposes unknown server detail", () => {
    expect(storagePoolErrorMessage(new AdminStoragePoolError("invalid-endpoint"), "en-US"))
      .toBe("Enter a valid storage endpoint.");
    expect(storagePoolErrorMessage(new AdminStoragePoolError("conflict", 409), "en-US"))
      .toBe("This storage pool was changed by another administrator. Reload and try again.");
    expect(storagePoolErrorMessage(new Error("internal details must not reach the UI"), "en-US"))
      .toBe("The storage pool request could not be completed. Try again.");
  });
});
