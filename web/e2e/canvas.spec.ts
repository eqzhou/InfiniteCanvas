import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolveE2EEnvironment } from "./environment";

const { agentPort } = resolveE2EEnvironment();
const agentUrl = `http://127.0.0.1:${agentPort}`;
const pngPixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAADFbP4CAAAAFUlEQVQIHWP8z8AARAjAhGBCWIQFAIPRAgYQO+IXAAAAAElFTkSuQmCC";
const pngReplacementBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAADFbP4CAAAAFUlEQVQIHWNk+A+ESIAJiQ1mEhYAAILSAgahbK2jAAAAAElFTkSuQmCC";

function triangleGlb(): Buffer {
  const manifest = {
    asset: { version: "2.0", generator: "OpenBoard E2E" },
    buffers: [{ byteLength: 44 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 2, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.8, 0.4, 1] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = Buffer.from(JSON.stringify(manifest));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binary = Buffer.alloc(44);
  const positions = [-1, 0, 0, 1, 0, 0, 0, 2, 0];
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 36 + index * 2));
  const total = 12 + 8 + jsonLength + 8 + binary.length;
  const result = Buffer.alloc(total);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(total, 8);
  result.writeUInt32LE(jsonLength, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  json.copy(result, 20);
  result.fill(0x20, 20 + json.length, 20 + jsonLength);
  const binaryHeader = 20 + jsonLength;
  result.writeUInt32LE(binary.length, binaryHeader);
  result.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(result, binaryHeader + 8);
  return result;
}

async function openFreshBoard(
  page: Page,
  { requireProjectPanel = true }: { requireProjectPanel?: boolean } = {},
) {
  await page.goto("/");
  // Toolbar "文本" button only — node titles may also use title="文本".
  const textTool = page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "文本", exact: true });
  await expect(textTool).toBeVisible();
  if (!requireProjectPanel) return;
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page.getByRole("button", { name: "打开项目侧栏" }).click();
  }
  const projectTab = page.getByRole("tab", { name: "项目" });
  if (await projectTab.getAttribute("aria-selected") !== "true") {
    await projectTab.click();
  }
  // Formal/local storage may already have projects; ensure at least one active board.
  await expect(page.locator('aside input[value]').first()).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page.locator("aside").getByRole("button", { name: "关闭项目侧栏" }).click();
  }
}

async function installOwnerAuthRoutes(page: Page) {
  await page.route(/\/api\/auth\/me$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      authMode: "local",
      guest: false,
      user: {
        id: "owner-e2e",
        tenantId: "tenant-e2e",
        email: "owner@example.test",
        displayName: "Owner",
        role: "owner",
      },
    }),
  }));
  await page.route(/\/api\/auth\/usage$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      storageBytes: 0,
      generationThisMonth: 0,
      storageQuotaBytes: 1_000_000,
      generationQuotaMonthly: 1_000,
      plan: "test",
      credits: 1_000,
    }),
  }));
}

/** Click the canvas toolbar tool by accessible name (avoids node title collisions). */
async function clickCanvasTool(page: Page, name: string) {
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name, exact: true }).click();
}

