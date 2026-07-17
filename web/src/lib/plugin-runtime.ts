import type { PluginManifest, PluginPermission } from "@/types/board";
import { validateJsonObject } from "@/lib/bounded-json";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PERMISSIONS = new Set<PluginPermission>([
  "node:read",
  "node:write",
  "asset:read",
  "asset:write",
  "ai:text",
  "ai:image",
  "ai:video",
  "panel:control",
]);
const MAX_DOCUMENT_LENGTH = 512_000;
const MAX_PATCH_BYTES = 64 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new Error(`${label} must be a non-empty string up to ${max} characters`);
  }
  return value;
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const input = object(value, "plugin manifest");
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
    throw new Error("unsupported plugin schemaVersion");
  }
  const id = boundedString(input.id, "plugin id", 128);
  if (!ID_PATTERN.test(id)) throw new Error("plugin id is invalid");
  const version = boundedString(input.version, "plugin version", 64);
  if (!VERSION_PATTERN.test(version)) throw new Error("plugin version is invalid");
  const permissions = Array.isArray(input.permissions) ? input.permissions : [];
  if (permissions.length > 32 || permissions.some((permission) =>
    typeof permission !== "string" || !PERMISSIONS.has(permission as PluginPermission))) {
    throw new Error("plugin permission is unsupported");
  }
  const defaultSize = object(input.defaultSize, "plugin defaultSize");
  const width = defaultSize.width;
  const height = defaultSize.height;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 160 || width > 2_000 ||
      typeof height !== "number" || !Number.isFinite(height) || height < 100 || height > 2_000) {
    throw new Error("plugin defaultSize is invalid");
  }
  return {
    schemaVersion: 2,
    id,
    name: boundedString(input.name, "plugin name", 100),
    version,
    description: boundedString(input.description, "plugin description", 500),
    document: boundedString(input.document, "plugin document", MAX_DOCUMENT_LENGTH),
    permissions: [...new Set(permissions as PluginPermission[])],
    defaultSize: { width, height },
  };
}

function escapeScriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function buildPluginDocument(manifest: PluginManifest, nonce: string): string {
  const bridge = escapeScriptJSON({ nonce, pluginId: manifest.id });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">
<style>html,body{margin:0;min-height:100%;font:14px system-ui,sans-serif;color:#202124;background:transparent}*{box-sizing:border-box}</style>
<script>(function(){const identity=${bridge};let current={};const pending=new Map();function send(type,payload){parent.postMessage({type,nonce:identity.nonce,pluginId:identity.pluginId,...payload},'*')}function request(method,params){const requestId=crypto.randomUUID();return new Promise(function(resolve,reject){pending.set(requestId,{resolve:resolve,reject:reject});send('openboard:request',{requestId:requestId,method:method,params:params||{}})})}window.openboard={ready:function(){send('openboard:ready',{})},getState:function(){return current},patch:function(patch){send('openboard:patch',{patch})},request:request,node:{get:function(){return request('node.get')},patch:function(patch){return request('node.patch',patch)}},assets:{list:function(query){return request('asset.list',{query:query||''})},create:function(asset){return request('asset.create',asset)}},ai:{text:function(options){return request('ai.text',options)},image:function(options){return request('ai.image',options)},video:function(options){return request('ai.video',options)}},panel:{setOpen:function(open){return request('panel.setOpen',{open:!!open})}}};addEventListener('message',function(event){const message=event.data;if(!message||message.nonce!==identity.nonce||message.pluginId!==identity.pluginId)return;if(message.type==='openboard:init'){current=message.state||{};dispatchEvent(new CustomEvent('openboard:init',{detail:current}));return}if(message.type==='openboard:response'){const task=pending.get(message.requestId);if(!task)return;pending.delete(message.requestId);if(message.ok)task.resolve(message.result);else task.reject(new Error(message.error||'Plugin host request failed'))}})})();</script>
</head><body>${manifest.document}</body></html>`;
}

export function parsePluginPatchMessage(
  value: unknown,
  nonce: string,
  pluginId?: string,
): { title?: string; state?: Record<string, unknown> } {
  const message = object(value, "plugin message");
  if (message.type !== "openboard:patch") throw new Error("plugin message type is invalid");
  if (message.nonce !== nonce) throw new Error("plugin message nonce is invalid");
  if (pluginId !== undefined && message.pluginId !== pluginId) {
    throw new Error("plugin message plugin id is invalid");
  }
  const patch = object(message.patch, "plugin patch");
  if (Object.keys(patch).some((key) => key !== "title" && key !== "state")) {
    throw new Error("plugin patch field is unsupported");
  }
  if (JSON.stringify(patch).length > MAX_PATCH_BYTES) throw new Error("plugin patch is too large");
  const result: { title?: string; state?: Record<string, unknown> } = {};
  if (patch.title !== undefined) result.title = boundedString(patch.title, "plugin title", 500);
  if (patch.state !== undefined) {
    result.state = validateJsonObject(patch.state, {
      label: "plugin state",
      maxBytes: MAX_PATCH_BYTES,
      maxDepth: 20,
      maxEntries: 10_000,
    });
  }
  return result;
}

export function isPluginReadyMessage(
  value: unknown,
  nonce: string,
  pluginId: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.type === "openboard:ready" &&
    message.nonce === nonce &&
    message.pluginId === pluginId;
}
