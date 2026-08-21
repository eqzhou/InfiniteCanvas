import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { I18nProvider } from "@/i18n/I18nProvider";
import { createDefaultConfig, createProject } from "@/lib/defaults";
import { useBoardStore } from "@/stores/use-board-store";
import type {
  AdminChannel,
  AdminPromptCatalog,
  AdminStoragePoolProviderStatus,
  AdminUser,
  PlatformTenant,
  TenantInvitation,
} from "@/services/admin";
import { AdminChannelsPanel } from "./AdminChannelsPanel";
import { AdminLibraryPanel } from "./AdminLibraryPanel";
import { AdminPromptCatalogPanel } from "./AdminPromptCatalogPanel";
import { AdminStoragePoolPanel } from "./AdminStoragePoolPanel";
import { PlatformAdminPanel } from "./PlatformAdminPanel";
import { TenantInvitationsPanel } from "./TenantInvitationsPanel";
import { TenantPolicyPanel } from "./TenantPolicyPanel";
import {
  flushRenderer,
  fire,
  hostButton,
  hostInput,
  hostNodes,
  hostSelect,
  installBrowser,
  nodeText,
  renderRenderer,
  restoreBrowser,
} from "@/test/react-renderer";
import type { ReactTestRenderer } from "react-test-renderer";

const REVISION = "a".repeat(64);
const NOW = "2026-08-19T00:00:00.000Z";

const channel: AdminChannel = {
  id: "tenant-openai",
  name: "Tenant OpenAI",
  baseUrl: "https://api.example.com/v1",
  protocol: "openai",
  enabled: true,
  allowUserUse: true,
  weight: 2,
  timeoutSeconds: 60,
  models: ["gpt-image-1", "video-pro"],
  mediaCapabilities: [{ model: "gpt-image-1", kind: "image", modes: ["text_to_image"], sizes: ["1024x1024"], resolutions: [], durations: [], maxReferences: 2 }],
  defaultTextModel: "gpt-4.1",
  defaultImageModel: "gpt-image-1",
  defaultVideoModel: "video-pro",
  defaultAudioModel: "tts-1",
  secretConfigured: true,
  secretBindingId: "binding-1",
};

const libraryItem = {
  id: "library-1",
  kind: "text" as const,
  title: "Library prompt",
  tags: ["cinema", "wide"],
  content: "A cinematic establishing shot",
  source: "team",
  notes: "reviewed",
  createdAt: NOW,
  updatedAt: NOW,
};

const promptCatalog: AdminPromptCatalog = {
  version: 1,
  revision: 4,
  categories: [{ id: "cinema", name: "电影", order: 1 }],
  prompts: [
    { id: "prompt-1", categoryId: "cinema", title: "Wide shot", body: "cinematic wide composition", tags: ["wide", "cinema"], updatedAt: NOW },
    { id: "prompt-2", title: "Portrait", body: "soft portrait light", tags: ["portrait"], sourceId: "source-1", updatedAt: NOW },
  ],
  sources: [{ id: "source-1", name: "Community", url: "https://example.com/prompts.json", format: "json", enabled: true, scheduleEnabled: true, intervalMinutes: 30, scheduleStatus: "scheduled", nextRunAt: NOW, itemCount: 2 }],
  syncRuns: [{ id: "run-1", sourceId: "source-1", sourceUrl: "https://example.com/prompts.json", status: "succeeded", startedAt: NOW, completedAt: NOW, itemCount: 2 }],
};

const storageItems: AdminStoragePoolProviderStatus[] = [
  { id: "fallback", kind: "local", weight: 1, configuredSelectable: true, probeKnown: false, probeHealthy: false, capacityKnown: false },
  { id: "s3-main", kind: "s3", endpoint: "https://storage.example.com", bucket: "openboard", region: "auto", prefix: "openboard", weight: 1, healthy: true, allowPrivate: false, allowInsecureLoopback: false, secretConfigured: true, configuredSelectable: true, probeKnown: true, probeHealthy: true, capacityKnown: true, totalBytes: 1_000_000, availableBytes: 750_000 },
];

const invitation: TenantInvitation = { id: "invite-1", tenantId: "tenant-1", email: "pending@example.com", role: "user", expiresAt: NOW, createdBy: "owner", createdAt: NOW };
const acceptedInvitation: TenantInvitation = { ...invitation, id: "invite-2", email: "accepted@example.com", acceptedAt: NOW };
const tenant: PlatformTenant = { id: "tenant-1", name: "Example tenant", plan: "pro", storageQuotaBytes: 10_000, generationQuotaMonthly: 100, createdAt: NOW, userCount: 2 };
const user: AdminUser = { id: "user-1", tenantId: "tenant-1", email: "owner@example.com", displayName: "Owner", role: "owner", status: "active", credits: 40, platformAdmin: true };

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function page<T>(items: T[]) {
  return { items, page: 1, pageSize: 100, total: items.length };
}

