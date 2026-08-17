export type LazyDataState = "idle" | "loading" | "loaded" | "error";

export class WorkspaceScopeChangedError extends Error {
  constructor() {
    super("workspace scope changed");
    this.name = "WorkspaceScopeChangedError";
  }
}

export function shouldAutoloadLazySlice(ready: boolean, state: LazyDataState): boolean {
  return ready && state === "idle";
}

export function canPersistLazySlice(state: LazyDataState): boolean {
  return state === "loaded";
}

export function resolveActiveProjectId(
  current: string | null,
  projects: ReadonlyArray<{ id: string }>,
): string | null {
  if (current && projects.some((project) => project.id === current)) return current;
  return projects[0]?.id ?? null;
}

export function keepLazyLoadPromise<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  promise: Promise<T>,
): void {
  if (cache.get(key) === promise) cache.delete(key);
}
