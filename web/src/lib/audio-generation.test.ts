import { describe, expect, test } from "bun:test";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { audioJobParameters, audioSpeechOptions } from "./audio-generation";

describe("audio generation option resolution", () => {
  test("uses tenant defaults while preserving optional provider settings", () => {
    const defaults = {
      ...DEFAULT_GENERATION_DEFAULTS,
      audioVoice: "tenant-voice",
      audioFormat: "wav",
      audioSpeed: 1.25,
      audioInstructions: "  Calm delivery  ",
    };

    expect(audioSpeechOptions("  node-voice  ", defaults)).toEqual({
      voice: "node-voice",
      format: "wav",
      speed: 1.25,
      instructions: "Calm delivery",
    });
  });

  test("omits unset optional values and shares the durable job contract", () => {
    const defaults = {
      ...DEFAULT_GENERATION_DEFAULTS,
      audioVoice: "fallback",
      audioSpeed: 0,
      audioInstructions: "   ",
    };

    expect(audioJobParameters(" ", defaults)).toEqual({
      voice: "fallback",
      format: defaults.audioFormat,
    });
    expect(audioSpeechOptions(undefined, undefined).voice).toBe(DEFAULT_GENERATION_DEFAULTS.audioVoice);
  });
});
