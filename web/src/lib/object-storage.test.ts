import { describe, expect, test } from "bun:test";
import {
  createDefaultObjectStorage,
  normalizeObjectStorage,
  stripObjectStorageSecrets,
  validateObjectStorageConfig,
} from "./object-storage";

describe("object storage config", () => {
  test("normalizes defaults and strips unsafe prefix segments", () => {
    expect(normalizeObjectStorage(undefined)).toEqual(createDefaultObjectStorage());
    expect(normalizeObjectStorage({
      enabled: true,
      endpoint: " https://account.r2.cloudflarestorage.com ",
      bucket: "Media-Bucket",
      region: "",
      prefix: "../evil/openboard",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "tok",
      allowInsecureLoopback: true,
    })).toMatchObject({
      enabled: true,
      endpoint: "https://account.r2.cloudflarestorage.com",
      bucket: "media-bucket",
      region: "auto",
      prefix: "openboard",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "tok",
      allowInsecureLoopback: true,
    });
  });

  test("validates enabled configurations", () => {
    const valid = normalizeObjectStorage({
      enabled: true,
      endpoint: "https://account.r2.cloudflarestorage.com",
      bucket: "openboard-media",
      region: "auto",
      prefix: "openboard",
      accessKeyId: "ak",
      secretAccessKey: "sk",
    });
    expect(validateObjectStorageConfig(valid)).toBeNull();
    expect(validateObjectStorageConfig({ ...valid, endpoint: "http://example.com" })).toMatch(/HTTPS/);
    expect(validateObjectStorageConfig({ ...valid, endpoint: "http://127.0.0.1:9000", allowInsecureLoopback: true })).toBeNull();
    expect(validateObjectStorageConfig({ ...valid, accessKeyId: "" })).toMatch(/Access Key/);
    expect(validateObjectStorageConfig({ ...createDefaultObjectStorage(), enabled: false })).toBeNull();
  });

  test("strips credentials without mutating input", () => {
    const input = normalizeObjectStorage({
      enabled: true,
      endpoint: "https://account.r2.cloudflarestorage.com",
      bucket: "openboard-media",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "tok",
    });
    const stripped = stripObjectStorageSecrets(input);
    expect(stripped.accessKeyId).toBe("");
    expect(stripped.secretAccessKey).toBe("");
    expect(stripped.sessionToken).toBe("");
    expect(input.accessKeyId).toBe("ak");
  });
});
