import { expect, test, type Page } from "@playwright/test";

const agentUrl = process.env.OPENBOARD_E2E_PRODUCTION === "1"
  ? "http://127.0.0.1:8792"
  : "http://127.0.0.1:8791";

async function openFreshBoard(page: Page) {
  await page.goto("/");
  await expect(page.getByTitle("文本")).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page.getByTitle("项目").click();
  }
  await expect(page.locator('input[value="我的第一个画布"]')).toHaveCount(1);
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page.locator("aside").getByTitle("关闭").click();
  }
}

test("first launch creates and opens a board project", async ({ page }) => {
  await openFreshBoard(page);
  if ((page.viewportSize()?.width ?? 1440) >= 768) {
    await expect(page.locator('input[value="我的第一个画布"]')).toBeVisible();
    await expect(page.getByText("0 节点", { exact: false })).toBeVisible();
  }
});

test("a text node and its content survive a reload", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("文本").click();

  const editor = page.getByPlaceholder("写下提示词或说明…");
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
  await expect(page.getByRole("button", { name: "新建文本" })).toBeVisible();
  await page.getByRole("button", { name: "新建音频" }).click();
  await expect(page.locator('[data-node-type="audio"]')).toHaveCount(1);
});

test("node title, font size, and model overrides are editable and persistent", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("文本").click();
  const node = page.locator('[data-node-type="text"]');
  await node.locator("span", { hasText: "文本" }).dblclick();
  const title = node.getByLabel("节点标题");
  await title.fill("本地创作节点");
  await title.press("Enter");
  await expect(node.getByTitle("本地创作节点")).toBeVisible();

  const model = node.getByLabel("文本节点模型");
  await model.fill("local-text-model");
  const editor = page.getByPlaceholder("写下提示词或说明…");
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
  await expect(page.locator('[data-node-type="text"]').getByTitle("本地创作节点")).toBeVisible();
  await expect(page.getByLabel("文本节点模型")).toHaveValue("local-text-model");
});

test("text-to-image creates a connected config and executes immediately", async ({ page }) => {
  let requestBody: Record<string, unknown> | null = null;
  await page.route("https://mock.example/v1/images/generations", async (route) => {
    requestBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [{
          b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC",
        }],
      }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  const settings = page.getByRole("heading", { name: "设置" }).locator("..").locator("..");
  await settings.getByLabel("生图 URL").fill("https://mock.example/v1");
  await settings.getByLabel("生图 API Key").fill("test-only-key");
  await settings.getByLabel("生图模型").fill("mock-image-model");
  await settings.getByRole("button", { name: "关闭" }).click();

  await page.getByTitle("文本").click();
  await page.getByPlaceholder("写下提示词或说明…").fill("a red square");
  await page.getByTitle("生图").click();

  await expect(page.locator('[data-node-type="config"]')).toHaveCount(1);
  await expect.poll(() => requestBody).toMatchObject({
    model: "mock-image-model",
    prompt: "a red square",
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
          resolve(projects.some((project) => project?.nodes?.some(
            (item: { type?: string; metadata?: { status?: string } }) =>
              item.type === "image" && item.metadata?.status === "success",
          )));
          database.close();
        };
      };
    }),
  )).toBe(true);
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
  await page.getByLabel("生图模型").fill("workbench-image");
  await page.getByRole("button", { name: "关闭" }).click();

  await page.goto("/workbench/image");
  await expect(page.getByRole("heading", { name: "图片创作工作台" })).toBeVisible();
  await page.getByText("提示词", { exact: true }).locator("..").locator("textarea").fill("workbench square");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  const history = page.locator("article").filter({ hasText: "workbench square" });
  await expect(history).toContainText("succeeded");
  await page.reload();
  await expect(page.locator("article").filter({ hasText: "workbench square" })).toBeVisible();
  await page.getByRole("button", { name: "插入画布" }).click();
  await expect(page.getByRole("button", { name: "已插入" })).toBeVisible();
  await page.goto("/");
  await expect(page.locator('[data-node-type="image"]')).toHaveCount(1);
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
                    (node: { metadata?: { pluginState?: { text?: string } } }) =>
                      node.metadata?.pluginState?.text === "plugin state from Playwright",
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
  await expect(
    page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容"),
  ).toHaveValue("plugin state from Playwright");
});

test("plugin registry installation requires consent for every permission", async ({ page }) => {
  await page.route("https://registry.example/openboard.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        plugins: [{
          id: "example.registry-note",
          name: "Registry Note",
          version: "1.0.0",
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
        version: "1.0.0",
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
  await expect(page.locator("article").filter({ hasText: "example.registry-note" })).toContainText("已安装");
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
  await expect(canvas).toBeVisible();
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

test("image reverse prompt creates a connected text node", async ({ page }) => {
  await page.route("https://vision.example/v1/responses", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ output_text: "studio light, red square" }) });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("文本 URL").fill("https://vision.example/v1");
  await page.getByLabel("文本 API Key").fill("vision-test-key");
  await page.getByLabel("文本模型").fill("vision-model");
  await page.getByRole("button", { name: "关闭" }).click();
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: "vision.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await page.getByTitle("反推提示词").click();
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("studio light, red square");
});

