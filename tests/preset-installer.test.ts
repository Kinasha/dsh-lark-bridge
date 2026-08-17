import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUNDLED_PRESET_ID,
  ensureBundledPreset,
} from "../src/preset-installer.js";

test("bundled preset installs once and never overwrites changed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-lark-preset-"));
  try {
    const first = await ensureBundledPreset(root);
    assert.equal(first.installed, true);
    assert.equal(path.basename(first.path), BUNDLED_PRESET_ID);
    assert.match(
      await readFile(path.join(first.path, "agent.cordis.yml"), "utf8"),
      /read-only-files/,
    );

    const second = await ensureBundledPreset(root);
    assert.equal(second.installed, false);

    await writeFile(path.join(first.path, "preset.yml"), "name: user-owned\n");
    await assert.rejects(
      ensureBundledPreset(root),
      /already exists with different contents/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
