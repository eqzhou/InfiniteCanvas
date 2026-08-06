import { parsePluginManifest } from "@/lib/plugin-runtime";
import type { PluginManifest } from "@/types/board";

const stickyNote = parsePluginManifest({
  schemaVersion: 1,
  id: "openboard.sticky-note",
  name: "便签",
  version: "1.0.0",
  description: "一张可编辑、自动保存的便签。",
  permissions: ["node:read", "node:write"],
  defaultSize: { width: 300, height: 220 },
  document: `<style>body{background:#fff3a6;padding:14px}textarea{width:100%;height:180px;resize:none;border:0;outline:0;background:transparent;color:#3d351d;font:16px/1.55 system-ui}</style><textarea aria-label="便签内容" placeholder="写点什么..."></textarea><script>const field=document.querySelector('textarea');addEventListener('openboard:init',e=>{field.value=String(e.detail.state?.text||'')});field.addEventListener('input',()=>openboard.patch({state:{text:field.value}}));openboard.ready()</script>`,
});

const markdownNote = parsePluginManifest({
  schemaVersion: 1,
  id: "openboard.markdown-note",
  name: "Markdown 笔记",
  version: "1.0.0",
  description: "支持标题、列表和强调预览的轻量笔记。",
  permissions: ["node:read", "node:write"],
  defaultSize: { width: 420, height: 300 },
  document: `<style>body{display:grid;grid-template-columns:1fr 1fr;height:100vh;background:#fff}textarea,article{min-width:0;padding:12px;border:0;font:14px/1.55 system-ui}textarea{resize:none;outline:0;border-right:1px solid #ddd}article{overflow:auto}h1,h2{margin:.2em 0 .5em}ul{padding-left:20px}</style><textarea aria-label="Markdown 内容"></textarea><article></article><script>const input=document.querySelector('textarea'),out=document.querySelector('article');const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));function render(save){let html=esc(input.value).split('\n').map(line=>line.startsWith('## ')?'<h2>'+line.slice(3)+'</h2>':line.startsWith('# ')?'<h1>'+line.slice(2)+'</h1>':line.startsWith('- ')?'<div>• '+line.slice(2)+'</div>':'<div>'+line.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')+'</div>').join('');out.innerHTML=html;if(save)openboard.patch({state:{text:input.value}})}addEventListener('openboard:init',e=>{input.value=String(e.detail.state?.text||'');render(false)});input.addEventListener('input',()=>render(true));openboard.ready()</script>`,
});

const htmlPreview = parsePluginManifest({
  schemaVersion: 1,
  id: "openboard.html-preview",
  name: "HTML 预览",
  version: "1.0.0",
  description: "在隔离沙箱内编辑和预览 HTML 片段。",
  permissions: ["node:read", "node:write"],
  defaultSize: { width: 460, height: 320 },
  document: `<style>body{display:grid;grid-template-rows:1fr 1fr;height:100vh;background:white}textarea{resize:none;border:0;border-bottom:1px solid #ddd;padding:10px;font:12px/1.5 ui-monospace,monospace;outline:0}iframe{width:100%;height:100%;border:0}</style><textarea aria-label="HTML 源码" spellcheck="false"></textarea><iframe sandbox title="HTML 预览"></iframe><script>const input=document.querySelector('textarea'),preview=document.querySelector('iframe');function render(save){preview.srcdoc=input.value;if(save)openboard.patch({state:{html:input.value}})}addEventListener('openboard:init',e=>{input.value=String(e.detail.state?.html||'<h2>Hello</h2>');render(false)});input.addEventListener('input',()=>render(true));openboard.ready()</script>`,
});

const svgStudio = parsePluginManifest({
  schemaVersion: 2,
  id: "openboard.svg-studio",
  name: "SVG 工作室",
  version: "1.0.0",
  description: "编辑并安全预览 SVG 图形源码。",
  permissions: ["node:read", "node:write"],
  defaultSize: { width: 480, height: 340 },
  document: `<style>body{display:grid;grid-template-columns:1fr 1fr;height:100vh;background:#fff}textarea,output{min-width:0;padding:12px}textarea{resize:none;border:0;border-right:1px solid #ddd;outline:0;font:12px/1.5 ui-monospace,monospace}output{display:grid;place-items:center;overflow:auto}output svg{max-width:100%;max-height:100%}</style><textarea aria-label="SVG 源码" spellcheck="false"></textarea><output aria-label="SVG 预览"></output><script>const input=document.querySelector('textarea'),output=document.querySelector('output');const fallback='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 140"><rect width="200" height="140" fill="#0f766e"/><circle cx="100" cy="70" r="42" fill="#f4d35e"/></svg>';function safe(value){const parser=new DOMParser(),doc=parser.parseFromString(value,'image/svg+xml'),svg=doc.documentElement;if(svg.localName!=='svg'||doc.querySelector('parsererror,script,foreignObject'))return fallback;for(const element of [svg,...svg.querySelectorAll('*')])for(const attr of [...element.attributes])if(/^on/i.test(attr.name)||/(?:javascript:|https?:)/i.test(attr.value))element.removeAttribute(attr.name);return new XMLSerializer().serializeToString(svg)}function render(save){const value=safe(input.value);output.innerHTML=value;if(save)openboard.patch({state:{svg:input.value}})}addEventListener('openboard:init',e=>{input.value=String(e.detail.state?.svg||fallback);render(false)});input.addEventListener('input',()=>render(true));openboard.ready()</script>`,
});

const panorama = parsePluginManifest({
  schemaVersion: 2,
  id: "openboard.panorama",
  name: "3D 全景",
  version: "1.0.0",
  description: "上传或选择画布图片，在 Three.js 中交互查看等距全景。",
  permissions: ["node:read", "node:write", "asset:read"],
  defaultSize: { width: 360, height: 280 },
  document: "<main></main>",
});

export const BUILTIN_PLUGINS: readonly PluginManifest[] = [
  stickyNote,
  markdownNote,
  htmlPreview,
  svgStudio,
  panorama,
];

export function findPluginManifest(
  pluginId: string | undefined,
  installed: readonly PluginManifest[] = [],
): PluginManifest | undefined {
  if (!pluginId) return undefined;
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === pluginId) ??
    installed.find((plugin) => plugin.id === pluginId);
}
