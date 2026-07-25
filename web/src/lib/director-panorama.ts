import type { BoardNode, BoardProject } from "@/types/board";
import { uid } from "@/lib/id";
import { validatePanoramaDimensions } from "@/lib/panorama";

function hasRenderableMedia(node: BoardNode | null | undefined): node is BoardNode {
  return Boolean(node && (node.metadata.storageKey || node.metadata.content));
}

/** True only for strict 2:1 native panorama media (spherical environment). */
export function isUsablePanoramaEnvironment(node: BoardNode | null | undefined): node is BoardNode {
  if (!node || node.type !== "panorama" || !hasRenderableMedia(node)) return false;
  try {
    validatePanoramaDimensions(node.metadata.naturalWidth ?? 0, node.metadata.naturalHeight ?? 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Public Tiger behavior: a connected image node can be selected as a director
 * environment source. Ordinary images remain ordinary backgrounds; only
 * validated 2:1 panorama nodes are true spherical environments.
 */
export function isDirectorEnvironmentSource(node: BoardNode | null | undefined): node is BoardNode {
  if (!node) return false;
  // Empty panorama/image nodes may still be connected before media is ready.
  return node.type === "panorama" || node.type === "image";
}

export function isUsableDirectorEnvironment(node: BoardNode | null | undefined): node is BoardNode {
  if (!node || !hasRenderableMedia(node)) return false;
  if (node.type === "panorama") return isUsablePanoramaEnvironment(node);
  if (node.type === "image") return true;
  return false;
}

/** Environment choices are only sources currently connected into the director. */
export function listDirectorEnvironmentOptions(
  project: BoardProject,
  directorId: string,
): BoardNode[] {
  const director = project.nodes.find((node) => node.id === directorId && node.type === "director");
  if (!director) return [];
  const options: BoardNode[] = [];
  const seen = new Set<string>();
  for (const edge of project.edges) {
    if (edge.to !== directorId) continue;
    const candidate = project.nodes.find((node) => node.id === edge.from);
    if (!candidate || !isDirectorEnvironmentSource(candidate)) continue;
    if (!candidate.metadata.content) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    options.push(candidate);
  }
  return options;
}

export function resolveDirectorPanorama(project: BoardProject, directorId: string): BoardNode | undefined {
  const director = project.nodes.find((node) => node.id === directorId && node.type === "director");
  if (!director) return undefined;
  for (const edge of project.edges) {
    if (edge.to !== directorId) continue;
    const candidate = project.nodes.find((node) => node.id === edge.from);
    if (isUsableDirectorEnvironment(candidate)) return candidate;
  }
  return undefined;
}

export function bindDirectorPanorama(
  project: BoardProject,
  directorId: string,
  environmentId: string | null,
): BoardProject {
  const director = project.nodes.find((node) => node.id === directorId);
  if (!director || director.type !== "director") throw new Error("导演台节点不存在");
  const environment = environmentId === null
    ? null
    : project.nodes.find((node) => node.id === environmentId) ?? null;
  if (environmentId !== null && !isDirectorEnvironmentSource(environment)) {
    throw new Error("环境节点不存在");
  }
  const environmentIds = new Set(
    project.nodes.filter((node) => isDirectorEnvironmentSource(node)).map((node) => node.id),
  );
  const edges = project.edges.filter((edge) => !(edge.to === directorId && environmentIds.has(edge.from)));
  if (environment) edges.push({ id: uid("edge"), from: environment.id, to: directorId });
  const unchanged = edges.length === project.edges.length &&
    edges.every((edge, index) => edge === project.edges[index]);
  return unchanged ? project : { ...project, edges };
}

export function removeEdgeAndReconcilePanorama(project: BoardProject, edgeId: string): BoardProject {
  const edges = project.edges.filter((edge) => edge.id !== edgeId);
  return edges.length === project.edges.length ? project : { ...project, edges };
}
