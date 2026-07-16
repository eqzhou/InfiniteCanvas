import { createEdgeIndex } from "../src/lib/edge-index";
import { createNodeSpatialIndex } from "../src/lib/spatial-index";
import {
  assertEdgeQueryCorrect,
  assertSpatialQueryCorrect,
  createBenchmarkDataset,
  percentile,
} from "./index-benchmark-core";

declare const Bun: { readonly version: string };
declare const process: {
  readonly argv: readonly string[];
  readonly platform: string;
  readonly arch: string;
};

type Timing = { p50Ms: number; p95Ms: number; samples: number };
type ScenarioResult = {
  scenario: string;
  seed: number;
  nodeCount: number;
  edgeCount: number;
  correctnessQueries: number;
  spatialBuild: Timing;
  spatialQuery: Timing;
  edgeBuild: Timing;
  edgeQuery: Timing;
  checksum: number;
};

type Budget = {
  spatialBuildP95Ms: number;
  spatialQueryP95Ms: number;
  edgeBuildP95Ms: number;
  edgeQueryP95Ms: number;
};

const MASTER_SEED = 0x1f1f_2026;
const BUILD_WARMUPS = 2;
const BUILD_RUNS = 11;
const QUERY_WARMUPS = 1;
const QUERY_ROUNDS = 6;

const scenarios: readonly {
  name: string;
  nodeCount: number;
  edgeCount: number;
  seed: number;
  budget: Budget;
}[] = [
  {
    name: "dense-1k-nodes-30k-edges",
    nodeCount: 1_000,
    edgeCount: 30_000,
    seed: MASTER_SEED,
    budget: {
      spatialBuildP95Ms: 150,
      spatialQueryP95Ms: 20,
      edgeBuildP95Ms: 250,
      edgeQueryP95Ms: 50,
    },
  },
  {
    name: "large-10k-nodes-30k-edges",
    nodeCount: 10_000,
    edgeCount: 30_000,
    seed: MASTER_SEED ^ 0x10_000,
    budget: {
      spatialBuildP95Ms: 500,
      spatialQueryP95Ms: 50,
      edgeBuildP95Ms: 250,
      edgeQueryP95Ms: 50,
    },
  },
];

