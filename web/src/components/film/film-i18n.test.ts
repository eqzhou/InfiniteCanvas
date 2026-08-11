import { describe, expect, test } from "bun:test";

import { filmEnUS, filmZhCN } from "@/i18n/messages/film";

describe("Film localization catalog", () => {
  test("keeps complete locale parity under the Film namespace", () => {
    expect(Object.keys(filmEnUS).sort()).toEqual(Object.keys(filmZhCN).sort());
    expect(Object.keys(filmZhCN).length).toBeGreaterThan(100);
    for (const key of Object.keys(filmZhCN)) expect(key.startsWith("film.")).toBeTrue();
  });

  test("covers every production surface in both languages", () => {
    expect(filmZhCN["film.episodes.views.storyboard"]).toBe("故事板");
    expect(filmEnUS["film.episodes.views.storyboard"]).toBe("Storyboard");
    expect(filmZhCN["film.timeline.title"]).toBe("可视化剪辑台");
    expect(filmEnUS["film.timeline.title"]).toBe("Visual timeline editor");
    expect(filmZhCN["film.voice.identity"]).toBe("声音身份");
    expect(filmEnUS["film.voice.identity"]).toBe("Voice identity");
  });

  test("does not put user, model, or audit examples in translation values", () => {
    const values = Object.values({ ...filmZhCN, ...filmEnUS });
    for (const original of ["潮汐信号", "External screenplay", "gpt-text", "INT. ROOM"]) {
      expect(values).not.toContain(original);
    }
  });
});