async function importSingleImageProject(page: Page, title: string) {
  const now = "2026-07-26T00:00:00.000Z";
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: `${title}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2,
      id: `${title}-project`,
      title,
      createdAt: now,
      updatedAt: now,
      nodes: [{
        id: `${title}-image`,
        type: "image",
        title: "图片",
        position: { x: 220, y: 160 },
        width: 240,
        height: 180,
        metadata: {
          content: `data:image/png;base64,${pngPixelBase64}`,
          naturalWidth: 4,
          naturalHeight: 4,
          mimeType: "image/png",
          status: "success",
        },
      }],
      edges: [],
      chatSessions: [],
      activeChatId: null,
      backgroundMode: "dots",
      viewport: { x: 0, y: 0, k: 1 },
    })),
  });
  const node = page.locator('[data-node-type="image"]').first();
  await expect(node).toBeVisible();
  await node.locator("[data-node-header]").click();
  return node;
}


async function openCodexPanel(page: Page) {
  await page.getByTitle("本地 Agent").click();
  const codexTab = page.getByRole("tab", { name: "Codex" });
  if (await codexTab.count()) {
    await codexTab.click();
  }
}

async function closeSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openProjectPanel(page: Page) {
  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  if (await panel.isVisible().catch(() => false)) return;
  const openBtn = page.getByRole("button", { name: "打开项目侧栏" });
  if (await openBtn.isVisible().catch(() => false)) {
    await openBtn.click();
  } else {
    const expand = page.getByRole("button", { name: "展开侧栏" });
    if (await expand.isVisible().catch(() => false)) await expand.click();
  }
  await expect(panel).toBeVisible();
}

function projectCard(page: Page, title: string) {
  return page.locator("aside .group").filter({
    has: page.locator(`input[value="${title}"]`),
  });
}

test("first launch creates and opens a board project", async ({ page }) => {
  await openFreshBoard(page);
  if ((page.viewportSize()?.width ?? 1440) >= 768) {
    // Active project row shows a title input and a node-count summary.
    await expect(page.locator("aside input[value]").first()).toBeVisible();
    await expect(page.locator("aside").getByText("节点", { exact: false }).first()).toBeVisible();
  }
});

test("admin console manages users, credit logs, and model costs through protected APIs", async ({ page }) => {
  await page.route(/\/api\/auth\/me$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ authMode: "local", user: { id: "owner-e2e", tenantId: "tenant-e2e", email: "owner@example.test", displayName: "Owner", role: "owner" } }),
  }));
  await page.route(/\/api\/auth\/usage$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ storageBytes: 0, generationThisMonth: 0, storageQuotaBytes: 1000, generationQuotaMonthly: 10, plan: "test", credits: 100 }),
  }));
  const user = {
    id: "user-admin-e2e",
    tenantId: "tenant-e2e",
    email: "member@example.test",
    displayName: "E2E Member",
    role: "member",
    status: "active",
    credits: 20,
  };
  let adjustment: Record<string, unknown> | null = null;
  let savedModels: Record<string, unknown> | null = null;
  let savedSharedSecret: Record<string, unknown> | null = null;
  await page.route(/\/api\/admin\/users\?.*/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ items: [user], page: 1, pageSize: 100, total: 1 }),
  }));
  await page.route(/\/api\/admin\/users\/user-admin-e2e\/credit-adjustments$/, async (route) => {
    adjustment = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { ...user, credits: 25 },
        log: { id: 9, userId: user.id, delta: 5, balanceAfter: 25, reason: "E2E adjustment", createdAt: new Date().toISOString() },
        replayed: false,
      }),
    });
  });
  await page.route(/\/api\/admin\/credit-logs\?.*/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      items: [{ id: 9, userId: user.id, delta: 5, balanceAfter: 25, reason: "E2E adjustment", createdAt: "2026-07-26T00:00:00Z" }],
      page: 1,
      pageSize: 100,
      total: 1,
    }),
  }));
  await page.route(/\/api\/admin\/models$/, async (route) => {
    if (route.request().method() === "PUT") {
      savedModels = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(savedModels) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ modelCosts: [{ model: "existing-model", credits: 2 }], defaultCredits: 1 }),
    });
  });
  await page.route(/\/api\/admin\/storage-pool$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      id: "process-main", kind: "s3", weight: 3, configuredSelectable: true,
      probeKnown: false, probeHealthy: false, capacityKnown: false,
    }]),
  }));
  await page.route(/\/api\/admin\/channels$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      id: "shared-e2e", name: "Shared E2E", baseUrl: "https://shared.example/v1", protocol: "openai",
      enabled: true, allowUserUse: true, weight: 2, timeoutSeconds: 60,
      defaultTextModel: "", defaultImageModel: "shared-image", defaultVideoModel: "", defaultAudioModel: "",
      secretConfigured: false, secretBindingId: "binding-e2e",
    }]),
  }));
  await page.route(/\/api\/admin\/channels\/shared-e2e\/secret$/, async (route) => {
    savedSharedSecret = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    await route.fulfill({ status: 204 });
  });
  await page.route(/\/api\/admin\/prompt-catalog$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      version: 1, revision: 3,
      categories: [{ id: "product", name: "Product", order: 1 }],
      prompts: [{ id: "prompt-e2e", categoryId: "product", title: "Admin prompt E2E", body: "catalog body", tags: ["e2e"] }],
      sources: [{ id: "source-e2e", name: "Prompt source E2E", url: "https://prompts.example/catalog.json", format: "json", enabled: true, scheduleEnabled: true, intervalMinutes: 30, scheduleStatus: "scheduled" }],
      syncRuns: [],
    }),
  }));

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "member@example.test" });
  await expect(row).toContainText("20");
  await row.getByRole("button", { name: "调整额度" }).click();
  const dialog = page.getByRole("dialog", { name: "调整额度" });
  await dialog.getByLabel("变化值").fill("5");
  await dialog.getByLabel("原因").fill("E2E adjustment");
  await dialog.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => adjustment).toMatchObject({ delta: 5, reason: "E2E adjustment" });
  await expect(row).toContainText("25");

  await page.getByRole("tab", { name: "额度日志" }).click();
  await expect(page.getByRole("row").filter({ hasText: "E2E adjustment" })).toContainText("+5");
  await page.getByRole("tab", { name: "模型成本" }).click();
  const defaultModelCost = page.getByLabel("未知模型默认成本");
  await expect(defaultModelCost).toHaveValue("1");
  await defaultModelCost.fill("3");
  await page.getByRole("button", { name: "添加模型" }).click();
  await page.getByPlaceholder("模型 ID").last().fill("new-model");
  await page.locator('input[type="number"]').last().fill("7");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => savedModels).toMatchObject({
    defaultCredits: 3,
    modelCosts: [{ model: "existing-model", credits: 2 }, { model: "new-model", credits: 7 }],
  });
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "存储池" }).click();
  await expect(page.getByRole("heading", { name: "租户存储池" })).toBeVisible();
  const processStorage = page.locator("article").filter({ hasText: "process-main" });
  await expect(processStorage).toContainText("未知（权限中立）");
  await expect(processStorage).toContainText("未知（提供商未暴露）");
  await expect(processStorage).toContainText("权重 3");
  await page.getByRole("tab", { name: "共享渠道" }).click();
  await expect(page.locator('input[value="Shared E2E"]')).toBeVisible();
  await page.getByLabel(/API 密钥/).fill("shared-secret-e2e");
  await page.getByRole("button", { name: "保存密钥" }).click();
  await expect.poll(() => savedSharedSecret).toEqual({ apiKey: "shared-secret-e2e", secretBindingId: "binding-e2e" });
  await expect(page.getByRole("status")).toContainText("密钥已加密保存");
  await expect(page.getByLabel(/API 密钥/)).toHaveValue("");
  await page.getByRole("tab", { name: "提示词", exact: true }).click();
  await expect(page.getByText("Admin prompt E2E", { exact: true })).toBeVisible();
  await expect(page.getByText("Prompt source E2E", { exact: true })).toBeVisible();
});

test("admin route denies authenticated members in the UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("openboard:session", "member-e2e-session"));
  await page.route(/\/api\/auth\/me$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      authMode: "local",
      user: { id: "member", tenantId: "tenant", email: "member@example.test", displayName: "Member", role: "member" },
    }),
  }));
  await page.route(/\/api\/auth\/usage$/, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ storageBytes: 0, generationThisMonth: 0, storageQuotaBytes: 1000, generationQuotaMonthly: 10, plan: "free" }),
  }));
  await page.goto("/admin");
  await expect(page.getByText("需要管理员权限。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理后台" })).toHaveCount(0);
  await expect(page.locator('nav a[href="/admin"]')).toHaveCount(0);
});

test("3D director edits persist and rendered captures return to the canvas", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The director desktop layout is covered in this flow.");
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "导演台");

  const directorNode = page.locator('[data-node-type="director"]').last();
  await expect(directorNode).toBeVisible();
  await clickCanvasTool(page, "文本");
  const textNodes = page.locator('[data-node-type="text"]');
  await expect(textNodes).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(textNodes).toHaveCount(0);
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const dialog = page.getByRole("dialog", { name: "3D 导演台" });
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "重做" }).click();
  await expect(textNodes).toHaveCount(1);
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "撤销" }).click();
  await expect(textNodes).toHaveCount(0);

  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("场景层级").getByText("角色 1")).toBeVisible();
  await expect(dialog.getByLabel("场景层级").getByText("主摄像机")).toBeVisible();
  await expect(dialog.locator('canvas[data-testid="director-viewport-canvas"]')).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-node-type="director"]')).toHaveCount(1);

  await dialog.getByLabel("位置 X", { exact: true }).fill("2");
  await dialog.getByLabel("焦距").fill("85");
  await dialog.getByLabel("光圈").fill("4");
  await dialog.getByLabel("画幅").selectOption("1:1");
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(300);

  await page.reload();
  await expect(directorNode).toBeVisible({ timeout: 10_000 });
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(dialog.getByLabel("位置 X", { exact: true })).toHaveValue("2");
  await expect(dialog.getByLabel("焦距")).toHaveValue("85");
  await expect(dialog.getByLabel("光圈")).toHaveValue("4");
  await expect(dialog.getByLabel("画幅")).toHaveValue("1:1");

  const imageNodes = page.locator('[data-node-type="image"]');
  const edgeGroups = page.getByTestId("canvas-surface").locator("svg").first().locator("g");
  const imagesBefore = await imageNodes.count();
  const edgesBefore = await edgeGroups.count();
  const captureButton = dialog.getByRole("button", { name: "拍摄当前机位" });
  const captures = dialog.getByRole("list", { name: "本机截图列表" }).getByRole("listitem");
  await captureButton.click();
  await expect(captures).toHaveCount(1);
  await expect(captureButton).toBeEnabled();
  await captureButton.click();
  await expect(captures).toHaveCount(2);
  await expect(captureButton).toBeEnabled();
  await expect(dialog).toBeVisible();
  await expect(imageNodes).toHaveCount(imagesBefore);

  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await page.reload();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(dialog.getByRole("list", { name: "本机截图列表" }).getByRole("listitem")).toHaveCount(2);
  await dialog.getByRole("button", { name: "查看截图 主摄像机" }).first().click();
  await expect(page.getByRole("dialog", { name: "截图预览" })).toBeVisible();
  await page.getByRole("button", { name: "关闭截图预览" }).click();
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  const localOnlyExportPromise = page.waitForEvent("download");
  await page.getByTitle("导出当前", { exact: true }).click();
  const localOnlyExportPath = await (await localOnlyExportPromise).path();
  expect(localOnlyExportPath).not.toBeNull();
  const localOnlyJson = await readFile(localOnlyExportPath!, "utf8");
  expect(localOnlyJson).not.toContain("directorCaptures");
  expect(localOnlyJson).not.toContain("captureTray");
  expect(localOnlyJson).not.toContain("data:image/png");

  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await dialog.getByRole("button", { name: "全选" }).click();
  await dialog.getByRole("button", { name: "发送到画布" }).click();
  await expect(imageNodes).toHaveCount(imagesBefore + 2, { timeout: 15_000 });
  await expect(edgeGroups).toHaveCount(edgesBefore + 2);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await expect(dialog).toHaveCount(0);
  const capturedImage = page.locator('[data-node-type="image"]').last().locator("img");
  await expect(capturedImage).toBeVisible();
  const capturedDimensions = await capturedImage.evaluate((image) => [image.naturalWidth, image.naturalHeight]);
  expect(capturedDimensions[0]).toBeGreaterThan(0);
  expect(capturedDimensions[1]).toBeGreaterThan(0);
  expect(capturedDimensions[0]).toBe(capturedDimensions[1]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(imageNodes).toHaveCount(imagesBefore);
  await expect(edgeGroups).toHaveCount(edgesBefore);
  await page.keyboard.press("ControlOrMeta+y");
  await expect(imageNodes).toHaveCount(imagesBefore + 2);
  await expect(edgeGroups).toHaveCount(edgesBefore + 2);

  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await dialog.getByRole("button", { name: "清空全部" }).click();
  await expect(dialog.getByRole("list", { name: "本机截图列表" })).toHaveCount(0);
  await expect(dialog.getByText("拍摄后会保存在当前浏览器")).toBeVisible();
  await expect(imageNodes).toHaveCount(imagesBefore + 2);
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
});

test("director manages multiple cameras and independent composition guides", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The director desktop layout is covered here.");
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "导演台");
  await clickCanvasTool(page, "适应");
  const directorNode = page.locator('[data-node-type="director"]').last();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const dialog = page.getByRole("dialog", { name: "3D 导演台" });

  await dialog.getByRole("button", { name: "添加机位" }).click();
  await expect(dialog.getByLabel("场景层级").getByRole("button", { name: /选择机位/ })).toHaveCount(2);
  await dialog.getByLabel("机位名称").fill("近景机位");
  await dialog.getByLabel("焦距").fill("85");
  await dialog.getByLabel("光圈").fill("4");
  await dialog.getByLabel("画幅").selectOption("1:1");

  await dialog.getByLabel("场景层级").getByRole("button", { name: "选择机位 主摄像机" }).click();
  await expect(dialog.getByLabel("焦距")).toHaveValue("50");
  await expect(dialog.getByLabel("画幅")).toHaveValue("16:9");
  await dialog.getByLabel("场景层级").getByRole("button", { name: "选择机位 近景机位" }).click();
  await expect(dialog.getByLabel("焦距")).toHaveValue("85");
  await expect(dialog.getByLabel("画幅")).toHaveValue("1:1");

  await dialog.getByRole("button", { name: "机位视角" }).click();
  await expect(dialog.locator('[data-view-mode="camera"]')).toBeVisible();
  await dialog.getByLabel("显示九宫格").check();
  await dialog.getByLabel("显示比例框").check();
  await expect(dialog.getByTestId("director-rule-of-thirds")).toBeVisible();
  const aspectFrame = dialog.getByTestId("director-aspect-frame");
  await expect(aspectFrame).toBeVisible();
  const frameBox = await aspectFrame.boundingBox();
  expect(frameBox).not.toBeNull();
  expect(Math.abs(frameBox!.width - frameBox!.height)).toBeLessThan(3);
  await dialog.getByLabel("显示地面网格").uncheck();
  await expect(dialog.getByTestId("director-rule-of-thirds")).toBeVisible();
  await dialog.getByLabel("旋转（度） X").fill("999");
  await dialog.getByLabel("缩放 X").fill("5000");
  await expect(dialog.getByLabel("旋转（度） X")).toHaveValue("360");
  await expect(dialog.getByLabel("缩放 X")).toHaveValue("1000");

  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await page.reload();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(dialog.getByLabel("场景层级").getByRole("button", { name: "选择机位 近景机位" })).toHaveAttribute("aria-current", "true");
  await expect(dialog.getByLabel("焦距")).toHaveValue("85");
  await expect(dialog.getByLabel("显示九宫格")).toBeChecked();
  await expect(dialog.getByLabel("显示比例框")).toBeChecked();
  await expect(dialog.getByLabel("显示地面网格")).not.toBeChecked();
  await expect(dialog.getByLabel("旋转（度） X")).toHaveValue("360");
  await expect(dialog.getByLabel("缩放 X")).toHaveValue("1000");

  await dialog.getByRole("button", { name: "删除活动机位" }).click();
  await expect(dialog.getByLabel("场景层级").getByRole("button", { name: "选择机位 主摄像机" })).toHaveAttribute("aria-current", "true");
  await expect(dialog.getByRole("button", { name: "删除活动机位" })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
});

test("director imports local GLB models, restores transforms, and relinks missing files", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The director desktop model flow is covered here.");
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "导演台");
  const directorNode = page.locator('[data-node-type="director"]').last();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const dialog = page.getByRole("dialog", { name: "3D 导演台" });
  const modelFile = { name: "triangle.glb", mimeType: "model/gltf-binary", buffer: triangleGlb() };
  await dialog.locator('input[type="file"][accept*=".glb"]').setInputFiles(modelFile);

  const modelRow = dialog.getByLabel("场景层级").getByRole("button").filter({ hasText: "triangle" });
  await expect(modelRow).toContainText("已关联", { timeout: 15_000 });
  const canvas = dialog.locator('canvas[data-testid="director-viewport-canvas"]');
  await expect(canvas).toHaveAttribute("data-transform-attached", "true");
  await dialog.getByRole("button", { name: "旋转", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-transform-mode", "rotate");
  await dialog.getByRole("button", { name: "缩放", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-transform-mode", "scale");
  await dialog.getByRole("button", { name: "移动", exact: true }).click();
  await dialog.getByLabel("位置 X", { exact: true }).fill("3");
  await dialog.getByLabel("旋转（度） Y").fill("45");
  await dialog.getByLabel("缩放 X").fill("2");
  await dialog.getByLabel("锁定变换").check();
  await expect(canvas).toHaveAttribute("data-transform-attached", "false");
  await dialog.getByLabel("锁定变换").uncheck();
  await expect(canvas).toHaveAttribute("data-transform-attached", "true");
  await dialog.getByRole("button", { name: "关闭导演台" }).click();

  const exportPromise = page.waitForEvent("download");
  await page.getByTitle("导出当前", { exact: true }).click();
  const exportPath = await (await exportPromise).path();
  expect(exportPath).not.toBeNull();
  const exported = await readFile(exportPath!, "utf8");
  expect(exported).toContain('"fileName": "triangle.glb"');
  expect(exported).toContain('"assetId"');
  expect(exported).not.toContain("Z2xURg");
  expect(exported).not.toContain("blob:");
  expect(exported).not.toContain("ownerScope");

  await page.reload();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(modelRow).toContainText("已关联", { timeout: 15_000 });
  await expect(dialog.getByLabel("位置 X", { exact: true })).toHaveValue("3");
  await expect(dialog.getByLabel("旋转（度） Y")).toHaveValue("45");
  await expect(dialog.getByLabel("缩放 X")).toHaveValue("2");
  await dialog.getByRole("button", { name: "关闭导演台" }).click();

  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("openboard-director-models");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("models", "readwrite");
      transaction.objectStore("models").clear();
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  await page.reload();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(modelRow).toContainText("缺失");
  await expect(dialog.getByText("资源缺失", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("位置 X", { exact: true })).toHaveValue("3");

  const chooserPromise = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "重新关联 GLB" }).click();
  await (await chooserPromise).setFiles({ ...modelFile, name: "triangle-restored.glb" });
  await expect(modelRow).toContainText("已关联", { timeout: 15_000 });
  await expect(dialog.getByText("triangle-restored.glb", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("位置 X", { exact: true })).toHaveValue("3");
  await expect(dialog.getByLabel("旋转（度） Y")).toHaveValue("45");
  await expect(dialog.getByLabel("缩放 X")).toHaveValue("2");

  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "撤销" }).click();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(modelRow).toContainText("缺失", { timeout: 15_000 });
  await expect(dialog.getByText("triangle.glb", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "重做" }).click();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(modelRow).toContainText("已关联", { timeout: 15_000 });
  await expect(dialog.getByText("triangle-restored.glb", { exact: true })).toBeVisible();

  const invalidChooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "导入 GLB 模型" }).click();
  await (await invalidChooser).setFiles({ name: "broken.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("not a glb") });
  await expect(dialog.locator('p[role="alert"]')).toContainText("GLB");
  await expect(dialog.getByLabel("场景层级").getByRole("button").filter({ hasText: "triangle" })).toHaveCount(1);
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
});

test("director stages eight characters, twenty poses, geometry, and instanced crowds", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The director desktop cast flow is covered here.");
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "导演台");
  const directorNode = page.locator('[data-node-type="director"]').last();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const dialog = page.getByRole("dialog", { name: "3D 导演台" });
  const addGroup = dialog.getByRole("group", { name: "快速添加场景对象" });

  await addGroup.getByRole("button", { name: "角色", exact: true }).click();
  await expect(dialog.getByLabel("人物预设").locator("option")).toHaveCount(8);
  await expect(dialog.getByLabel("人物姿势").locator("option")).toHaveCount(20);
  const characterPicker = dialog.getByRole("region", { name: "人物外观选择器" });
  await characterPicker.getByRole("button", { name: /人物外观/ }).click();
  const characterCatalog = characterPicker.getByRole("listbox", { name: "人物外观视觉目录" });
  await expect(characterCatalog.getByRole("option")).toHaveCount(8);
  const studioOption = characterCatalog.getByRole("option", { name: "选择人物外观 棚拍标准" });
  await studioOption.focus();
  await studioOption.press("ArrowRight");
  await expect(characterCatalog.getByRole("option", { name: "选择人物外观 修长轮廓" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("人物预设")).toHaveValue("tall");
  await characterCatalog.getByRole("option", { name: "选择人物外观 未来造型" }).click();

  const posePicker = dialog.getByRole("region", { name: "动作姿态选择器" });
  await posePicker.getByRole("button", { name: /动作姿态/ }).click();
  const poseCatalog = posePicker.getByRole("listbox", { name: "动作姿态视觉目录" });
  await expect(poseCatalog.getByRole("option")).toHaveCount(20);
  await poseCatalog.getByRole("option", { name: "选择动作姿态 自然站立" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(poseCatalog.getByRole("option", { name: "选择动作姿态 双手叉腰" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("人物姿势")).toHaveValue("hands-hips");
  await poseCatalog.getByRole("option", { name: "选择动作姿态 欢呼" }).click();
  await expect(dialog.getByLabel("人物预设")).toHaveValue("future");
  await expect(dialog.getByLabel("人物姿势")).toHaveValue("celebrate");

  await addGroup.getByRole("button", { name: "群演", exact: true }).click();
  await expect(dialog.getByLabel("人物身份")).toHaveValue("extra");
  await addGroup.getByRole("button", { name: "几何体", exact: true }).click();
  await dialog.getByLabel("基础几何体").selectOption("sphere");

  await addGroup.getByRole("button", { name: "阵列", exact: true }).click();
  await dialog.getByLabel("群众行数").fill("4");
  await dialog.getByLabel("群众列数").fill("7");
  await dialog.getByLabel("群众横向间距").fill("1.2");
  await dialog.getByLabel("群众纵向间距").fill("1.4");
  await dialog.getByLabel("群众人物预设").selectOption("casual");
  await dialog.getByLabel("群众人物姿势").selectOption("talk");
  const crowdRow = dialog.getByLabel("场景层级").getByRole("button").filter({ hasText: "群众阵列" });
  await expect(crowdRow).toContainText("4×7 · 28人");
  await expect(crowdRow).toHaveAttribute("aria-selected", "true");
  const canvas = dialog.locator('canvas[data-testid="director-viewport-canvas"]');
  await expect(canvas).toHaveAttribute("data-rendered-population", "31");
  await dialog.getByLabel("锁定变换").check();
  await expect(canvas).toHaveAttribute("data-transform-attached", "false");
  await dialog.getByLabel("锁定变换").uncheck();
  await expect(canvas).toHaveAttribute("data-transform-attached", "true");

  await dialog.getByLabel("群众行数").fill("64");
  await dialog.getByLabel("群众列数").fill("64");
  await expect(dialog.locator('p[role="alert"]')).toContainText("1024");
  await expect(dialog.getByLabel("群众列数")).toHaveValue("7");
  await dialog.getByLabel("群众行数").fill("4");
  await dialog.getByRole("button", { name: "关闭导演台" }).click();

  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "撤销" }).click();
  await expect(directorNode).toContainText("1 人");
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "重做" }).click();
  await expect(directorNode).toContainText("31 人");
  await page.waitForTimeout(300);
  await page.reload();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(dialog.getByLabel("场景层级").getByRole("button").filter({ hasText: "群众阵列" })).toContainText("4×7 · 28人");
  await expect(canvas).toHaveAttribute("data-rendered-population", "31");
  await dialog.getByLabel("场景层级").getByRole("button").filter({ hasText: "角色 2" }).click();
  await expect(dialog.getByLabel("人物预设")).toHaveValue("future");
  await expect(dialog.getByLabel("人物姿势")).toHaveValue("celebrate");
  await dialog.getByLabel("场景层级").getByRole("button").filter({ hasText: "几何体" }).last().click();
  await expect(dialog.getByLabel("基础几何体")).toHaveValue("sphere");

  await dialog.getByRole("button", { name: "拍摄当前机位" }).click();
  await expect(dialog.getByRole("list", { name: "本机截图列表" }).getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTitle("导出当前", { exact: true }).click();
  const exportPath = await (await downloadPromise).path();
  expect(exportPath).not.toBeNull();
  const exported = await readFile(exportPath!, "utf8");
  expect(exported).toContain('"version": 4');
  expect(exported).toContain('"rows": 4');
  expect(exported).toContain('"columns": 7');
  expect(exported).not.toContain('"instances"');
  expect(exported).not.toContain('"matrices"');
  expect(exported).not.toContain('"expandedObjects"');
});

test("native panorama uploads, previews, persists, and lights the director environment", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The panorama/director desktop flow is covered here.");
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "全景");

  const panoramaNode = page.locator('[data-node-type="panorama"]').last();
  await expect(panoramaNode).toBeVisible();
  const panoramaBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(240, 20, 220)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await panoramaNode.locator('input[type="file"]').setInputFiles({
    name: "studio-panorama.png",
    mimeType: "image/png",
    buffer: Buffer.from(panoramaBase64, "base64"),
  });
  const panoramaImage = panoramaNode.locator("img");
  await expect(panoramaImage).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => panoramaImage.evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual([128, 64]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(panoramaNode.locator("img")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+y");
  await expect(panoramaImage).toBeVisible();

  await panoramaNode.getByRole("button", { name: "打开 360° 全景" }).click();
  const panoramaDialog = page.getByRole("dialog", { name: "360° 全景查看器" });
  await expect(panoramaDialog).toBeVisible();
  const panoramaCanvas = panoramaDialog.locator('canvas[data-native-panorama-canvas="true"]');
  await expect(panoramaCanvas).toBeVisible();
  await expect(panoramaCanvas).toHaveAttribute("data-panorama-loaded", "true", { timeout: 10_000 });
  await panoramaDialog.getByRole("button", { name: "关闭全景查看器" }).click();

  await clickCanvasTool(page, "导演台");
  const directorNode = page.locator('[data-node-type="director"]').last();
  await panoramaNode.getByTitle("输出端口 / 拖出连线").click();
  await directorNode.getByTitle("输入端口").click();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const directorDialog = page.getByRole("dialog", { name: "3D 导演台" });
  const environmentSelect = directorDialog.getByLabel("导演台全景环境");
  await environmentSelect.selectOption({ label: "360° 全景" });
  const directorCanvas = directorDialog.locator('canvas[data-testid="director-viewport-canvas"]');
  await expect(directorCanvas).toHaveAttribute("data-environment-loaded", "true", { timeout: 10_000 });

  const imageNodes = page.locator('[data-node-type="image"]');
  const imagesBefore = await imageNodes.count();
  await directorDialog.getByRole("button", { name: "拍摄当前机位" }).click();
  await expect(directorDialog.getByRole("list", { name: "本机截图列表" }).getByRole("listitem")).toHaveCount(1);
  await expect(directorDialog.getByLabel("选择截图 主摄像机")).toBeChecked();
  await directorDialog.getByRole("button", { name: "发送到画布" }).click();
  await directorDialog.getByRole("button", { name: "关闭导演台" }).click();
  await expect(directorDialog).toHaveCount(0);
  await clickCanvasTool(page, "适应");
  await expect(imageNodes).toHaveCount(imagesBefore + 1, { timeout: 15_000 });
  const capture = imageNodes.last().locator("img");
  await expect(capture).toBeVisible();
  const corner = await capture.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(4, 4, 1, 1).data];
  });
  expect(corner[0]).toBeGreaterThan(120);
  expect(corner[1]).toBeLessThan(130);
  expect(corner[2]).toBeGreaterThan(120);

  await page.reload();
  await expect(panoramaNode.locator("img")).toBeVisible({ timeout: 10_000 });
  await expect(directorNode).toBeVisible();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  await expect(directorDialog.getByLabel("导演台全景环境")).toHaveValue(/node_/);
  await directorDialog.getByLabel("导演台全景环境").selectOption("");
  await expect(directorCanvas).toHaveAttribute("data-environment-loaded", "fallback");
});

test("panorama generation accepts ordinary image references and commits a persistent result batch", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The panorama batch layout is covered on desktop.");
  let editRequestBody = "";
  await openFreshBoard(page, { requireProjectPanel: false });
  const panoramaBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(40, 120, 220)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.route("https://panorama-batch.example/v1/images/edits", async (route) => {
    editRequestBody = route.request().postDataBuffer()?.toString("latin1") ?? "";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: Array.from({ length: 3 }, () => ({ b64_json: panoramaBase64 })),
      }),
    });
  });
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByLabel("生图 URL").fill("https://panorama-batch.example/v1");
  await settings.getByLabel("生图 API Key").fill("panorama-test-key");
  await settings.getByLabel("生图模型", { exact: true }).fill("panorama-image-model");
  await closeSettings(page);

  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "square-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngPixelBase64, "base64"),
  });
  await clickCanvasTool(page, "全景");
  await clickCanvasTool(page, "适应");
  const imageNode = page.locator('[data-node-type="image"]').last();
  const panoramaRoot = page.locator('[data-node-type="panorama"]').last();
  await imageNode.getByTitle("输出端口 / 拖出连线").click();
  await panoramaRoot.getByTitle("输入端口").click();
  await expect(panoramaRoot.getByText("已连接 1 张普通图片作为生成参考")).toBeVisible();
  await panoramaRoot.getByLabel("全景提示词").fill("a calm blue gallery");
  await panoramaRoot.getByLabel("全景生成质量").selectOption("high");
  await panoramaRoot.getByLabel("全景生成张数").selectOption("3");
  await panoramaRoot.getByRole("button", { name: "生成全景图" }).click();

  await expect.poll(() => editRequestBody).toContain("2048x1024");
  expect(editRequestBody).toContain("panorama-image-model");
  expect(editRequestBody).toContain("a calm blue gallery");
  expect(editRequestBody).toMatch(/name="n"\r\n\r\n3\r\n/);
  expect(editRequestBody).toContain("ref-0.png");
  await expect(page.locator('[data-node-type="panorama"]')).toHaveCount(3, { timeout: 15_000 });
  await expect(panoramaRoot.getByText("全景组 3")).toBeVisible();
  await expect(panoramaRoot.getByTitle("设为主全景")).toContainText("主结果");

  const canvasToolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  await canvasToolbar.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator('[data-node-type="panorama"]')).toHaveCount(1);
  await expect(panoramaRoot.locator("img")).toHaveCount(0);
  await canvasToolbar.getByRole("button", { name: "重做" }).click();
  await expect(page.locator('[data-node-type="panorama"]')).toHaveCount(3);
  await expect(panoramaRoot.locator("img")).toBeVisible();

  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator('[data-node-type="panorama"]')).toHaveCount(3, { timeout: 10_000 });
  const generatedChild = page.locator('[data-node-type="panorama"]').filter({ hasText: "360° 全景 2" });
  await generatedChild.getByRole("button", { name: "打开 360° 全景" }).click();
  await expect(page.getByRole("dialog", { name: "360° 全景查看器" })).toBeVisible();
  await page.getByRole("button", { name: "关闭全景查看器" }).click();
  await clickCanvasTool(page, "导演台");
  await clickCanvasTool(page, "适应");
  const directorNode = page.locator('[data-node-type="director"]').last();
  await generatedChild.getByTitle("输出端口 / 拖出连线").click();
  await directorNode.getByTitle("输入端口").click();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const directorDialog = page.getByRole("dialog", { name: "3D 导演台" });
  await directorDialog.getByLabel("导演台全景环境").selectOption({ label: "360° 全景 2" });
  await expect(directorDialog.locator('canvas[data-testid="director-viewport-canvas"]')).toHaveAttribute("data-environment-loaded", "true", { timeout: 10_000 });
  await directorDialog.getByRole("button", { name: "关闭导演台" }).click();
});

test("panorama generation rolls back project state and preserves redo when durable commit fails", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The panorama transaction flow is covered on desktop.");
  await page.addInitScript(() => {
    const state = window as unknown as { __panoramaCommitRejected?: boolean };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      const [value, key] = args;
      const projects = Array.isArray(value) ? value as Array<{
        nodes?: Array<{ type?: string; metadata?: { status?: string; storageKey?: string } }>;
      }> : [];
      const containsSuccessfulPanorama = projects.some((project) => project.nodes?.some((node) =>
        node.type === "panorama" && node.metadata?.status === "success" &&
        node.metadata.storageKey?.startsWith("image:"),
      ));
      const shouldReject = !state.__panoramaCommitRejected && this.name === "app_state" &&
        key === "openboard:projects" && containsSuccessfulPanorama;
      const request = originalPut.apply(this, args);
      if (shouldReject) {
        state.__panoramaCommitRejected = true;
        this.transaction.abort();
      }
      return request;
    };
  });
  await openFreshBoard(page, { requireProjectPanel: false });
  const panoramaBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(220, 80, 40)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.route("https://panorama-rollback.example/v1/images/generations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: panoramaBase64 }] }),
    });
  });
  let rejectedCommit = false;
  await page.route("**/api/projects/*", async (route) => {
    const body = route.request().postData() ?? "";
    let containsSuccessfulPanorama = false;
    try {
      const project = JSON.parse(body) as { nodes?: Array<{ type?: string; metadata?: { status?: string; storageKey?: string } }> };
      containsSuccessfulPanorama = project.nodes?.some((item) => item.type === "panorama" &&
        item.metadata?.status === "success" && item.metadata.storageKey?.startsWith("image:")) ?? false;
    } catch {
      containsSuccessfulPanorama = false;
    }
    if (!rejectedCommit && route.request().method() === "PUT" && containsSuccessfulPanorama) {
      rejectedCommit = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"forced commit failure"}' });
      return;
    }
    await route.continue();
  });
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByLabel("生图 URL").fill("https://panorama-rollback.example/v1");
  await settings.getByLabel("生图 API Key").fill("panorama-test-key");
  await settings.getByLabel("生图模型", { exact: true }).fill("panorama-image-model");
  await closeSettings(page);

  await clickCanvasTool(page, "全景");
  const panorama = page.locator('[data-node-type="panorama"]').last();
  await panorama.getByLabel("全景提示词").fill("transactional panorama");
  await clickCanvasTool(page, "文本");
  const textNodes = page.locator('[data-node-type="text"]');
  await expect(textNodes).toHaveCount(1);
  const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  await toolbar.getByRole("button", { name: "撤销" }).click();
  await expect(textNodes).toHaveCount(0);

  await panorama.getByRole("button", { name: "生成全景图" }).click();
  await expect.poll(async () => rejectedCommit || page.evaluate(
    () => Boolean((window as unknown as { __panoramaCommitRejected?: boolean }).__panoramaCommitRejected),
  )).toBe(true);
  await expect(panorama.getByRole("alert")).toContainText("全景图生成失败");
  await expect(panorama.locator("img")).toHaveCount(0);
  await expect(page.locator('[data-node-type="panorama"]')).toHaveCount(1);
  await toolbar.getByRole("button", { name: "重做" }).click();
  await expect(textNodes).toHaveCount(1);

  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator('[data-node-type="panorama"]')).toHaveCount(1);
  await expect(page.locator('[data-node-type="panorama"] img')).toHaveCount(0);
});

test("image workflow templates run, persist history, and insert final results atomically", async ({ page }) => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC";
  let requests = 0;
  await page.route("https://workflow.example/v1/images/generations", async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: pngBase64 }] }),
    });
  });
  await openFreshBoard(page, { requireProjectPanel: false });
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByLabel("生图 URL").fill("https://workflow.example/v1");
  await settings.getByLabel("生图 API Key").fill("workflow-test-key");
  await settings.getByLabel("生图模型", { exact: true }).fill("workflow-image-model");
  await closeSettings(page);

  await page.goto("/workbench/workflows");
  await expect(page.getByRole("heading", { name: "图片创作工作流" })).toBeVisible();
  const publicTemplate = page.getByRole("button", { name: /单图主视觉.*公开.*1 步/ });
  await expect(publicTemplate).toBeVisible();
  await publicTemplate.click();
  await page.getByRole("button", { name: "复制" }).click();
  await expect(page.getByText("个人 · r1")).toBeVisible();
  await page.getByLabel("模板名称").fill("我的主视觉流程");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("个人 · r2")).toBeVisible();

  await page.getByLabel("主体描述 *").fill("玻璃海边酒店");
  await page.getByLabel("视觉风格 *").selectOption("商业摄影");
  await page.getByRole("button", { name: "运行工作流" }).click();
  await expect.poll(() => requests).toBe(1);
  const runCard = page.locator("article").filter({ hasText: "我的主视觉流程" }).first();
  await expect(runCard).toContainText("已完成", { timeout: 15_000 });
  await expect(runCard.getByAltText("工作流生成结果")).toBeVisible();
  await runCard.getByRole("button", { name: "发送最终结果到画布" }).click();
  await expect(page.getByRole("status")).toContainText("工作流结果已发送到当前画布");

  await page.goto("/");
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('[data-node-type="image"] img')).toBeVisible();

  await page.goto("/workbench/workflows");
  await expect(page.locator("article").filter({ hasText: "我的主视觉流程" }).first()).toContainText("已完成");
});

test("browser workflow reload marks an in-flight child interrupted without replaying it", async ({ page }) => {
  let requests = 0;
  await page.route("https://workflow-reload.example/v1/images/generations", async (route) => {
    requests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await openFreshBoard(page, { requireProjectPanel: false });
  await page.goto("/workbench/workflows");
  const timestamp = new Date().toISOString();
  await page.evaluate(async ({ timestamp }) => {
    const read = <T,>(database: string, store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction(store, "readonly");
        const get = transaction.objectStore(store).get(key);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result as T);
      };
    });
    const write = (database: string, store: string, values: Array<[IDBValidKey, unknown]>) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction(store, "readwrite");
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => resolve();
          for (const [key, value] of values) transaction.objectStore(store).put(value, key);
        };
      });
    const projects = await read<Array<{ id: string }>>("openboard-app", "app_state", "openboard:projects");
    const projectId = projects[0]!.id;
    const template = {
      schemaVersion: 1, id: "personal_reload", revision: 1, scope: "personal",
      title: "浏览器恢复测试", description: "", category: "测试", variables: [],
      steps: [{
        id: "render", title: "生成", promptTemplate: "不会重放", providerId: "",
        parameters: { size: "1024x1024", count: 1 }, references: [],
      }],
      createdAt: timestamp, updatedAt: timestamp,
    };
    const childId = "workflow_reload_child";
    const parent = {
      id: "workflow_reload_parent", projectId, kind: "workflow", status: "running", prompt: template.title,
      parameters: {
        executor: "browser", requestHash: "0123456789abcdef", templateId: template.id,
        templateRevision: 1, templateSnapshot: template, values: {},
      },
      result: { steps: { render: { status: "running", childJobId: childId } }, outputStorageKeys: [] },
      createdAt: timestamp, updatedAt: timestamp,
    };
    const child = {
      id: childId, projectId, kind: "image", status: "running", prompt: "不会重放",
      parameters: { ownerClientId: "workflow-browser", workflowRunId: parent.id, workflowStepId: "render" },
      result: {}, createdAt: timestamp, updatedAt: timestamp,
    };
    await write("openboard-generation-jobs", "jobs", [[parent.id, parent], [child.id, child]]);
  }, { timestamp });

  await page.reload();
  const card = page.locator("article").filter({ hasText: "浏览器恢复测试" });
  await expect(card).toContainText("页面刷新后浏览器任务已中断，请按快照重试");
  await expect(card.getByRole("button", { name: "按快照重试" })).toBeVisible();
  expect(requests).toBe(0);
});

test("director reports a recoverable error when WebGL is unavailable", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "The director desktop fallback is covered here.");
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
      return original.call(this, type, ...args as []) as ReturnType<typeof original>;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "导演台");
  const directorNode = page.locator('[data-node-type="director"]').last();
  await directorNode.getByRole("button", { name: "打开导演台" }).click();
  const dialog = page.getByRole("dialog", { name: "3D 导演台" });
  await expect(dialog.getByRole("alert").first()).toContainText("无法创建 3D 渲染环境");
  await dialog.getByRole("button", { name: "拍摄当前机位" }).click();
  await expect(dialog.locator('p[role="alert"]')).toContainText("无法创建 3D 渲染环境");
  await dialog.getByRole("button", { name: "关闭导演台" }).click();
  await expect(dialog).toHaveCount(0);
});

test("projects support create, rename, JSON export/import, and batch delete", async ({ page }) => {
  await openFreshBoard(page);
  await openProjectPanel(page);
  await page.getByTitle("新建").click();
  await page.getByTitle("新建").click();
  await expect(page.locator('input[value="画布 2"]')).toBeVisible();
  const latestTitle = page.locator('input[value="画布 3"]');
  await latestTitle.fill("可导出项目");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTitle("导出当前", { exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("可导出项目.json");

  const archiveDownloadPromise = page.waitForEvent("download");
  await page.getByTitle("导出当前画布包").click();
  const archiveDownload = await archiveDownloadPromise;
  expect(archiveDownload.suggestedFilename()).toBe("可导出项目.openboard");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const now = "2026-07-18T00:00:00.000Z";
  await page.locator('input[type="file"][accept^=".json"]').setInputFiles({
    name: "imported-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2,
      id: "import-source",
      title: "外部项目",
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: [],
      chatSessions: [],
      activeChatId: null,
      backgroundMode: "dots",
      viewport: { x: 0, y: 0, k: 1 },
    })),
  });
  await expect(page.locator('input[value="外部项目 (导入)"]')).toBeVisible();
  expect(pageErrors).toEqual([]);

  await projectCard(page, "画布 2").getByRole("checkbox").check();
  await projectCard(page, "可导出项目").getByRole("checkbox").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTitle("删除勾选").click();
  await expect(page.locator('input[value="画布 2"]')).toHaveCount(0);
  await expect(page.locator('input[value="可导出项目"]')).toHaveCount(0);
  await expect(page.locator('input[value="我的第一个画布"]')).toBeVisible();
  await expect(page.locator('input[value="外部项目 (导入)"]')).toBeVisible();
});

test("desktop project panel resizes, collapses, and persists its width", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop resize behavior is covered here.");
  await openFreshBoard(page);
  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  const resizeHandle = page.getByRole("separator", { name: "调整项目侧栏宽度" });
  const before = await panel.boundingBox();
  const handle = await resizeHandle.boundingBox();
  expect(before).not.toBeNull();
  expect(handle).not.toBeNull();

  await resizeHandle.hover({ position: { x: 2, y: 80 } });
  await page.mouse.down();
  await page.mouse.move(handle!.x + 86, handle!.y + 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(before!.width + 60);
  const resizedWidth = (await panel.boundingBox())!.width;

  await panel.getByTitle("收起侧栏").click();
  await expect(panel).toBeHidden();
  const expandPanel = page.getByTitle("展开侧栏");
  const firstTool = page.getByRole("toolbar", { name: "画布工具栏" })
    .getByTitle("文本", { exact: true });
  const expandBox = await expandPanel.boundingBox();
  const firstToolBox = await firstTool.boundingBox();
  expect(expandBox).not.toBeNull();
  expect(firstToolBox).not.toBeNull();
  expect(expandBox!.x + expandBox!.width).toBeLessThanOrEqual(firstToolBox!.x);
  await expandPanel.click();
  await expect(panel).toBeVisible();
  await expect(page.getByTitle("收起侧栏")).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
  // Allow formal storage flush of canvasPanelCollapsed=false + width.
  await page.waitForTimeout(300);

  await page.reload();
  await expect(panel).toBeVisible({ timeout: 10_000 });
  expect((await panel.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
});

test("canvas element panel selects, locates, and batch exports nodes", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("文本", { exact: true }).click();
  await page.getByTitle("配置", { exact: true }).click();
  await openProjectPanel(page);

  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  await panel.getByRole("tab", { name: "元素" }).click();
  const elements = panel.getByRole("list", { name: "画布元素" });
  await expect(elements.getByRole("listitem")).toHaveCount(2);
  await panel.getByRole("button", { name: "全选元素" }).click();
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await expect(panel.getByRole("checkbox", { name: "选择文本" })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "选择生成配置" })).toBeChecked();
  } else {
    await expect(page.locator('[data-node-type="text"]')).toHaveClass(/border-\[var\(--ob-select\)\]/);
    await expect(page.locator('[data-node-type="config"]')).toHaveClass(/border-\[var\(--ob-select\)\]/);
  }

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出所选元素" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/画布元素-2\.zip$/);

  await elements.getByRole("button", { name: "定位文本" }).click();
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await expect(panel).toBeHidden();
  }
  await expect(page.locator('[data-node-type="text"]')).toHaveClass(/border-\[var\(--ob-select\)\]/);
  await page.reload();
  await openProjectPanel(page);
  await expect(panel.getByRole("tab", { name: "元素", selected: true })).toBeVisible();
});

test("canvas editing preserves copied edges, history, view controls, and appearance", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop controls and edge hit targets are covered here.");
  await openFreshBoard(page);
  await clickCanvasTool(page, "文本");
  await page.getByTitle("配置").click();
  const textNode = page.locator('[data-node-type="text"]');
  const configNode = page.locator('[data-node-type="config"]');
  await textNode.getByTitle("输出端口 / 拖出连线").click();
  await configNode.getByTitle("输入端口").click();
  const edges = page.getByTestId("canvas-surface").locator("svg").first().locator("g");
  await expect(edges).toHaveCount(1);
  await textNode.locator("[data-node-header]").click();
  await expect(textNode).toHaveClass(/border-\[var\(--ob-select\)\]/);
  await expect(configNode).toHaveClass(/border-\[var\(--ob-accent\)\]/);
  await expect(edges.first().locator("path").nth(1)).toHaveAttribute("stroke", "var(--ob-select)");

  const textBox = await textNode.boundingBox();
  const configBox = await configNode.boundingBox();
  expect(textBox).not.toBeNull();
  expect(configBox).not.toBeNull();
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.move(Math.max(0, textBox!.x - 16), Math.max(0, Math.min(textBox!.y, configBox!.y) - 16));
  await page.mouse.down();
  await page.mouse.move(
    Math.max(textBox!.x + textBox!.width, configBox!.x + configBox!.width) + 16,
    Math.max(textBox!.y + textBox!.height, configBox!.y + configBox!.height) + 16,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.keyboard.up("ControlOrMeta");
  await expect(textNode).toHaveClass(/ring-2/);
  await expect(configNode).toHaveClass(/ring-2/);

  const edgePoint = await edges.first().locator('path[stroke="transparent"]').evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error("edge screen transform is unavailable");
    return {
      x: matrix.a * point.x + matrix.c * point.y + matrix.e,
      y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    };
  });
  await page.mouse.click(edgePoint.x, edgePoint.y);
  await expect(edges.first().locator("path").nth(1)).toHaveAttribute("stroke", "var(--ob-select)");
  await page.keyboard.press("Delete");
  await expect(edges).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(edges).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator('[data-node-type="text"]')).toHaveCount(2);
  await expect(page.locator('[data-node-type="config"]')).toHaveCount(2);
  await expect(edges).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator('[data-node-type="text"]')).toHaveCount(1);
  await expect(edges).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator('[data-node-type="text"]')).toHaveCount(2);
  await expect(edges).toHaveCount(2);

  const surface = page.getByTestId("canvas-surface");
  await expect.poll(() => surface.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("radial-gradient");
  await page.getByTitle("背景").click();
  await expect.poll(() => surface.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("linear-gradient");
  await page.getByTitle("背景").click();
  await expect.poll(() => surface.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toBe("none");

  await expect(page.getByLabel("画布小地图")).toBeVisible();
  await page.getByTitle("小地图").click();
  await expect(page.getByLabel("画布小地图")).toHaveCount(0);
  await page.getByTitle("小地图").click();
  await expect(page.getByLabel("画布小地图")).toBeVisible();

  const wasDark = await page.locator("html").evaluate((element) => element.classList.contains("dark"));
  await page.getByTitle("主题").click();
  await expect.poll(() => page.locator("html").evaluate((element) => element.classList.contains("dark")))
    .toBe(!wasDark);
});

test("loopback New API links configure text credentials and scrub the URL", async ({ page }) => {
  await page.goto("/?apiKey=local-test-key&baseUrl=http%3A%2F%2F127.0.0.1%3A3001%2Fv1");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByLabel("文本 URL")).toHaveValue("http://127.0.0.1:3001/v1");
  await expect(page.getByLabel("文本 API Key")).toHaveValue("local-test-key");
  await expect(page.getByLabel("生图 API Key")).not.toHaveValue("local-test-key");
  await expect(page.getByLabel("视频 API Key")).not.toHaveValue("local-test-key");
  await expect(page.getByLabel("音频 API Key")).not.toHaveValue("local-test-key");
});

test("a text node and its content survive a reload", async ({ page }) => {
  await openFreshBoard(page);
  await clickCanvasTool(page, "文本");

  const editor = page.locator('[data-node-type="text"]').getByPlaceholder("写下提示词或说明…");
  await expect(editor).toBeVisible();
  await editor.fill("persisted from Playwright");
  if ((page.viewportSize()?.width ?? 1440) >= 768) {
    await expect(page.getByText("1 节点", { exact: false })).toBeVisible();
  }

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open("openboard-app");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const database = open.result;
              const transaction = database.transaction("app_state", "readonly");
              const request = transaction.objectStore("app_state").get("openboard:projects");
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const projects = Array.isArray(request.result) ? request.result : [];
                const persisted = projects.some((project) =>
                  project?.nodes?.some(
                    (node: { metadata?: { content?: string } }) =>
                      node.metadata?.content === "persisted from Playwright",
                  ),
                );
                database.close();
                resolve(persisted);
              };
            };
          }),
      ),
    )
    .toBe(true);
  await page.reload();

  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue(
    "persisted from Playwright",
  );
  if ((page.viewportSize()?.width ?? 1440) >= 768) {
    await expect(page.getByText("1 节点", { exact: false })).toBeVisible();
  }
});

test("blank canvas double-click opens the node chooser at the pointer", async ({ page }) => {
  await openFreshBoard(page);
  const surface = page.getByTestId("canvas-surface");
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await surface.dblclick({
    position: {
      x: Math.min(200, surfaceBox!.width / 2),
      y: Math.min(300, surfaceBox!.height / 2),
    },
  });
  await expect(page.getByRole("menuitem", { name: "新建文本" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "上传资源" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "从素材库插入" })).toBeVisible();
  await page.getByRole("menuitem", { name: "新建音频" }).click();
  await expect(page.locator('[data-node-type="audio"]')).toHaveCount(1);
});

test("blank canvas chooser can open the asset library at the pointer", async ({ page }) => {
  await openFreshBoard(page);
  const surface = page.getByTestId("canvas-surface");
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await surface.dblclick({
    position: {
      x: Math.min(220, surfaceBox!.width / 2),
      y: Math.min(280, surfaceBox!.height / 2),
    },
  });
  await page.getByRole("menuitem", { name: "从素材库插入" }).click();
  await expect(page.getByRole("dialog", { name: "从素材插入" })).toBeVisible();
});

test("node ports support click-to-connect without requiring a drag", async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 1440) < 768,
    "Desktop node spacing is required for the click-to-connect layout assertion.",
  );
  await openFreshBoard(page);
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "connection-source.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await page.getByRole("toolbar", { name: "画布工具栏" })
    .getByRole("button", { name: "视频", exact: true }).click();
  const video = page.locator('[data-node-type="video"]');
  await page.getByTitle("适应").click();

  await page.locator('[data-node-type="image"]')
    .getByTitle("输出端口 / 拖出连线").click();
  await video.getByTitle("输入端口").click();

  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly")
        .objectStore("app_state")
        .get("openboard:projects");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const projects = Array.isArray(request.result) ? request.result : [];
        database.close();
        resolve(projects.reduce((count, project) => count + (project?.edges?.length ?? 0), 0));
      };
    };
  }))).toBe(1);
});

test("Escape closes settings, shortcuts, and the local Agent panel", async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 1440) < 768,
    "The shortcut button is intentionally hidden in the compact toolbar.",
  );
  await openFreshBoard(page);

  await page.getByTitle("设置").click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "设置" })).toHaveCount(0);

  await page.getByTitle("快捷键").click();
  await expect(page.getByRole("heading", { name: "画布快捷键" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "画布快捷键" })).toHaveCount(0);

  await page.getByTitle("本地 Agent").click();
  await expect(page.getByText("本地 Agent", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("本地 Agent", { exact: true })).toHaveCount(0);
});

test("Escape dismisses only the topmost canvas overlay", async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 1440) < 768,
    "The local Agent button is intentionally hidden in the compact toolbar.",
  );
  await openFreshBoard(page);
  await page.getByTitle("本地 Agent").click();
  await expect(page.getByText("本地 Agent", { exact: true })).toBeVisible();

  await page.getByTestId("canvas-surface").dispatchEvent("contextmenu", {
    button: 2,
    clientX: 500,
    clientY: 300,
  });
  await expect(page.getByRole("menuitem", { name: "新建文本" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "新建文本" })).toHaveCount(0);
  await expect(page.getByText("本地 Agent", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByText("本地 Agent", { exact: true })).toHaveCount(0);
});

test("a same-frame drag commits group membership before pointerup reconciliation", async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 1440) < 768,
    "Stable desktop coordinates are required for the pointer timing regression.",
  );
  await openFreshBoard(page);
  const now = "2026-07-18T00:00:00.000Z";
  const project = {
    schemaVersion: 2,
    id: "group-race-project",
    title: "Group race atomic",
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "group_1",
        type: "group",
        title: "分组",
        position: { x: 76, y: 76 },
        width: 368,
        height: 228,
        metadata: { childIds: ["text_a", "text_b"] },
      },
      {
        id: "text_a",
        type: "text",
        title: "A",
        position: { x: 100, y: 100 },
        width: 140,
        height: 180,
        metadata: { content: "A" },
      },
      {
        id: "text_b",
        type: "text",
        title: "B",
        position: { x: 280, y: 100 },
        width: 140,
        height: 180,
        metadata: { content: "B" },
      },
      {
        id: "text_c",
        type: "text",
        title: "C",
        position: { x: 560, y: 100 },
        width: 140,
        height: 180,
        metadata: { content: "C" },
      },
    ],
    edges: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    viewport: { x: 0, y: 0, k: 1 },
  };
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: "group-race.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });

  const moving = page.locator('[data-node-id="text_c"]');
  const surface = page.getByTestId("canvas-surface");
  const source = await moving.locator("[data-node-header]").boundingBox();
  const canvas = await surface.boundingBox();
  expect(source).not.toBeNull();
  expect(canvas).not.toBeNull();
  const persistedGroup = () => page.evaluate(() => new Promise<{
    childIds: string[];
    position: { x: number; y: number } | null;
    width: number | null;
    height: number | null;
    padding: { left: number; top: number; right: number; bottom: number } | null;
  }>((resolve, reject) => {
    const request = indexedDB.open("openboard-app");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("app_state", "readonly")
        .objectStore("app_state").get("openboard:projects");
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const projects = Array.isArray(read.result) ? read.result : [];
        const imported = projects.find((item) => item?.title === "Group race atomic (导入)");
        const group = imported?.nodes?.find((node: { id?: string }) => node.id === "group_1");
        const childIds: string[] = group?.metadata?.childIds ?? [];
        const children = imported?.nodes?.filter((node: { id?: string }) => childIds.includes(node.id ?? "")) ?? [];
        const minX = children.length ? Math.min(...children.map((node: { position: { x: number } }) => node.position.x)) : 0;
        const minY = children.length ? Math.min(...children.map((node: { position: { y: number } }) => node.position.y)) : 0;
        const maxX = children.length ? Math.max(...children.map((node: { position: { x: number }; width: number }) => node.position.x + node.width)) : 0;
        const maxY = children.length ? Math.max(...children.map((node: { position: { y: number }; height: number }) => node.position.y + node.height)) : 0;
        database.close();
        resolve({
          childIds,
          position: group?.position ?? null,
          width: group?.width ?? null,
          height: group?.height ?? null,
          padding: group && children.length ? {
            left: minX - group.position.x,
            top: minY - group.position.y,
            right: group.position.x + group.width - maxX,
            bottom: group.position.y + group.height - maxY,
          } : null,
        });
      };
    };
  }));
  await page.evaluate(({ source }) => {
    const header = document.querySelector<HTMLElement>('[data-node-id="text_c"] [data-node-header]');
    if (!header) throw new Error("group drag fixture missing");
    const startX = source.x + 20;
    const startY = source.y + 15;
    header.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 17, button: 0, buttons: 1, clientX: startX, clientY: startY,
    }));
  }, { source: source! });
  await page.evaluate(({ canvas }) => {
    const surface = document.querySelector<HTMLElement>('[data-testid="canvas-surface"]');
    if (!surface) throw new Error("canvas surface missing");
    const endX = canvas.x + 420;
    const endY = canvas.y + 115;
    surface.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 17, button: 0, buttons: 1, clientX: endX, clientY: endY,
    }));
    surface.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 17, button: 0, buttons: 0, clientX: endX, clientY: endY,
    }));
  }, { canvas: canvas! });

  await expect.poll(async () => {
    const group = await persistedGroup();
    return { childIds: group.childIds, padding: group.padding };
  }).toEqual({
    childIds: ["text_a", "text_b", "text_c"],
    padding: { left: 24, top: 24, right: 24, bottom: 24 },
  });

  await page.getByTitle("撤销").click();
  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b"], width: 368 });
  await page.getByTitle("重做").click();
  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b", "text_c"], padding: { left: 24, top: 24, right: 24, bottom: 24 } });
  await page.reload();
  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b", "text_c"], padding: { left: 24, top: 24, right: 24, bottom: 24 } });

  const reloadedSource = await page.locator('[data-node-id="text_c"] [data-node-header]').boundingBox();
  const reloadedCanvas = await page.getByTestId("canvas-surface").boundingBox();
  expect(reloadedSource).not.toBeNull();
  expect(reloadedCanvas).not.toBeNull();
  await page.evaluate(({ source }) => {
    const header = document.querySelector<HTMLElement>('[data-node-id="text_c"] [data-node-header]');
    if (!header) throw new Error("group drag fixture missing after reload");
    header.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 18,
      button: 0,
      buttons: 1,
      clientX: source.x + 20,
      clientY: source.y + 15,
    }));
  }, { source: reloadedSource! });
  await page.evaluate(({ canvas }) => {
    const surface = document.querySelector<HTMLElement>('[data-testid="canvas-surface"]');
    if (!surface) throw new Error("canvas surface missing after reload");
    const endX = canvas.x + 620;
    const endY = canvas.y + 115;
    surface.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 18, button: 0, buttons: 1, clientX: endX, clientY: endY,
    }));
    surface.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 18, button: 0, buttons: 0, clientX: endX, clientY: endY,
    }));
  }, { canvas: reloadedCanvas! });

  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b"], width: 368 });
  await page.getByTitle("撤销").click();
  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b", "text_c"], padding: { left: 24, top: 24, right: 24, bottom: 24 } });
  await page.getByTitle("重做").click();
  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b"], width: 368 });
  await page.reload();
  await expect.poll(persistedGroup).toMatchObject({ childIds: ["text_a", "text_b"], width: 368 });
});

test("group shortcut, whole-group drag/resize, copy/delete, undo, and reload stay atomic", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop pointer coordinates are required.");
  await openFreshBoard(page);
  await clickCanvasTool(page, "文本");
  await clickCanvasTool(page, "文本");
  const texts = page.locator('[data-node-type="text"]');
  await expect(texts).toHaveCount(2);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await texts.nth(0).locator("[data-node-header]").click();
  await texts.nth(1).locator("[data-node-header]").click({ modifiers: ["Shift"] });
  await expect(page.locator('[data-node-type="text"][data-selected="true"]')).toHaveCount(2);
  await page.keyboard.press(`${modifier}+g`);

  const groups = page.locator('[data-node-type="group"]');
  await expect(groups).toHaveCount(1);
  const group = groups.first();
  const groupBefore = await group.boundingBox();
  const firstBefore = await texts.nth(0).boundingBox();
  expect(groupBefore).not.toBeNull();
  expect(firstBefore).not.toBeNull();
  const groupHeader = group.locator("[data-node-header]");
  const headerBox = await groupHeader.boundingBox();
  expect(headerBox).not.toBeNull();
  await groupHeader.dispatchEvent("pointerdown", {
    pointerId: 91, button: 0, buttons: 1, clientX: headerBox!.x + 30, clientY: headerBox!.y + 12,
  });
  await page.getByTestId("canvas-surface").dispatchEvent("pointermove", {
    pointerId: 91, button: 0, buttons: 1, clientX: headerBox!.x + 110, clientY: headerBox!.y + 52,
  });
  await page.getByTestId("canvas-surface").dispatchEvent("pointerup", {
    pointerId: 91, button: 0, buttons: 0, clientX: headerBox!.x + 110, clientY: headerBox!.y + 52,
  });
  await expect.poll(async () => (await group.boundingBox())?.x ?? 0).toBeCloseTo(groupBefore!.x + 80, 0);
  await expect.poll(async () => (await texts.nth(0).boundingBox())?.x ?? 0).toBeCloseTo(firstBefore!.x + 80, 0);

  const movedBox = await group.boundingBox();
  const resize = group.locator(".cursor-se-resize");
  const resizeBox = await resize.boundingBox();
  expect(movedBox).not.toBeNull();
  expect(resizeBox).not.toBeNull();
  await resize.dispatchEvent("pointerdown", {
    pointerId: 92, button: 0, buttons: 1, clientX: resizeBox!.x + 5, clientY: resizeBox!.y + 5,
  });
  await page.getByTestId("canvas-surface").dispatchEvent("pointermove", {
    pointerId: 92, button: 0, buttons: 1, clientX: resizeBox!.x + 65, clientY: resizeBox!.y + 45,
  });
  await page.getByTestId("canvas-surface").dispatchEvent("pointerup", {
    pointerId: 92, button: 0, buttons: 0, clientX: resizeBox!.x + 65, clientY: resizeBox!.y + 45,
  });
  await expect.poll(async () => (await group.boundingBox())?.width ?? 0).toBeGreaterThan(movedBox!.width + 40);

  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press(`${modifier}+v`);
  await expect(groups).toHaveCount(2);
  await expect(texts).toHaveCount(4);
  await page.keyboard.press("Delete");
  await expect(groups).toHaveCount(1);
  await expect(texts).toHaveCount(2);
  await page.keyboard.press(`${modifier}+z`);
  await expect(groups).toHaveCount(2);
  await expect(texts).toHaveCount(4);
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect(groups).toHaveCount(1);
  await expect(texts).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => new Promise<{ groups: number; texts: number }>((resolve, reject) => {
    const request = indexedDB.open("openboard-app");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("app_state", "readonly")
        .objectStore("app_state").get("openboard:projects");
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const projects = Array.isArray(read.result) ? read.result : [];
        const project = projects.find((item) => item?.title === "我的第一个画布") ?? projects[0];
        const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
        database.close();
        resolve({
          groups: nodes.filter((node: { type?: string }) => node.type === "group").length,
          texts: nodes.filter((node: { type?: string }) => node.type === "text").length,
        });
      };
    };
  }))).toEqual({ groups: 1, texts: 2 });
  await page.reload();
  await expect(groups).toHaveCount(1);
  await expect(texts).toHaveCount(2);
});

test("Escape and lost pointer capture terminate node dragging", async ({ page }) => {
  await openFreshBoard(page);
  await clickCanvasTool(page, "文本");
  const node = page.locator('[data-node-type="text"]');
  const surface = page.getByTestId("canvas-surface");
  const header = node.locator("[data-node-header]");
  const start = await header.boundingBox();
  expect(start).not.toBeNull();

  await header.dispatchEvent("pointerdown", { pointerId: 71, button: 0, buttons: 1, clientX: start!.x + 20, clientY: start!.y + 12 });
  await surface.dispatchEvent("pointermove", { pointerId: 71, button: 0, buttons: 1, clientX: start!.x + 80, clientY: start!.y + 42 });
  await page.keyboard.press("Escape");
  const afterEscape = await node.boundingBox();
  await surface.dispatchEvent("pointermove", { pointerId: 71, button: 0, buttons: 1, clientX: start!.x + 240, clientY: start!.y + 160 });
  await expect.poll(async () => ({ x: (await node.boundingBox())?.x, y: (await node.boundingBox())?.y }))
    .toEqual({ x: afterEscape?.x, y: afterEscape?.y });

  const resumed = await header.boundingBox();
  await header.dispatchEvent("pointerdown", { pointerId: 72, button: 0, buttons: 1, clientX: resumed!.x + 20, clientY: resumed!.y + 12 });
  await surface.dispatchEvent("pointermove", { pointerId: 72, button: 0, buttons: 1, clientX: resumed!.x + 70, clientY: resumed!.y + 32 });
  await surface.dispatchEvent("lostpointercapture", { pointerId: 72 });
  await expect.poll(async () => ({ x: (await node.boundingBox())?.x, y: (await node.boundingBox())?.y }))
    .toEqual({ x: (afterEscape?.x ?? 0) + 50, y: (afterEscape?.y ?? 0) + 20 });
  const afterLoss = await node.boundingBox();
  await surface.dispatchEvent("pointermove", { pointerId: 72, button: 0, buttons: 1, clientX: resumed!.x + 220, clientY: resumed!.y + 120 });
  await expect.poll(async () => ({ x: (await node.boundingBox())?.x, y: (await node.boundingBox())?.y }))
    .toEqual({ x: afterLoss?.x, y: afterLoss?.y });
});

test("a legacy v1 project upgrades to schema v2 and survives reload", async ({ page }) => {
  await openFreshBoard(page);
  const now = "2026-07-18T00:00:00.000Z";
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: "legacy-v1.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: "legacy-v1",
      title: "Legacy schema fixture",
      createdAt: now,
      updatedAt: now,
      nodes: [{
        id: "legacy_text",
        type: "text",
        title: "Legacy text",
        position: { x: 120, y: 120 },
        width: 320,
        height: 180,
        metadata: { content: "persisted legacy content" },
      }],
      edges: [],
      chatSessions: [],
      activeChatId: null,
      backgroundMode: "dots",
      viewport: { x: 0, y: 0, k: 1 },
    })),
  });

  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("persisted legacy content");
  await expect.poll(() => page.evaluate(() => new Promise<number | null>((resolve, reject) => {
    const request = indexedDB.open("openboard-app");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("app_state", "readonly")
        .objectStore("app_state").get("openboard:projects");
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const projects = Array.isArray(read.result) ? read.result : [];
        const imported = projects.find((item) => item?.title === "Legacy schema fixture (导入)");
        database.close();
        resolve(imported?.schemaVersion ?? null);
      };
    };
  }))).toBe(2);

  await page.reload();
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("persisted legacy content");
});

test("config input reorder changes Ark reference order", async ({ page }) => {
  const red = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const blue = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNkYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
  let requestBody: { content?: Array<{ type?: string; image_url?: { url?: string } }> } | null = null;
  await page.route("https://order.example/api/plan/v3/contents/generations/tasks", async (route) => {
    requestBody = JSON.parse(route.request().postData() ?? "null") as typeof requestBody;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "ordered-task",
        status: "succeeded",
        content: { video_url: "https://cdn.example/ordered.mp4" },
      }),
    });
  });
  await page.route("https://cdn.example/ordered.mp4", async (route) => {
    await route.fulfill({ contentType: "video/mp4", body: "video-bytes" });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("视频协议").selectOption("ark");
  await page.getByLabel("视频 URL").fill("https://order.example/api/plan/v3");
  await page.getByLabel("视频 API Key").fill("order-test-key");
  await page.getByLabel("视频模型", { exact: true }).fill("seedance-1-0-pro-250528");
  await closeSettings(page);

  const now = "2026-07-18T00:00:00.000Z";
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: "ordered-inputs.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2,
      id: "ordered-inputs",
      title: "Ordered inputs fixture",
      createdAt: now,
      updatedAt: now,
      nodes: [
        { id: "red", type: "image", title: "Red", position: { x: 40, y: 80 }, width: 140, height: 140, metadata: { content: red } },
        { id: "blue", type: "image", title: "Blue", position: { x: 40, y: 280 }, width: 140, height: 140, metadata: { content: blue } },
        { id: "config", type: "config", title: "Video config", position: { x: 300, y: 120 }, width: 360, height: 360, metadata: { generationMode: "video", prompt: "ordered references", duration: 5, videoRatio: "16:9", resolution: "720p" } },
      ],
      edges: [
        { id: "red-config", from: "red", to: "config" },
        { id: "blue-config", from: "blue", to: "config" },
      ],
      chatSessions: [],
      activeChatId: null,
      backgroundMode: "dots",
      viewport: { x: 0, y: 0, k: 1 },
    })),
  });

  await page.locator('[data-node-id="config"] [data-node-header]').click();
  await page.getByRole("button", { name: "下移输入 1" }).click();
  await page.getByTitle("运行生成").click();
  await expect.poll(() => requestBody).not.toBeNull();
  const references = requestBody?.content
    ?.filter((item) => item.type === "image_url")
    .map((item) => item.image_url?.url);
  expect(references).toEqual([blue, red]);
});

test("node title, font size, and model overrides are editable and persistent", async ({ page }) => {
  await openFreshBoard(page);
  await clickCanvasTool(page, "文本");
  const node = page.locator('[data-node-type="text"]').first();
  await node.locator("[data-node-title]").dblclick();
  const title = node.getByLabel("节点标题");
  await title.fill("本地创作节点");
  await title.press("Enter");
  await expect(node.locator("[data-node-title]")).toHaveText("本地创作节点");

  const model = node.getByLabel("文本节点模型");
  await model.fill("local-text-model");
  const editor = page.getByPlaceholder("写下提示词或说明…");
  await editor.fill("toolbar editing target");
  await page.getByTitle("适应").click();
  await node.locator("[data-node-header]").click();
  await node.getByTitle("编辑文字").click();
  await expect.poll(() => editor.evaluate((element) => document.activeElement === element)).toBe(true);
  const initialSize = await editor.evaluate((element) => getComputedStyle(element).fontSize);
  await page.getByTitle("增大字号").click();
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).fontSize))
    .not.toBe(initialSize);

  await expect.poll(() => page.evaluate(
    () => new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open("openboard-app");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction("app_state", "readonly")
          .objectStore("app_state")
          .get("openboard:projects");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const projects = Array.isArray(request.result) ? request.result : [];
          resolve(projects.some((project) => project?.nodes?.some(
            (item: { title?: string; metadata?: { model?: string } }) =>
              item.title === "本地创作节点" && item.metadata?.model === "local-text-model",
          )));
          database.close();
        };
      };
    }),
  )).toBe(true);

  await page.reload();
  await expect(page.locator('[data-node-type="text"]').locator("[data-node-title]")).toHaveText("本地创作节点");
  await page.locator('[data-node-type="text"]').first().locator("[data-node-header]").click();
  await expect(page.getByLabel("文本节点模型")).toHaveValue("local-text-model");
});

test("compact node controls keep long models, multiline text, and image actions usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page, { requireProjectPanel: false });
  await clickCanvasTool(page, "文本");
  const textNode = page.locator('[data-node-type="text"]');
  await textNode.getByLabel("文本节点模型").fill(`model-${"very-long-".repeat(40)}`);
  await textNode.getByPlaceholder("写下提示词或说明…").fill("first line\n\nthird line");
  const send = textNode.getByRole("button", { name: "发送提示词" });
  await expect(send).toBeVisible();
  const sendBox = await send.boundingBox();
  expect(sendBox).not.toBeNull();
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(390);

  await importSingleImageProject(page, "compact-image-toolbar");
  await page.getByTitle("适应").click();
  const imageNode = page.locator('[data-node-type="image"]');
  await imageNode.locator("[data-node-header]").click();
  const actions = imageNode.locator(".ob-chrome").first();
  await expect(imageNode.getByTitle("下载")).toBeVisible();
  const actionBox = await actions.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.x).toBeGreaterThanOrEqual(0);
  expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(390);
});

test("config node preserves blank-line prompts across reload and uses them for generation", async ({ page }) => {
  let requestPrompt = "";
  await page.route("https://config-prompt.example/v1/images/generations", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { prompt?: string };
    requestPrompt = body.prompt ?? "";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: pngPixelBase64 }] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://config-prompt.example/v1");
  await page.getByLabel("生图 API Key").fill("config-prompt-key");
  await page.getByLabel("生图模型", { exact: true }).fill("config-prompt-model");
  await closeSettings(page);
  await clickCanvasTool(page, "配置");
  const node = page.locator('[data-node-type="config"]');
  const prompt = node.getByLabel("配置节点提示词");
  await prompt.fill("first line\n\nthird line");
  await expect(prompt).toHaveValue("first line\n\nthird line");
  await expect.poll(() => page.evaluate(() => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open("openboard-app");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("app_state", "readonly")
        .objectStore("app_state").get("openboard:projects");
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const projects = Array.isArray(read.result) ? read.result : [];
        const project = projects.find((item) => item?.title === "我的第一个画布") ?? projects[0];
        const config = project?.nodes?.find((item: { type?: string }) => item.type === "config");
        database.close();
        resolve(config?.metadata?.prompt ?? "");
      };
    };
  }))).toBe("first line\n\nthird line");
  await page.reload();
  await node.locator("[data-node-header]").click();
  await expect(node.getByLabel("配置节点提示词")).toHaveValue("first line\n\nthird line");
  await node.getByTitle("运行生成").click();
  await expect.poll(() => requestPrompt).toBe("first line\n\nthird line");
});

test("node titles appear only while hovered, selected, or edited", async ({ page }) => {
  await openFreshBoard(page);
  await clickCanvasTool(page, "文本");
  const node = page.locator('[data-node-type="text"]');
  const title = node.locator("[data-node-title]");
  await expect(title).toHaveCSS("opacity", "1");

  await page.getByTestId("canvas-surface").click({ position: { x: 24, y: 24 } });
  await expect(title).toHaveCSS("opacity", "0");
  if ((page.viewportSize()?.width ?? 1440) >= 768) {
    await node.hover();
    await expect(title).toHaveCSS("opacity", "1");
  }
  await node.locator("[data-node-header]").click();
  await expect(title).toHaveCSS("opacity", "1");
});

test("settings keeps provider configuration structured without responsive overflow", async ({ page }) => {
  for (const viewport of [
    { width: 1380, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openFreshBoard(page, { requireProjectPanel: false });
    await page.getByTitle("设置").click();

    const dialog = page.getByRole("dialog", { name: "设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-provider-kind]")).toHaveCount(4);
    await expect(dialog.getByLabel("文本 URL")).toBeVisible();
    await expect(dialog.getByLabel("生图 API Key")).toBeVisible();

    const dimensions = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    await dialog.getByLabel("WebDAV URL").scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "关闭" })).toBeVisible();
    await closeSettings(page);
  }
});

test("text-to-image creates a connected config and executes immediately", async ({ page }) => {
  let requestBody: Record<string, unknown> | null = null;
  await page.route("https://mock.example/v1/images/generations", async (route) => {
    requestBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: Array.from({ length: 2 }, () => ({
          b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC",
        })),
      }),
    });
  });
  await installOwnerAuthRoutes(page);
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByLabel("生图 URL").fill("https://mock.example/v1");
  await settings.getByLabel("生图 API Key").fill("test-only-key");
  await settings.getByLabel("生图模型", { exact: true }).fill("mock-image-model");
  await settings.getByLabel("默认数量").fill("2");
  await settings.getByLabel("全局系统提示词").fill("Use a crisp editorial style.");
  await closeSettings(page);

  await clickCanvasTool(page, "文本");
  await page.getByPlaceholder("写下提示词或说明…").fill("a red square");
  await page.getByTitle("生图").click();

  await expect(page.locator('[data-node-type="config"]')).toHaveCount(1);
  await expect(page.locator('[data-node-type="config"]').getByLabel("配置节点提示词"))
    .toHaveValue("a red square");
  await expect.poll(() => requestBody).toMatchObject({
    model: "mock-image-model",
    prompt: "Use a crisp editorial style.\n\na red square",
  });
  await expect.poll(() => page.evaluate(
    () => new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open("openboard-app");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction("app_state", "readonly")
          .objectStore("app_state")
          .get("openboard:projects");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const projects = Array.isArray(request.result) ? request.result : [];
          resolve(projects.some((project) => {
            const config = project?.nodes?.find((item: { type?: string }) => item.type === "config");
            const images = project?.nodes?.filter((item: { type?: string }) => item.type === "image") ?? [];
            return config?.metadata?.batchChildIds?.length === 2 && images.length === 2 &&
              images.every((item: { metadata?: Record<string, unknown> }) =>
                item.metadata?.status === "success" &&
                item.metadata?.generationType === "text-to-image" &&
                item.metadata?.model === "mock-image-model" &&
                item.metadata?.size === "1024x1024" &&
                item.metadata?.quality === "auto" &&
                item.metadata?.count === 2 &&
                Array.isArray(item.metadata?.referenceStorageKeys));
          }));
          database.close();
        };
      };
    }),
  )).toBe(true);
});

test("failed text-to-image keeps its config and can retry successfully", async ({ page }) => {
  let requests = 0;
  await page.route("https://retry-flow.example/v1/images/generations", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC" }],
      }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://retry-flow.example/v1");
  await page.getByLabel("生图 API Key").fill("retry-flow-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("retry-flow-image");
  await closeSettings(page);

  await clickCanvasTool(page, "文本");
  await page.getByPlaceholder("写下提示词或说明…").fill("retryable image flow");
  await page.getByTitle("生图").click();

  const config = page.locator('[data-node-type="config"]');
  await expect(config).toHaveCount(1);
  await expect(config).toContainText("AI 503");
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(0);
  await config.locator("[data-node-header]").click();
  await config.getByTitle("运行生成").click();
  await expect.poll(() => requests).toBe(2);
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  await expect(config).not.toContainText("AI 503");
});

test("a configuration node generates the requested text batch", async ({ page }) => {
  let requests = 0;
  const textBodies: Array<Record<string, unknown>> = [];
  await page.route("https://batch.example/v1/images/generations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [{
          b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC",
        }],
      }),
    });
  });
  await page.route("https://batch.example/v1/responses", async (route) => {
    requests += 1;
    textBodies.push(JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ output_text: `batch result ${requests}` }),
    });
  });

  await installOwnerAuthRoutes(page);
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("文本 URL").fill("https://batch.example/v1");
  await page.getByLabel("文本 API Key").fill("batch-test-key");
  await page.getByLabel("文本模型", { exact: true }).fill("batch-text-model");
  await page.getByLabel("生图 URL").fill("https://batch.example/v1");
  await page.getByLabel("生图 API Key").fill("batch-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("batch-image-model");
  await page.getByLabel("默认数量").fill("1");
  await page.getByLabel("全局系统提示词").fill("Return one concise alternative.");
  await closeSettings(page);

  await clickCanvasTool(page, "文本");
  const source = page.locator('[data-node-type="text"]');
  await source.getByPlaceholder("写下提示词或说明…").fill("three alternatives");
  await source.getByTitle("生图").click();
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  const config = page.locator('[data-node-type="config"]');
  await expect(config).toHaveCount(1);
  await config.locator("[data-node-header]").click();
  await expect(config.getByTitle("运行生成")).toBeVisible();
  await config.getByLabel("模式").selectOption("text");
  await config.getByLabel("数量").fill("3");
  await config.getByTitle("运行生成").click();

  await expect.poll(() => requests).toBe(3);
  expect(textBodies).toHaveLength(3);
  expect(textBodies.every((body) => body.instructions === "Return one concise alternative.")).toBe(true);
  await expect(page.locator('[data-node-type="text"]')).toHaveCount(4);
  for (const index of [1, 2, 3]) {
    await expect(page.getByText(`batch result ${index}`, { exact: true })).toBeVisible();
  }
});

test("image workbench persists history and inserts a result into the canvas", async ({ page }) => {
  await page.route("https://workbench.example/v1/images/generations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC" }] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://workbench.example/v1");
  await page.getByLabel("生图 API Key").fill("workbench-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("workbench-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await expect(page.getByRole("heading", { name: "图片创作工作台" })).toBeVisible();
  await page.getByText("提示词", { exact: true }).locator("..").locator("textarea").fill("workbench square");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  const history = page.locator("article").filter({ hasText: "workbench square" });
  await expect(history).toHaveAttribute("data-generation-status", "succeeded");
  await page.reload();
  await expect(page.locator("article").filter({ hasText: "workbench square" })).toBeVisible();
  await page.getByRole("button", { name: "插入画布" }).click();
  await expect(page.getByRole("button", { name: "已插入" })).toBeVisible();
  await page.goto("/");
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);

  await page.goto("/workbench/image");
  const retainedHistory = page.locator("article").filter({ hasText: "workbench square" });
  await retainedHistory.getByTitle("删除").click();
  await expect(retainedHistory).toHaveCount(0);
  await page.goto("/");
  await page.reload();
  await expect(page.locator('[data-node-type="image"] img[alt="工作台图片"]')).toBeVisible();
});

test("image workbench switches layout, runs concurrent categories, and filters sized results", async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("https://concurrent-workbench.example/v1/images/generations", async (route) => {
    requests += 1;
    await gate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: pngPixelBase64 }] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://concurrent-workbench.example/v1");
  await page.getByLabel("生图 API Key").fill("concurrent-key");
  await page.getByLabel("生图模型", { exact: true }).fill("concurrent-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await page.getByRole("button", { name: "底部" }).click();
  await expect(page.locator('[data-workbench-layout="bottom"]')).toBeVisible();
  await page.getByRole("combobox", { name: "分类", exact: true }).fill("海报");
  await page.getByLabel("提示词").fill("concurrent poster");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await page.getByRole("combobox", { name: "分类", exact: true }).fill("角色");
  await page.getByLabel("提示词").fill("concurrent character");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole("button", { name: "生成", exact: true })).toContainText("2 个进行中");
  await expect(page.locator("article").filter({ hasText: "concurrent poster" })).toContainText("进行中");
  await expect(page.locator("article").filter({ hasText: "concurrent character" })).toContainText("进行中");
  release();
  const poster = page.locator("article").filter({ hasText: "concurrent poster" });
  const character = page.locator("article").filter({ hasText: "concurrent character" });
  await expect(poster).toContainText("成功");
  await expect(character).toContainText("成功");
  await expect(poster).toContainText(/\d+ B/);
  await page.getByLabel("生成历史分类").selectOption("海报");
  await expect(poster).toBeVisible();
  await expect(character).toHaveCount(0);
});

test("image workbench workflow entrance is draggable and keeps its position", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/workbench/image");
  const entry = page.getByTestId("draggable-workflow-entry");
  const before = await entry.boundingBox();
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x - 120, before!.y - 100, { steps: 4 });
  await page.mouse.up();
  const moved = await entry.boundingBox();
  expect(moved).not.toBeNull();
  expect(moved!.x).toBeLessThan(before!.x - 50);
  expect(page.url()).toContain("/workbench/image");
  await page.reload();
  const restored = await entry.boundingBox();
  expect(restored).not.toBeNull();
  expect(Math.abs(restored!.x - moved!.x)).toBeLessThan(2);
  await entry.click();
  await expect(page).toHaveURL(/\/workbench\/workflows$/);
});

test("image workbench reuses My Assets and shows reference thumbnails", async ({ page }) => {
  let editRequests = 0;
  await page.route("https://asset-reuse.example/v1/images/edits", async (route) => {
    editRequests += 1;
    expect(route.request().postData() ?? "").toContain("reuse asset reference");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: pngPixelBase64 }] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://asset-reuse.example/v1");
  await page.getByLabel("生图 API Key").fill("asset-reuse-key");
  await page.getByLabel("生图模型", { exact: true }).fill("asset-reuse-image");
  await closeSettings(page);
  const imageInput = page.getByRole("toolbar", { name: "画布工具栏" }).locator('input[type="file"][accept="image/*"]');
  await imageInput.setInputFiles({ name: "asset-source.png", mimeType: "image/png", buffer: Buffer.from(pngPixelBase64, "base64") });
  const imageNode = page.locator('[data-node-type="image"]').last();
  await expect(imageNode.locator("img")).toBeVisible();
  await imageNode.locator("[data-node-header]").click();
  await imageNode.getByTitle("加入素材").click();
  await expect(imageNode.getByTitle("已加入素材")).toBeVisible();
  await page.goto("/assets");
  await expect(page.locator("article")).toHaveCount(1);
  await page.goto("/workbench/image");
  const assetChoice = page.getByRole("group", { name: "从“我的素材”复用" }).getByRole("checkbox").first();
  await expect(assetChoice).toBeVisible();
  await assetChoice.check();
  await page.getByLabel("提示词").fill("reuse asset reference");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect.poll(() => editRequests).toBe(1);
  const history = page.locator("article").filter({ hasText: "reuse asset reference" });
  await expect(history).toContainText("成功");
  await expect(history.getByLabel("任务参考图").locator("img")).toHaveCount(1);
});

test("Agent sees one unified running generation task from the image workbench", async ({ page, request, context }) => {
  let requestStarted = false;
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  await page.route("https://activity.example/v1/images/generations", async (route) => {
    requestStarted = true;
    await providerGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: pngPixelBase64 }] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://activity.example/v1");
  await page.getByLabel("生图 API Key").fill("activity-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("activity-image");
  await closeSettings(page);
  await page.goto("/workbench/image");
  await page.getByLabel("提示词").fill("tracked workbench generation");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect.poll(() => requestStarted).toBe(true);

  await page.getByTitle("本地 Agent").click();
  await expect(page.getByRole("region", { name: "正在运行的生成任务" })).toContainText("tracked workbench generation");
  const response = await request.post(`${agentUrl}/api/runtime/command`, {
    headers: { Authorization: "Bearer e2e-token" },
    data: { method: "board.get_state", params: {}, timeoutMs: 10_000 },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const state = await response.json() as { generationTasks?: Array<Record<string, unknown>> };
  expect(state.generationTasks?.[0]).toMatchObject({
    kind: "image",
    status: "running",
    surface: "image-workbench",
    prompt: "tracked workbench generation",
  });
  const taskId = String(state.generationTasks?.[0]?.id);
  const statusResponse = await request.post(`${agentUrl}/api/runtime/command`, {
    headers: { Authorization: "Bearer e2e-token" },
    data: {
      method: "generation_get_status",
      params: { taskId },
      timeoutMs: 10_000,
    },
  });
  expect(statusResponse.ok(), await statusResponse.text()).toBe(true);
  expect(await statusResponse.json()).toMatchObject({
    task: { status: "running", surface: "image-workbench" },
  });

  const second = await context.newPage();
  await second.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  await openFreshBoard(second);
  await second.goto("/prompts");
  await second.bringToFront();
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await second.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => {
    const active = await request.post(`${agentUrl}/api/runtime/command`, {
      headers: { Authorization: "Bearer e2e-token" },
      data: { method: "board.get_state", params: {}, timeoutMs: 10_000 },
    });
    return (await active.json() as { route?: string }).route;
  }).toBe("/prompts");
  const denied = await request.post(`${agentUrl}/api/runtime/command`, {
    headers: { Authorization: "Bearer e2e-token" },
    data: { method: "generation_get_status", params: { taskId }, timeoutMs: 10_000 },
  });
  expect(await denied.json()).toEqual({ task: { id: taskId, status: "not_found" } });
  await second.close();
  await page.bringToFront();
  await expect.poll(async () => {
    const fallback = await request.post(`${agentUrl}/api/runtime/command`, {
      headers: { Authorization: "Bearer e2e-token" },
      data: { method: "generation_get_status", params: { taskId }, timeoutMs: 10_000 },
    });
    if (!fallback.ok()) return undefined;
    return (await fallback.json() as { task?: { status?: string } }).task?.status;
  }).toBe("running");

  releaseProvider();
  await expect(page.getByRole("region", { name: "正在运行的生成任务" })).toHaveCount(0);
  await expect(page.locator("article").filter({ hasText: "tracked workbench generation" }))
    .toHaveAttribute("data-generation-status", "succeeded");
  const completed = await request.post(`${agentUrl}/api/runtime/command`, {
    headers: { Authorization: "Bearer e2e-token" },
    data: { method: "generation_get_status", params: { taskId }, timeoutMs: 10_000 },
  });
  expect(await completed.json()).toMatchObject({ task: { id: taskId, status: "succeeded" } });

  await page.reload();
  await expect(page.getByRole("heading", { name: "图片创作工作台" })).toBeVisible();
  await expect.poll(async () => {
    const afterReload = await request.post(`${agentUrl}/api/runtime/command`, {
      headers: { Authorization: "Bearer e2e-token" },
      data: { method: "generation_get_status", params: { taskId }, timeoutMs: 10_000 },
    });
    if (!afterReload.ok()) return undefined;
    return (await afterReload.json() as { task?: { status?: string } }).task?.status;
  }).toBe("succeeded");
});

test("image workbench records cancellation and retries the cancelled job", async ({ page }) => {
  let requests = 0;
  await page.route("https://cancel.example/v1/images/generations", async (route) => {
    requests += 1;
    if (requests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC" }] }),
    }).catch(() => undefined);
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://cancel.example/v1");
  await page.getByLabel("生图 API Key").fill("cancel-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("cancel-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await page.getByLabel("提示词").fill("cancel then retry");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.getByTitle("停止")).toBeEnabled();
  await page.getByTitle("停止").click();

  const cancelled = page.locator("article").filter({ hasText: "cancel then retry" });
  await expect(cancelled).toHaveAttribute("data-generation-status", "cancelled");
  await cancelled.getByTitle("重试").click();
  await expect.poll(() => requests).toBe(2);
  const jobs = page.locator("article").filter({ hasText: "cancel then retry" });
  await expect(page.locator('article[data-generation-status="succeeded"]').filter({ hasText: "cancel then retry" })).toHaveCount(1);
});

test("image workbench refuses retry when a recorded reference is missing", async ({ page }) => {
  let requests = 0;
  await page.route("https://missing-reference.example/v1/images/generations", async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://missing-reference.example/v1");
  await page.getByLabel("生图 API Key").fill("missing-reference-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("missing-reference-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await page.evaluate(() => new Promise<{ projectId: string; providerId: string }>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("app_state", "readonly");
      const store = transaction.objectStore("app_state");
      const projectsRequest = store.get("openboard:projects");
      const configRequest = store.get("openboard:config");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        const projectId = Array.isArray(projectsRequest.result) ? projectsRequest.result[0]?.id : undefined;
        const providerId = configRequest.result?.activeChannelId;
        database.close();
        if (typeof projectId === "string" && typeof providerId === "string") resolve({ projectId, providerId });
        else reject(new Error("active test project or provider is missing"));
      };
    };
  }).then(({ projectId, providerId }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("openboard-generation-jobs");
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => open.result.createObjectStore("jobs");
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("jobs", "readwrite");
      transaction.objectStore("jobs").put({
        id: "job-missing-reference",
        projectId,
        kind: "image",
        status: "failed",
        prompt: "missing reference retry",
        providerId,
        model: "missing-reference-image",
        parameters: { referenceStorageKeys: ["image:does-not-exist"] },
        result: {},
        error: "previous failure",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      }, "job-missing-reference");
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  })));
  await page.reload();

  const history = page.locator("article").filter({ hasText: "missing reference retry" });
  await history.getByTitle("重试").click();
  await expect(page.getByRole("alert")).toContainText("参考图已丢失或无法恢复");
  expect(requests).toBe(0);
  await expect(page.locator("article").filter({ hasText: "missing reference retry" })).toHaveCount(1);
});

test("workbench history bulk delete removes only selected cards", async ({ page }) => {
  let imageRequests = 0;
  await page.route("https://workbench-bulk.example/v1/images/generations", async (route) => {
    imageRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC" }],
      }),
    });
  });

  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://workbench-bulk.example/v1");
  await page.getByLabel("生图 API Key").fill("workbench-bulk-key");
  await page.getByLabel("生图模型", { exact: true }).fill("bulk-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await page.getByLabel("提示词").fill("bulk delete keep me");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: "bulk delete keep me" })).toHaveAttribute("data-generation-status", "succeeded");

  await page.getByLabel("提示词").fill("bulk delete remove me");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: "bulk delete remove me" })).toHaveAttribute("data-generation-status", "succeeded");
  expect(imageRequests).toBeGreaterThanOrEqual(2);

  await page.getByRole("checkbox", { name: "选择历史 bulk delete remove me" }).check();
  await page.getByRole("button", { name: "批量删除" }).click();
  await expect(page.locator("article").filter({ hasText: "bulk delete remove me" })).toHaveCount(0);
  await expect(page.locator("article").filter({ hasText: "bulk delete keep me" })).toHaveCount(1);
});

test("Kling v3 custom shots expose dedicated controls and allow shot-only generation", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("视频协议").selectOption("apimart");
  await page.getByLabel("视频 URL").fill("https://api.apimart.example/v1");
  await page.getByLabel("视频 API Key").fill("apimart-e2e-key");
  await page.getByLabel("视频模型", { exact: true }).fill("kling-v3");
  await closeSettings(page);

  await page.goto("/workbench/video");
  const controls = page.getByRole("group", { name: "Kling 专属参数" });
  await expect(controls).toBeVisible();
  await expect(controls.getByLabel("生成模式").locator('option[value="4k"]')).toHaveCount(1);
  await controls.getByLabel("多镜头").check();
  await controls.getByLabel("镜头拆分方式").selectOption("customize");
  await controls.getByRole("button", { name: "添加镜头" }).click();
  await controls.getByPlaceholder("镜头 1 提示词").fill("wide establishing shot");
  await controls.getByLabel("镜头 1 秒数").fill("5");

  const generate = page.getByRole("button", { name: "生成", exact: true });
  await expect(page.getByLabel("提示词", { exact: true })).toHaveValue("");
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByRole("alert")).toContainText(/apimart|server|服务端|后端/i);

  await page.getByLabel("模型").fill("kling-v2-6");
  await expect(controls.getByLabel("多镜头")).toHaveCount(0);
  await expect(controls.getByLabel("生成模式").locator('option[value="4k"]')).toHaveCount(0);
});

test("video workbench persists Ark audio and watermark settings across retry", async ({ page }) => {
  const requestBodies: Array<Record<string, unknown>> = [];
  await page.route("https://workbench-video.example/api/plan/v3/contents/generations/tasks", async (route) => {
    requestBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: `video-${requestBodies.length}`,
        status: "succeeded",
        content: { video_url: "https://cdn.example/workbench.mp4" },
      }),
    });
  });
  await page.route("https://cdn.example/workbench.mp4", async (route) => {
    await route.fulfill({ contentType: "video/mp4", body: "video-bytes" });
  });

  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("视频协议").selectOption("ark");
  await page.getByLabel("视频 URL").fill("https://workbench-video.example/api/plan/v3");
  await page.getByLabel("视频 API Key").fill("workbench-video-key");
  await page.getByLabel("视频模型", { exact: true }).fill("doubao-seedance-2.0");
  await closeSettings(page);

  await page.goto("/workbench/video");
  await page.getByLabel("提示词").fill("orbiting product shot");
  await page.getByLabel("生成声音").check();
  await page.getByLabel("水印").check();
  await page.getByRole("button", { name: "生成", exact: true }).click();

  const history = page.locator("article").filter({ hasText: "orbiting product shot" });
  await expect(history).toHaveAttribute("data-generation-status", "succeeded");
  expect(requestBodies).toHaveLength(1);
  expect(requestBodies[0]?.generate_audio).toBe(true);
  expect(requestBodies[0]?.watermark).toBe(true);

  await page.reload();
  const reloaded = page.locator("article").filter({ hasText: "orbiting product shot" });
  await reloaded.getByTitle("重试").click();
  await expect.poll(() => requestBodies).toHaveLength(2);
  expect(requestBodies[1]?.generate_audio).toBe(true);
  expect(requestBodies[1]?.watermark).toBe(true);
});

test("video workbench first/last frame mode maps ordered image roles and survives retry", async ({ page }) => {
  const requestBodies: Array<Record<string, unknown>> = [];
  await page.route("https://workbench-frames.example/api/plan/v3/contents/generations/tasks", async (route) => {
    requestBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: `frame-${requestBodies.length}`,
        status: "succeeded",
        content: { video_url: "https://cdn.example/frames.mp4" },
      }),
    });
  });
  await page.route("https://cdn.example/frames.mp4", async (route) => {
    await route.fulfill({ contentType: "video/mp4", body: "frame-video-bytes" });
  });

  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("视频协议").selectOption("ark");
  await page.getByLabel("视频 URL").fill("https://workbench-frames.example/api/plan/v3");
  await page.getByLabel("视频 API Key").fill("workbench-frame-key");
  await page.getByLabel("视频模型", { exact: true }).fill("doubao-seedance-2.0");
  await closeSettings(page);

  await page.goto("/workbench/video");
  await page.getByLabel("提示词").fill("first to last product turn");
  await page.getByLabel("图片参考模式").selectOption("first-last");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator('input[type="file"][accept="image/*,video/*,audio/*"]').setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: png },
    { name: "last.png", mimeType: "image/png", buffer: png },
  ]);
  await page.getByRole("button", { name: "生成", exact: true }).click();

  const history = page.locator("article").filter({ hasText: "first to last product turn" });
  await expect(history).toHaveAttribute("data-generation-status", "succeeded");
  expect(requestBodies).toHaveLength(1);
  const content = (requestBodies[0]?.content as Array<Record<string, unknown>>) ?? [];
  expect(content[0]).toMatchObject({ type: "text", text: "first to last product turn" });
  expect(content.slice(1).map((item) => item.role)).toEqual(["first_frame", "last_frame"]);

  await page.reload();
  const reloaded = page.locator("article").filter({ hasText: "first to last product turn" });
  await reloaded.getByTitle("重试").click();
  await expect.poll(() => requestBodies).toHaveLength(2);
  const retryContent = (requestBodies[1]?.content as Array<Record<string, unknown>>) ?? [];
  expect(retryContent.slice(1).map((item) => item.role)).toEqual(["first_frame", "last_frame"]);
});

test("image split supports draggable guides and persists normalized lineage", async ({ page }) => {
  await openFreshBoard(page);
  const imageInput = page.locator('input[type="file"][accept="image/*"]').first();
  await imageInput.setInputFiles({
    name: "split.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await page.getByTitle("切分").click();
  const vertical = page.getByRole("button", { name: "纵向分割线 1" });
  const box = await vertical.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "新增横线" }).click();
  await page.getByRole("button", { name: "删除选中线" }).click();
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await page.getByRole("button", { name: "应用" }).click();
  await expect.poll(() => page.evaluate(
    () => new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open("openboard-app");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction("app_state", "readonly").objectStore("app_state").get("openboard:projects");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const projects = Array.isArray(request.result) ? request.result : [];
          resolve(projects.some((project) => project?.nodes?.some((node: { metadata?: { transformOperation?: string; splitVertical?: number[]; splitHorizontal?: number[] } }) =>
            node.metadata?.transformOperation === "split" && node.metadata.splitVertical?.[0] === 0.5 && node.metadata.splitHorizontal?.[0] === 0.5,
          )));
          database.close();
        };
      };
    }),
  )).toBe(true);
});

test("a sandboxed plugin node persists its state across reloads", async ({ page }) => {
  await openFreshBoard(page);
  await page.locator('nav a[href="/plugins"]').click();

  const stickyCard = page.locator("article").filter({ hasText: "openboard.sticky-note" });
  await stickyCard.getByRole("button", { name: "添加到画布" }).click();
  await expect(page).toHaveURL("/");

  const note = page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容");
  await expect(note).toBeVisible();
  await note.fill("plugin state from Playwright");
  // Sticky note patches via openboard.patch; wait for host-roundtrip + persist.
  await expect
    .poll(async () => page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容").inputValue(), {
      timeout: 15_000,
    })
    .toBe("plugin state from Playwright");
  await page.waitForTimeout(400);

  await page.reload();
  await expect(
    page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容"),
  ).toHaveValue("plugin state from Playwright", { timeout: 15_000 });

  await page.goto("/plugins");
  const enabled = page.getByRole("switch", { name: "便签 启用状态" });
  await enabled.uncheck();
  await expect(enabled).toBeEnabled({ timeout: 15_000 });
  await expect(stickyCard.getByRole("button", { name: "添加到画布" })).toBeDisabled();
  await page.goto("/");
  await expect(page.getByTestId("plugin-unavailable")).toBeVisible({ timeout: 15_000 });
  await expect(page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容")).toHaveCount(0);

  await page.goto("/plugins");
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  // Product sets busy while flushConfig runs; wait until the switch is interactive again.
  await expect(enabled).toBeEnabled({ timeout: 15_000 });
  await expect(enabled).toBeChecked();
  await page.goto("/");
  await expect(page.getByTestId("plugin-unavailable")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容"))
    .toHaveValue("plugin state from Playwright", { timeout: 15_000 });
});

test("plugin registry install, upgrade, and uninstall preserve permission consent", async ({ page }) => {
  let registryVersion = "1.0.0";
  await page.route("https://registry.example/openboard.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        plugins: [{
          id: "example.registry-note",
          name: "Registry Note",
          version: registryVersion,
          description: "Registry test plugin",
          manifestUrl: "https://plugins.example/registry-note.json",
        }],
      }),
    });
  });
  await page.route("https://plugins.example/registry-note.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "example.registry-note",
        name: "Registry Note",
        version: registryVersion,
        description: "Registry test plugin",
        document: "<script>openboard.ready()</script>",
        permissions: ["node:read", "ai:text"],
        defaultSize: { width: 320, height: 220 },
      }),
    });
  });
  await openFreshBoard(page);
  await page.goto("/plugins");
  await page.getByLabel("OpenBoard 插件注册表 URL").fill("https://registry.example/openboard.json");
  await page.getByRole("button", { name: "刷新注册表" }).click();
  const registryCard = page.locator("article").filter({ hasText: "example.registry-note" });
  await registryCard.getByRole("button", { name: "安装" }).click();
  const dialog = page.getByRole("dialog", { name: /安装 Registry Note/ });
  const confirm = dialog.getByRole("button", { name: "同意并安装" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("node:read").check();
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("ai:text").check();
  await confirm.click();
  const installedCard = page.locator("article").filter({ hasText: "example.registry-note" });
  await expect(installedCard).toContainText("v1.0.0");

  registryVersion = "1.1.0";
  await page.getByRole("button", { name: "刷新注册表" }).click();
  await installedCard.getByRole("button", { name: "升级到 v1.1.0" }).click();
  const upgradeDialog = page.getByRole("dialog", { name: /安装 Registry Note/ });
  await expect(upgradeDialog.getByLabel("node:read")).toBeChecked();
  await expect(upgradeDialog.getByLabel("ai:text")).toBeChecked();
  await upgradeDialog.getByRole("button", { name: "同意并安装" }).click();
  await expect(installedCard).toContainText("v1.1.0");

  page.once("dialog", (confirmation) => confirmation.accept());
  await installedCard.getByTitle("卸载插件").click();
  const registryCardAfterRemoval = page.locator("article").filter({ hasText: "example.registry-note" });
  await expect(registryCardAfterRemoval).toContainText("注册表");
  await expect(registryCardAfterRemoval.getByRole("button", { name: "安装" })).toBeVisible();
});

test("SVG plugin edits and previews isolated markup", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/plugins");
  const card = page.locator("article").filter({ hasText: "openboard.svg-studio" });
  await card.getByRole("button", { name: "添加到画布" }).click();
  const frame = page.frameLocator('iframe[title="SVG 工作室 插件"]');
  await frame.getByLabel("SVG 源码").fill('<svg xmlns="http://www.w3.org/2000/svg"><rect width="80" height="60" fill="#0f766e"/></svg>');
  await expect(frame.getByLabel("SVG 预览").locator("rect")).toHaveAttribute("fill", "#0f766e");
});

test("Three.js panorama renders nonblank pixels on desktop and mobile", async ({ page }, testInfo) => {
  await openFreshBoard(page);
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "panorama-source.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(page.locator('img[alt="图片"]')).toBeVisible();
  await page.locator('nav a[href="/plugins"]').click();
  const card = page.locator("article").filter({ hasText: "openboard.panorama" });
  await card.getByRole("button", { name: "添加到画布" }).click();
  const canvas = page.locator('canvas[data-panorama-canvas="true"]');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("选择全景图片").selectOption({ label: "画布 · 图片" });
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly").objectStore("app_state").get("openboard:projects");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const projects = Array.isArray(request.result) ? request.result : [];
        resolve(projects.some((project) => project?.nodes?.some((node: { metadata?: { pluginId?: string; pluginState?: { storageKey?: string } } }) =>
          node.metadata?.pluginId === "openboard.panorama" && Boolean(node.metadata.pluginState?.storageKey))));
        database.close();
      };
    };
  }))).toBe(true);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (element.width < 2 || element.height < 2) return 0;
    if (element.dataset.panoramaRenderer === "2d") {
      const context = element.getContext("2d");
      if (!context) return 0;
      return context.getImageData(
        Math.max(0, Math.floor(element.width / 2) - 1),
        Math.max(0, Math.floor(element.height / 2) - 1),
        3,
        3,
      ).data.reduce((sum, value) => sum + value, 0);
    }
    const context = element.getContext("webgl2") ?? element.getContext("webgl");
    if (!context) return 0;
    const pixels = new Uint8Array(4 * 9);
    context.readPixels(
      Math.max(0, Math.floor(element.width / 2) - 1),
      Math.max(0, Math.floor(element.height / 2) - 1),
      3,
      3,
      context.RGBA,
      context.UNSIGNED_BYTE,
      pixels,
    );
    return pixels.reduce((sum, value) => sum + value, 0);
  })).toBeGreaterThan(0);
  await page.locator('div[aria-label="3D 全景视图"]').screenshot({
    path: testInfo.outputPath(`panorama-${testInfo.project.name}.png`),
  });
});

test("panorama falls back to an interactive 2D canvas without WebGL", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one browser is sufficient for the forced no-WebGL path");
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return Reflect.apply(original, this, [type, ...args]);
      },
    });
  });
  await openFreshBoard(page);
  await page.goto("/plugins");
  await page.locator("article").filter({ hasText: "openboard.panorama" })
    .getByRole("button", { name: "添加到画布" }).click();
  const canvas = page.locator('canvas[data-panorama-renderer="2d"]');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    if (!context || element.width < 2 || element.height < 2) return 0;
    return context.getImageData(0, 0, 2, 2).data.reduce((sum, value) => sum + value, 0);
  })).toBeGreaterThan(0);
});

test("double-clicking an image opens and closes the full preview", async ({ page }) => {
  await openFreshBoard(page);
  const imageInput = page.locator('input[type="file"][accept="image/*"]').first();
  await imageInput.setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC",
      "base64",
    ),
  });

  const canvasImage = page.locator('img[alt="图片"]').first();
  await expect(canvasImage).toBeVisible();
  await canvasImage.dblclick();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "图片预览" })).toHaveCount(0);
});

test("image nodes support replacement, resize mode, download, crop, and asset reuse", async ({ page, browserName }) => {
  await openFreshBoard(page);
  const imageInput = page.locator('input[type="file"][accept="image/*"]').first();
  await imageInput.setInputFiles({
    name: "source.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngReplacementBase64, "base64"),
  });
  const node = page.locator('[data-node-type="image"]').first();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  const initialSrc = await node.locator("img").getAttribute("src");

  await node.getByTitle("自由缩放").click();
  await expect(node.getByTitle("锁定比例")).toBeVisible();
  await node.getByTitle("锁定比例").click();
  await expect(node.getByTitle("自由缩放")).toBeVisible();

  if (browserName === "webkit") {
    await node.getByTitle("下载").click();
    await expect(page).toHaveURL(/\/$/);
  } else {
    const downloadPromise = page.waitForEvent("download");
    await node.getByTitle("下载").click();
    expect((await downloadPromise).suggestedFilename()).toBe("图片.png");
  }

  await node.getByTitle("加入素材").click();
  await expect(node.getByTitle("已加入素材")).toBeVisible();
  await node.getByText("替换图片", { exact: true }).locator('input[type="file"]').setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngPixelBase64, "base64"),
  });
  await expect.poll(() => node.locator("img").getAttribute("src")).not.toBe(initialSrc);

  await node.getByTitle("多角度").click();
  await expect(page.getByRole("heading", { name: "多角度变换" })).toBeVisible();
  await page.getByRole("button", { name: "30°", exact: true }).click();
  await page.getByRole("button", { name: "生成变换节点" }).click();
  await expect(page.getByRole("heading", { name: "多角度变换" })).toHaveCount(0);
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(2);

  await node.getByTitle("裁剪").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "裁剪图片" })).toBeVisible();
  await expect(page.getByText("X (0-4)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成裁剪节点" }).click();
  await expect(page.getByRole("heading", { name: "裁剪图片" })).toHaveCount(0);
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(3);

  await page.locator('nav a[href="/assets"]').click();
  const asset = page.locator("article").filter({ hasText: "图片" });
  await expect(asset).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly")
        .objectStore("app_state")
        .get("openboard:assets");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(Array.isArray(request.result) ? request.result.length : 0);
        database.close();
      };
    };
  }))).toBe(1);
  await page.reload();
  await expect(asset).toBeVisible();
  await asset.getByRole("button", { name: "插入画布" }).click();
  await page.locator('nav a[href="/"]').click();
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(4);
});

test("local video and audio nodes persist, render native players, and download", async ({ page, browserName }) => {
  await openFreshBoard(page);
  await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
    name: "local-video.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("openboard-video-fixture"),
  });
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: "local-audio.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("openboard-audio-fixture"),
  });
  await page.getByTitle("适应").click();

  const videoNode = page.locator('[data-node-type="video"]');
  const audioNode = page.locator('[data-node-type="audio"]');
  await expect(videoNode.locator("video[controls]")).toHaveCount(1);
  await expect(audioNode.locator("audio[controls]")).toHaveCount(1);
  await expect(audioNode).toContainText("audio/mpeg");

  await videoNode.locator("[data-node-header]").click();
  if (browserName === "webkit") {
    await videoNode.getByTitle("下载").click();
    await expect(page).toHaveURL(/\/$/);
  } else {
    const videoDownload = page.waitForEvent("download");
    await videoNode.getByTitle("下载").click();
    expect((await videoDownload).suggestedFilename()).toBe("视频.mp4");
  }
  await audioNode.locator("[data-node-header]").click();
  if (browserName === "webkit") {
    await audioNode.getByTitle("下载").click();
    await expect(page).toHaveURL(/\/$/);
  } else {
    const audioDownload = page.waitForEvent("download");
    await audioNode.getByTitle("下载").click();
    expect((await audioDownload).suggestedFilename()).toBe("音频.mp3");
  }

  const videoSrc = await videoNode.locator("video").getAttribute("src");
  const audioSrc = await audioNode.locator("audio").getAttribute("src");
  await page.reload();
  const reloadedVideo = page.locator('[data-node-type="video"] video[controls]');
  const reloadedAudio = page.locator('[data-node-type="audio"] audio[controls]');
  await expect(reloadedVideo).toHaveAttribute("src", /^(blob:|data:video\/)/);
  await expect(reloadedAudio).toHaveAttribute("src", /^(blob:|data:audio\/)/);
  expect(videoSrc).toMatch(/^(blob:|data:video\/)/);
  expect(audioSrc).toMatch(/^(blob:|data:audio\/)/);
  await expect(page.locator('[data-node-type="audio"]')).toContainText("audio/mpeg");
});

test("image reverse prompt creates a connected text node", async ({ page }) => {
  await page.route("https://vision.example/v1/responses", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ output_text: "studio light, red square" }) });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("文本 URL").fill("https://vision.example/v1");
  await page.getByLabel("文本 API Key").fill("vision-test-key");
  await page.getByLabel("文本模型", { exact: true }).fill("vision-model");
  await closeSettings(page);
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "vision.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await page.getByTitle("反推提示词").click();
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("studio light, red square");
});

test("an image node can create a connected video with itself as reference", async ({ page }) => {
  let requestBody: Record<string, unknown> | null = null;
  await page.route("https://video.example/v1/videos", async (route) => {
    requestBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "video-direct",
        status: "completed",
        url: "https://cdn.example/result.mp4",
      }),
    });
  });
  await page.route("https://cdn.example/result.mp4", async (route) => {
    await route.fulfill({ contentType: "video/mp4", body: "video-bytes" });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("视频 URL").fill("https://video.example/v1");
  await page.getByLabel("视频 API Key").fill("video-test-key");
  await page.getByLabel("视频模型", { exact: true }).fill("video-model");
  await closeSettings(page);
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  page.once("dialog", async (dialog) => dialog.accept("animate this reference"));
  await page.getByTitle("生成视频").click();

  await expect.poll(() => requestBody).toMatchObject({
    model: "video-model",
    prompt: "animate this reference",
  });
  expect(String(requestBody?.input_reference)).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('[data-node-type="video"]')).toHaveCount(1);
});

test("node prompt media chips preserve and submit connected image references", async ({ page }) => {
  const requestBodies: Array<Record<string, unknown>> = [];
  await page.route("https://chips.example/v1/videos", async (route) => {
    requestBodies.push(JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: `video-chip-${requestBodies.length}`,
        status: "completed",
        url: `https://cdn.example/chip-${requestBodies.length}.mp4`,
      }),
    });
  });
  await page.route(/https:\/\/cdn\.example\/chip-\d+\.mp4/, async (route) => {
    await route.fulfill({ contentType: "video/mp4", body: "video-bytes" });
  });

  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("视频 URL").fill("https://chips.example/v1");
  await page.getByLabel("视频 API Key").fill("chip-test-key");
  await page.getByLabel("视频模型", { exact: true }).fill("chip-video-model");
  await closeSettings(page);
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "chip-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  page.once("dialog", async (dialog) => dialog.accept("create the first clip"));
  await page.getByTitle("生成视频").click();
  await expect.poll(() => requestBodies).toHaveLength(1);

  await page.getByTitle("适应").click();
  const videoNode = page.locator('[data-node-type="video"]');
  await expect(videoNode).toHaveCount(1);
  await videoNode.locator("[data-node-header]").click();
  const editor = page.getByRole("textbox", { name: "节点生成提示词" });
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.type("@");
  const referenceOption = page.getByRole("option", { name: "图片1 图片" });
  await expect(referenceOption).toBeVisible();
  await referenceOption.click();
  const chip = editor.locator('[data-prompt-reference]');
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('img[alt="图片1"]')).toBeVisible();

  await editor.press("Backspace");
  await expect(chip).toHaveCount(0);
  await editor.fill("");
  await editor.type("@");
  await page.getByRole("option", { name: "图片1 图片" }).click();
  await editor.type(" slow orbit");
  await editor.press("Control+Enter");

  await expect.poll(() => requestBodies).toHaveLength(2);
  expect(requestBodies[1]?.prompt).toContain("图片1 slow orbit");
  expect(String(requestBodies[1]?.input_reference)).toMatch(/^data:image\/png;base64,/);
});