test("local image upscale creates a lineage-tracked derived node", async ({ page }) => {
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

  await page.getByTitle("放大").click();
  await expect(page.getByText("浏览器 Canvas 插值，不调用云端模型。")).toBeVisible();
  await page.getByRole("button", { name: "应用" }).click();
  const output = page.locator('img[alt="图片 · 2x"]');
  await expect(output).toHaveCount(1);
  await expect.poll(() => output.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ width: 2, height: 2 });

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
            .find((node) => node?.metadata?.transformOperation === "upscale");
          database.close();
          resolve(derived?.metadata ?? null);
        };
      };
    }),
  );
  await expect.poll(readLineage).toMatchObject({
    transformOperation: "upscale",
    transformProvider: "local-canvas",
    transformModel: "browser-bicubic",
    transformParameters: { scale: 2 },
  });
  const lineage = await readLineage();
  expect(lineage?.derivedFromId).toBeTruthy();
});

test("prompt details can insert their content into the active canvas", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/prompts");
  await page.getByRole("button", { name: "恢复内置" }).click();
  const promptCard = page.locator("article").filter({ hasText: "产品棚拍" });
  await promptCard.getByRole("button", { name: "详情" }).click();

  const dialog = page.getByRole("dialog", { name: "产品棚拍" });
  await expect(dialog).toContainText("Studio product photo");
  await dialog.getByRole("button", { name: "插入当前画布文本节点" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue(
    /Studio product photo/,
  );
});

test("asset editor updates title, source, tags, notes, and text content", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/assets");
  const answers = ["Draft asset", "Initial content"];
  page.on("dialog", async (dialog) => {
    await dialog.accept(answers.shift() ?? "");
  });
  await page.getByRole("button", { name: "新增文本" }).click();

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

test("local Agent connects to the real Go service with a session token", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("本地 Agent").click();
  await page.getByLabel("Local URL").fill(agentUrl);
  await page.getByLabel("Connect token").fill("e2e-token");
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByText("board.list_nodes", { exact: true })).toBeVisible();
});

test("browser runtime executes board commands, navigation, and protected snapshots", async ({ page, request }) => {
  await openFreshBoard(page);
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
  const sessionBodies: Record<string, unknown>[] = [];
  let eventStreamCount = 0;
  await page.route("**/api/agent/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: true, bridges: ["codex"], tools: [] }),
    });
  });
  await page.route("**/api/codex/session", async (route) => {
    if (route.request().method() === "POST") {
      sessionBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "session-e2e", threadId: "thread-e2e" }),
    });
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
  await page.route("**/api/codex/events?sessionId=session-e2e", async (route) => {
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
  await page.getByLabel("Local URL").fill("http://127.0.0.1:8790");
  await page.getByRole("button", { name: "连接" }).click();
  await page.getByRole("button", { name: "继续会话" }).click();
  await expect(page.getByText("hello from Codex")).toBeVisible();
  await expect(page.locator("script").filter({ hasText: "bad()" })).toHaveCount(0);
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(page.getByAltText("pixel.png")).toBeVisible();
  await page.getByPlaceholder("发送消息").fill("inspect this image");
  await page.getByTitle("发送").click();
  await expect.poll(() => messageBody).toMatchObject({
    sessionId: "session-e2e",
    text: "inspect this image",
    attachmentIds: ["image-e2e"],
  });
  await page.getByTitle("停止").click();
  await expect.poll(() => interrupted).toBe(true);
  expect(sessionBodies[0]).toEqual({ profile: "default", fresh: false });
  await page.getByRole("button", { name: "新会话" }).last().click();
  await expect.poll(() => sessionBodies.at(-1)).toEqual({ profile: "default", fresh: true });
  await expect(page.getByText("Codex 请求审批")).toBeVisible();
  await page.getByTitle("允许").click();
  await expect.poll(() => approvalBody).toMatchObject({
    sessionId: "session-e2e",
    id: "approval-e2e",
    approve: true,
  });
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
  await page.getByRole("button", { name: "恢复内置" }).click();
  await expect(page.locator("article").first().getByRole("button", { name: "详情" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile assistant can be opened and closed without hiding the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshBoard(page);
  await page.getByTitle("助手面板").click();
  await expect(page.getByText("画布助手", { exact: true })).toBeVisible();
  await page.getByTitle("关闭助手").click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible();
  await expect(page.getByText("画布助手", { exact: true })).toHaveCount(0);
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
