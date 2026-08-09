import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const runId = process.env.OPENBOARD_E2E_RUN_ID ?? `${Date.now()}-${process.pid}`;
function pdfFixture(text?: string): Buffer {
  const content = text ? `BT\n(${text.replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\n", "\\n")}) Tj\nET` : "q\nQ";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object) => { const offset = Buffer.byteLength(body); body += object; return offset; });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 5\n0000000000 65535 f\n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n`).join("\n")}\n`;
  body += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body);
}

const textLayerPDF = pdfFixture("EPISODE 1\nINT. PDF STAGE - DAY\nA text layer rolls.");

async function createFilmProject(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  const createButton = page.getByTitle("新建");
  if (!await createButton.isVisible()) {
    await page.getByRole("button", { name: /打开项目侧栏|展开侧栏/ }).click();
  }
  await expect(createButton).toBeVisible();
  await createButton.click();
  await page.getByRole("button", { name: /影片制作/ }).click();
  await expect(page).toHaveURL(/\/film\/[A-Za-z0-9_-]+$/);
  await expect(page.getByTestId("film-workbench")).toBeVisible();
}

test.beforeEach(async ({ context, request }, testInfo) => {
  const suffix = createHash("sha256")
    .update(`${runId}:${testInfo.project.name}:${testInfo.testId}:${testInfo.retry}`)
    .digest("hex")
    .slice(0, 24);
  const tenantId = `e2e-${suffix}`;
  const response = await request.post("/api/e2e/tenant", {
    headers: { "X-OpenBoard-E2E-Token": "e2e-tenant-token" },
    data: { tenantId },
  });
  expect(response).toBeOK();
  await context.setExtraHTTPHeaders({
    "X-OpenBoard-E2E-Tenant": tenantId,
    "X-OpenBoard-E2E-Token": "e2e-tenant-token",
  });
});

test("creates a film, imports a manuscript, approves decomposition, validates, and exports", async ({ page }) => {
  await createFilmProject(page);
  await page.getByLabel("粘贴剧本原稿").fill([
    "EPISODE 1 — Arrival",
    "INT. OBSERVATORY - NIGHT",
    "Mira opens the brass dome. The telescope turns toward a green comet.",
  ].join("\n"));
  await page.getByRole("button", { name: "导入并拆解" }).click();

  const decompose = page.getByTestId("film-stage-decompose");
  await expect(decompose).toContainText("needs_review");
  await decompose.getByRole("button", { name: "批准" }).click();
  await expect(decompose).toContainText("approved");

  const projectId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "刷新到真实画布" }).click();
  await expect(page.getByRole("status").filter({ hasText: "真实画布" })).toBeVisible();
  await expect.poll(async () => page.evaluate(async (id) => {
    const project = await (await fetch(`/api/projects/${id}`)).json();
    return project.nodes?.filter((node: { metadata?: { filmProjectionKey?: string } }) => node.metadata?.filmProjectionKey).length ?? 0;
  }, projectId)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "运行检查" }).click();
  await expect(page.getByText(/个问题，/)).toBeVisible();
  await page.getByRole("button", { name: "请求导出" }).click();
  await expect(page.getByText("Production manifest")).toBeVisible();
  await expect(page.getByText("manifest · approved")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载" })).toBeVisible();
});

