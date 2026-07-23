import { expect, test, type Page } from "@playwright/test";

const agentUrl = process.env.OPENBOARD_E2E_PRODUCTION === "1"
  ? "http://127.0.0.1:8792"
  : "http://127.0.0.1:8791";
const pngPixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAADFbP4CAAAAFUlEQVQIHWP8z8AARAjAhGBCWIQFAIPRAgYQO+IXAAAAAElFTkSuQmCC";
const pngReplacementBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAADFbP4CAAAAFUlEQVQIHWNk+A+ESIAJiQ1mEhYAAILSAgahbK2jAAAAAElFTkSuQmCC";

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

/** Click the canvas toolbar tool by accessible name (avoids node title collisions). */
async function clickCanvasTool(page: Page, name: string) {
  await page.getByRole("toolbar", { name: "画布工具栏" }).getByRole("button", { name, exact: true }).click();
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
  expect((await panel.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);

  await page.reload();
  await expect(panel).toBeVisible();
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
  await page.getByRole("menuitem", { name: "新建音频" }).click();
  await expect(page.locator('[data-node-type="audio"]')).toHaveCount(1);
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
