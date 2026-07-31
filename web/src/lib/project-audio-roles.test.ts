import { describe, expect, test } from "bun:test";
import { createNode, createProject } from "@/lib/defaults";
import {
  migrateLegacyAudioRoles,
  replaceProjectAudioRoles,
} from "@/lib/project-audio-roles";

describe("project audio roles", () => {
  test("new projects own an independent empty role catalog", () => {
    const first = createProject("First");
    const second = createProject("Second");

    expect(first.audioRoles).toEqual([]);
    expect(second.audioRoles).toEqual([]);
    expect(first.audioRoles).not.toBe(second.audioRoles);
  });

  test("migrates legacy roles only into projects that predate the project field", () => {
    const legacy = createProject("Legacy");
    delete (legacy as { audioRoles?: unknown }).audioRoles;
    const modern = { ...createProject("Modern"), audioRoles: [] };
    const roles = [{ id: "hero", name: "男主", voices: { edge: "zh-CN-YunxiNeural" } }];

    const migrated = migrateLegacyAudioRoles([legacy, modern], roles);

    expect(migrated.migrated).toBe(true);
    expect(migrated.projects[0]?.audioRoles).toEqual(roles);
    expect(migrated.projects[1]?.audioRoles).toEqual([]);
    expect(migrated.projects[0]?.audioRoles).not.toBe(roles);
  });

  test("removing a role clears stale node bindings but preserves voice overrides", () => {
    const project = createProject("Cast");
    const node = createNode("audio", { x: 0, y: 0 }, {
      metadata: { audioRoleId: "hero", voice: "custom-voice" },
    });
    const withRole = {
      ...project,
      audioRoles: [{ id: "hero", name: "男主", voices: { openai: "onyx" } }],
      nodes: [node],
    };

    const updated = replaceProjectAudioRoles(withRole, []);

    expect(updated.audioRoles).toEqual([]);
    expect(updated.nodes[0]?.metadata.audioRoleId).toBeUndefined();
    expect(updated.nodes[0]?.metadata.voice).toBe("custom-voice");
  });
});