test("preflights imports, edits a multitrack timeline, and surfaces revision conflicts", async ({ page }) => {
  await createFilmProject(page);

  await expect(page.getByTestId("film-format-pdf")).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("film-manuscript-file").setInputFiles({
    name: "text-layer.pdf",
    mimeType: "application/pdf",
    buffer: textLayerPDF,
  });
  await expect(page.getByTestId("film-stage-decompose")).toContainText("needs_review");

  await page.getByTestId("film-manuscript-file").setInputFiles({
    name: "scan.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(),
  });
  await expect(page.getByRole("alert").filter({ hasText: "请先 OCR" })).toBeVisible();

  await page.getByTestId("film-manuscript-file").setInputFiles({
    name: "workbench.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("EPISODE 1\nINT. MIX STAGE - NIGHT\nA fader rises."),
  });
  await expect(page.getByTestId("film-stage-decompose")).toContainText("needs_review");

  await page.getByRole("button", { name: "添加 video 片段" }).click();
  await page.getByRole("button", { name: "添加 subtitle 片段" }).click();
  const subtitle = page.getByTestId("timeline-track-subtitle").getByTestId("timeline-clip").first();
  await subtitle.getByLabel("字幕文本").fill("Mix ready");
  await subtitle.getByLabel("出点").fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "入点必须早于出点" })).toBeVisible();
  await subtitle.getByLabel("出点").fill("2");
  await page.getByRole("button", { name: "保存时间线" }).click();
  await expect(page.getByRole("status")).toContainText("时间线已保存");

  await page.getByLabel("资产类型").selectOption("style");
  await page.getByLabel("资产名称").fill("Noir dusk");
  await page.getByRole("button", { name: "添加资产" }).click();
  const asset = page.getByTestId(/^film-asset-/).first();
  const assetId = (await asset.getAttribute("data-testid"))!.replace("film-asset-", "");
  const revision = Number(await asset.getAttribute("data-revision"));
  await page.evaluate(async ({ projectId, assetId, revision }) => {
    await fetch(`/api/film/projects/${projectId}/assets/${assetId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, title: "Server edit" }),
    });
  }, { projectId: page.url().split("/").pop()!, assetId, revision });
  await asset.getByLabel("资产名称编辑").fill("Stale local edit");
  await asset.getByRole("button", { name: "保存资产" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "修订冲突" })).toBeVisible();
});

test("runs a scoped generation pass and retries one failed shot job", async ({ page }) => {
  await createFilmProject(page);
  await page.getByLabel("粘贴剧本原稿").fill("EPISODE 1\nINT. STAGE - NIGHT\nA camera rolls.");
  await page.getByRole("button", { name: "导入并拆解" }).click();
  await expect(page.getByTestId("film-stage-decompose")).toContainText("needs_review");
  const projectId = page.url().split("/").pop()!;
  const response = await page.evaluate(async (id) => (await fetch(`/api/film/projects/${id}/status`)).json(), projectId);
  const capable = {
    ...response,
    data: {
      ...response.data,
      stages: response.data.stages.map((stage: { id: string; status: string }) => ({
        ...stage,
        status: ["decompose", "script", "storyboard"].includes(stage.id) ? "approved" : stage.status,
      })),
      tasks: [...response.data.tasks, {
        id: "task-1", revision: 1, stage: "video", title: "Shot 1", status: "failed", progress: 0,
        shotId: response.data.shots[0].id, generationJobId: "child-1",
        createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z",
      }],
    },
    capabilities: {
      ...response.capabilities,
      stageGeneration: true,
      generationJobs: true,
      generationStages: { storyboard: false, audio: false, video: true },
    },
  };
  let retried = false;
  let runBody: Record<string, unknown> | undefined;

  await page.route(`**/api/film/projects/${projectId}/status`, (route) => route.fulfill({ json: capable }));
  await page.route(`**/api/film/projects/${projectId}/stages/video/run`, async (route) => {
    runBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: capable });
  });
  await page.route(`**/api/film/projects/${projectId}/stages/video/sync`, (route) => route.fulfill({ json: capable }));
  await page.route(`**/api/film/projects/${projectId}/generation-jobs**`, async (route) => {
    if (route.request().url().endsWith("/child-1/retry")) {
      retried = true;
      await route.fulfill({ json: { data: {
        id: "child-1", parentJobId: "parent-1", shotId: "shot-1", stage: "video", status: "needs_review",
        title: "Shot 1", createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:01:00Z",
      } } });
      return;
    }
    await route.fulfill({ json: { data: [
      { id: "parent-1", stage: "video", status: "running", title: "Video pass", createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z" },
      { id: "child-1", parentJobId: "parent-1", shotId: "shot-1", stage: "video", status: retried ? "needs_review" : "failed", title: "Shot 1", error: "provider timeout", createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z" },
    ] } });
  });
  await page.reload();

  await page.getByLabel("运行阶段").selectOption("video");
  await page.getByLabel("Provider").fill("studio-provider");
  await page.getByLabel("Model").fill("video-v2");
  await page.getByLabel("幂等键").fill("video-pass-0001");
  await expect(page.getByLabel("Provider")).toHaveValue("studio-provider");
  await expect(page.getByLabel("Model")).toHaveValue("video-v2");
  const startGeneration = page.getByRole("button", { name: "开始生成" });
  await expect(startGeneration).toBeEnabled();
  await startGeneration.click();
  await expect.poll(() => runBody?.providerId).toBe("studio-provider");
  const child = page.getByTestId("generation-job-child-1");
  await expect(child).toContainText("failed");
  await child.getByRole("button", { name: "重试镜头" }).click();
  await expect(child).toContainText("needs_review");
  await expect(child).not.toContainText("approved");
});
