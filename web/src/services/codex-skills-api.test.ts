import { describe, expect, test } from "bun:test";
import {
  createCodexSkill,
  deleteCodexSkill,
  getCodexSkill,
  invokeCodexSkill,
  listCodexSkills,
  toggleCodexSkill,
  updateCodexSkill,
  type AgentConnection,
} from "@/services/local-agent";

const connection: AgentConnection = { baseUrl: "http://127.0.0.1:8790" };
const skill = {
  id: "review-code",
  name: "Review code",
  description: "Check tests",
  enabled: true,
  updatedAt: "2026-08-05T00:00:00Z",
  bytes: 14,
  version: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  content: "# Review code",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Codex Skill API client", () => {
  test("validates the list and sends an optimistic concurrency header on update", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return response({ skills: [skill] });
      return response({ ...skill, content: "# Updated", bytes: 10 });
    };

    await expect(listCodexSkills(connection, fetcher)).resolves.toMatchObject([{ id: skill.id, version: skill.version }]);
    await expect(updateCodexSkill(connection, "review-code", "# Updated", skill.version, fetcher)).resolves.toMatchObject({
      id: "review-code",
      content: "# Updated",
    });
    expect(new Headers(requests[1].init?.headers).get("If-Match")).toBe(skill.version);
  });

  test("covers create, toggle, invoke, delete and rejects unsafe ids before fetch", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 3) return response({ id: skill.id, name: skill.name, content: skill.content });
      if (requests.length === 4) return new Response(null, { status: 204 });
      if (requests.length === 5) return response({ skills: [skill] });
      return response(skill);
    };

    await expect(createCodexSkill(connection, { id: skill.id, content: skill.content }, fetcher)).resolves.toMatchObject({ id: skill.id });
    await expect(toggleCodexSkill(connection, skill.id, false, skill.version, fetcher)).resolves.toMatchObject({ id: skill.id });
    await expect(invokeCodexSkill(connection, skill.id, fetcher)).resolves.toEqual({ id: skill.id, name: skill.name, content: skill.content });
    await expect(deleteCodexSkill(connection, skill.id, skill.version, fetcher)).resolves.toBeUndefined();
    await expect(listCodexSkills(connection, fetcher)).resolves.toHaveLength(1);
    await expect(getUnsafeSkill()).rejects.toThrow("invalid");
  });
});

async function getUnsafeSkill(): Promise<unknown> {
  return getCodexSkill(connection, "../escape", async () => response({}));
}
