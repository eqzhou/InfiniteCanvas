import { describe, expect, test } from "bun:test";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordPolicyError, passwordsMatch } from "./password-policy";

describe("password policy", () => {
  test("rejects passwords shorter than the server minimum", () => {
    expect(passwordPolicyError("short")).toBe("too-short");
    expect(passwordPolicyError("1234567")).toBe("too-short");
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  test("accepts an 8-character password and rejects overlong or whitespace input", () => {
    expect(passwordPolicyError("abcdefgh")).toBeNull();
    expect(passwordPolicyError("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(passwordPolicyError("a".repeat(PASSWORD_MAX_LENGTH + 1))).toBe("too-long");
    expect(passwordPolicyError("        ")).toBe("too-short");
    expect(passwordPolicyError("密".repeat(25))).toBe("too-long");
  });

  test("requires an exact confirmation match", () => {
    expect(passwordsMatch("abcdefgh", "abcdefgh")).toBe(true);
    expect(passwordsMatch("abcdefgh", "abcdefgH")).toBe(false);
  });
});
