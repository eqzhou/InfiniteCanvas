import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodexModelControls, resolveCodexReasoningEffort } from "./CodexModelControls";

const noOp = () => undefined;

describe("CodexModelControls", () => {
  test("distinguishes loading, empty and failed catalogs", () => {
    const common = {
      models: [], model: "", effort: "", disabled: false,
      onModelChange: noOp, onEffortChange: noOp,
    };
    expect(renderToStaticMarkup(<CodexModelControls {...common} loading />))
      .toContain("正在读取当前账号模型");
    expect(renderToStaticMarkup(<CodexModelControls {...common} loading={false} />))
      .toContain("当前账号未返回可选模型");
    expect(renderToStaticMarkup(<CodexModelControls {...common} loading={false} error="offline" />))
      .toContain("模型目录暂不可用");
  });

  test("renders only the advertised model and reasoning choices", () => {
    const html = renderToStaticMarkup(<CodexModelControls
      models={[{
        id: "provider/model+preview",
        model: "provider/model+preview",
        displayName: "Preview Model",
        description: "Preview",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deep" },
        ],
        isDefault: true,
      }]}
      model="provider/model+preview"
      effort="high"
      disabled={false}
      loading={false}
      onModelChange={noOp}
      onEffortChange={noOp}
    />);
    expect(html).toContain('<option value="provider/model+preview" selected="">Preview Model</option>');
    expect(html).toContain('<option value="high" title="Deep" selected="">high</option>');
  });

  test("omits effort when the advertised model has no selectable efforts", () => {
    expect(resolveCodexReasoningEffort({
      id: "model", model: "model", displayName: "Model", description: "",
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [], isDefault: true,
    }, "medium")).toBe("");
  });
});
