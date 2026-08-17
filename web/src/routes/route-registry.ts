import { lazy, type ComponentType } from "react";

type RouteModule = Record<string, unknown>;
type RouteDefinition = {
  loader: () => Promise<RouteModule>;
  exportName: string;
};

export const routeDefinitions = {
  home: { loader: () => import("@/pages/HomePage"), exportName: "HomePage" },
  assets: { loader: () => import("@/pages/AssetsPage"), exportName: "AssetsPage" },
  library: { loader: () => import("@/pages/ServerLibraryPage"), exportName: "ServerLibraryPage" },
  aiLogs: { loader: () => import("@/pages/AICallLogsPage"), exportName: "AICallLogsPage" },
  prompts: { loader: () => import("@/pages/PromptsPage"), exportName: "PromptsPage" },
  plugins: { loader: () => import("@/pages/PluginsPage"), exportName: "PluginsPage" },
  imageWorkbench: { loader: () => import("@/pages/ImageWorkbenchPage"), exportName: "ImageWorkbenchPage" },
  videoWorkbench: { loader: () => import("@/pages/VideoWorkbenchPage"), exportName: "VideoWorkbenchPage" },
  admin: { loader: () => import("@/pages/AdminPage"), exportName: "AdminPage" },
  help: { loader: () => import("@/pages/HelpPage"), exportName: "HelpPage" },
  workflowWorkbench: { loader: () => import("@/pages/WorkflowWorkbenchPage"), exportName: "WorkflowWorkbenchPage" },
  filmWorkbench: { loader: () => import("@/pages/FilmWorkbenchPage"), exportName: "FilmWorkbenchPage" },
  tasks: { loader: () => import("@/pages/TaskCenterPage"), exportName: "TaskCenterPage" },
} satisfies Record<string, RouteDefinition>;

export type RouteChunk = keyof typeof routeDefinitions;

const promiseCache = new Map<RouteChunk, Promise<RouteModule>>();

export function preloadRouteChunk(route: RouteChunk): Promise<RouteModule> {
  const cached = promiseCache.get(route);
  if (cached) return cached;
  const promise = routeDefinitions[route].loader().catch((error) => {
    promiseCache.delete(route);
    throw error;
  });
  promiseCache.set(route, promise);
  return promise;
}

export function lazyRoute(route: RouteChunk) {
  return lazy(async () => {
    const definition = routeDefinitions[route];
    const module = await preloadRouteChunk(route);
    return { default: module[definition.exportName] as ComponentType };
  });
}

export const routeChunkForPath: Readonly<Record<string, RouteChunk>> = {
  "/": "home",
  "/assets": "assets",
  "/library": "library",
  "/ai-logs": "aiLogs",
  "/prompts": "prompts",
  "/plugins": "plugins",
  "/workbench/image": "imageWorkbench",
  "/workbench/video": "videoWorkbench",
  "/workbench/workflows": "workflowWorkbench",
  "/admin": "admin",
  "/help": "help",
  "/tasks": "tasks",
};

const routePrefixChunks: ReadonlyArray<readonly [string, RouteChunk]> = [
  ["/film/", "filmWorkbench"],
];

export function prefetchRoutePath(path: string): Promise<RouteModule> | undefined {
  const exact = routeChunkForPath[path];
  if (exact) return preloadRouteChunk(exact);
  const prefixed = routePrefixChunks.find(([prefix]) => path.startsWith(prefix));
  return prefixed ? preloadRouteChunk(prefixed[1]) : undefined;
}
