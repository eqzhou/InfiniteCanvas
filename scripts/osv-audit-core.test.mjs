import assert from "node:assert/strict";
import test from "node:test";
import {
  affectedImportPaths,
  dedupeQueries,
  filterFindingsByImports,
  findingsFromBatch,
} from "./osv-audit-core.mjs";

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

test("affectedImportPaths returns scoped Go packages and null when unscoped", () => {
  assert.deepEqual(affectedImportPaths({
    affected: [{
      package: { name: "golang.org/x/crypto", ecosystem: "Go" },
      ecosystem_specific: {
        imports: [
          { path: "golang.org/x/crypto/openpgp" },
          { path: "golang.org/x/crypto/openpgp/packet" },
        ],
      },
    }],
  }), [
    "golang.org/x/crypto/openpgp",
    "golang.org/x/crypto/openpgp/packet",
  ]);
  assert.equal(affectedImportPaths({
    affected: [{ package: { name: "example.com/mod", ecosystem: "Go" } }],
  }), null);
});

test("filterFindingsByImports drops openpgp-only advisories when only bcrypt is imported", () => {
  const findings = [{
    ecosystem: "Go",
    name: "golang.org/x/crypto",
    version: "v0.54.0",
    id: "GO-2026-5932",
    summary: "openpgp unmaintained",
  }];
  const details = new Map([["GO-2026-5932", {
    id: "GO-2026-5932",
    affected: [{
      package: { name: "golang.org/x/crypto", ecosystem: "Go" },
      ecosystem_specific: {
        imports: [
          { path: "golang.org/x/crypto/openpgp" },
          { path: "golang.org/x/crypto/openpgp/packet" },
        ],
      },
    }],
  }]]);
  assert.deepEqual(
    filterFindingsByImports(findings, details, [
      "golang.org/x/crypto/bcrypt",
      "golang.org/x/crypto/blowfish",
    ]),
    [],
  );
  assert.equal(
    filterFindingsByImports(findings, details, [
      "golang.org/x/crypto/openpgp",
    ]).length,
    1,
  );
});
