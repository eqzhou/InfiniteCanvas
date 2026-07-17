import { expect, test } from "@playwright/test";

test("formal local runtime persists projects, blobs, state, and Agent access", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByTitle("文本")).toBeVisible();
  await page.getByTitle("设置").click();
  await expect(page.getByRole("button", { name: "拉取文本模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取生图模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取视频模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "拉取音频模型" })).toBeVisible();
  await expect(page.getByText("API Key 经本地服务加密后存入 PostgreSQL，数据库中不保存明文。", { exact: false })).toBeVisible();
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

  await page.goto("/assets");
  const answers = ["Formal asset", "Stored in PostgreSQL"];
  page.on("dialog", async (dialog) => dialog.accept(answers.shift() ?? ""));
  await page.getByRole("button", { name: "新增文本" }).click();
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
  const listed = await request.get("/api/generation-jobs?projectId=formal-project&kind=image&page=1&pageSize=10");
  await expect(listed).toBeOK();
  await expect(listed.json()).resolves.toMatchObject({ page: 1, pageSize: 10, total: 1 });
  const deleted = await request.delete("/api/generation-jobs/formal-job-1");
  expect(deleted.status()).toBe(204);
});
