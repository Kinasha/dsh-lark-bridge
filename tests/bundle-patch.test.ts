import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isMap, isScalar, parseDocument, type Scalar } from "yaml";
import { CONFIG_FIELD_NAMES, Config } from "../src/settings/schema.js";
import { inject, name } from "../src/plugin.js";

const PATCH_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dsh.bundle.patch.yml",
);

const JS_TAG = "tag:yaml.org,2002:js";

function configNode() {
  const document = parseDocument(readFileSync(PATCH_PATH, "utf8"));
  const config = document.getIn(["0", "insert", "0", "config"], true);
  assert.ok(isMap(config), "the patch declares a config map");
  return config;
}

test("every !!js expression stays a tagged scalar", () => {
  // An unquoted expression containing ": " — any ternary — is parsed by YAML as
  // a MAPPING, which silently drops the !!js tag and hands the plugin an object
  // instead of the evaluated value. Fields whose schema tolerates the wrong
  // shape (a transform, say) then fail silently rather than loudly: this is how
  // allowedSenderIds shipped as a permanent no-op.
  const offenders: string[] = [];
  for (const pair of configNode().items) {
    const key = String((pair.key as Scalar).value);
    const value = pair.value;
    if (isMap(value)) {
      offenders.push(`${key}: parsed as a YAML map, not a !!js scalar`);
      continue;
    }
    assert.ok(isScalar(value), `${key} is a scalar`);
    if (typeof value.value === "string" && value.tag !== JS_TAG) {
      offenders.push(`${key}: string without the !!js tag`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a ternary is only safe when quoted", () => {
  // Locks the reason the file quotes everything, so nobody "tidies" the quotes
  // away and reintroduces the silent failure.
  const unquoted = parseDocument("a: !!js x === 'b' ? 'b' : 'c'");
  assert.ok(isMap(unquoted.get("a", true)), "unquoted ternary degrades to a map");

  const quoted = parseDocument("a: !!js \"x === 'b' ? 'b' : 'c'\"");
  const node = quoted.get("a", true);
  assert.ok(isScalar(node));
  assert.equal(node.tag, JS_TAG);
  assert.equal(node.value, "x === 'b' ? 'b' : 'c'");
});

test("the sender allowlist expression survives parsing", () => {
  // The regression this test exists for: a configured allowlist that silently
  // allowed everyone because the expression became a map and the transform
  // coerced it to [].
  for (const field of ["allowedSenderIds", "blockedSenderIds"]) {
    const node = configNode().get(field, true);
    assert.ok(isScalar(node), `${field} is a scalar`);
    assert.equal((node as Scalar).tag, JS_TAG, field);
    assert.match(String((node as Scalar).value), /DSH_LARK_/, field);
  }
});

test("every patched key exists in the settings schema", () => {
  const patched = configNode().items.map((pair) =>
    String((pair.key as Scalar).value),
  );
  const unknown = patched.filter((key) => !CONFIG_FIELD_NAMES.has(key));
  assert.deepEqual(unknown, [], "a patched key with no schema field is ignored silently");
  assert.ok(patched.length > 0);
  void Config;
});

test("evaluating each expression yields a value the schema accepts", () => {
  // The patch is the settings `base` layer, so a wrong shape here fails the
  // whole plugin at boot — as `domain` did.
  const environment: Record<string, string> = {};
  const fakeProcess = { env: environment, cwd: () => "/workspace" };
  const base: Record<string, unknown> = {};
  for (const pair of configNode().items) {
    const key = String((pair.key as Scalar).value);
    const node = pair.value as Scalar;
    const evaluate = new Function(
      "process",
      `return (${String(node.value)});`,
    ) as (proc: typeof fakeProcess) => unknown;
    const value = evaluate(fakeProcess);
    if (value !== null && value !== undefined) base[key] = value;
  }
  const resolved = Config(base as never);
  assert.equal(resolved.domain, "feishu");
  assert.equal(resolved.replyMode, "post");
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.enableApprovals, false, "approvals stay opt-in");
  assert.equal(resolved.allowSlashCommands, false);
  assert.equal(resolved.maxConcurrentTopics, 4);
  assert.equal(resolved.turnTimeoutMs, 0);
  assert.equal(resolved.progressSurface, "cot");
  assert.equal(resolved.toolDetailMode, "standard");
  assert.equal(resolved.progressStyle, "timeline");
  assert.equal(resolved.thinkingIcon, "brain");
  assert.equal(resolved.maxProgressItems, 100);
  assert.equal(resolved.collapseProgressOnFinish, true);
});

test("the patch requests exactly the seams the plugin requires", () => {
  // DSH composes the plugin from this list, not from `inject` in the module: a
  // seam the plugin requires but the patch omits is undefined at apply() time,
  // and an optional seam listed here becomes required, so a profile without it
  // refuses to load the whole bundle.
  const document = parseDocument(readFileSync(PATCH_PATH, "utf8"));
  const entry = document.getIn(["0", "insert", "0"], true);
  assert.ok(isMap(entry), "the patch inserts one plugin entry");
  assert.equal(entry.get("name"), name, "the entry names this package");

  const requested = (entry.get("inject") as { toJSON(): unknown }).toJSON();
  assert.deepEqual(requested, inject.required);
  for (const optional of inject.optional) {
    assert.ok(
      !(requested as string[]).includes(optional),
      `${optional} is optional; requesting it makes a profile without it fail to load`,
    );
  }
});