test("image toolbar preferences persist ordering, visibility, and labels", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByLabel("显示工具名称").check();
  await settings.getByLabel("显示裁剪").uncheck();
  await settings.getByRole("button", { name: "下移下载（必显）" }).click();
  await closeSettings(page);

  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "toolbar-preferences.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngPixelBase64, "base64"),
  });
  const node = page.locator('[data-node-type="image"]').first();
  await expect(node.getByTitle("裁剪")).toHaveCount(0);
  await expect(node.getByTitle("下载")).toContainText("下载");
  const actionTitles = await node.locator("button[title]").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("title")),
  );
  expect(actionTitles.indexOf("下载")).toBeGreaterThan(actionTitles.indexOf("自由缩放"));

  await page.reload();
  const reloaded = page.locator('[data-node-type="image"]').first();
  await expect(reloaded).toBeVisible();
  await reloaded.locator("[data-node-header]").click();
  await expect(reloaded.getByTitle("裁剪")).toHaveCount(0);
  await expect(reloaded.getByTitle("下载")).toContainText("下载");
  const reloadedTitles = await reloaded.locator("button[title]").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("title")),
  );
  expect(reloadedTitles.indexOf("下载")).toBeGreaterThan(reloadedTitles.indexOf("自由缩放"));
});

