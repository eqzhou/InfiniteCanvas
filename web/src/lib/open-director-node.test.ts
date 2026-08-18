import { describe, expect, test } from "bun:test";

import { getOpenDirectorNodeId, setOpenDirectorNodeId, subscribeOpenDirectorNodeId } from "./open-director-node";

describe("open director session pin", () => {
  test("notifies subscribers and can be cleared", () => {
    setOpenDirectorNodeId(null);
    const seen: Array<string | null> = [];
    const stop = subscribeOpenDirectorNodeId(() => seen.push(getOpenDirectorNodeId()));
    setOpenDirectorNodeId("director-1");
    setOpenDirectorNodeId("director-1");
    setOpenDirectorNodeId(null);
    stop();
    setOpenDirectorNodeId("director-2");
    expect(seen).toEqual(["director-1", null]);
    setOpenDirectorNodeId(null);
  });
});
