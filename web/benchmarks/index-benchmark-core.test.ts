import { describe, expect, test } from "bun:test";

import {
  assertEdgeQueryCorrect,
  assertSpatialQueryCorrect,
  createBenchmarkDataset,
  percentile,
} from "./index-benchmark-core";

describe("index benchmark utilities", () => {
  test("generates repeatable graph data from a fixed seed", () => {
    const first = createBenchmarkDataset({ nodeCount: 25, edgeCount: 60, seed: 0x5eed });
    const second = createBenchmarkDataset({ nodeCount: 25, edgeCount: 60, seed: 0x5eed });
    const different = createBenchmarkDataset({ nodeCount: 25, edgeCount: 60, seed: 0x5eee });

    expect(second).toEqual(first);
    expect(different.nodes).not.toEqual(first.nodes);
    expect(first.nodes).toHaveLength(25);
    expect(first.edges).toHaveLength(60);
    expect(first.queries).toHaveLength(128);
    expect(first.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  test("rejects invalid scenario sizes", () => {
    expect(() => createBenchmarkDataset({ nodeCount: 0, edgeCount: 1, seed: 1 })).toThrow();
    expect(() => createBenchmarkDataset({ nodeCount: 1.5, edgeCount: 1, seed: 1 })).toThrow();
    expect(() => createBenchmarkDataset({ nodeCount: 2, edgeCount: -1, seed: 1 })).toThrow();
  });

  test("calculates nearest-rank percentiles without mutating samples", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(percentile(samples, 0.5)).toBe(5);
    expect(percentile(samples, 0.95)).toBe(9);
    expect(samples).toEqual([9, 1, 5, 3, 7]);
  });

  test("compares spatial results by identity and stacking order", () => {
    const { nodes } = createBenchmarkDataset({ nodeCount: 10, edgeCount: 0, seed: 3 });
    const rect = { x: -1_000_000, y: -1_000_000, w: 2_000_000, h: 2_000_000 };

    expect(() => assertSpatialQueryCorrect(nodes, rect, nodes)).not.toThrow();
    expect(() => assertSpatialQueryCorrect(nodes, rect, [...nodes].reverse())).toThrow(
      /spatial query mismatch/,
    );
  });

  test("compares edge results by identity and source order", () => {
    const { edges } = createBenchmarkDataset({ nodeCount: 10, edgeCount: 20, seed: 4 });
    const allNodeIds = new Set(Array.from({ length: 10 }, (_, index) => `node-${index}`));

    expect(() => assertEdgeQueryCorrect(edges, allNodeIds, edges)).not.toThrow();
    expect(() => assertEdgeQueryCorrect(edges, allNodeIds, edges.slice(1))).toThrow(
      /edge query mismatch/,
    );
  });
});
