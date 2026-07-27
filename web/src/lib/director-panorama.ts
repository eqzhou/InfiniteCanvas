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
  const preferredId = director.metadata.directorScene?.environment?.sourceId ?? null;
  if (preferredId) {
    const preferred = project.nodes.find((node) => node.id === preferredId);
    if (
      preferred &&
      isUsableDirectorEnvironment(preferred) &&
      project.edges.some((edge) => edge.from === preferred.id && edge.to === directorId)
    ) {
      return preferred;
    }
  }
  for (const edge of project.edges) {
    if (edge.to !== directorId) continue;
    const candidate = project.nodes.find((node) => node.id === edge.from);
    if (isUsableDirectorEnvironment(candidate)) return candidate;
  }
  return undefined;
}

/**
 * True when the environment should be rendered as a spherical equirectangular
 * skybox. Ordinary photos stay flat backgrounds even if they are connected.
 */
export function isSphericalDirectorEnvironment(node: BoardNode | null | undefined): boolean {
  if (!node || !hasRenderableMedia(node)) return false;
  if (node.type === "panorama") return isUsablePanoramaEnvironment(node);
  if (node.type === "image") {
    // Only images that were explicitly imported / marked as equirectangular
    // panoramas use the sphere path; plain photos stay flat.
    if (node.metadata.panoramaProjection === "equirectangular") {
      try {
        validatePanoramaDimensions(node.metadata.naturalWidth ?? 0, node.metadata.naturalHeight ?? 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
  return false;
}

/**
 * Connect an environment source into a director without dropping other
 * environment edges. Passing null clears every environment edge and the
 * active selection. Passing an already-connected id only updates the active
 * selection so multi-select stays intact.
 */
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

  let edges = project.edges;
  if (environmentId === null) {
    edges = project.edges.filter((edge) => !(edge.to === directorId && environmentIds.has(edge.from)));
  } else if (environment && !project.edges.some((edge) => edge.from === environment.id && edge.to === directorId)) {
    edges = [...project.edges, { id: uid("edge"), from: environment.id, to: directorId }];
  }

  const nodes = project.nodes.map((node) => {
    if (node.id !== directorId) return node;
    const current = node.metadata.directorScene;
    const sameSource = (current?.environment?.sourceId ?? null) === (environment?.id ?? null);
    if (sameSource && edges === project.edges) return node;
    if (!current) {
      // Director without a scene yet: only record the active environment selection.
      return {
        ...node,
        metadata: {
          ...node.metadata,
          directorScene: {
            version: 4 as const,
            background: "#0b1220",
            showGroundGrid: true,
            showRuleOfThirds: false,
            showSafeFrame: true,
            viewMode: "director" as const,
            directorView: { position: { x: 0, y: 1.6, z: 4 }, target: { x: 0, y: 1, z: 0 } },
            selectedObjectId: null,
            activeCameraId: "camera_main",
            cameras: [{
              id: "camera_main",
              name: "主摄像机",
              position: { x: 0, y: 1.6, z: 4 },
              target: { x: 0, y: 1, z: 0 },
              focalLength: 35,
              aperture: 2.8,
              aspect: "16:9" as const,
            }],
            environment: {
              rotationY: 0,
              intensity: 1,
              sourceId: environment?.id ?? null,
            },
            objects: [],
          },
        },
      };
    }
    return {
      ...node,
      metadata: {
        ...node.metadata,
        directorScene: {
          ...current,
          environment: {
            ...current.environment,
            sourceId: environment?.id ?? null,
          },
        },
      },
    };
  });

  const unchanged = edges === project.edges && nodes.every((node, index) => node === project.nodes[index]);
  return unchanged ? project : { ...project, edges, nodes };
}

export function removeEdgeAndReconcilePanorama(project: BoardProject, edgeId: string): BoardProject {
  const removed = project.edges.find((edge) => edge.id === edgeId);
  const edges = project.edges.filter((edge) => edge.id !== edgeId);
  if (edges.length === project.edges.length || !removed) {
    return edges.length === project.edges.length ? project : { ...project, edges };
  }
  const director = project.nodes.find((node) => node.id === removed.to && node.type === "director");
  if (!director) return { ...project, edges };
  const activeId = director.metadata.directorScene?.environment?.sourceId ?? null;
  if (activeId !== removed.from) return { ...project, edges };
  // Dropped the active environment edge: clear selection so resolve falls through.
  const nodes = project.nodes.map((node) => {
    if (node.id !== director.id || !node.metadata.directorScene) return node;
    const scene = node.metadata.directorScene;
    return {
      ...node,
      metadata: {
        ...node.metadata,
        directorScene: {
          ...scene,
          environment: {
            ...scene.environment,
            sourceId: null,
          },
        },
      },
    };
  });
  return { ...project, edges, nodes };
}
