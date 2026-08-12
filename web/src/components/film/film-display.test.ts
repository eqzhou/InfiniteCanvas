import { describe, expect, it } from "bun:test";

import { translate } from "@/i18n/core";
import { localizeFilmDiagnostic, localizeFilmKind, localizeFilmStatus } from "./film-display";

describe("film display labels", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    it(`localizes stable statuses and delivery kinds in ${locale}`, () => {
      const t = (key: Parameters<typeof translate>[1], params?: Readonly<Record<string, string | number>>) => translate(locale, key, params);
      expect(localizeFilmStatus(t, "needs_review")).not.toBe("needs_review");
      expect(localizeFilmKind(t, "asset_bundle")).not.toBe("asset_bundle");
      expect(localizeFilmDiagnostic(t, "ffmpeg_unavailable")).not.toBe("ffmpeg_unavailable");
    });
  }
});
