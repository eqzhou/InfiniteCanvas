import { validateJsonObject } from "@/lib/bounded-json";
import type { PluginPermission } from "@/types/board";

export type PluginHostMethod =
  | "node.get"
  | "node.patch"
  | "asset.list"
  | "asset.create"
  | "ai.text"
  | "ai.image"
  | "ai.video"
  | "panel.setOpen";

export type PluginHostRequest = {
  requestId: string;
  method: PluginHostMethod;
  params: Record<string, unknown>;
};

/** Control-plane budget: titles, queries, prompts, panel flags. */
export const PLUGIN_HOST_PARAMS_MAX_BYTES = 64 * 1024;

/**
 * Budget for the two methods that carry data URLs. Matches the host→plugin
 * ceiling in PluginNodeFrame so the bridge is symmetric: a plugin can hand back
 * an image it was just given.
 */
export const PLUGIN_HOST_MEDIA_PARAMS_MAX_BYTES = 8 * 1024 * 1024;

/** Message quota budget: the media params plus a bounded protocol envelope. */
export const PLUGIN_HOST_MESSAGE_MAX_BYTES =
  PLUGIN_HOST_MEDIA_PARAMS_MAX_BYTES + PLUGIN_HOST_PARAMS_MAX_BYTES;

const MEDIA_BEARING_METHODS: ReadonlySet<PluginHostMethod> = new Set([
  "asset.create",
  "ai.text",
]);

export function paramsBudgetForPluginMethod(method: PluginHostMethod): number {
  return MEDIA_BEARING_METHODS.has(method)
    ? PLUGIN_HOST_MEDIA_PARAMS_MAX_BYTES
    : PLUGIN_HOST_PARAMS_MAX_BYTES;
}

const METHOD_PERMISSIONS: Readonly<Record<PluginHostMethod, PluginPermission>> = {
  "node.get": "node:read",
  "node.patch": "node:write",
  "asset.list": "asset:read",
  "asset.create": "asset:write",
  "ai.text": "ai:text",
  "ai.image": "ai:image",
  "ai.video": "ai:video",
  "panel.setOpen": "panel:control",
};

export function permissionForPluginMethod(method: string): PluginPermission {
  const permission = METHOD_PERMISSIONS[method as PluginHostMethod];
  if (!permission) throw new Error("plugin host method is unsupported");
  return permission;
}

export function parsePluginHostRequest(
  value: unknown,
  nonce: string,
  pluginId: string,
  permissions: readonly PluginPermission[],
): PluginHostRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plugin host request must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.type !== "openboard:request" || input.nonce !== nonce || input.pluginId !== pluginId) {
    throw new Error("plugin host request identity is invalid");
  }
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) {
    throw new Error("plugin host request id is invalid");
  }
  if (typeof input.method !== "string") throw new Error("plugin host method is invalid");
  const permission = permissionForPluginMethod(input.method);
  if (!permissions.includes(permission)) throw new Error(`plugin permission ${permission} was not granted`);
  const method = input.method as PluginHostMethod;
  return {
    requestId: input.requestId,
    method,
    params: validateJsonObject(input.params ?? {}, {
      label: "plugin host params",
      maxBytes: paramsBudgetForPluginMethod(method),
      maxDepth: 12,
      maxEntries: 2_000,
    }),
  };
}
