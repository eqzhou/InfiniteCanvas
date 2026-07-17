export type PluginPermission =
  | "node:read"
  | "node:write"
  | "asset:read"
  | "asset:write"
  | "ai:text"
  | "ai:image"
  | "ai:video"
  | "panel:control";

export type PluginNodeState = {
  title?: string;
  state?: Record<string, unknown>;
};

export type PluginAsset = {
  id: string;
  kind: "text" | "image";
  title: string;
  content?: string;
  coverUrl?: string;
  tags: string[];
};

export type OpenBoardPluginApi = {
  ready(): void;
  getState(): PluginNodeState;
  patch(patch: PluginNodeState): void;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  node: {
    get(): Promise<PluginNodeState>;
    patch(patch: PluginNodeState): Promise<PluginNodeState>;
  };
  assets: {
    list(query?: string): Promise<PluginAsset[]>;
    create(asset: { kind: "text" | "image"; title: string; content: string; tags?: string[] }): Promise<PluginAsset>;
  };
  ai: {
    text(options: { prompt: string; model?: string; images?: string[] }): Promise<{ text: string }>;
    image(options: { prompt: string; model?: string; size?: string; count?: number }): Promise<{ images: string[] }>;
    video(options: { prompt: string; model?: string; ratio?: string; seconds?: number }): Promise<{ id: string; url?: string }>;
  };
  panel: {
    setOpen(open: boolean): Promise<{ open: boolean }>;
  };
};

declare global {
  interface Window {
    openboard: OpenBoardPluginApi;
  }
}

export function getOpenBoard(): OpenBoardPluginApi {
  if (!window.openboard) throw new Error("OpenBoard plugin host is unavailable");
  return window.openboard;
}
