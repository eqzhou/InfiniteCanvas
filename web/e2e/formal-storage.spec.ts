import { expect, test } from "@playwright/test";

test("formal local runtime persists projects, blobs, state, and Agent access", async ({ page, request }) => {
  await page.route("https://formal-prompts.example/catalog.json", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ payload: { entries: [{ label: "Formal prompt", value: "persisted prompt source body" }] } }),
  }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "文本", exact: true })).toBeVisible();
  await page.getByTitle("设置").click();
  await expect(page.getByRole("button", { name: "拉取文本模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取生图模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取视频模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取音频模型" })).toBeVisible();
  const encryptionNotice = page.getByText("API Key 经本地服务加密后存入 PostgreSQL，数据库中不保存明文。", { exact: false });
  await encryptionNotice.scrollIntoViewIfNeeded();
  await expect(encryptionNotice).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByTitle("文本").click();
  const editor = page.getByPlaceholder("写下提示词或说明…");
  await editor.fill("formal PostgreSQL persistence");

  await expect.poll(async () => {
    const projects = await request.get("/api/projects");
    const summaries = await projects.json() as Array<{ id: string }>;
    for (const project of summaries) {
      const response = await request.get(`/api/projects/${encodeURIComponent(project.id)}`);
      const document = await response.json() as { nodes?: Array<{ metadata?: { content?: string } }> };
      if (document.nodes?.some((node) => node.metadata?.content === "formal PostgreSQL persistence")) return true;
    }
    return false;
  }).toBe(true);

  const imageInput = page.locator('input[type="file"][accept="image/*"]').first();
  await imageInput.setInputFiles({
    name: "formal-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+eN3oAAAAAElFTkSuQmCC", "base64"),
  });
  await expect(page.locator('img[alt="图片"]').first()).toBeVisible();
  await expect.poll(async () => {
    const projects = await request.get("/api/projects");
    const summaries = await projects.json() as Array<{ id: string }>;
    for (const project of summaries) {
      const response = await request.get(`/api/projects/${encodeURIComponent(project.id)}`);
      const document = await response.json() as { nodes?: Array<{ type?: string; metadata?: { storageKey?: string } }> };
      if (document.nodes?.some((node) => node.type === "image" && node.metadata?.storageKey)) return true;
    }
    return false;
  }).toBe(true);

  await page.reload();
  await expect(page.getByPlaceholder("写下提示词或说明…")).toHaveValue("formal PostgreSQL persistence");
  await expect(page.locator('img[alt="图片"]').first()).toBeVisible();

  await page.goto("/prompts");
  await page.getByRole("button", { name: "管理来源" }).click();
  let sourceManager = page.getByRole("dialog", { name: "管理提示词来源" });
  await sourceManager.getByLabel("来源名称").fill("Formal source");
  await sourceManager.getByLabel("来源解析格式").selectOption("json");
  await sourceManager.getByLabel("来源 URL").fill("https://formal-prompts.example/catalog.json");
  await sourceManager.getByLabel("条目路径").fill("payload.entries");
  await sourceManager.getByLabel("标题路径").fill("label");
  await sourceManager.getByLabel("正文路径").fill("value");
  await sourceManager.getByRole("button", { name: "保存来源" }).click();
  await sourceManager.getByRole("button", { name: "刷新" }).click();
  await sourceManager.getByTitle("关闭来源管理").click();
  await expect(page.getByText("Formal prompt", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Formal prompt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管理来源" }).click();
  sourceManager = page.getByRole("dialog", { name: "管理提示词来源" });
  await expect(sourceManager.getByRole("listitem").filter({ hasText: "Formal source" })).toBeVisible();
  await sourceManager.getByTitle("关闭来源管理").click();

  await page.goto("/assets");
  await page.getByRole("button", { name: "新增文本" }).click();
  const creator = page.getByRole("dialog", { name: "新增素材" });
  await creator.getByLabel("标题").fill("Formal asset");
  await creator.getByLabel("内容").fill("Stored in PostgreSQL");
  await creator.getByRole("button", { name: "保存" }).click();
  await expect(creator).toHaveCount(0);
  await expect(page.locator("article").filter({ hasText: "Formal asset" })).toBeVisible();
  await page.reload();
  await expect(page.locator("article").filter({ hasText: "Formal asset" })).toBeVisible();

  await page.goto("/");
  await page.getByTitle("本地 Agent").click();
  await page.getByLabel("Local URL").fill("http://127.0.0.1:8793");
  await page.getByLabel("Connect token").fill("e2e-token");
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByText("board.list_nodes", { exact: true })).toBeVisible();

  const health = await request.get("/api/health");
  await expect(health).toBeOK();
  await expect(health.json()).resolves.toMatchObject({ storage: "postgresql+redis" });

  const generation = {
    id: "formal-job-1",
    projectId: "formal-project",
    kind: "image",
    status: "succeeded",
    prompt: "formal generation",
    providerId: "mock-provider",
    model: "mock-image",
    parameters: { size: "1024x1024" },
    result: { items: [] },
  };
  const created = await request.post("/api/generation-jobs", { data: generation });
  await expect(created).toBeOK();
  expect(created.status()).toBe(201);
  const createdJob = await created.json() as Record<string, unknown>;
  const listed = await request.get("/api/generation-jobs?projectId=formal-project&kind=image&page=1&pageSize=10");
  await expect(listed).toBeOK();
  await expect(listed.json()).resolves.toMatchObject({ page: 1, pageSize: 10, total: 1 });
  const restoredAt = "2026-07-01T02:03:04.567Z";
  const replaced = await request.put("/api/generation-jobs", { data: [
    createdJob,
    {
      ...generation,
      id: "formal-job-restored",
      prompt: "restored generation",
      createdAt: restoredAt,
      updatedAt: restoredAt,
    },
  ] });
  expect(replaced.status()).toBe(204);
  const restored = await request.get("/api/generation-jobs/formal-job-restored");
  await expect(restored).toBeOK();
  await expect(restored.json()).resolves.toMatchObject({
    id: "formal-job-restored",
    createdAt: restoredAt,
    updatedAt: restoredAt,
  });
  const ownerClientId = await page.evaluate(() => sessionStorage.getItem("openboard:runtime-owner-id"));
  expect(ownerClientId).toMatch(/^owner-[A-Za-z0-9]+$/);
  const orphaned = await request.post("/api/generation-jobs", { data: {
    ...generation,
    id: "formal-job-orphaned",
    status: "running",
    prompt: "interrupted by reload",
    parameters: { ownerClientId },
  } });
  await expect(orphaned).toBeOK();
  await page.reload();
  await expect(page.getByRole("button", { name: "文本", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get("/api/generation-jobs/formal-job-orphaned");
    return await response.json() as { status?: string; error?: string };
  }).toMatchObject({ status: "failed", error: "页面刷新后任务已中断，请重试" });
  const cleared = await request.put("/api/generation-jobs", { data: [] });
  expect(cleared.status()).toBe(204);
});
