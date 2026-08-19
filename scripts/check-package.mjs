#!/usr/bin/env node
// Packs the tarball `npm publish` would upload, then asserts it is complete and
// loadable on its own.
//
// `npm pack --dry-run` only printed a file list, so nothing checked that the
// list still matched the code: `files` names one entry per top-level `src/`
// directory, so a new directory ships as a missing module, and an import of a
// devDependency ships as a module that cannot resolve on a consumer's machine.
// Both failures are invisible until someone installs the published package.
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

/**
 * Runtime specifiers the DSH host supplies to a plugin it loads. They are not
 * dependencies: the plugin only runs inside a DSH profile that already provides
 * them, and declaring them would install a second copy beside the host's.
 * Anything not listed here must be a declared `dependency`.
 */
const HOST_PROVIDED = new Set(["@deepseek-ai/dsh-settings"]);
/** Specifiers the DSH web client's module loader resolves for `dist/client.js`. */
const CLIENT_PROVIDED = new Set(["react", ...(manifest.dsh?.client?.inject ?? [])]);
/** Directories under `src/` deliberately absent from the package. */
const UNPUBLISHED_DIRECTORIES = new Set(["standalone"]);
/** Root modules under `src/` that ship only as a bundle. */
const UNPUBLISHED_MODULES = new Set(["client"]);

const failures = [];
const fail = (message) => failures.push(message);

function walk(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(root, relative));
    else files.push(relative);
  }
  return files;
}