const argumentsSet = new Set(process.argv.slice(2));
const assertBudgets = argumentsSet.has("--assert");
const jsonOnly = argumentsSet.has("--json");
const unknownArguments = [...argumentsSet].filter((argument) => argument !== "--assert" && argument !== "--json");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown benchmark argument(s): ${unknownArguments.join(", ")}`);
}

const results = scenarios.map((scenario) => runScenario(scenario));

if (assertBudgets) {
  scenarios.forEach((scenario, index) => assertWithinBudget(results[index], scenario.budget));
}

if (jsonOnly) {
  console.log(JSON.stringify({ masterSeed: MASTER_SEED, results }, null, 2));
} else {
  printHumanReport(results);
}

function runScenario(scenario: (typeof scenarios)[number]): ScenarioResult {
  const dataset = createBenchmarkDataset(scenario);
  const spatialIndex = createNodeSpatialIndex(dataset.nodes);
  const spatialResults = dataset.queries.map((query) => spatialIndex.query(query));
  spatialResults.forEach((actual, index) =>
    assertSpatialQueryCorrect(dataset.nodes, dataset.queries[index], actual),
  );

  const visibleNodeSets = spatialResults.map(
    (nodes) => new Set(nodes.map((node) => node.id)),
  );
  const edgeIndex = createEdgeIndex(dataset.edges);
  visibleNodeSets.forEach((nodeIds) =>
    assertEdgeQueryCorrect(dataset.edges, nodeIds, edgeIndex.touching(nodeIds)),
  );

  const spatialBuild = measureBuild(() => createNodeSpatialIndex(dataset.nodes));
  const edgeBuild = measureBuild(() => createEdgeIndex(dataset.edges));
  const spatialQuery = measureQueries(dataset.queries, (query) => spatialIndex.query(query).length);
  const edgeQuery = measureQueries(visibleNodeSets, (nodeIds) => edgeIndex.touching(nodeIds).length);

  return {
    scenario: scenario.name,
    seed: scenario.seed,
    nodeCount: dataset.nodes.length,
    edgeCount: dataset.edges.length,
    correctnessQueries: dataset.queries.length,
    spatialBuild: spatialBuild.timing,
    spatialQuery: spatialQuery.timing,
    edgeBuild: edgeBuild.timing,
    edgeQuery: edgeQuery.timing,
    checksum: spatialBuild.checksum ^ edgeBuild.checksum ^ spatialQuery.checksum ^ edgeQuery.checksum,
  };
}

function measureBuild<T>(build: () => T): { timing: Timing; checksum: number } {
  let checksum = 0;
  for (let index = 0; index < BUILD_WARMUPS; index += 1) checksum ^= Number(Boolean(build()));
  const samples = Array.from({ length: BUILD_RUNS }, () => {
    const startedAt = performance.now();
    const value = build();
    const duration = performance.now() - startedAt;
    checksum ^= Number(Boolean(value));
    return duration;
  });
  return { timing: summarize(samples), checksum };
}

function measureQueries<T>(
  queries: readonly T[],
  query: (input: T) => number,
): { timing: Timing; checksum: number } {
  let checksum = 0;
  for (let round = 0; round < QUERY_WARMUPS; round += 1) {
    for (const input of queries) checksum = (checksum + query(input)) | 0;
  }
  const samples: number[] = [];
  for (let round = 0; round < QUERY_ROUNDS; round += 1) {
    for (const input of queries) {
      const startedAt = performance.now();
      checksum = (checksum + query(input)) | 0;
      samples.push(performance.now() - startedAt);
    }
  }
  return { timing: summarize(samples), checksum };
}

function summarize(samples: readonly number[]): Timing {
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    samples: samples.length,
  };
}

function assertWithinBudget(result: ScenarioResult, budget: Budget): void {
  const checks: readonly [string, number, number][] = [
    ["spatial build", result.spatialBuild.p95Ms, budget.spatialBuildP95Ms],
    ["spatial query", result.spatialQuery.p95Ms, budget.spatialQueryP95Ms],
    ["edge build", result.edgeBuild.p95Ms, budget.edgeBuildP95Ms],
    ["edge query", result.edgeQuery.p95Ms, budget.edgeQueryP95Ms],
  ];
  const failures = checks
    .filter(([, actual, maximum]) => actual > maximum)
    .map(([name, actual, maximum]) => `${name} p95 ${actual.toFixed(2)}ms > ${maximum}ms`);
  if (failures.length > 0) {
    throw new Error(`${result.scenario} exceeded performance budget: ${failures.join("; ")}`);
  }
}

function printHumanReport(results: readonly ScenarioResult[]): void {
  console.log(`Index benchmark (fixed master seed: 0x${MASTER_SEED.toString(16)})`);
  console.log(`Runtime: Bun ${Bun.version}, ${process.platform}/${process.arch}`);
  console.log("Correctness is checked against full scans before timings are collected.\n");
  for (const result of results) {
    console.log(`${result.scenario} (seed=${result.seed}, correctness queries=${result.correctnessQueries})`);
    console.table([
      tableRow("spatial build", result.spatialBuild),
      tableRow("spatial query", result.spatialQuery),
      tableRow("edge build", result.edgeBuild),
      tableRow("edge query", result.edgeQuery),
    ]);
    console.log(`checksum=${result.checksum}\n`);
  }
  console.log(assertBudgets ? "Performance budgets passed." : "Baseline only; pass --assert to enforce generous budgets.");
}

function tableRow(operation: string, timing: Timing): Record<string, string | number> {
  return {
    operation,
    samples: timing.samples,
    "p50 (ms)": timing.p50Ms.toFixed(3),
    "p95 (ms)": timing.p95Ms.toFixed(3),
  };
}
