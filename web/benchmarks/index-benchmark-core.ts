import type { BoardEdge, BoardNode } from "../src/types/board";

export type BenchmarkRect = { x: number; y: number; w: number; h: number };

export type BenchmarkDatasetOptions = {
  nodeCount: number;
  edgeCount: number;
  seed: number;
};

export type BenchmarkDataset = {
  nodes: BoardNode[];
  edges: BoardEdge[];
  queries: BenchmarkRect[];
};

const QUERY_COUNT = 128;

export function createBenchmarkDataset(options: BenchmarkDatasetOptions): BenchmarkDataset {
  validateCount(options.nodeCount, "nodeCount", false);
  validateCount(options.edgeCount, "edgeCount", true);
  if (!Number.isSafeInteger(options.seed)) throw new Error("seed must be a safe integer");

  const random = createSeededRandom(options.seed);
  const worldSize = Math.max(12_000, Math.ceil(Math.sqrt(options.nodeCount)) * 900);
  const nodes = Array.from({ length: options.nodeCount }, (_, index): BoardNode => {
    const width = 180 + Math.floor(random() * 321);
    const height = 120 + Math.floor(random() * 281);
    return {
      id: `node-${index}`,
      type: index % 7 === 0 ? "image" : "text",
      title: `Benchmark node ${index}`,
      position: {
        x: Math.floor((random() - 0.5) * worldSize),
        y: Math.floor((random() - 0.5) * worldSize),
      },
      width,
      height,
      metadata: {},
    };
  });
  const edges = Array.from({ length: options.edgeCount }, (_, index): BoardEdge => {
    const fromIndex = Math.floor(random() * options.nodeCount);
    const toOffset = 1 + Math.floor(random() * (options.nodeCount - 1));
    return {
      id: `edge-${index}`,
      from: `node-${fromIndex}`,
      to: `node-${(fromIndex + toOffset) % options.nodeCount}`,
    };
  });
  const queries = Array.from({ length: QUERY_COUNT }, (): BenchmarkRect => {
    const w = 1_200 + Math.floor(random() * 2_401);
    const h = 800 + Math.floor(random() * 1_601);
    return {
      x: Math.floor((random() - 0.5) * worldSize),
      y: Math.floor((random() - 0.5) * worldSize),
      w,
      h,
    };
  });

  return { nodes, edges, queries };
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error("percentile requires at least one sample");
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error("quantile must be greater than 0 and at most 1");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

export function assertSpatialQueryCorrect(
  nodes: readonly BoardNode[],
  rect: BenchmarkRect,
  actual: readonly BoardNode[],
): void {
  const expected = nodes.filter((node) => rectanglesIntersect(rect, node));
  assertOrderedIds("spatial query", expected, actual);
}

export function assertEdgeQueryCorrect(
  edges: readonly BoardEdge[],
  nodeIds: ReadonlySet<string>,
  actual: readonly BoardEdge[],
): void {
  const expected = edges.filter((edge) => nodeIds.has(edge.from) || nodeIds.has(edge.to));
  assertOrderedIds("edge query", expected, actual);
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function validateCount(value: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 2)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "greater-than-one"} integer`);
  }
}

function rectanglesIntersect(rect: BenchmarkRect, node: BoardNode): boolean {
  return (
    rect.x < node.position.x + node.width &&
    rect.x + rect.w > node.position.x &&
    rect.y < node.position.y + node.height &&
    rect.y + rect.h > node.position.y
  );
}

function assertOrderedIds(
  label: string,
  expected: readonly { id: string }[],
  actual: readonly { id: string }[],
): void {
  if (expected.length !== actual.length) {
    throw new Error(`${label} mismatch: expected ${expected.length} results, received ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].id !== actual[index].id) {
      throw new Error(
        `${label} mismatch at index ${index}: expected ${expected[index].id}, received ${actual[index].id}`,
      );
    }
  }
}
