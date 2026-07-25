import { authFetch } from "@/services/auth-session";

export type LibraryAssetKind = "text" | "image" | "video" | "audio";

export type LibraryAsset = {
  id: string;
  kind: LibraryAssetKind;
  title: string;
  tags: string[];
  content?: string;
  coverUrl?: string;
  source?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type LibraryAssetPage = {
  items: LibraryAsset[];
  page: number;
  pageSize: number;
  total: number;
};

export type LibraryAssetInput = {
  kind: LibraryAssetKind;
  title: string;
  tags?: string[];
  content?: string;
  coverUrl?: string;
  source?: string;
  notes?: string;
};

export type LibraryAssetQuery = {
  q?: string;
  kind?: LibraryAssetKind | "all";
  tag?: string;
  page?: number;
  pageSize?: number;
};

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listLibraryAssets(query: LibraryAssetQuery = {}): Promise<LibraryAssetPage> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.kind && query.kind !== "all") params.set("kind", query.kind);
  if (query.tag?.trim()) params.set("tag", query.tag.trim());
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const qs = params.toString();
  return readJSON<LibraryAssetPage>(
    await authFetch(`library-assets${qs ? `?${qs}` : ""}`),
  );
}

export async function createLibraryAsset(input: LibraryAssetInput): Promise<LibraryAsset> {
  return readJSON<LibraryAsset>(
    await authFetch("library-assets", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateLibraryAsset(id: string, input: LibraryAssetInput): Promise<LibraryAsset> {
  return readJSON<LibraryAsset>(
    await authFetch(`library-assets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteLibraryAsset(id: string): Promise<void> {
  await readJSON<void>(
    await authFetch(`library-assets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  );
}
