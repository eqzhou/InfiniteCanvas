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

test("a sandboxed plugin node persists its state across reloads", async ({ page }) => {
  await openFreshBoard(page);
  await page.goto("/plugins");

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
  await expect(dialog).toContainText("node:read、node:write");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("已安装", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "安装清单" }).click();
  await page.getByRole("dialog", { name: "安装 Remote Note" })
    .getByRole("button", { name: "同意并安装" }).click();
  await expect(page.locator("article").filter({ hasText: "example.remote-note" })).toContainText("已安装");
});

test("Codex panel streams a message and handles explicit approval", async ({ page }) => {
  await openFreshBoard(page);
  let approvalBody: Record<string, unknown> | null = null;
  await page.route("**/api/agent/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: true, bridges: ["codex"], tools: [] }),
    });
  });
  await page.route("**/api/codex/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "session-e2e", threadId: "thread-e2e" }),
    });
  });
  await page.route("**/api/codex/message", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/codex/approval", async (route) => {
    approvalBody = JSON.parse(route.request().postData() ?? "null") as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/codex/events?sessionId=session-e2e", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'event: notification\ndata: {"type":"notification","method":"agent_message_delta","params":{"delta":"hello from Codex"}}\n\n',
        'event: approval\ndata: {"type":"approval","method":"item/tool/call","id":"approval-e2e","params":{"tool":"board.add_node"}}\n\n',
      ].join(""),
    });
  });

  await page.getByTitle("本地 Agent").click();
  await page.getByLabel("Local URL").fill("http://127.0.0.1:8790");
  await page.getByRole("button", { name: "连接" }).click();
  await page.getByRole("button", { name: "开始会话" }).click();
  await expect(page.getByText("hello from Codex")).toBeVisible();
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
