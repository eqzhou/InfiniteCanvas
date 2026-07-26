import assert from "node:assert/strict";
import test from "node:test";

import { directDependencyNames } from "./audit-licenses-core.mjs";

test("directDependencyNames follows the runtime manifest and selected tooling", () => {
  const manifest = {
    dependencies: { react: "1", "react-router": "2" },
    devDependencies: { typescript: "3", vite: "4" },
  };

  assert.deepEqual(directDependencyNames(manifest, ["vite", "missing", "typescript"]), [
    "react",
    "react-router",
    "typescript",
    "vite",
  ]);
});

test("directDependencyNames tolerates missing dependency maps", () => {
  assert.deepEqual(directDependencyNames({}, ["typescript"]), []);
});