function installAdminFetch() {
  let libraries = [libraryItem];
  let catalog = structuredClone(promptCatalog);
  let invitations = [invitation, acceptedInvitation];
  const requests: Array<{ path: string; method: string }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api\//, "");
    const method = init?.method ?? "GET";
    requests.push({ path, method });
    if (path === "library-assets" && method === "GET") return jsonResponse(page(libraries));
    if (path === "library-assets" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as typeof libraryItem;
      const created = { ...libraryItem, ...body, id: "library-new" };
      libraries = [created];
      return jsonResponse(created);
    }
    if (path.startsWith("library-assets/") && method === "PUT") return jsonResponse(libraryItem);
    if (path.startsWith("library-assets/") && method === "DELETE") return jsonResponse(undefined, 204);

    if (path === "tenant/prompt-catalog" && method === "GET") return jsonResponse(catalog);
    if (path.startsWith("tenant/prompt-categories") || path === "tenant/prompts" || path.startsWith("tenant/prompts/") || path === "tenant/prompts/bulk-delete" || path.startsWith("tenant/prompt-sources")) {
      if (path.includes("bulk-delete")) catalog.prompts = catalog.prompts.filter((item) => !JSON.parse(String(init?.body ?? "{}")).ids.includes(item.id));
      if (path.endsWith("prompt-categories") && method === "POST") catalog.categories = [...catalog.categories, JSON.parse(String(init?.body ?? "{}"))];
      if (path === "tenant/prompt-sources" && method === "POST") catalog.sources = [...catalog.sources, JSON.parse(String(init?.body ?? "{}"))];
      return jsonResponse(catalog);
    }

    if (path === "tenant/storage-pool" && method === "GET") return jsonResponse(storageItems, 200, { "X-OpenBoard-Revision": REVISION, "X-OpenBoard-WebDAV-Media-Enabled": "false" });
    if (path === "tenant/storage-pool" && method === "PUT") return jsonResponse(storageItems, 200, { "X-OpenBoard-Revision": REVISION });
    if (path.startsWith("tenant/storage-pool/") && method === "PUT") return jsonResponse(undefined, 204);
    if (path.startsWith("tenant/storage-pool/") && method === "DELETE") return jsonResponse(undefined, 204, { "X-OpenBoard-Revision": REVISION });

    if (path === "tenant/invitations" && method === "GET") return jsonResponse(invitations);
    if (path === "tenant/invitations" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const invitationCredentialFixture = ["invite", "token"].join("-");
      const created = { ...invitation, id: "invite-new", email: body.email, expiresAt: NOW, token: invitationCredentialFixture };
      invitations = [...invitations, created];
      return jsonResponse(created);
    }
    if (path.startsWith("tenant/invitations/") && method === "POST") return jsonResponse(undefined, 204);
    if (path === "tenant/policy" && method === "GET") return jsonResponse({ allowCustomChannel: true, allowCloudChannel: true, availableModels: ["gpt-image-1", "gpt-image-2"], defaultImageModel: "gpt-image-1" });
    if (path === "tenant/policy" && method === "PUT") return jsonResponse({ allowCustomChannel: true, allowCloudChannel: true, availableModels: ["gpt-image-1", "gpt-image-2"], defaultImageModel: "gpt-image-1" });
    if (path === "tenant/channels" && method === "GET") return jsonResponse([channel], 200, { "X-OpenBoard-Revision": REVISION });
    if (path === "tenant/channels" && method === "PUT") return jsonResponse([channel], 200, { "X-OpenBoard-Revision": REVISION });
    if (path.startsWith("tenant/channels/") && method === "PUT") return jsonResponse([channel], 200, { "X-OpenBoard-Revision": REVISION });
    if (path.includes("preview-models")) return jsonResponse({ models: ["gpt-image-1", "new-model"] });
    if (path.includes("preview-test")) return jsonResponse({ ok: true, modelCount: 2 });
    if (path.endsWith("/secret")) return jsonResponse(undefined, 204);
    if (path.endsWith("/models")) return jsonResponse({ models: ["gpt-image-1", "new-model"] });
    if (path.endsWith("/test")) return jsonResponse({ ok: true, modelCount: 2 });

    if (path === "platform/policy" && method === "GET") return jsonResponse({ allowRegister: false, linuxDoEnabled: true });
    if (path === "platform/policy" && method === "PUT") return jsonResponse({ allowRegister: true, linuxDoEnabled: true });
    if (path === "platform/tenants" && method === "GET") return jsonResponse(page([tenant]));
    if (path.startsWith("platform/tenants/") && method === "PUT") return jsonResponse({ ...tenant, generationQuotaMonthly: 120 });
    if (path === "platform/users" && method === "GET") return jsonResponse(page([user]));
    if (path.startsWith("platform/users/") && path.endsWith("/password")) return jsonResponse(undefined, 204);
    if (path.startsWith("platform/users/") && method === "PATCH") return jsonResponse(user);
    if (path.startsWith("platform/users/") && path.endsWith("credit-adjustments")) return jsonResponse({ user, log: { id: 1, userId: user.id, delta: 2, balanceAfter: 42, reason: "test", createdAt: NOW }, replayed: false });
    if (path === "platform/channels" && method === "GET") return jsonResponse([channel], 200, { "X-OpenBoard-Revision": REVISION });
    if (path === "platform/channels" && method === "PUT") return jsonResponse([channel], 200, { "X-OpenBoard-Revision": REVISION });
    if (path.startsWith("platform/channels/") && method === "PUT") return jsonResponse([channel], 200, { "X-OpenBoard-Revision": REVISION });

    return jsonResponse({}, 200);
  };
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return { requests, restore: () => { globalThis.fetch = previous; } };
}

