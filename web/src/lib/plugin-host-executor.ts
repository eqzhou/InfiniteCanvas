import { PLUGIN_HOST_MEDIA_PARAMS_MAX_BYTES, type PluginHostRequest } from "@/lib/plugin-host";

type NodeState = { title?: string; state?: Record<string, unknown> };
type AssetInput = {
  kind: "text" | "image";
  title: string;
  content: string;
  tags?: string[];
};
type AssetOutput = {
  id: string;
  kind: "text" | "image";
  title: string;
  content?: string;
  coverUrl?: string;
  tags: string[];
};

export type PluginHostContext = {
  getNode: () => NodeState;
  patchNode: (patch: NodeState) => NodeState;
  listAssets: (query: string) => AssetOutput[];
  createAsset: (asset: AssetInput) => AssetOutput | Promise<AssetOutput>;
  generateText: (options: { prompt: string; model?: string; images?: string[] }) => Promise<{ text: string }>;
  generateImage: (options: { prompt: string; model?: string; size?: string; quality?: string; resolution?: string; count?: number }) => Promise<{ images: string[] }>;
  generateVideo: (options: { prompt: string; model?: string; ratio?: string; seconds?: number }) => Promise<{ id: string; url?: string }>;
  setPanelOpen: (open: boolean) => { open: boolean };
};

function stringParam(
  params: Record<string, unknown>,
  key: string,
  max: number,
  required = false,
): string | undefined {
  const value = params[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    throw new Error(`plugin ${key} is invalid`);
  }
  return value;
}

function promptOptions(params: Record<string, unknown>) {
  return {
    prompt: stringParam(params, "prompt", 32_000, true)!,
    model: stringParam(params, "model", 200),
  };
}

export async function executePluginHostRequest(
  request: PluginHostRequest,
  context: PluginHostContext,
): Promise<unknown> {
  const { params } = request;
  switch (request.method) {
    case "node.get":
      return context.getNode();
    case "node.patch":
      return context.patchNode({
        title: stringParam(params, "title", 500),
        state: params.state && typeof params.state === "object" && !Array.isArray(params.state)
          ? params.state as Record<string, unknown>
          : undefined,
      });
    case "asset.list":
      return context.listAssets(stringParam(params, "query", 200) ?? "");
    case "asset.create": {
      const kind = params.kind;
      if (kind !== "text" && kind !== "image") throw new Error("plugin asset kind is invalid");
      const tags = params.tags === undefined
        ? undefined
        : Array.isArray(params.tags) && params.tags.length <= 50 && params.tags.every((tag) =>
          typeof tag === "string" && tag.length <= 100)
          ? [...params.tags] as string[]
          : (() => { throw new Error("plugin asset tags are invalid"); })();
      return context.createAsset({
        kind,
        title: stringParam(params, "title", 500, true)!,
        content: stringParam(
          params,
          "content",
          kind === "image" ? PLUGIN_HOST_MEDIA_PARAMS_MAX_BYTES : 512_000,
          true,
        )!,
        tags,
      });
    }
    case "ai.text": {
      const images = params.images === undefined
        ? undefined
        : Array.isArray(params.images) && params.images.length <= 8 && params.images.every((image) =>
          typeof image === "string" && image.length <= PLUGIN_HOST_MEDIA_PARAMS_MAX_BYTES)
          ? [...params.images] as string[]
          : (() => { throw new Error("plugin images are invalid"); })();
      return context.generateText({ ...promptOptions(params), images });
    }
    case "ai.image": {
      const count = params.count === undefined ? undefined : Number(params.count);
      if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 100)) {
        throw new Error("plugin image count is invalid");
      }
      return context.generateImage({
        ...promptOptions(params),
        size: stringParam(params, "size", 50),
        quality: stringParam(params, "quality", 50),
        resolution: stringParam(params, "resolution", 20),
        count,
      });
    }
    case "ai.video": {
      const seconds = params.seconds === undefined ? undefined : Number(params.seconds);
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 1 || seconds > 300)) {
        throw new Error("plugin video seconds is invalid");
      }
      return context.generateVideo({
        ...promptOptions(params),
        ratio: stringParam(params, "ratio", 20),
        seconds,
      });
    }
    case "panel.setOpen":
      if (typeof params.open !== "boolean") throw new Error("plugin panel open is invalid");
      return context.setPanelOpen(params.open);
    default: {
      // Never resolve an unimplemented method as a successful no-op: the host
      // replies ok:true with the returned value. Typed never keeps the switch
      // exhaustive when the protocol grows.
      const unsupported: never = request.method;
      throw new Error(`plugin host method ${String(unsupported)} is unsupported`);
    }
  }
}
