import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("PostgreSQL 18 compose storage and migration runbook stay aligned", () => {
  const compose = read("compose.yaml");
  const readme = read("README.md");
  assert.match(compose, /image: postgres:18-alpine/);
  assert.match(compose, /PGDATA: \/var\/lib\/postgresql\/18\/docker/);
  assert.match(compose, /- openboard-postgres18:\/var\/lib\/postgresql\s/);
  assert.doesNotMatch(compose, /openboard-postgres:\/var\/lib\/postgresql\/data/);
  assert.match(readme, /PostgreSQL 17.*18|PG17.*PG18/i);
  assert.match(readme, /pg_dump/);
  assert.match(readme, /pg_restore/);
  assert.match(readme, /set -Eeuo pipefail/);
  assert.match(readme, /docker volume inspect/);
  assert.match(readme, /test -s backup\/openboard-pg17\.dump/);
  assert.match(readme, /pg_restore --list/);
  assert.match(readme, /pg_restore[^\n]*--exit-on-error/);
  assert.match(readme, /openboard-postgres18/);
  assert.match(readme, /openboard-postgres/);
});
