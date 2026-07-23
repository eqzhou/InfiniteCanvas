import { authFetch } from "@/services/auth-session";
import type { AppConfig, AssetItem, BoardProject, PromptItem } from "@/types/board";
import { parseBoardProject } from "@/lib/board-document";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return authFetch(path, init);
}

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Server storage failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function loadServerProjects(): Promise<BoardProject[]> {
  const summaries = await readJSON<Array<{ id: string }>>(await request("projects"));
  return Promise.all(summaries.map(async ({ id }) =>
    parseBoardProject(await readJSON<unknown>(await request(`projects/${encodeURIComponent(id)}`))),
  ));
}

export async function saveServerProjects(projects: BoardProject[]): Promise<void> {
  const remote = await readJSON<Array<{ id: string }>>(await request("projects"));
  const localIDs = new Set(projects.map((project) => project.id));
  await Promise.all([
    ...projects.map(async (project) => {
      const response = await request(`projects/${encodeURIComponent(project.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      if (!response.ok) throw new Error(`Project save failed: HTTP ${response.status}`);
    }),
    ...remote.filter(({ id }) => !localIDs.has(id)).map(async ({ id }) => {
      const response = await request(`projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Project delete failed: HTTP ${response.status}`);
    }),
  ]);
}

export async function loadServerState<T>(key: "config" | "assets" | "prompts"): Promise<T | null> {
  const response = await request(`state/${key}`);
  if (response.status === 404) return null;
  return readJSON<T>(response);
}

export async function saveServerState(
  key: "config" | "assets" | "prompts",
  value: AppConfig | AssetItem[] | PromptItem[],
): Promise<void> {
  const response = await request(`state/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`State save failed: HTTP ${response.status}`);
}

export async function loadServerSecrets<T>(): Promise<T | null> {
  const response = await request("secrets/config");
  if (response.status === 404) return null;
  return readJSON<T>(response);
}

export async function saveServerSecrets<T>(value: T): Promise<void> {
  const response = await request("secrets/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`);
}

export async function putServerBlob(key: string, blob: Blob): Promise<void> {
  const response = await request(`blobs/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) throw new Error(`Blob save failed: HTTP ${response.status}`);
}

export async function getServerBlob(key: string): Promise<Blob | undefined> {
  const response = await request(`blobs/${encodeURIComponent(key)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Blob read failed: HTTP ${response.status}`);
  return response.blob();
}

export async function deleteServerBlob(key: string): Promise<void> {
  const response = await request(`blobs/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Blob delete failed: HTTP ${response.status}`);
}
