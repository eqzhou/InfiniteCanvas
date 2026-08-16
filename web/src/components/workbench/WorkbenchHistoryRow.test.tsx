import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerationJob } from "@/types/board";
import { WorkbenchHistoryRow } from "./WorkbenchHistoryRow";

const job: GenerationJob = {
  id: "job-1",
  projectId: "project-1",
  kind: "image",
  status: "succeeded",
  prompt: "角色权限测试",
  providerId: "provider-1",
  model: "image-model",
  parameters: {},
  result: { items: [] },
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

describe("WorkbenchHistoryRow permissions", () => {
  test("omits the tenant-wide delete control when no owner callback is provided", () => {
    const html = renderToStaticMarkup(
      <WorkbenchHistoryRow
        job={job}
        onRefill={() => undefined}
        onRetry={() => undefined}
        onInsert={async () => undefined}
      />,
    );

    expect(html).not.toContain('title="删除"');
    expect(html).toContain('title="重试"');
  });

  test("renders the delete control for an owner callback", () => {
    const html = renderToStaticMarkup(
      <WorkbenchHistoryRow
        job={job}
        onRefill={() => undefined}
        onRetry={() => undefined}
        onInsert={async () => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain('title="删除"');
  });
});
