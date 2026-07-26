import { describe, expect, test } from "bun:test";
import { storageCapacityLabel, storageProbeLabel } from "./AdminStoragePoolPanel";
import type { AdminStoragePoolProviderStatus } from "@/services/admin";

const status = (patch: Partial<AdminStoragePoolProviderStatus> = {}): AdminStoragePoolProviderStatus => ({
  id: "pool", kind: "s3", weight: 1, configuredSelectable: true,
  probeKnown: false, probeHealthy: false, capacityKnown: false, ...patch,
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
