import { describe, expect, test } from "bun:test";
import {
  normalizeKlingVideoParameters,
  validateKlingVideoParameters,
  type KlingVideoParameters,
} from "@/lib/kling-video";

function fixture(patch: Partial<KlingVideoParameters> = {}): KlingVideoParameters {
  return {
    model: "kling-v3",
    prompt: "  a crane over a city  ",
    negativePrompt: "  blur  ",
    mode: "pro",
    duration: 6,
    aspectRatio: "16:9",
    audio: false,
    watermark: false,
    imageUrls: [],
    multiShot: false,
    shotType: "intelligence",
    shots: [],
    elements: [],
    ...patch,
  };
}

describe("Kling video parameters", () => {
  test("normalizes into a detached value and removes inactive multi-shot fields", () => {
    const input = fixture({
      imageUrls: [" https://cdn.example/first.png "],
      shots: [{ index: 9, prompt: " stale ", duration: 6 }],
      elements: [{ name: " dog ", description: " gold ", imageUrls: [" https://cdn.example/dog.png "] }],
    });
    const output = normalizeKlingVideoParameters(input);
    expect(output).toMatchObject({
      prompt: "a crane over a city",
      negativePrompt: "blur",
      imageUrls: ["https://cdn.example/first.png"],
      shots: [],
      elements: [{ name: "dog", description: "gold", imageUrls: ["https://cdn.example/dog.png"] }],
    });
    expect(output).not.toBe(input);
    expect(output.imageUrls).not.toBe(input.imageUrls);
    expect(output.elements).not.toBe(input.elements);
  });

  test("accepts v3 custom shots only when indexes and durations are exact", () => {
    const valid = fixture({
      prompt: "",
      duration: 6,
      multiShot: true,
      shotType: "customize",
      shots: [
        { index: 1, prompt: "wide", duration: 2 },
        { index: 2, prompt: "close", duration: 4 },
      ],
    });
    expect(validateKlingVideoParameters(valid).shots).toHaveLength(2);
    expect(() => validateKlingVideoParameters({ ...valid, shots: [{ index: 2, prompt: "bad", duration: 6 }] }))
      .toThrow("镜头序号必须从 1 连续排列");
    expect(() => validateKlingVideoParameters({ ...valid, shots: [{ index: 1, prompt: "bad", duration: 5 }] }))
      .toThrow("镜头时长总和必须等于视频时长");
  });

  test("enforces Kling 2.6 mode, last-frame, audio and duration constraints", () => {
    const base = fixture({ model: "kling-v2-6", mode: "std", duration: 5 });
    expect(() => validateKlingVideoParameters({ ...base, audio: true })).toThrow("标准模式不支持音频");
    expect(() => validateKlingVideoParameters({ ...base, imageUrls: ["https://a.example/1.png", "https://a.example/2.png"] }))
      .toThrow("标准模式不支持尾帧");
    expect(() => validateKlingVideoParameters({ ...base, mode: "pro", audio: true, imageUrls: ["https://a.example/1.png", "https://a.example/2.png"] }))
      .toThrow("尾帧与音频不能同时使用");
    expect(() => validateKlingVideoParameters({ ...base, duration: 6 })).toThrow("仅支持 5 或 10 秒");
  });

  test("enforces v3 shot, element, URL and string boundaries", () => {
    expect(() => validateKlingVideoParameters(fixture({ imageUrls: ["javascript:alert(1)"] }))).toThrow("参考图片 URL 无效");
    expect(() => validateKlingVideoParameters(fixture({ elements: [{ name: "dog", description: "gold", imageUrls: ["https://a.example/one.png"] }] })))
      .toThrow("每个元素需要 2-4 张参考图片");
    expect(() => validateKlingVideoParameters(fixture({ negativePrompt: "x".repeat(2501) }))).toThrow("负面提示词过长");
    expect(() => validateKlingVideoParameters(fixture({ mode: "4k", duration: 15, audio: true }))).not.toThrow();
  });
});