test("local image resize creates a lineage-tracked derived node", async ({ page }) => {
  await openFreshBoard(page);
  await importSingleImageProject(page, "resize-lineage");

  await page.getByTitle("本地尺寸放大").click();
  await expect(page.getByText("浏览器 Canvas 插值，不调用云端模型。")).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "本地尺寸放大" });
  await dialog.getByRole("button", { name: "应用" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  const output = page.locator('img[alt="图片 · 本地放大 2x"]');
  await expect(output).toHaveCount(1);
  await expect.poll(() => output.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ width: 8, height: 8 });

  const readLineage = () => page.evaluate(
    () => new Promise<Record<string, unknown> | null>((resolve, reject) => {
      const open = indexedDB.open("openboard-app");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction("app_state", "readonly")
          .objectStore("app_state")
          .get("openboard:projects");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const projects = Array.isArray(request.result) ? request.result : [];
          const derived = projects.flatMap((project) => project?.nodes ?? [])
            .find((node) => node?.metadata?.transformOperation === "resize");
          database.close();
          resolve(derived?.metadata ?? null);
        };
      };
    }),
  );
  await expect.poll(readLineage).toMatchObject({
    transformOperation: "resize",
    transformProvider: "local-canvas",
    transformModel: "browser-bicubic",
    transformParameters: { scale: 2 },
  });
  const lineage = await readLineage();
  expect(lineage?.derivedFromId).toBeTruthy();
});