function collectEntryPoints() {
  const declared = new Map();
  const add = (value, label) => {
    if (typeof value === "string" && value.startsWith(".")) {
      declared.set(path.posix.normalize(value.replace(/^\.\//, "")), label);
    }
  };
  add(manifest.main, "main");
  add(manifest.types, "types");
  for (const [name, target] of Object.entries(manifest.bin ?? {})) add(target, `bin.${name}`);
  const addExports = (node, label) => {
    if (typeof node === "string") add(node, label);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) addExports(value, `${label}.${key}`);
    }
  };
  addExports(manifest.exports ?? {}, "exports");
  add(manifest.dsh?.bundle?.patch, "dsh.bundle.patch");
  return declared;
}

function specifiersIn(source) {
  const found = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

const workspace = mkdtempSync(path.join(os.tmpdir(), "dsh-lark-package-"));
try {
  try {
    // Quiet unless it breaks: the tarball listing npm prints is the old
    // `pack:check` output, and this script checks that listing itself.
    execFileSync("npm", ["pack", "--pack-destination", workspace], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(String(error.stderr ?? "") + String(error.stdout ?? ""));
    throw new Error("npm pack failed");
  }
  const tarball = readdirSync(workspace).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  execFileSync("tar", ["-xzf", path.join(workspace, tarball), "-C", workspace]);
  const packageRoot = path.join(workspace, "package");
  const packaged = new Set(walk(packageRoot));

  for (const [target, label] of collectEntryPoints()) {
    if (!packaged.has(target)) fail(`${label} points at ${target}, which the package omits`);
  }

  for (const file of packaged) {
    if (file.endsWith(".ts") && !file.endsWith(".d.ts")) fail(`packages TypeScript source: ${file}`);
    if (file.endsWith(".tgz")) fail(`packages a tarball: ${file}`);
    if (path.basename(file).startsWith(".env")) fail(`packages an environment file: ${file}`);
    if (file.startsWith("node_modules/")) fail(`packages installed modules: ${file}`);
    if (file.startsWith("tests/")) fail(`packages tests: ${file}`);
    for (const directory of UNPUBLISHED_DIRECTORIES) {
      if (file.startsWith(`dist/src/${directory}/`)) fail(`packages unpublished ${directory}: ${file}`);
    }
  }

  for (const entry of readdirSync(path.join(repoRoot, "src"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (UNPUBLISHED_DIRECTORIES.has(entry.name)) continue;
      const shipped = [...packaged].some((file) => file.startsWith(`dist/src/${entry.name}/`));
      if (!shipped) {
        fail(`src/${entry.name}/ is not in the package; add "dist/src/${entry.name}/**" to files`);
      }
    } else if (entry.name.endsWith(".ts")) {
      const stem = entry.name.slice(0, -3);
      if (UNPUBLISHED_MODULES.has(stem)) continue;
      if (!packaged.has(`dist/src/${stem}.js`)) {
        fail(`src/${entry.name} is not in the package; add "dist/src/${stem}.*" to files`);
      }
    }
  }

  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  for (const file of packaged) {
    const runtime = file.endsWith(".js") && file.startsWith("dist/src/");
    const declaration = file.endsWith(".d.ts");
    if (!runtime && !declaration) continue;
    const source = readFileSync(path.join(packageRoot, file), "utf8");
    for (const specifier of specifiersIn(source)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const base = path.posix.join(path.posix.dirname(file), specifier);
        const candidates = [base, `${base}.js`, `${base}/index.js`];
        if (declaration) {
          candidates.push(base.replace(/\.js$/, ".d.ts"), `${base}.d.ts`, `${base}/index.d.ts`);
        }
        if (!candidates.some((candidate) => packaged.has(candidate))) {
          fail(`${file} imports ${specifier}, which the package omits`);
        }
        continue;
      }
      // Only runtime imports must resolve on a consumer's machine; a type-only
      // import in a .d.ts costs nothing when the package is absent.
      if (!runtime) continue;
      const name = packageNameOf(specifier);
      if (!dependencies.has(name) && !HOST_PROVIDED.has(name)) {
        fail(`${file} imports ${name} at runtime, which is not a declared dependency`);
      }
    }
  }

  if (packaged.has("dist/client.js")) {
    const bundle = readFileSync(path.join(packageRoot, "dist/client.js"), "utf8");
    if (!bundle.includes("window.__ModuleLoader__.load")) {
      fail("dist/client.js is not wrapped for the DSH client module loader");
    }
    for (const specifier of specifiersIn(bundle)) {
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
      if (!CLIENT_PROVIDED.has(packageNameOf(specifier))) {
        fail(`dist/client.js requires ${specifier}, which the client loader does not inject`);
      }
    }
  }

  for (const target of Object.values(manifest.bin ?? {})) {
    const binary = path.join(packageRoot, target);
    if (!packaged.has(target.replace(/^\.\//, ""))) continue;
    if ((statSync(binary).mode & 0o111) === 0) fail(`${target} is packaged without the executable bit`);
  }

  // The package resolves its own imports only when the modules it does not ship
  // are installed. Borrowing the repository's tree keeps this check offline.
  const borrowed = path.join(packageRoot, "node_modules");
  symlinkSync(path.join(repoRoot, "node_modules"), borrowed, "dir");

  const entryUrl = pathToFileURL(path.join(packageRoot, manifest.main)).href;
  const smoke = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const plugin = await import(${JSON.stringify(entryUrl)});
       if (plugin.name !== ${JSON.stringify(manifest.name)}) throw new Error("wrong plugin name: " + plugin.name);
       if (typeof plugin.apply !== "function") throw new Error("plugin exports no apply()");
       if (!Array.isArray(plugin.inject?.required)) throw new Error("plugin declares no required inject");
       if (typeof plugin.Config !== "function") throw new Error("plugin exports no Config schema");`,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (smoke.status !== 0) fail(`importing ${manifest.main} from the package failed:\n${smoke.stderr.trim()}`);

  for (const target of Object.values(manifest.bin ?? {})) {
    const environment = { ...process.env };
    delete environment.LARK_APP_ID;
    delete environment.LARK_APP_SECRET;
    const doctor = spawnSync(process.execPath, [path.join(packageRoot, target)], {
      cwd: packageRoot,
      encoding: "utf8",
      env: environment,
    });
    // Without credentials the command must refuse in one line and exit non-zero,
    // never crash on an unresolved import or reach the Feishu API.
    if (doctor.status === 0) fail(`${target} reported success without credentials`);
    if (!/^error: LARK_APP_ID/m.test(doctor.stderr)) {
      fail(`${target} without credentials printed:\n${doctor.stderr.trim() || doctor.stdout.trim()}`);
    }
  }

  const bytes = [...packaged].reduce(
    (total, file) => total + lstatSync(path.join(packageRoot, file)).size,
    0,
  );
  if (failures.length === 0) {
    console.log(
      `package ok: ${manifest.name}@${manifest.version}, ${packaged.size} files, ` +
        `${(bytes / 1024).toFixed(0)} KiB unpacked`,
    );
  }
} finally {
  // Unlink the borrowed tree first: deleting the workspace must never be able to
  // reach the repository's node_modules through it.
  rmSync(path.join(workspace, "package", "node_modules"), { force: true });
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`package check failed:\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