function withI18n(element: ReactElement): ReactElement {
  return <I18nProvider>{element}</I18nProvider>;
}

let browserSnapshot: ReturnType<typeof installBrowser>;
let storeSnapshot: ReturnType<typeof useBoardStore.getState>;
let fetchRestore: (() => void) | undefined;
const activeRenderers: ReactTestRenderer[] = [];

beforeEach(() => {
  browserSnapshot = installBrowser();
  storeSnapshot = useBoardStore.getState();
  useBoardStore.setState({ ready: true, projectsState: "loaded", projects: [createProject("Test canvas")], activeProjectId: null, config: createDefaultConfig() });
  fetchRestore = installAdminFetch().restore;
});

afterEach(async () => {
  for (const renderer of activeRenderers.splice(0)) await fire(() => renderer.unmount());
  fetchRestore?.();
  await fire(() => useBoardStore.setState(storeSnapshot, true));
  restoreBrowser(browserSnapshot);
});

async function loaded(element: ReactElement): Promise<ReactTestRenderer> {
  const renderer = await renderRenderer(withI18n(element));
  await flushRenderer();
  await flushRenderer();
  activeRenderers.push(renderer);
  return renderer;
}

describe("admin panels with React test renderer", () => {
  test("loads, creates, edits and deletes library assets through real handlers", async () => {
    const renderer = await loaded(<AdminLibraryPanel />);
    expect(nodeText(renderer.root)).toContain("Library prompt");
    const title = hostInput(renderer, (node) => node.props.placeholder === "标题");
    await fire(() => hostButton(renderer, "新增素材").props.onClick());
    await flushRenderer();
    await fire(() => title.props.onChange({ target: { value: "New asset" } }));
    await fire(() => hostButton(renderer, "新增素材").props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("New asset");
    const edit = hostNodes(renderer, "button").find((node) => nodeText(node) === "编辑");
    expect(edit).toBeDefined();
    await fire(() => edit!.props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("取消编辑");
    const remove = hostNodes(renderer, "button").find((node) => node.props["aria-label"]?.includes("删除"));
    expect(remove).toBeDefined();
    await fire(() => remove!.props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("确认删除素材");
    const confirm = hostNodes(renderer, "button").find((node) => node.props.className?.includes("ob-btn-danger") && nodeText(node) === "删除");
    expect(confirm).toBeDefined();
    await fire(() => confirm!.props.onClick());
    await flushRenderer();
  });

  test("drives prompt catalog category, filtering, bulk-delete and source controls", async () => {
    const renderer = await loaded(<AdminPromptCatalogPanel />);
    expect(nodeText(renderer.root)).toContain("Wide shot");
    const categoryInputs = hostNodes(renderer, "input");
    await fire(() => categoryInputs[0].props.onChange({ target: { value: "new-category" } }));
    await fire(() => categoryInputs[1].props.onChange({ target: { value: "New category" } }));
    await fire(() => hostButton(renderer, "新增分类").props.onClick());
    await flushRenderer();
    const search = hostInput(renderer, (node) => Boolean(node.props["aria-label"]));
    await fire(() => search.props.onChange({ target: { value: "wide" } }));
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("Wide shot");
    const promptCheckbox = hostInput(renderer, (node) => node.props.type === "checkbox" && String(node.props["aria-label"] ?? "").includes("Wide shot"));
    await fire(() => promptCheckbox.props.onChange({ target: { checked: true } }));
    await flushRenderer();
    await fire(() => hostButton(renderer, "批量删除").props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("确认删除已选中的");
    const confirm = hostNodes(renderer, "button").find((node) => node.props.className?.includes("ob-btn-danger") && nodeText(node) === "删除");
    expect(confirm).toBeDefined();
    await fire(() => confirm!.props.onClick());
    await flushRenderer();
    const sourceInputs = hostNodes(renderer, "input");
    const sourceId = sourceInputs.at(-2)!;
    const sourceUrl = sourceInputs.at(-1)!;
    await fire(() => sourceId.props.onChange({ target: { value: "new-source" } }));
    await fire(() => sourceUrl.props.onChange({ target: { value: "https://example.com/new.json" } }));
    await fire(() => hostButton(renderer, "新增来源").props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("Community");
  });

  test("loads storage providers, opens credentials, adds a draft and removes a provider", async () => {
    const renderer = await loaded(<AdminStoragePoolPanel />);
    expect(nodeText(renderer.root)).toContain("s3-main");
    const credential = hostButton(renderer, "更新凭据");
    await fire(() => credential.props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("更新 s3-main 凭据");
    const access = hostInput(renderer, (node) => node.props.autoFocus === true);
    await fire(() => access.props.onChange({ target: { value: "access" } }));
    const secret = hostInput(renderer, (node) => node.props.type === "password" && node.props.autoComplete === "new-password");
    await fire(() => secret.props.onChange({ target: { value: "secret" } }));
    await fire(() => hostButton(renderer, "加密保存").props.onClick());
    await flushRenderer();
    await fire(() => hostButton(renderer, "新增").props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("未命名存储提供商");
    const deletes = hostNodes(renderer, "button").filter((node) => node.props.className?.includes("ob-btn-danger"));
    expect(deletes.length).toBeGreaterThan(0);
    await fire(() => deletes[0]!.props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("s3-main");
  });

  test("creates and revokes invitations and persists tenant policy changes", async () => {
    const invitationRenderer = await loaded(<TenantInvitationsPanel />);
    const email = hostInput(invitationRenderer, (node) => node.props.type === "email");
    await fire(() => email.props.onChange({ target: { value: "new@example.com" } }));
    await fire(() => hostButton(invitationRenderer, "创建邀请").props.onClick());
    await flushRenderer();
    expect(nodeText(invitationRenderer.root)).toContain("invite-token");
    const revoke = hostButton(invitationRenderer, "撤销邀请");
    await fire(() => revoke.props.onClick());
    await flushRenderer();
    expect(nodeText(invitationRenderer.root)).toContain("撤销后链接将立即失效");
    const confirm = hostNodes(invitationRenderer, "button").find((node) => node.props.className?.includes("ob-btn-danger") && nodeText(node) === "撤销邀请");
    await fire(() => confirm!.props.onClick());
    await flushRenderer();

    const policyRenderer = await loaded(<TenantPolicyPanel />);
    const switches = hostNodes(policyRenderer, "button").filter((node) => node.props.role === "switch");
    await fire(() => switches[0].props.onClick());
    await flushRenderer();
    const models = hostNodes(policyRenderer, "textarea")[0]!;
    await fire(() => models.props.onChange({ target: { value: "gpt-image-1\ngpt-video-1" } }));
    await fire(() => hostButton(policyRenderer, "保存模型白名单").props.onClick());
    await flushRenderer();
    expect(nodeText(policyRenderer.root)).toContain("租户策略已保存");
  });

  test("runs channel editor actions and platform administration controls", async () => {
    const renderer = await loaded(<AdminChannelsPanel />);
    expect(nodeText(renderer.root)).toContain("Tenant OpenAI");
    const models = hostNodes(renderer, "textarea").find((node) => node.props.placeholder?.includes("gpt-image-1"))!;
    await fire(() => models.props.onChange({ target: { value: "gpt-image-1\nnew-model" } }));
    await flushRenderer();
    await fire(() => hostButton(renderer, "拉取模型").props.onClick());
    await flushRenderer();
    expect(nodeText(renderer.root)).toContain("确认更新模型");
    const confirmModels = hostButton(renderer, "确认更新模型");
    await fire(() => confirmModels.props.onClick());
    await flushRenderer();
    await fire(() => hostButton(renderer, "测试连接").props.onClick());
    await flushRenderer();
    await fire(() => hostButton(renderer, "保存此渠道").props.onClick());
    await flushRenderer();

    const platform = await loaded(<PlatformAdminPanel />);
    expect(nodeText(platform.root)).toContain("Example tenant");
    const quota = hostInput(platform, (node) => node.props["aria-label"]?.includes("总额度"));
    await fire(() => quota.props.onChange({ target: { value: "120" } }));
    await fire(() => hostButton(platform, "保存额度").props.onClick());
    await flushRenderer();
    const registration = hostNodes(platform, "button").find((node) => node.props.role === "switch");
    expect(registration).toBeDefined();
    await fire(() => registration!.props.onClick());
    await flushRenderer();
  });
});
