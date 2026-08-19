#!/usr/bin/env node
// Asserts the invariants that live between files rather than inside one, and
// that a reviewer therefore has to hold in their head.
//
// The bundle patch, the README table and `.env.example` describe the same set
// of environment variables three times; the README, SECURITY.md and
// package.json state the same two version numbers; `.nvmrc`, `engines.node` and
// the CI matrix state the same Node version. Each file stays individually valid
// when one of them changes alone, so nothing else notices that they stopped
// agreeing until a user hits the half that was not updated.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
const manifest = JSON.parse(read("package.json"));

/** Prose files that describe the current release. CHANGELOG.md is excluded: it
 *  is supposed to name every past version and the DSH release each aligned to. */
const PROSE = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CONTEXT.md"].filter((file) =>
  existsSync(path.join(repoRoot, file)),
);

const failures = [];
const fail = (message) => failures.push(message);
const unique = (values) => [...new Set(values)].sort();
const matches = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);

// --- environment variables: the bundle patch is the source of truth ----------
{
  const declared = unique(matches(read("dsh.bundle.patch.yml"), /(DSH_LARK_[A-Z0-9_]+)/g));
  for (const [file, label] of [
    ["README.md", "the README configuration table"],
    [".env.example", ".env.example"],
  ]) {
    if (!existsSync(path.join(repoRoot, file))) continue;
    const documented = unique(matches(read(file), /(DSH_LARK_[A-Z0-9_]+)/g));
    for (const name of declared) {
      if (!documented.includes(name)) fail(`${name} is in the bundle patch but not in ${label}`);
    }
    for (const name of documented) {
      if (!declared.includes(name)) fail(`${name} is in ${label} but not in the bundle patch`);
    }
  }
}

// --- versions ----------------------------------------------------------------
{
  const { version } = manifest;
  for (const file of PROSE) {
    const source = read(file);
    for (const found of unique(matches(source, /open-aiden-dsh-lark-bridge-(\d+\.\d+\.\d+)\.tgz/g))) {
      if (found !== version) fail(`${file} names tarball ${found}, but package.json is ${version}`);
    }
    // Only the two files that state "this is the current release" — elsewhere a
    // bare `x.y.z` is as likely to be some other project's version.
    if (file === "README.md" || file === "SECURITY.md") {
      for (const found of unique(matches(source, /`(\d+\.\d+\.\d+)`/g))) {
        if (found !== version) fail(`${file} names version ${found}, but package.json is ${version}`);
      }
    }
  }
  if (existsSync(path.join(repoRoot, "CHANGELOG.md"))) {
    const changelog = read("CHANGELOG.md");
    if (!changelog.includes(`## [${version}]`)) {
      fail(`CHANGELOG.md has no "## [${version}]" section for the version package.json publishes`);
    }
  }
}

// --- the DSH release this bridge is built against ----------------------------
{
  const pinned = manifest.devDependencies?.["@deepseek-ai/dsh"];
  const mismatched = Object.entries(manifest.devDependencies ?? {})
    .filter(([name, range]) => name.startsWith("@deepseek-ai/dsh") && range !== pinned)
    .map(([name, range]) => `${name}@${range}`);
  if (mismatched.length > 0) {
    fail(`the @deepseek-ai/dsh* packages must share one release; found ${mismatched.join(", ")} beside ${pinned}`);
  }
  for (const file of PROSE) {
    for (const found of unique(matches(read(file), /@deepseek-ai\/dsh@([^\s`)，。]+)/g))) {
      if (found !== pinned) fail(`${file} claims alignment with dsh@${found}, but package.json pins ${pinned}`);
    }
  }
}

// --- Node version: .nvmrc, engines and the CI matrix -------------------------
{
  const engine = manifest.engines?.node ?? "";
  const minimum = Number(engine.replace(/[^\d.]/g, "").split(".")[0]);
  if (!Number.isFinite(minimum)) fail(`engines.node (${engine}) declares no major version`);
  if (existsSync(path.join(repoRoot, ".nvmrc"))) {
    const pinned = Number(read(".nvmrc").trim().replace(/^v/, "").split(".")[0]);
    if (pinned !== minimum) {
      fail(`.nvmrc pins Node ${pinned}, but engines.node requires ${engine}; pin the oldest supported release`);
    }
  }
  const workflow = ".github/workflows/ci.yml";
  if (existsSync(path.join(repoRoot, workflow))) {
    const versions = (parseYaml(read(workflow))?.jobs?.verify?.strategy?.matrix?.node ?? []).map(Number);
    if (versions.length === 0) fail(`${workflow} declares no jobs.verify.strategy.matrix.node`);
    else if (Math.min(...versions) !== minimum) {
      fail(`${workflow} tests Node ${versions.join(", ")}, but engines.node requires ${engine}`);
    }
  }
}

// --- the README source map matches the tree ----------------------------------
{
  const readme = read("README.md");
  const section = readme.split("### 源码结构")[1]?.split("```")[1];
  if (section === undefined) fail('README.md has no "### 源码结构" code block');
  else {
    const documented = new Set(
      section
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((token) => token?.endsWith("/") || token?.endsWith(".ts")),
    );
    const actual = new Set(
      readdirSync(path.join(repoRoot, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.name.endsWith(".ts"))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)),
    );
    for (const name of actual) {
      if (!documented.has(name)) fail(`src/${name} is missing from the README source map`);
    }
    for (const name of documented) {
      if (name !== "src/" && !actual.has(name)) fail(`the README source map lists src/${name}, which does not exist`);
    }
  }
}

// --- secrets and build output stay out of git --------------------------------
{
  const ignored = read(".gitignore")
    .split("\n")
    .map((line) => line.trim());
  for (const pattern of [".env", "*.tgz", "dist/", "node_modules/"]) {
    if (!ignored.includes(pattern)) fail(`.gitignore does not ignore ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error(`repository check failed:\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `repository ok: ${manifest.name}@${manifest.version} against @deepseek-ai/dsh@${manifest.devDependencies?.["@deepseek-ai/dsh"]}`,
);
