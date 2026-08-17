import { describe, expect, test } from "bun:test";
import { prefetchRoutePath, preloadRouteChunk, routeChunkForPath } from "./route-registry";

describe("route registry", () => {
  test("deduplicates chunk preloads", () => {
    expect(preloadRouteChunk("assets")).toBe(preloadRouteChunk("assets"));
  });

  test("maps menu destinations to chunks", () => {
    expect(routeChunkForPath["/assets"]).toBe("assets");
    expect(routeChunkForPath["/prompts"]).toBe("prompts");
    expect(routeChunkForPath["/"]).toBe("home");
  });

  test("prefetches parameterized film routes", () => {
    expect(prefetchRoutePath("/film/proj-1")).toBe(preloadRouteChunk("filmWorkbench"));
    expect(prefetchRoutePath("/")).toBe(preloadRouteChunk("home"));
  });
});
