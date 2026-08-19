#!/usr/bin/env node
// Discovers tests/**/*.test.ts and runs them under tsx's test runner.
//
// Discovery lives here rather than in the npm script because POSIX sh does not
// expand `**`: the previous `tests/*.test.ts tests/*/*.test.ts` pair covered
// exactly two levels, so a test file one directory deeper was silently never
// run and the suite still reported success. Extra arguments are forwarded to
// the runner, which is how `npm run coverage` adds its threshold flags.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(repoRoot, "tests");

function discover(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discover(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

const files = discover(testsRoot).map((file) => path.relative(repoRoot, file));
if (files.length === 0) {
  console.error("error: no test file matched tests/**/*.test.ts");
  process.exit(1);
}
console.error(`running ${files.length} test files`);

const tsx = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const result = spawnSync(tsx, ["--test", ...process.argv.slice(2), ...files], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) {
  console.error(`error: could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