test("AI upscale stays distinct from local resize and records cloud lineage", async ({ page }) => {
  let upscaleRequests = 0;
  await page.route("https://upscale.example/v1/images/upscales", async (route) => {
    upscaleRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "upscale-e2e", data: [{ b64_json: pngPixelBase64 }] }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://upscale.example/v1");
  await page.getByLabel("生图 API Key").fill("upscale-test-key");
  await page.getByLabel("生图模型", { exact: true }).fill("upscale-model");
  await closeSettings(page);
  const node = await importSingleImageProject(page, "ai-upscale-lineage");
  await expect(node.getByTitle("本地尺寸放大")).toBeEnabled();
  await expect(node.getByTitle("AI 超分")).toBeEnabled();
  await node.getByTitle("AI 超分").click();
  const dialog = page.getByRole("dialog", { name: "AI 超分" });
  await expect(dialog.getByText("调用当前 AI 渠道的专用超分接口；不会静默回退到图像编辑。")).toBeVisible();
  await dialog.getByRole("button", { name: "应用" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => upscaleRequests).toBe(1);
  await expect(page.locator('img[alt="图片 · AI 超分 2x"]')).toHaveCount(1);

  const lineage = () => page.evaluate(() => new Promise<Record<string, unknown> | null>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly")
        .objectStore("app_state").get("openboard:projects");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const projects = Array.isArray(request.result) ? request.result : [];
        const derived = projects.flatMap((project) => project?.nodes ?? [])
          .find((item) => item?.metadata?.transformOperation === "ai-upscale");
        database.close();
        resolve(derived?.metadata ?? null);
      };
    };
  }));
  await expect.poll(lineage).toMatchObject({
    transformOperation: "ai-upscale",
    transformProvider: "openai-compatible",
    transformModel: "upscale-model",
    transformParameters: { scale: 2 },
  });
});

