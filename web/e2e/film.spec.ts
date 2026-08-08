import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const runId = process.env.OPENBOARD_E2E_RUN_ID ?? `${Date.now()}-${process.pid}`;

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
  await page.goto("/");
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await page.getByTitle("新建").click();
  await page.getByRole("button", { name: /影片制作/ }).click();

  await expect(page).toHaveURL(/\/film\/[A-Za-z0-9_-]+$/);
  await expect(page.getByTestId("film-workbench")).toBeVisible();
  await page.getByLabel("纯文本或 Markdown 剧本").fill([
    "EPISODE 1 — Arrival",
    "INT. OBSERVATORY - NIGHT",
    "Mira opens the brass dome. The telescope turns toward a green comet.",
  ].join("\n"));
  await page.getByRole("button", { name: "导入并拆解" }).click();

  const decompose = page.getByTestId("film-stage-decompose");
  await expect(decompose).toContainText("needs_review");
  await decompose.getByRole("button", { name: "批准" }).click();
  await expect(decompose).toContainText("approved");

  await page.getByRole("button", { name: "运行检查" }).click();
  await expect(page.getByText(/个问题，/)).toBeVisible();
  await page.getByRole("button", { name: "请求导出" }).click();
  await expect(page.getByText("Production manifest")).toBeVisible();
});
