import { normalizeAudioRoles } from "@/lib/audio-provider";
import type { AudioRolePreset, BoardProject } from "@/types/board";

export function migrateLegacyAudioRoles(
  projects: readonly BoardProject[],
  legacyRoles: unknown,
): { projects: BoardProject[]; migrated: boolean } {
  const roles = normalizeAudioRoles(legacyRoles);
  let migrated = false;
  const next = projects.map((project) => {
    if (project.audioRoles !== undefined || roles.length === 0) return project;
    migrated = true;
    return { ...project, audioRoles: cloneRoles(roles) };
  });
  return { projects: migrated ? next : [...projects], migrated };
}

export function replaceProjectAudioRoles(
  project: BoardProject,
  value: unknown,
): BoardProject {
  const audioRoles = normalizeAudioRoles(value);
  const validRoleIDs = new Set(audioRoles.map((role) => role.id));
  const nodes = project.nodes.map((node) => {
    if (node.type !== "audio" || !node.metadata.audioRoleId || validRoleIDs.has(node.metadata.audioRoleId)) {
      return node;
    }
    return { ...node, metadata: { ...node.metadata, audioRoleId: undefined } };
  });
  return { ...project, audioRoles: cloneRoles(audioRoles), nodes };
}

function cloneRoles(roles: readonly AudioRolePreset[]): AudioRolePreset[] {
  return roles.map((role) => ({ ...role, voices: { ...role.voices } }));
}