test("prompt details can insert their content into the active canvas", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/prompts");
  await page.getByRole("button", { name: "恢复内置", exact: true }).click();
  const promptCard = page.locator("article").filter({ hasText: "产品棚拍" });
  await expect(promptCard).toBeVisible({ timeout: 15_000 });
  const detailButton = promptCard.getByRole("button", { name: "详情" });
  await expect(detailButton).toBeVisible();
  await detailButton.focus();
  await detailButton.press("Enter");

  const dialog = page.getByRole("dialog", { name: "产品棚拍" });
  await expect(dialog).toContainText("Studio product photo");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          sessionStorage.setItem("openboard:e2e-prompt-copy", value);
          return Promise.resolve();
        },
      },
    });
  });
  await dialog.getByRole("button", { name: "复制提示词" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("openboard:e2e-prompt-copy")))
    .toContain("Studio product photo");
  await dialog.getByRole("button", { name: "加入素材" }).click();
  await dialog.getByRole("button", { name: "插入当前画布文本节点" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue(
    /Studio product photo/,
  );
  await page.locator('nav a[href="/assets"]').click();
  await expect(page.locator("article").filter({ hasText: "产品棚拍" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly")
        .objectStore("app_state")
        .get("openboard:assets");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(Array.isArray(request.result) ? request.result.length : 0);
        database.close();
      };
    };
  }))).toBe(1);
  await page.reload();
  await expect(page.locator("article").filter({ hasText: "产品棚拍" })).toBeVisible();
});

test("local prompts support create, reload, edit, direct canvas use, and delete", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/prompts");
  await page.getByRole("button", { name: "新建提示词" }).click();

  let editor = page.getByRole("dialog", { name: "新建提示词" });
  await editor.getByLabel("标题").fill("本地商品主图");
  await editor.getByLabel("提示词内容").fill("Clean product hero image on a vivid red background");
  await editor.getByLabel("标签").fill("商品, 红色, 主图");
  await editor.getByRole("button", { name: "保存提示词" }).click();

  let card = page.locator("article").filter({ hasText: "本地商品主图" });
  await expect(card).toContainText("Clean product hero image");
  await page.getByRole("button", { name: "恢复内置", exact: true }).click();
  await expect(card).toBeVisible();
  await expect(page.locator("article").filter({ hasText: "产品棚拍" })).toBeVisible();
  await page.reload();
  card = page.locator("article").filter({ hasText: "本地商品主图" });
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "编辑" }).click();
  editor = page.getByRole("dialog", { name: "编辑提示词" });
  await editor.getByLabel("提示词内容").fill("Updated local product prompt");
  await editor.getByRole("button", { name: "保存提示词" }).click();
  await expect(card).toContainText("Updated local product prompt");

  await card.getByRole("button", { name: "插入画布" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("Updated local product prompt");

  await page.goto("/prompts");
  card = page.locator("article").filter({ hasText: "本地商品主图" });
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "删除" }).click();
  await expect(page.locator("article").filter({ hasText: "本地商品主图" })).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator("article").filter({ hasText: "本地商品主图" })).toHaveCount(0, { timeout: 10_000 });
});

test("prompt library filters tags and manages multiple persisted remote sources", async ({ page }) => {
  const sources = ["https://prompts-one.example/catalog.json", "https://prompts-two.example/catalog.json"];
  await page.route(sources[0], async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{ title: "Remote Product", prompt: "product prompt", tags: ["product"] }]),
  }));
  await page.route(sources[1], async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      title: "Remote Portrait",
      prompt: "portrait prompt",
      tags: ["portrait"],
      images: ["https://cdn.example/portrait.png"],
    }]),
  }));
  await openFreshBoard(page);
  await page.goto("/prompts");
  const sourceInput = page.getByPlaceholder("远程源 URL（raw JSON / Markdown）");
  for (const source of sources) {
    await sourceInput.fill(source);
    await page.getByRole("button", { name: "拉取远程提示词" }).click();
  }

  await page.getByLabel("提示词标签").selectOption("portrait");
  await expect(page.getByText("Remote Portrait", { exact: true })).toBeVisible();
  await expect(page.getByText("Remote Product", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "详情" }).click();
  await expect(page.getByAltText("结果图 1")).toBeVisible();
  await page.getByTitle("关闭详情").click();

  const firstSource = page.locator("li").filter({ hasText: sources[0] });
  page.once("dialog", (dialog) => dialog.accept());
  await firstSource.getByTitle("移除提示词源").click();
  await page.reload();
  await expect(page.locator("li").filter({ hasText: sources[0] })).toHaveCount(0);
  await expect(page.locator("li").filter({ hasText: sources[1] })).toBeVisible();
});

test("community prompt presets can be installed from the prompt library", async ({ page }) => {
  const presetUrl = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json";
  await page.route(presetUrl, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      id: "awesome-gpt-image:community-night",
      title: "社区夜景",
      prompt: "community neon street still",
      coverUrl: "https://cdn.example/community-cover.png",
      referenceImageUrls: ["https://cdn.example/community-cover.png"],
      tags: ["摄影"],
    }]),
  }));

  await openFreshBoard(page);
  await page.goto("/prompts");
  const presetCard = page.getByRole("list", { name: "社区提示词源" })
    .getByRole("listitem")
    .filter({ hasText: "ZeroLu/awesome-gpt-image" });
  await expect(presetCard).toBeVisible();
  // Built-in Image Prompts catalogs are always installed; one-click refreshes them.
  await presetCard.getByRole("button", { name: "刷新" }).click();
  await expect(page.getByText("社区夜景", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("community neon street still")).toBeVisible();
  await expect(presetCard.getByRole("button", { name: "刷新" })).toBeVisible();

  await page.reload();
  await expect(page.getByText("社区夜景", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "社区提示词源" })
      .getByRole("listitem")
      .filter({ hasText: "ZeroLu/awesome-gpt-image" })
      .getByRole("button", { name: "刷新" }),
  ).toBeVisible();
});


test("canvas prompt panel groups library entries by source and inserts them", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/prompts");
  await page.getByRole("button", { name: "新建提示词" }).click();
  const editor = page.getByRole("dialog", { name: "新建提示词" });
  await editor.getByLabel("标题").fill("侧栏夜景");
  await editor.getByLabel("提示词内容").fill("neon alley with rain reflections");
  await editor.getByLabel("标签").fill("city");
  await editor.getByRole("button", { name: "保存提示词" }).click();
  await expect(page.getByText("侧栏夜景", { exact: true })).toBeVisible();
  await expect(editor).toHaveCount(0);

  await page.goto("/");
  await openProjectPanel(page);
  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  await panel.getByRole("tab", { name: "提示词" }).click();
  await panel.getByLabel("搜索画布提示词库").fill("侧栏夜景");
  const library = panel.getByRole("list", { name: "侧栏提示词库" });
  await expect(library.getByText("我的", { exact: true })).toBeVisible();
  await expect(library.getByText("侧栏夜景", { exact: true })).toBeVisible();
  await library.getByRole("button", { name: "插入提示词 侧栏夜景" }).click();
  await expect(page.getByPlaceholder("写下提示词或说明…").first()).toHaveValue("neon alley with rain reflections");
  // Inserted text node keeps the prompt title on the node header.
  await expect(page.locator('[data-node-type="text"]').locator("[data-node-title]")).toHaveText("侧栏夜景");
  await page.reload();
  await openProjectPanel(page);
  await expect(panel.getByRole("tab", { name: "提示词", selected: true })).toBeVisible();
});

test("node prompt bar keeps the draft after a successful image generation", async ({ page }) => {
  await page.route("https://keep-prompt.example/v1/images/generations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC" }],
      }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://keep-prompt.example/v1");
  await page.getByLabel("生图 API Key").fill("keep-prompt-key");
  await page.getByLabel("生图模型", { exact: true }).fill("keep-prompt-image");
  await closeSettings(page);

  await clickCanvasTool(page, "图片");
  const imageNode = page.locator('[data-node-type="image"]').first();
  await imageNode.locator("[data-node-header]").click();
  const promptInput = imageNode.getByRole("textbox", { name: "节点生成提示词" });
  await expect(promptInput).toBeVisible();
  await promptInput.fill("keep this cinematic still prompt");
  await promptInput.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect.poll(async () => imageNode.locator("img").count()).toBeGreaterThan(0);
  await expect(promptInput).toContainText("keep this cinematic still prompt");
});

test("node prompt bar preserves multiline paste and keeps wheel scrolling local", async ({ page }) => {
  await openFreshBoard(page);
  await clickCanvasTool(page, "图片");
  const imageNode = page.locator('[data-node-type="image"]').first();
  await imageNode.locator("[data-node-header]").click();
  const promptInput = imageNode.getByRole("textbox", { name: "节点生成提示词" });
  await expect(promptInput).toBeVisible();
  await promptInput.click();

  await promptInput.evaluate((element) => {
    element.focus();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? "line one\n\nline three" : ""),
      },
    });
    element.dispatchEvent(event);
  });
  await expect(promptInput).toContainText("line one");
  await expect(promptInput).toContainText("line three");
  await expect.poll(async () => promptInput.evaluate((element) => {
    const text = element.innerText.replace(/\r/g, "");
    return text.includes("line one\n\nline three") || text.includes("line one\n\nline three\n");
  })).toBe(true);

  // Leave the prompt and reselect so the serialized value is restored from store.
  await page.getByTestId("canvas-surface").click({ position: { x: 40, y: 40 } });
  await imageNode.locator("[data-node-header]").click();
  await expect(promptInput).toContainText("line one");
  await expect.poll(async () => promptInput.evaluate((element) => element.innerText.replace(/\r/g, "")))
    .toMatch(/line one\n\nline three/);

  const zoomBefore = await page.locator('[data-testid="canvas-surface"]').evaluate((surface) => {
    const world = surface.querySelector("[data-canvas-world]") as HTMLElement | null;
    return world?.style.transform ?? "";
  });
  await promptInput.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new WheelEvent("wheel", {
      deltaY: 240,
      bubbles: true,
      cancelable: true,
    }));
  });
  const zoomAfter = await page.locator('[data-testid="canvas-surface"]').evaluate((surface) => {
    const world = surface.querySelector("[data-canvas-world]") as HTMLElement | null;
    return world?.style.transform ?? "";
  });
  expect(zoomAfter).toBe(zoomBefore);
});

test("node camera settings persist, stay screen-sized, and expand generation prompts once", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 900, "Camera panel positioning is covered on desktop.");
  const prompts: string[] = [];
  const videoPrompts: string[] = [];
  await page.route("https://camera-prompt.example/v1/images/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/generations")) {
      const body = JSON.parse(request.postData() ?? "{}") as { prompt?: string };
      prompts.push(body.prompt ?? "");
    } else {
      const multipart = request.postData() ?? "";
      prompts.push((multipart.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/)?.[1] ?? "").replaceAll("\r\n", "\n"));
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: pngPixelBase64 }] }),
    });
  });
  await page.route("https://camera-video.example/v1/videos", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { prompt?: string };
    videoPrompts.push(body.prompt ?? "");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: `camera-video-${videoPrompts.length}`,
        status: "completed",
        url: `https://camera-cdn.example/result-${videoPrompts.length}.mp4`,
      }),
    });
  });
  await page.route(/https:\/\/camera-cdn\.example\/result-\d+\.mp4/, async (route) => {
    await route.fulfill({ contentType: "video/mp4", body: "video-bytes" });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("生图 URL").fill("https://camera-prompt.example/v1");
  await page.getByLabel("生图 API Key").fill("camera-prompt-key");
  await page.getByLabel("生图模型", { exact: true }).fill("camera-image");
  await page.getByLabel("视频 URL").fill("https://camera-video.example/v1");
  await page.getByLabel("视频 API Key").fill("camera-video-key");
  await page.getByLabel("视频模型", { exact: true }).fill("camera-video");
  await closeSettings(page);

  await clickCanvasTool(page, "图片");
  await clickCanvasTool(page, "适应");
  await expect.poll(async () => page.locator('[data-node-type="image"]').count()).toBeGreaterThan(0);
  let imageNode = page.locator('[data-node-type="image"]').last();
  await imageNode.locator("[data-node-header]").click();
  await imageNode.getByTitle("摄像机设置").click();
  let cameraPanel = page.getByRole("dialog", { name: "摄像机提示词" });
  await cameraPanel.getByLabel("启用摄像机提示词").check();
  await cameraPanel.getByLabel("相机").selectOption("cinema");
  await cameraPanel.getByLabel("镜头").selectOption("anamorphic");
  await cameraPanel.getByLabel("焦距").fill("35");
  await cameraPanel.getByLabel("光圈").fill("2.8");
  const sizeAt100 = await cameraPanel.boundingBox();
  await page.getByLabel("缩放比例").evaluate((input) => {
    const range = input as HTMLInputElement;
    range.value = "50";
    range.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const sizeAt50 = await cameraPanel.boundingBox();
  expect(sizeAt100).not.toBeNull();
  expect(sizeAt50).not.toBeNull();
  expect(Math.abs(sizeAt100!.width - sizeAt50!.width)).toBeLessThan(2);
  expect(Math.abs(sizeAt100!.height - sizeAt50!.height)).toBeLessThan(2);
  await cameraPanel.getByTitle("关闭摄像机设置").click();

  const promptInput = imageNode.getByRole("textbox", { name: "节点生成提示词" });
  await promptInput.fill("a rainy night street");
  await promptInput.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toContain("a rainy night street");
  expect(prompts[0]).toContain("Camera: cinema camera; Lens: anamorphic lens; Focal length: 35mm; Aperture: f/2.8.");
  expect(prompts[0]!.match(/Camera: cinema camera/g)).toHaveLength(1);
  await expect.poll(async () => imageNode.locator("img").count()).toBeGreaterThan(0);

  await page.reload();
  imageNode = page.locator('[data-node-type="image"]').last();
  await imageNode.locator("[data-node-header]").click();
  await expect(imageNode.getByRole("textbox", { name: "节点生成提示词" })).toContainText("a rainy night street");
  await imageNode.getByTitle("摄像机设置（已启用）").click();
  cameraPanel = page.getByRole("dialog", { name: "摄像机提示词" });
  await expect(cameraPanel.getByLabel("相机")).toHaveValue("cinema");
  await expect(cameraPanel.getByLabel("镜头")).toHaveValue("anamorphic");
  await expect(cameraPanel.getByLabel("焦距")).toHaveValue("35");
  await expect(cameraPanel.getByLabel("光圈")).toHaveValue("2.8");
  await cameraPanel.getByTitle("关闭摄像机设置").click();
  const persistedPrompt = imageNode.getByRole("textbox", { name: "节点生成提示词" });
  await expect(persistedPrompt).toContainText("a rainy night street");
  await imageNode.getByRole("button", { name: "发送提示词" }).click();
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts[1]).toBe(prompts[0]);
  expect(prompts[1]!.match(/Camera: cinema camera/g)).toHaveLength(1);

  const now = "2026-07-24T00:00:00.000Z";
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: "camera-nodes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2,
      id: "camera-node-paths",
      title: "Camera node paths",
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: "camera-config",
          type: "config",
          title: "Camera config",
          position: { x: 100, y: 100 },
          width: 300,
          height: 300,
          metadata: { generationMode: "image", prompt: "config camera scene", status: "idle" },
        },
        {
          id: "camera-video-node",
          type: "video",
          title: "Camera video",
          position: { x: 1000, y: 100 },
          width: 360,
          height: 240,
          metadata: { prompt: "raw video camera scene", status: "idle" },
        },
      ],
      edges: [],
      chatSessions: [],
      activeChatId: null,
      backgroundMode: "dots",
      viewport: { x: 0, y: 0, k: 1 },
    })),
  });
  await clickCanvasTool(page, "适应");
  const configNode = page.locator('[data-node-id="camera-config"]');
  await configNode.locator("[data-node-header]").click();
  await expect(configNode.getByTitle("摄像机设置")).toBeVisible();
  await configNode.getByTitle("摄像机设置").click();
  cameraPanel = page.getByRole("dialog", { name: "摄像机提示词" });
  await cameraPanel.getByLabel("启用摄像机提示词").check();
  await cameraPanel.getByLabel("相机").selectOption("mirrorless");
  await cameraPanel.getByLabel("镜头").selectOption("wide");
  await cameraPanel.getByLabel("焦距").fill("24");
  await cameraPanel.getByLabel("光圈").fill("4");
  await cameraPanel.getByTitle("关闭摄像机设置").click();
  await configNode.getByTitle("运行生成").click();
  await expect.poll(() => prompts.length).toBe(3);
  expect(prompts[2]).toContain("config camera scene");
  expect(prompts[2]!.match(/Camera: mirrorless camera/g)).toHaveLength(1);
  const configImageResult = page.locator('[data-node-type="image"]').last();
  await configImageResult.locator("[data-node-header]").click();
  await expect(configImageResult.getByTitle("摄像机设置（已启用）")).toBeVisible();
  await expect(configImageResult.getByRole("textbox", { name: "节点生成提示词" })).toContainText("config camera scene");

  await configNode.locator("[data-node-header]").click();
  await configNode.getByLabel("模式").selectOption("text");
  await expect(configNode.getByTitle("摄像机设置")).toHaveCount(0);
  await configNode.getByLabel("模式").selectOption("video");
  await expect(configNode.getByTitle("摄像机设置（已启用）")).toBeVisible();
  await configNode.getByTitle("运行生成").click();
  await expect.poll(() => videoPrompts.length).toBe(1);
  expect(videoPrompts[0]).toContain("config camera scene");
  expect(videoPrompts[0]!.match(/Camera: mirrorless camera/g)).toHaveLength(1);
  const configExportPromise = page.waitForEvent("download");
  await page.getByTitle("导出当前", { exact: true }).click();
  const configExport = await configExportPromise;
  const configExportPath = await configExport.path();
  expect(configExportPath).not.toBeNull();
  const exportedProject = JSON.parse(await readFile(configExportPath!, "utf8")) as {
    nodes: Array<{
      id: string;
      type: string;
      metadata: { prompt?: string; cameraPrompt?: { enabled?: boolean; camera?: string } };
    }>;
  };
  const configVideoResult = exportedProject.nodes.find((item) =>
    item.type === "video" && item.id !== "camera-video-node"
  );
  expect(configVideoResult?.metadata.prompt).toBe("config camera scene");
  expect(configVideoResult?.metadata.cameraPrompt).toMatchObject({ enabled: true, camera: "mirrorless" });

  const videoNode = page.locator('[data-node-id="camera-video-node"]');
  await videoNode.locator("[data-node-header]").click();
  await expect(videoNode.getByTitle("摄像机设置")).toBeVisible();
  await videoNode.getByTitle("摄像机设置").click();
  cameraPanel = page.getByRole("dialog", { name: "摄像机提示词" });
  await cameraPanel.getByLabel("启用摄像机提示词").check();
  await cameraPanel.getByLabel("相机").selectOption("action");
  await cameraPanel.getByTitle("关闭摄像机设置").click();
  page.once("dialog", async (dialog) => dialog.accept("raw video camera scene"));
  await videoNode.getByTitle("生成视频").click();
  await expect.poll(() => videoPrompts.length).toBe(2);
  expect(videoPrompts[1]).toContain("raw video camera scene");
  expect(videoPrompts[1]!.match(/Camera: action camera/g)).toHaveLength(1);
  await expect(videoNode.getByTitle("摄像机设置（已启用）")).toBeVisible();
  await expect(videoNode.getByRole("textbox", { name: "节点生成提示词" })).toContainText("raw video camera scene");
});

