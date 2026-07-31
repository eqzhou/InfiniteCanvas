import { describe, expect, test } from "bun:test";
import {
  audioRoleDefaultLabel,
  audioProtocolRequiresKey,
  audioProtocolSupportsServerJobs,
  audioFormatOptions,
  audioVoiceLabel,
  normalizeAudioRoles,
  resolveAudioVoice,
} from "@/lib/audio-provider";

describe("audio provider configuration", () => {
  test("routes supported cloud protocols through the unified server executor", () => {
    expect(audioProtocolSupportsServerJobs("openai")).toBe(true);
    expect(audioProtocolSupportsServerJobs("azure")).toBe(true);
    expect(audioProtocolSupportsServerJobs("edge")).toBe(true);
    expect(audioProtocolSupportsServerJobs("gemini")).toBe(false);
    expect(audioProtocolRequiresKey("openai")).toBe(true);
    expect(audioProtocolRequiresKey("azure")).toBe(true);
    expect(audioProtocolRequiresKey("edge")).toBe(false);
    expect(audioFormatOptions("edge")).toEqual(["mp3"]);
    expect(audioFormatOptions("azure")).toEqual(["mp3", "wav", "opus", "pcm"]);
  });

  test("normalizes immutable role mappings and resolves provider-specific voices", () => {
    const input = [{
      id: "narrator",
      name: "  旁白  ",
      voices: { azure: " zh-CN-XiaoxiaoNeural ", edge: "zh-CN-YunxiNeural" },
    }];
    const roles = normalizeAudioRoles(input);
    expect(roles).toEqual([{
      id: "narrator",
      name: "旁白",
      voices: { azure: "zh-CN-XiaoxiaoNeural", edge: "zh-CN-YunxiNeural" },
    }]);
    expect(roles).not.toBe(input);
    expect(resolveAudioVoice({ roles, roleId: "narrator", protocol: "edge", fallback: "alloy" }))
      .toBe("zh-CN-YunxiNeural");
    expect(resolveAudioVoice({ roles, roleId: "missing", protocol: "edge", fallback: "alloy" }))
      .toBe("zh-CN-XiaoxiaoNeural");
    expect(resolveAudioVoice({
      roles,
      roleId: "missing",
      protocol: "openai",
      fallback: "zh-CN-XiaoxiaoNeural",
      explicit: "zh-CN-YunxiNeural",
    })).toBe("alloy");
    expect(resolveAudioVoice({
      roles,
      roleId: "missing",
      protocol: "edge",
      fallback: "alloy",
      explicit: "custom-edge-voice",
    })).toBe("custom-edge-voice");
  });

  test("explains where an empty audio role list is configured", () => {
    expect(audioRoleDefaultLabel([])).toBe("未配置角色（请在项目中添加）");
    expect(audioRoleDefaultLabel([{ id: "narrator", name: "旁白", voices: {} }]))
      .toBe("无角色（使用默认声音）");
  });

  test("shows stable provider ids as readable Chinese voice names and genders", () => {
    expect(audioVoiceLabel("zh-CN-XiaoyiNeural")).toBe("晓伊（女声）");
    expect(audioVoiceLabel("zh-CN-YunjianNeural")).toBe("云健（男声）");
    expect(audioVoiceLabel("alloy")).toBe("合金（中性）");
    expect(audioVoiceLabel("custom-voice")).toBe("custom-voice");
  });
});
