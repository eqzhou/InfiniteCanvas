import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAudioRoleNameDraft, AudioRoleEditor } from "./AudioRoleEditor";

describe("AudioRoleEditor", () => {
  test("renders persisted roles with the voice mapped for the active provider", () => {
    const html = renderToStaticMarkup(
      <AudioRoleEditor
        protocol="azure"
        roles={[{
          id: "narrator",
          name: "旁白",
          voices: { azure: "zh-CN-XiaoxiaoNeural", edge: "zh-CN-YunxiNeural" },
        }]}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("多角色配音");
    expect(html).toContain("角色只属于当前画布项目");
    expect(html).toContain("旁白");
    expect(html).toContain('<option value="zh-CN-XiaoxiaoNeural" selected="">晓晓（女声）</option>');
  });

  test("keeps the persisted role while its name is temporarily empty", () => {
    const roles = [{ id: "hero", name: "男主角", voices: { edge: "zh-CN-YunxiNeural" } }];
    expect(applyAudioRoleNameDraft(roles, "hero", "")).toBeNull();
    expect(roles[0]?.name).toBe("男主角");

    const renamed = applyAudioRoleNameDraft(roles, "hero", " 新男主 ");
    expect(renamed?.[0]?.name).toBe("新男主");
    expect(renamed).not.toBe(roles);
  });
});