test("prompt source manager previews, persists, edits, disables, and removes declarative sources", async ({ page }) => {
  const jsonUrl = "https://mapped-prompts.example/catalog.json";
  const htmlUrl = "https://html-prompts.example/catalog.html";
  await page.route(jsonUrl, async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      payload: {
        entries: [{
          slug: "mapped-one",
          label: "Mapped prompt",
          value: "mapped nested body",
          metadata: { tags: ["mapped", "nested"] },
        }],
      },
    }),
  }));
  await page.route(htmlUrl, async (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><body>
      <article class="prompt-card"><h2 class="title">HTML prompt</h2>
      <p class="prompt">html mapped body</p><span class="tag">html</span></article>
    </body></html>`,
  }));

  await openFreshBoard(page);
  await page.goto("/prompts");
  await page.getByRole("button", { name: "管理来源" }).click();
  let manager = page.getByRole("dialog", { name: "管理提示词来源" });
  // Built-in Image Prompts catalogs always exist; create a custom source explicitly.
  await manager.getByRole("button", { name: "新增来源" }).click();
  await manager.getByLabel("来源名称").fill("Nested catalog");
  await manager.getByLabel("来源解析格式").selectOption("json");
  await manager.getByLabel("来源 URL").fill(jsonUrl);
  await manager.getByLabel("条目路径").fill("payload.entries");
  await manager.getByLabel("ID 路径").fill("slug");
  await manager.getByLabel("标题路径").fill("label");
  await manager.getByLabel("正文路径").fill("value");
  await manager.getByLabel("标签路径").fill("metadata.tags");
  await manager.getByRole("button", { name: "预览" }).click();
  await expect(manager.getByRole("list", { name: "来源预览" })).toContainText("Mapped prompt");
  await manager.getByRole("button", { name: "保存来源" }).click();
  await expect(manager.getByRole("listitem").filter({ hasText: "Nested catalog" })).toBeVisible();

  await manager.getByLabel("条目路径").fill("__proto__.polluted");
  await manager.getByRole("button", { name: "保存来源" }).click();
  await expect(manager.getByRole("alert")).toContainText("field path");
  await manager.getByLabel("条目路径").fill("payload.entries");
  await manager.getByLabel("来源名称").fill("Nested catalog edited");
  await manager.getByLabel("启用来源").uncheck();
  await manager.getByRole("button", { name: "保存来源" }).click();
  await expect(manager.getByRole("listitem").filter({ hasText: "Nested catalog edited" })).toContainText("已停用");
  await manager.getByTitle("关闭来源管理").click();

  await page.reload();
  await page.getByRole("button", { name: "管理来源" }).click();
  manager = page.getByRole("dialog", { name: "管理提示词来源" });
  await expect(manager.getByRole("listitem").filter({ hasText: "Nested catalog edited" })).toContainText("已停用");

  await manager.getByRole("button", { name: "新增来源" }).click();
  await manager.getByLabel("来源名称").fill("Script catalog");
  await manager.getByLabel("来源解析格式").selectOption("script");
  await manager.getByLabel("来源 URL").fill(jsonUrl);
  await manager.getByLabel("转换脚本").fill(`const data = helpers.parseJson(text);
return (data.payload?.entries ?? data).map((item) => ({
  id: item.slug || item.id,
  title: item.label || item.title,
  body: item.value || item.prompt || item.body,
}));`);
  await manager.getByRole("button", { name: "预览" }).click();
  await expect(manager.getByRole("list", { name: "来源预览" })).toContainText("Mapped prompt");
  await manager.getByRole("button", { name: "保存来源" }).click();
  await expect(manager.getByRole("listitem").filter({ hasText: "Script catalog" })).toBeVisible();

  await manager.getByRole("button", { name: "新增来源" }).click();
  await manager.getByLabel("来源名称").fill("HTML catalog");
  await manager.getByLabel("来源解析格式").selectOption("html");
  await manager.getByLabel("来源 URL").fill(htmlUrl);
  await manager.getByLabel("条目选择器").fill(".prompt-card");
  await manager.getByLabel("标题选择器").fill(".title");
  await manager.getByLabel("正文选择器").fill(".prompt");
  await manager.getByLabel("标签选择器").fill(".tag");
  await manager.getByRole("button", { name: "预览" }).click();
  await expect(manager.getByRole("list", { name: "来源预览" })).toContainText("HTML prompt");
  await manager.getByRole("button", { name: "保存来源" }).click();
  await expect(manager.getByRole("listitem").filter({ hasText: "HTML catalog" })).toBeVisible();

  await manager.getByRole("listitem").filter({ hasText: "Nested catalog edited" }).getByRole("button").click();
  page.once("dialog", (dialog) => dialog.accept());
  await manager.getByTitle("删除来源").click();
  await expect(manager.getByRole("listitem").filter({ hasText: "Nested catalog edited" })).toHaveCount(0);
  await manager.getByTitle("关闭来源管理").click();
  await expect(page.getByText("Mapped prompt", { exact: true })).toHaveCount(0);
});

test("asset editor updates title, source, tags, notes, and text content", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/assets");
  await page.getByRole("button", { name: "新增文本" }).click();
  const creator = page.getByRole("dialog", { name: "新增素材" });
  await creator.getByLabel("标题").fill("Draft asset");
  await creator.getByLabel("内容").fill("Initial content");
  await creator.getByRole("button", { name: "保存" }).click();

  const card = page.locator("article").filter({ hasText: "Draft asset" });
  await card.getByRole("button", { name: "编辑" }).click();
  const editor = page.getByRole("dialog", { name: "编辑素材" });
  await editor.getByLabel("标题").fill("Edited asset");
  await editor.getByLabel("来源").fill("local-test");
  await editor.getByLabel("标签").fill("alpha, beta");
  await editor.getByLabel("备注").fill("edited note");
  await editor.getByLabel("内容").fill("Edited content");
  await editor.getByRole("button", { name: "保存" }).click();

  const edited = page.locator("article").filter({ hasText: "Edited asset" });
  await expect(edited).toContainText("local-test");
  await expect(edited).toContainText("Edited content");
});

test("asset library uploads, persists, previews, and inserts video media", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/assets");
  await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
    name: "campaign-loop.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("000000206674797069736F6D0000020069736F6D69736F3261766331", "hex"),
  });

  let card = page.locator("article").filter({ hasText: "campaign-loop.mp4" });
  await expect(card.locator("video")).toBeVisible();
  await page.reload();
  card = page.locator("article").filter({ hasText: "campaign-loop.mp4" });
  await expect(card).toBeVisible();
  const insertVideo = card.getByRole("button", { name: "插入画布" });
  await insertVideo.click();
  // Product shows "插入中" while insertAsset/persistNow runs.
  await expect(card.getByRole("button", { name: "插入画布" })).toBeVisible({ timeout: 15_000 });
  await page.goto("/");
  await expect(page.locator('[data-node-type="video"]')).toHaveCount(1, { timeout: 15_000 });
});

test("canvas asset panel can upload image assets", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop canvas asset panel is covered here.");
  await openFreshBoard(page);
  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  await panel.getByRole("tab", { name: "素材" }).click();
  await panel.locator('input[aria-label="上传侧栏图片素材"]').setInputFiles({
    name: "sidebar-upload.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(panel.getByRole("button", { name: "插入素材 sidebar-upload.png" })).toBeVisible();
  await page.reload();
  await panel.getByRole("tab", { name: "素材" }).click();
  await expect(panel.getByRole("button", { name: "插入素材 sidebar-upload.png" })).toBeVisible();
});

test("canvas asset panel inserts and deletes persisted assets", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop canvas asset panel is covered here.");
  await openFreshBoard(page);
  await page.goto("/assets");
  await page.getByRole("button", { name: "新增文本" }).click();
  const dialog = page.getByRole("dialog", { name: "新增素材" });
  await dialog.getByLabel("标题").fill("Sidebar asset");
  await dialog.getByLabel("内容").fill("Sidebar body");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sidebar asset" })).toBeVisible();

  await page.goto("/");
  await openProjectPanel(page);
  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: "素材" }).click();
  const insert = panel.getByRole("button", { name: "插入素材 Sidebar asset" });
  await expect(insert).toBeVisible({ timeout: 15_000 });
  await insert.click({ force: true });
  await expect(page.locator('[data-node-type="text"]')).toHaveCount(1);

  page.once("dialog", (confirmation) => confirmation.accept());
  await panel.getByRole("button", { name: "删除素材 Sidebar asset" }).click({ force: true });
  await expect(panel.getByRole("button", { name: "插入素材 Sidebar asset" })).toHaveCount(0, { timeout: 10_000 });
  // Give formal storage a beat to finish the assets PUT after flushAssets.
  await page.waitForTimeout(300);
  await page.reload();
  await openProjectPanel(page);
  const panelAfter = page.getByRole("complementary", { name: "项目侧栏" });
  await panelAfter.getByRole("tab", { name: "素材" }).click();
  await expect(panelAfter.getByRole("button", { name: "插入素材 Sidebar asset" })).toHaveCount(0, { timeout: 10_000 });
});

test("canvas asset panel can drag assets onto the canvas", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop canvas asset panel is covered here.");
  await openFreshBoard(page);
  await page.goto("/assets");
  await page.getByRole("button", { name: "新增文本" }).click();
  const dialog = page.getByRole("dialog", { name: "新增素材" });
  await dialog.getByLabel("标题").fill("Drag me asset");
  await dialog.getByLabel("内容").fill("dragged from sidebar");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);

  await page.goto("/");
  await openProjectPanel(page);
  const panel = page.getByRole("complementary", { name: "项目侧栏" });
  await panel.getByRole("tab", { name: "素材" }).click();
  const card = panel.locator('[data-testid="sidebar-asset-item"]').filter({ hasText: "Drag me asset" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const surface = page.getByTestId("canvas-surface");
  await expect(surface).toBeVisible();
  await card.dragTo(surface, { targetPosition: { x: 420, y: 280 } });
  await expect(page.locator('[data-node-type="text"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('[data-node-type="text"]').filter({ hasText: "Drag me asset" })).toBeVisible();
});

test("asset library supports persistence, search, type filters, pagination, copy, download, insert, and delete", async ({ page, browserName }) => {
  await openFreshBoard(page);
  await page.locator('nav a[href="/assets"]').click();
  for (let index = 1; index <= 13; index += 1) {
    await page.getByRole("button", { name: "新增文本" }).click();
    const dialog = page.getByRole("dialog", { name: "新增素材" });
    await dialog.getByLabel("标题").fill(`Text Asset ${String(index).padStart(2, "0")}`);
    await dialog.getByLabel("内容").fill(`copy body ${index}`);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
  }
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "library.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(page.getByText("1 / 2 · 共 14", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly")
        .objectStore("app_state")
        .get("openboard:assets");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(Array.isArray(request.result) ? request.result.length : 0);
        database.close();
      };
    };
  }))).toBe(14);
  await page.reload();
  await expect(page.getByText("1 / 2 · 共 14", { exact: true })).toBeVisible();

  const search = page.getByRole("textbox", { name: "搜索素材" });
  await search.fill("Text Asset 01");
  await expect(page.locator("article")).toHaveCount(1);
  const textAsset = page.locator("article").filter({ hasText: "Text Asset 01" });
  await expect(textAsset).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          sessionStorage.setItem("openboard:e2e-copied-text", value);
          return Promise.resolve();
        },
      },
    });
  });
  await textAsset.getByRole("button", { name: "复制" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("openboard:e2e-copied-text")))
    .toBe("copy body 1");
  await search.fill("");

  await page.locator("select").selectOption("image");
  const imageAsset = page.locator("article").filter({ hasText: "library.png" });
  await expect(imageAsset).toBeVisible();
  await expect(page.getByText("1 / 1 · 共 1", { exact: true })).toBeVisible();
  if (browserName === "webkit") {
    await imageAsset.getByRole("button", { name: "下载" }).click();
    await expect(page).toHaveURL(/\/assets$/);
  } else {
    const downloadPromise = page.waitForEvent("download");
    await imageAsset.getByRole("button", { name: "下载" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("library.png");
  }
  // Insert stays on /assets (no navigation / no confirm dialog).
  await imageAsset.getByRole("button", { name: "插入画布" }).click();
  await expect(imageAsset.getByRole("button", { name: "插入画布" })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/assets/);

  await page.locator("select").selectOption("all");
  await expect(page.getByText("1 / 2 · 共 14", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("2 / 2 · 共 14", { exact: true })).toBeVisible();
  const pageTwoAsset = page.locator("article").filter({ hasText: "Text Asset 01" });
  await expect(pageTwoAsset).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await pageTwoAsset.getByRole("button", { name: "删除" }).click();
  // Wait for product delete+flush to remove the card and fix pagination totals.
  await expect(page.locator("article").filter({ hasText: "Text Asset 01" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(/共 13/, { exact: false })).toBeVisible({ timeout: 10_000 });

  await page.locator('nav a[href="/"]').click();
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
});

test("assistant can batch-delete sessions and preserves one active session", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "assistant is intentionally closed by default on mobile; desktop panel flow is covered separately");
  await openFreshBoard(page);
  const assistant = page.locator("aside").filter({ hasText: "画布助手" });
  await assistant.getByTitle("新会话").click();
  await assistant.getByTitle("新会话").click();
  await assistant.getByTitle("管理会话").click();
  const checkboxes = assistant.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(3);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await assistant.getByRole("button", { name: "删除 2 个会话" }).click();

  await assistant.getByTitle("管理会话").click();
  await expect(assistant.locator('input[type="checkbox"]')).toHaveCount(1);
});

test("assistant ignores the submit shortcut while IME composition is active", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "assistant is intentionally closed by default on mobile; desktop panel flow is covered separately");
  await openFreshBoard(page);
  const input = page.getByPlaceholder("问点什么…（可粘贴图片）");
  await input.fill("组合输入");
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    ctrlKey: true,
    isComposing: true,
  });
  await expect.poll(() => dialogs).toBe(0);
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    ctrlKey: true,
    isComposing: false,
  });
  await expect.poll(() => dialogs).toBe(1);
});

test("assistant previews pasted images and inserts them without sending", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "desktop assistant paste flow is covered here");
  await openFreshBoard(page);
  const input = page.getByPlaceholder("问点什么…（可粘贴图片）");
  await input.evaluate((element) => {
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC"),
      (character) => character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    element.dispatchEvent(event);
  });
  const preview = page.getByAltText("待发送图片");
  await expect(preview).toBeVisible();
  const assistant = page.locator("aside").filter({ hasText: "画布助手" });
  await assistant.getByRole("button", { name: "插入画布", exact: true }).click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  await expect(preview).toHaveCount(0);
});

test("assistant generates, retries, inserts, deletes, and reloads text and images", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, "Desktop assistant generation workflow is covered here.");
  let textRequests = 0;
  await page.route("https://assistant-flow.example/v1/responses", async (route) => {
    textRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ output_text: `assistant answer ${textRequests}` }),
    });
  });
  await page.route("https://assistant-flow.example/v1/images/generations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [{ b64_json: pngPixelBase64 }],
      }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("文本 URL").fill("https://assistant-flow.example/v1");
  await page.getByLabel("文本 API Key").fill("assistant-text-key");
  await page.getByLabel("文本模型", { exact: true }).fill("assistant-text-model");
  await page.getByLabel("生图 URL").fill("https://assistant-flow.example/v1");
  await page.getByLabel("生图 API Key").fill("assistant-image-key");
  await page.getByLabel("生图模型", { exact: true }).fill("assistant-image-model");
  await closeSettings(page);

  test.setTimeout(90_000);
  if (await page.locator("#canvas-assistant").count() === 0) {
    await page.getByTitle("助手面板").click();
  }
  const assistant = page.locator("#canvas-assistant");
  await expect(assistant).toBeVisible();
  const askInput = assistant.getByPlaceholder("问点什么…（可粘贴图片）");
  await askInput.fill("assistant draft");
  await askInput.press("ControlOrMeta+Enter");
  await expect.poll(() => textRequests, { timeout: 20_000 }).toBeGreaterThan(0);
  let answer = assistant.getByTestId("assistant-message-assistant").filter({ hasText: "assistant answer 1" });
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await answer.getByRole("button", { name: "插入画布" }).click();
  await expect(page.locator('[data-node-type="text"]').getByPlaceholder("写下提示词或说明…").first()).toHaveValue("assistant answer 1");

  await answer.getByRole("button", { name: "重试" }).click();
  await expect.poll(() => textRequests, { timeout: 20_000 }).toBe(2);
  answer = assistant.getByTestId("assistant-message-assistant").filter({ hasText: "assistant answer 2" });
  await expect(answer).toBeVisible({ timeout: 20_000 });
  const userMessage = assistant.getByTestId("assistant-message-user").filter({ hasText: "assistant draft" });
  await userMessage.getByRole("button", { name: "删除" }).click();
  await expect(userMessage).toHaveCount(0);

  await assistant.getByRole("tab", { name: "生图" }).click();
  const imageInput = assistant.getByPlaceholder("描述想生成的图片…（可粘贴图片）");
  await imageInput.fill("assistant image");
  await imageInput.press("ControlOrMeta+Enter");
  const imageAnswer = assistant.getByTestId("assistant-message-assistant").filter({ hasText: "已生成图片" });
  await imageAnswer.scrollIntoViewIfNeeded();
  await imageAnswer.getByRole("button", { name: "插入画布" }).click();
  await page.getByTitle("适应").click();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);

  await page.reload();
  await expect(assistant.getByText("assistant answer 2", { exact: true })).toBeVisible();
  await expect(assistant.getByText("已生成图片", { exact: true })).toBeVisible();
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  await assistant
    .getByTestId("assistant-message-assistant")
    .filter({ hasText: "已生成图片" })
    .getByRole("button", { name: "删除" })
    .click();
  await expect(assistant.getByTestId("assistant-message-assistant").filter({ hasText: "已生成图片" })).toHaveCount(0);
});

test("local Agent connects to the real Go service with a session token", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("本地 Agent").click();
  await expect(page.getByLabel("本地地址")).toHaveValue(new URL(page.url()).origin);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByLabel("本地地址").fill(agentUrl);
  await page.getByLabel("连接令牌").fill("e2e-token");
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByText("board.list_nodes", { exact: true })).toBeVisible();
});

test("audio nodes expose the audio generation prompt", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByRole("button", { name: "音频", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "节点生成提示词" });
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute("aria-placeholder", "输入语音文本…");
});

test("browser runtime executes board commands, navigation, and protected snapshots", async ({ page, request }) => {
  await openFreshBoard(page);
  await page.getByTitle("配置", { exact: true }).click();
  await expect.poll(async () => {
    const response = await request.get(`${agentUrl}/api/agent/status`, {
      headers: { Authorization: "Bearer e2e-token" },
    });
    return (await response.json() as { runtime?: { connected?: boolean } }).runtime?.connected;
  }).toBe(true);

  const command = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await request.post(`${agentUrl}/api/runtime/command`, {
      headers: { Authorization: "Bearer e2e-token" },
      data: { method, params, timeoutMs: 10_000 },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const state = await command("board.get_state");
  expect((state.project as { id?: string } | null)?.id).toBeTruthy();
  const generationNodeId = await page.locator('[data-node-type="config"]').getAttribute("data-node-id");
  expect(generationNodeId).toBeTruthy();
  const generationStatus = await command("generation_get_status", { nodeIds: [generationNodeId] });
  expect(generationStatus).toMatchObject({
    nodes: [{ nodeId: generationNodeId, status: "queued", kind: "image" }],
  });

  const created = await command("board.create_text_node", {
    title: "Runtime Note",
    content: "created through runtime",
    x: 120,
    y: 160,
  });
  expect(created.title).toBe("Runtime Note");
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("created through runtime");

  const snapshot = await command("board.export_snapshot");
  const snapshotUrl = new URL(String(snapshot.url));
  expect(snapshotUrl.origin).toBe(await page.evaluate(() => window.location.origin));
  expect(snapshotUrl.pathname).toMatch(/^\/api\/files\//);
  const protectedUrl = new URL(new URL(String(snapshot.url)).pathname, agentUrl).toString();
  const denied = await request.get(protectedUrl);
  expect(denied.status()).toBe(401);
  const image = await request.get(protectedUrl, {
    headers: { Authorization: "Bearer e2e-token" },
  });
  expect(image.ok()).toBe(true);
  expect(image.headers()["content-type"]).toBe("image/png");

  await command("site.navigate", { path: "/assets" });
  await expect(page).toHaveURL("/assets");
});

test("remote plugin installation requires explicit permission consent", async ({ page }) => {
  await page.route("https://plugins.example/note.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        id: "example.remote-note",
        name: "Remote Note",
        version: "1.0.0",
        description: "Remote test plugin",
        document: "<script>openboard.ready()</script>",
        permissions: ["node:read", "node:write"],
        defaultSize: { width: 320, height: 220 },
      }),
    });
  });
  await page.goto("/plugins");
  const source = page.getByPlaceholder("https://example.com/plugin.json");
  await source.fill("https://plugins.example/note.json");
  await page.getByRole("button", { name: "安装清单" }).click();

  const dialog = page.getByRole("dialog", { name: "安装 Remote Note" });
  await expect(dialog).toContainText("可能通过页面导航或网络请求发送插件内的数据");
  await expect(dialog.getByLabel("node:read")).not.toBeChecked();
  await expect(dialog.getByLabel("node:write")).not.toBeChecked();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("已安装", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "安装清单" }).click();
  const consent = page.getByRole("dialog", { name: "安装 Remote Note" });
  await consent.getByLabel("node:read").check();
  await consent.getByLabel("node:write").check();
  await consent.getByRole("button", { name: "同意并安装" }).click();
  await expect(page.locator("article").filter({ hasText: "example.remote-note" })).toContainText("已安装");
});

test("Codex panel streams a message and handles explicit approval", async ({ page }) => {
  await openFreshBoard(page);
  let approvalBody: Record<string, unknown> | null = null;
  let messageBody: Record<string, unknown> | null = null;
  let interrupted = false;
  let codexSessionCreated = false;
  let activeCodexSessionId = "session-e2e";
  const sessionBodies: Record<string, unknown>[] = [];
  let eventStreamCount = 0;
  let releaseInitialSessionGet!: () => void;
  const initialSessionGet = new Promise<void>((resolve) => { releaseInitialSessionGet = resolve; });
  await page.route("**/api/agent/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: true, bridges: ["codex"], tools: [] }),
    });
  });
  await page.route(/\/api\/codex\/session(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      if (!codexSessionCreated) {
        await initialSessionGet;
        await route.fulfill({ status: 404, body: "not found" });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: activeCodexSessionId, threadId: `thread-${activeCodexSessionId}`, profile: "default", running: !interrupted }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      sessionBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
      codexSessionCreated = true;
      if (sessionBodies.length > 1) activeCodexSessionId = `session-e2e-${sessionBodies.length}`;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: activeCodexSessionId, threadId: `thread-${activeCodexSessionId}`, profile: "default", running: false }),
    });
  });
  await page.route("**/api/codex/session/*", async (route) => {
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/codex/message", async (route) => {
    messageBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/codex/attachments", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ attachments: [{ id: "image-e2e", name: "pixel.png", mimeType: "image/png", bytes: 68 }] }),
    });
  });
  await page.route("**/api/codex/interrupt", async (route) => {
    interrupted = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/codex/approval", async (route) => {
    approvalBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/projects/*", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary sync failure" }),
    });
  });
  await page.route("**/api/codex/events?sessionId=*", async (route) => {
    eventStreamCount += 1;
    const event = eventStreamCount === 1
      ? { type: "notification", method: "agent_message_delta", params: { delta: "**hello from Codex** <script>bad()</script>" } }
      : { type: "approval", method: "item/tool/call", id: "approval-e2e", params: { tool: "board.add_node" } };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    });
  });

  await page.getByTitle("本地 Agent").click();
  await page.getByLabel("本地地址").fill(agentUrl);
  await page.getByLabel("连接令牌").fill("e2e-token");
  await page.getByRole("button", { name: "连接" }).click();
  const codexTab = page.getByRole("tab", { name: "Codex" });
  if (await codexTab.count()) await codexTab.click();
  await page.getByRole("button", { name: "启动 Codex 会话" }).click();
  await expect.poll(() => sessionBodies).toHaveLength(1);
  releaseInitialSessionGet();
  await expect(page.getByText("Agent project read failed: HTTP 503", { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder("发送消息")).toBeVisible();
  await expect(page.getByText("hello from Codex")).toBeVisible();
  await expect(page.locator("script").filter({ hasText: "bad()" })).toHaveCount(0);
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(page.getByAltText("pixel.png")).toBeVisible();
  const codexComposer = page.getByPlaceholder("发送消息").locator("..");
  await codexComposer.getByPlaceholder("发送消息").fill("inspect this image");
  await codexComposer.getByTitle("发送").click();
  await expect.poll(() => messageBody).toMatchObject({
    sessionId: "session-e2e",
    text: "inspect this image",
    attachmentIds: ["image-e2e"],
  });
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
  await expect(page.locator('[data-node-type="config"]')).toHaveCount(1);
  await expect(page.locator('[data-node-type="config"]')).toHaveClass(/border-\[var\(--ob-select\)\]/);
  const transcript = page.getByRole("log", { name: "Codex 消息记录" });
  await expect(transcript.locator("strong").filter({ hasText: /^你$/ })).toHaveCount(0);
  await expect(transcript.locator("strong").filter({ hasText: /^Codex$/ })).toHaveCount(0);
  await expect(transcript.getByText("hello from Codex")).toBeVisible();
  await page.getByTitle("停止").click();
  await expect.poll(() => interrupted).toBe(true);
  expect(sessionBodies[0]).toEqual({ profile: "default", fresh: false });
  await page.getByRole("button", { name: "新会话" }).last().click();
  await expect.poll(() => sessionBodies.at(-1)).toEqual({ profile: "default", fresh: true });
  await expect(page.getByText("Codex 请求审批")).toBeVisible();
  await page.getByTitle("允许").click();
  await expect.poll(() => approvalBody).toMatchObject({
    sessionId: "session-e2e-2",
    id: "approval-e2e",
    approve: true,
  });
  await page.getByTitle("关闭 Codex 会话").click();
  await page.getByRole("button", { name: "启动 Codex 会话" }).click();
  await expect.poll(() => sessionBodies).toHaveLength(3);
  await expect(page.getByText("hello from Codex")).toHaveCount(0);
});

test("Codex session and running state stay synchronized across browser tabs", async ({ page, context }) => {
  let created = false;
  let running = false;
  let activeSessionId = "session-shared";
  let messageBody: Record<string, unknown> | null = null;
  const installRoutes = async (target: Page) => {
    await target.route("**/api/agent/status", async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: true, bridges: ["codex"], tools: [] }),
    }));
    await target.route(/\/api\/codex\/session(?:\?.*)?$/, async (route) => {
      if (route.request().method() === "GET" && !created) {
        await route.fulfill({ status: 404, body: "not found" });
        return;
      }
      if (route.request().method() === "POST") created = true;
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as { fresh?: boolean };
        if (body.fresh) activeSessionId = "session-shared-2";
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: activeSessionId, threadId: `thread-${activeSessionId}`, profile: "default", running }),
      });
    });
    await target.route("**/api/codex/message", async (route) => {
      messageBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
      running = true;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await target.route("**/api/codex/interrupt", async (route) => {
      running = false;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await target.route("**/api/codex/events?sessionId=*", async (route) => {
      const isFresh = route.request().url().includes("session-shared-2");
      await route.fulfill({
        contentType: "text/event-stream",
        body: isFresh ? "" : [
          { type: "notification", method: "openboard/user_message", data: { id: "message-shared", text: "synced prior prompt" } },
          { type: "notification", method: "agent_message_delta", params: { threadId: "thread-other", delta: "wrong thread message" } },
        ].map((event) => `event: notification\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      });
    });
    await target.route("**/api/projects/*", async (route) => route.fulfill({ status: 404, body: "not found" }));
  };
  const connectPanel = async (target: Page) => {
    const runtimeReady = target.waitForEvent("websocket", {
      predicate: (socket) => socket.url().includes("/api/runtime/ws"),
      timeout: 15_000,
    }).then((socket) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("browser runtime did not announce its client ID")), 15_000);
      socket.on("framereceived", (event) => {
        if (!String(event.payload).includes('"clientId"')) return;
        clearTimeout(timer);
        resolve();
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new Error("browser runtime closed before announcing its client ID"));
      });
    }));
    await target.getByTitle("本地 Agent").click();
    await target.getByLabel("本地地址").fill(agentUrl);
    await target.getByLabel("连接令牌").fill("e2e-token");
    await target.getByRole("button", { name: "连接" }).click();
    await runtimeReady;
  };

  await installRoutes(page);
  await openFreshBoard(page);
  await connectPanel(page);
  const codexTab = page.getByRole("tab", { name: "Codex" });
  if (await codexTab.count()) await codexTab.click();
  await page.getByRole("button", { name: "启动 Codex 会话" }).click();
  await expect(page.getByPlaceholder("发送消息")).toBeEnabled();

  const second = await context.newPage();
  await installRoutes(second);
  await second.goto("/");
  await expect(second.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name: "文本", exact: true })).toBeVisible();
  await connectPanel(second);
  await expect(second.getByPlaceholder("发送消息")).toBeEnabled();
  await expect(second.getByText("synced prior prompt")).toBeVisible();
  await expect(second.getByText("wrong thread message")).toHaveCount(0);

  const codexComposer = page.getByPlaceholder("发送消息").locator("..");
  await codexComposer.getByPlaceholder("发送消息").fill("shared running state");
  await codexComposer.getByTitle("发送").click();
  await expect.poll(() => messageBody).toMatchObject({
    sessionId: "session-shared",
    text: "shared running state",
  });
  expect(String(messageBody?.clientId)).toMatch(/^browser-[A-Za-z0-9]+$/);
  await expect(second.getByPlaceholder("发送消息")).toBeDisabled();
  await expect(second.getByRole("button", { name: "新会话" }).last()).toBeDisabled();

  await page.getByTitle("停止").click();
  await expect(second.getByPlaceholder("发送消息")).toBeEnabled();
  await expect(second.getByRole("button", { name: "新会话" }).last()).toBeEnabled();
  await page.getByRole("button", { name: "新会话" }).last().click();
  await expect(second.getByText("synced prior prompt")).toHaveCount(0);
  await second.close();
});

