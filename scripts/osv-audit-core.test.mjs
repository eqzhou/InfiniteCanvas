import assert from "node:assert/strict";
import test from "node:test";
import { dedupeQueries, findingsFromBatch } from "./osv-audit-core.mjs";

test("dedupeQueries preserves the first package occurrence", () => {
  assert.deepEqual(dedupeQueries([
    { ecosystem: "npm", name: "react", version: "19.2.7" },
    { ecosystem: "npm", name: "react", version: "19.2.7" },
    { ecosystem: "Go", name: "github.com/go-chi/chi/v5", version: "v5.2.2" },
  ]), [
    { ecosystem: "npm", name: "react", version: "19.2.7" },
    { ecosystem: "Go", name: "github.com/go-chi/chi/v5", version: "v5.2.2" },
  ]);
});

test("findingsFromBatch ignores withdrawn advisories and retains package identity", () => {
  const queries = [{ ecosystem: "npm", name: "example", version: "1.0.0" }];
  assert.deepEqual(findingsFromBatch(queries, {
    results: [{ vulns: [
      { id: "OSV-ACTIVE", summary: "active issue" },
      { id: "OSV-WITHDRAWN", withdrawn: "2026-01-01T00:00:00Z" },
    ] }],
  }), [{
    ecosystem: "npm",
    name: "example",
    version: "1.0.0",
    id: "OSV-ACTIVE",
    summary: "active issue",
  }]);
});

test("findingsFromBatch rejects incomplete responses", () => {
  assert.throws(
    () => findingsFromBatch([{ ecosystem: "npm", name: "example", version: "1.0.0" }], { results: [] }),
    /result count/,
  );
});
