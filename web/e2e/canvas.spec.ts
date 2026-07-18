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

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toHaveCount(0);
}

test("first launch creates and opens a board project", async ({ page }) => {
  await openFreshBoard(page);
  if ((page.viewportSize()?.width ?? 1440) >= 768) {
    await expect(page.locator('input[value="我的第一个画布"]')).toBeVisible();
    await expect(page.getByText("0 节点", { exact: false })).toBeVisible();
  }
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
  const header = video.locator("[data-node-header]");
  const box = await header.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 30, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 430, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");

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
  await expect(page.getByRole("button", { name: "新建文本" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "新建文本" })).toHaveCount(0);
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
  await page.getByLabel("视频模型").fill("seedance-1-0-pro-250528");
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
  await page.getByTitle("文本").click();
  const node = page.locator('[data-node-type="text"]');
  await node.locator('[title="文本"]').dblclick();
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
        data: Array.from({ length: 2 }, () => ({
          b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC",
        })),
      }),
    });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  const settings = page.getByRole("heading", { name: "设置" }).locator("..").locator("..");
  await settings.getByLabel("生图 URL").fill("https://mock.example/v1");
  await settings.getByLabel("生图 API Key").fill("test-only-key");
  await settings.getByLabel("生图模型").fill("mock-image-model");
  await settings.getByLabel("默认数量").fill("2");
  await settings.getByLabel("全局系统提示词").fill("Use a crisp editorial style.");
  await closeSettings(page);

  await page.getByTitle("文本").click();
  await page.getByPlaceholder("写下提示词或说明…").fill("a red square");
  await page.getByTitle("生图").click();

  await expect(page.locator('[data-node-type="config"]')).toHaveCount(1);
  await expect(page.locator('[data-node-type="config"]').getByText("a red square", { exact: true }))
    .toBeVisible();
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
  await page.getByLabel("生图模型").fill("retry-flow-image");
  await closeSettings(page);

  await page.getByTitle("文本").click();
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

  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("文本 URL").fill("https://batch.example/v1");
  await page.getByLabel("文本 API Key").fill("batch-test-key");
  await page.getByLabel("文本模型").fill("batch-text-model");
  await page.getByLabel("生图 URL").fill("https://batch.example/v1");
  await page.getByLabel("生图 API Key").fill("batch-test-key");
  await page.getByLabel("生图模型").fill("batch-image-model");
  await page.getByLabel("默认数量").fill("1");
  await page.getByLabel("全局系统提示词").fill("Return one concise alternative.");
  await closeSettings(page);

  await page.getByTitle("文本").click();
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
  await page.getByLabel("生图模型").fill("workbench-image");
  await closeSettings(page);

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

  await page.goto("/workbench/image");
  const retainedHistory = page.locator("article").filter({ hasText: "workbench square" });
  await retainedHistory.getByTitle("删除").click();
  await expect(retainedHistory).toHaveCount(0);
  await page.goto("/");
  await page.reload();
  await expect(page.locator('[data-node-type="image"] img[alt="工作台图片"]')).toBeVisible();
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
  await page.getByLabel("生图模型").fill("cancel-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await page.getByLabel("提示词").fill("cancel then retry");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.getByTitle("停止")).toBeEnabled();
  await page.getByTitle("停止").click();

  const cancelled = page.locator("article").filter({ hasText: "cancel then retry" });
  await expect(cancelled).toContainText("cancelled");
  await cancelled.getByTitle("重试").click();
  await expect.poll(() => requests).toBe(2);
  const jobs = page.locator("article").filter({ hasText: "cancel then retry" });
  await expect(jobs.filter({ hasText: "succeeded" })).toHaveCount(1);
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
  await page.getByLabel("生图模型").fill("missing-reference-image");
  await closeSettings(page);

  await page.goto("/workbench/image");
  await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open("openboard-app");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("app_state", "readonly")
        .objectStore("app_state")
        .get("openboard:projects");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const projectId = Array.isArray(request.result) ? request.result[0]?.id : undefined;
        database.close();
        if (typeof projectId === "string") resolve(projectId);
        else reject(new Error("active test project is missing"));
      };
    };
  }).then((projectId) => new Promise<void>((resolve, reject) => {
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
        providerId: "default",
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
  await page.getByLabel("视频模型").fill("doubao-seedance-2.0");
  await closeSettings(page);

  await page.goto("/workbench/video");
  await page.getByLabel("提示词").fill("orbiting product shot");
  await page.getByLabel("生成声音").check();
  await page.getByLabel("水印").check();
  await page.getByRole("button", { name: "生成", exact: true }).click();

  const history = page.locator("article").filter({ hasText: "orbiting product shot" });
  await expect(history).toContainText("succeeded");
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

  await page.goto("/plugins");
  const enabled = page.getByLabel("便签 已启用");
  await enabled.uncheck();
  await expect(stickyCard.getByRole("button", { name: "添加到画布" })).toBeDisabled();
  await page.goto("/");
  await expect(page.getByText("插件不可用", { exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容")).toHaveCount(0);

  await page.goto("/plugins");
  await expect(page.getByLabel("便签 已启用")).not.toBeChecked();
  await page.getByLabel("便签 已启用").check();
  await page.goto("/");
  await expect(page.frameLocator('iframe[title="便签 插件"]').getByLabel("便签内容"))
    .toHaveValue("plugin state from Playwright");
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

test("image reverse prompt creates a connected text node", async ({ page }) => {
  await page.route("https://vision.example/v1/responses", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ output_text: "studio light, red square" }) });
  });
  await openFreshBoard(page);
  await page.getByTitle("设置").click();
  await page.getByLabel("文本 URL").fill("https://vision.example/v1");
  await page.getByLabel("文本 API Key").fill("vision-test-key");
  await page.getByLabel("文本模型").fill("vision-model");
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
  await page.getByLabel("视频模型").fill("video-model");
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
  await page.getByLabel("视频模型").fill("chip-video-model");
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
  const detailButton = promptCard.getByRole("button", { name: "详情" });
  await expect(detailButton).toBeVisible();
  await detailButton.focus();
  await detailButton.press("Enter");

  const dialog = page.getByRole("dialog", { name: "产品棚拍" });
  await expect(dialog).toContainText("Studio product photo");
  await dialog.getByRole("button", { name: "插入当前画布文本节点" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue(
    /Studio product photo/,
  );
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
  await firstSource.getByTitle("移除提示词源").click();
  await page.reload();
  await expect(page.locator("li").filter({ hasText: sources[0] })).toHaveCount(0);
  await expect(page.locator("li").filter({ hasText: sources[1] })).toBeVisible();
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

test("local Agent connects to the real Go service with a session token", async ({ page }) => {
  await openFreshBoard(page);
  await page.getByTitle("本地 Agent").click();
  await expect(page.getByLabel("Local URL")).toHaveValue(new URL(page.url()).origin);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByLabel("Local URL").fill(agentUrl);
  await page.getByLabel("Connect token").fill("e2e-token");
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
  await page.route("**/api/projects/*", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary sync failure" }),
    });
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