test("mobile asset and prompt pages keep primary actions usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);

  await page.goto("/assets");
  await expect(page.getByRole("heading", { name: "我的素材" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增文本" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto("/prompts");
  await expect(page.getByRole("heading", { name: "提示词库" })).toBeVisible();
  // Prefer the toolbar action (not the empty-state "加载内置示例").
  await page.getByRole("button", { name: "恢复内置", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: "产品棚拍" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "详情" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile assistant can be opened and closed without hiding the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);
  await page.getByRole("button", { name: "助手面板" }).last().click();
  await expect(page.getByText("画布助手", { exact: true })).toBeVisible();
  await page.getByTitle("关闭助手").click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
  await expect(page.getByText("画布助手", { exact: true })).toHaveCount(0);
});

test("compact navigation keeps secondary actions reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);

  await page.getByTitle("更多").click();
  const menu = page.getByRole("menu", { name: "更多操作" });
  await expect(menu.getByRole("menuitem", { name: "本地 Agent" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "快捷键" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "切换主题" })).toBeVisible();
  const versionItem = menu.getByTitle("查看版本更新");
  await expect(versionItem).toBeVisible();
  await expect(versionItem).toHaveAttribute("role", "menuitem");

  const wasDark = await page.locator("html").evaluate((element) => element.classList.contains("dark"));
  await menu.getByRole("menuitem", { name: "切换主题" }).click();
  await expect.poll(() => page.locator("html").evaluate((element) => element.classList.contains("dark")))
    .toBe(!wasDark);
  await expect(menu).toHaveCount(0);
});

test("mobile canvas controls stay compact and do not overlap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);

  const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.height).toBeLessThanOrEqual(60);

  const zoom = page.getByRole("group", { name: "缩放控制" });
  const minimap = page.getByLabel("画布小地图");
  await expect(zoom).toBeVisible();
  await expect(minimap).toBeVisible();
  const zoomBox = await zoom.boundingBox();
  const minimapBox = await minimap.boundingBox();
  expect(zoomBox).not.toBeNull();
  expect(minimapBox).not.toBeNull();
  const overlaps = !(
    zoomBox!.x + zoomBox!.width <= minimapBox!.x ||
    minimapBox!.x + minimapBox!.width <= zoomBox!.x ||
    zoomBox!.y + zoomBox!.height <= minimapBox!.y ||
    minimapBox!.y + minimapBox!.height <= zoomBox!.y
  );
  expect(overlaps).toBe(false);
});

for (const viewport of [
  { label: "tablet", width: 768, height: 900 },
  { label: "compact desktop", width: 1024, height: 900 },
]) {
  test(`${viewport.label} keeps project panel reachable while the assistant is open`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openFreshBoard(page, { requireProjectPanel: false });

    const surface = page.getByTestId("canvas-surface");
    const assistant = page.getByRole("complementary", { name: "画布助手" });
    const projectPanel = page.getByRole("complementary", { name: "项目侧栏" });
    await expect(surface).toBeVisible();
    await expect(assistant).toBeVisible();
    // Product: docked project panel remains available with the assistant open on md+.
    await expect(projectPanel).toBeVisible();
    await expect(projectPanel.getByRole("tab", { name: "项目" })).toBeVisible();

    const surfaceBox = await surface.boundingBox();
    const assistantBox = await assistant.boundingBox();
    const projectBox = await projectPanel.boundingBox();
    expect(surfaceBox).not.toBeNull();
    expect(assistantBox).not.toBeNull();
    expect(projectBox).not.toBeNull();
    // Canvas shares horizontal space with the docked project panel.
    expect(surfaceBox!.width).toBeLessThan(viewport.width);
    expect(surfaceBox!.height).toBeGreaterThan(500);
    expect(assistantBox!.x + assistantBox!.width).toBeLessThanOrEqual(viewport.width + 1);

    await assistant.getByTitle("关闭助手").click();
    await expect(assistant).toHaveCount(0);
    await expect(projectPanel).toBeVisible();
    await expect(surface).toBeVisible();
  });
}


test("desktop canvas toolbar exposes every core action without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFreshBoard(page);
  const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  // Core actions must be reachable. Horizontal scroll is acceptable on dense toolbars.
  for (const name of ["文本", "音频", "导入图片", "撤销", "背景", "小地图", "素材", "适应"]) {
    await expect(toolbar.getByTitle(name, { exact: true })).toBeVisible();
  }
  const dimensions = await toolbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  // Soft overflow budget: keep excess under one tool width (~80px) so actions remain one swipe away.
  expect(dimensions.scrollWidth - dimensions.clientWidth).toBeLessThanOrEqual(96);
});

test("canvas context menu remains inside the viewport at the lower-right edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);
  const surface = page.getByTestId("canvas-surface");
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.click(
    surfaceBox!.x + surfaceBox!.width - 4,
    surfaceBox!.y + surfaceBox!.height - 4,
    { button: "right" },
  );

  const menu = page.getByRole("menu", { name: "画布菜单" });
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(4);
  expect(menuBox!.y).toBeGreaterThanOrEqual(4);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390 + 1);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(844 + 1);
});

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.label} viewport has no horizontal document overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openFreshBoard(page);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(dimensions.clientWidth).toBe(viewport.width);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  });
}

test("touch pointer gestures update the canvas viewport without horizontal overflow", async ({ page, browserName }) => {
  test.skip(browserName === "firefox", "Firefox desktop does not expose touch pointer injection; mobile-chromium covers the touch state machine");
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);
  const surface = page.getByTestId("canvas-surface");
  const world = surface.locator("div.absolute.left-0.top-0");
  const before = await world.getAttribute("style");

  await surface.evaluate((element) => {
    const emit = (type: string, pointerId: number, x: number, y: number) => {
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        isPrimary: pointerId === 1,
      }));
    };
    emit("pointerdown", 1, 120, 180);
    emit("pointermove", 1, 180, 230);
    emit("pointerup", 1, 180, 230);
  });

  await expect.poll(() => world.getAttribute("style")).not.toBe(before);
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("all four node corners resize while the opposite corner stays anchored", async ({ page }) => {
  await openFreshBoard(page);
  await importSingleImageProject(page, "corner-resize");
  const node = page.locator('[data-node-type="image"]');
  await node.locator("[data-node-header]").click();

  const before = (await node.boundingBox())!;
  // Dragging the north-west corner must keep the south-east corner in place.
  const handle = node.locator('[data-resize-corner="nw"]');
  await handle.hover({ force: true });
  await page.mouse.down();
  await page.mouse.move(before.x - 40, before.y - 30, { steps: 8 });
  await page.mouse.up();

  const after = (await node.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width);
  expect(after.x + after.width).toBeCloseTo(before.x + before.width, 0);
  expect(after.y + after.height).toBeCloseTo(before.y + before.height, 0);

  // Each remaining corner must actually resize while pinning the opposite one.
  // Asserting only that the handle exists would miss a swapped dx/dy sign.
  const corners = [
    { corner: "ne", dx: 30, dy: -20, anchorX: "left", anchorY: "bottom" },
    { corner: "sw", dx: -30, dy: 20, anchorX: "right", anchorY: "top" },
    { corner: "se", dx: 30, dy: 20, anchorX: "left", anchorY: "top" },
  ] as const;
  for (const { corner, dx, dy, anchorX, anchorY } of corners) {
    const start = (await node.boundingBox())!;
    const handle = node.locator(`[data-resize-corner="${corner}"]`);
    await handle.hover({ force: true });
    await page.mouse.down();
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2 + dx, grip.y + grip.height / 2 + dy, { steps: 8 });
    await page.mouse.up();

    const moved = (await node.boundingBox())!;
    expect(moved.width).toBeGreaterThan(start.width);
    expect(moved.height).toBeGreaterThan(start.height);
    // The diagonally opposite corner is the anchor and must not move.
    const expectedX = anchorX === "left" ? start.x : start.x + start.width;
    const actualX = anchorX === "left" ? moved.x : moved.x + moved.width;
    const expectedY = anchorY === "top" ? start.y : start.y + start.height;
    const actualY = anchorY === "top" ? moved.y : moved.y + moved.height;
    expect(actualX).toBeCloseTo(expectedX, 0);
    expect(actualY).toBeCloseTo(expectedY, 0);
  }
});

test("node info dialog shows a readable summary and the raw document", async ({ page }) => {
  await openFreshBoard(page);
  await importSingleImageProject(page, "node-info");
  const node = page.locator('[data-node-type="image"]');
  await node.locator("[data-node-header]").click();
  await page.getByTitle("节点信息").click();

  const dialog = page.getByRole("dialog", { name: "节点信息" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("类型", { exact: true })).toBeVisible();
  await expect(dialog.getByText("图片", { exact: true }).first()).toBeVisible();

  await dialog.getByRole("button", { name: "查看 JSON" }).click();
  await expect(dialog.getByText('"metadata"', { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "基础信息" }).click();
  await expect(dialog.getByText("尺寸", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("global generation defaults are editable and seed new nodes", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });

  // The tenant defaults must be reachable from the settings dialog; without an
  // editor they are frozen at the built-in values and the feature is inert.
  await settings.getByLabel("默认视频比例").selectOption("9:16");
  await settings.getByLabel("默认清晰度").selectOption("1080p");
  await settings.getByLabel("默认声音").fill("verse");
  await closeSettings(page);

  // A newly created node inherits them.
  await page.getByRole("toolbar", { name: "画布工具栏" })
    .getByRole("button", { name: "视频", exact: true }).click();
  const video = page.locator('[data-node-type="video"]');
  await video.locator("[data-node-header]").click();
  await page.getByTitle("节点信息").click();
  const info = page.getByRole("dialog", { name: "节点信息" });
  await expect(info.getByText("9:16", { exact: true })).toBeVisible();
  await expect(info.getByText("1080p", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // The choice survives a reload rather than living only in component state.
  await page.reload();
  await page.getByTitle("设置").click();
  await expect(page.getByRole("dialog", { name: "设置" }).getByLabel("默认视频比例"))
    .toHaveValue("9:16");
});

test("a camera gesture is one undo step and leaves canvas content alone", async ({ page }) => {
  await openFreshBoard(page);
  await importSingleImageProject(page, "camera-undo");
  const node = page.locator('[data-node-type="image"]');
  await expect(node).toHaveCount(1);

  const readCamera = () => page.locator('[data-testid="canvas-surface"]').evaluate((surface) => {
    const world = surface.querySelector("[data-canvas-world]") as HTMLElement | null;
    return world?.style.transform ?? "";
  });

  const before = await readCamera();
  // One continuous wheel gesture: four notches, one undo step. The notches are
  // dispatched in a single synchronous burst so no unrelated store write can
  // land between them — an interleaved edit legitimately ends the run and
  // would split the gesture into two steps.
  await page.getByTestId("canvas-surface").evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    for (let i = 0; i < 4; i += 1) {
      surface.dispatchEvent(new WheelEvent("wheel", {
        deltaY: -120,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      }));
    }
  });
  await expect.poll(readCamera).not.toBe(before);
  const zoomed = await readCamera();

  const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
  await toolbar.getByRole("button", { name: "撤销" }).click();
  await expect.poll(readCamera).toBe(before);
  // Undoing the camera must not remove canvas content.
  await expect(node).toHaveCount(1);

  await toolbar.getByRole("button", { name: "重做" }).click();
  await expect.poll(readCamera).toBe(zoomed);
  await expect(node).toHaveCount(1);
});

test("workbench history refills the form without generating", async ({ page }) => {
  await openFreshBoard(page);

  // Seed a finished record straight into the history store. Generating one for
  // real would need a provider, and the point here is the refill path.
  const timestamp = "2026-07-27T00:00:00.000Z";
  await page.evaluate(async (createdAt) => {
    const read = <T,>(database: string, store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction(store, "readonly");
        const get = transaction.objectStore(store).get(key);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result as T);
      };
    });
    const write = (database: string, store: string, values: Array<[IDBValidKey, unknown]>) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction(store, "readwrite");
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => resolve();
          for (const [key, value] of values) transaction.objectStore(store).put(value, key);
        };
      });
    const projects = await read<Array<{ id: string }>>("openboard-app", "app_state", "openboard:projects");
    const job = {
      id: "refill_probe_job", projectId: projects[0]!.id, kind: "image", status: "succeeded",
      prompt: "回填探针提示词", providerId: "", model: "probe-image-model",
      parameters: { size: "1536x1024", quality: "high", count: 3, category: "探针" },
      result: { items: [] }, createdAt, updatedAt: createdAt,
    };
    await write("openboard-generation-jobs", "jobs", [[job.id, job]]);
  }, timestamp);

  await page.goto("/workbench/image");
  const prompt = page.getByPlaceholder("描述想生成的图片…");
  await expect(prompt).toBeVisible();

  // The record must actually be listed, otherwise this test proves nothing.
  const refill = page.getByRole("button", { name: "回填设置到表单" });
  await expect(refill).toHaveCount(1);

  // Move the form away from the record so a successful refill is unambiguous.
  await prompt.fill("另一个草稿");
  await page.getByLabel("尺寸").fill("1024x1024");
  await page.getByLabel("质量").fill("auto");
  await page.getByLabel("数量").fill("1");

  await refill.click();
  await expect(prompt).toHaveValue("回填探针提示词");
  await expect(page.getByLabel("尺寸")).toHaveValue("1536x1024");
  await expect(page.getByLabel("质量")).toHaveValue("high");
  await expect(page.getByLabel("数量")).toHaveValue("3");
  await expect(page.getByLabel("模型")).toHaveValue("probe-image-model");

  // Refilling must not start a generation: the record count stays put.
  await expect(refill).toHaveCount(1);
});
