import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_PRESET_ID = "dsh-lark-safe";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(moduleDirectory, "..");
const builtRoot = path.resolve(moduleDirectory, "../..");
const PACKAGE_ROOT = existsSync(path.join(sourceRoot, "package.json"))
  ? sourceRoot
  : builtRoot;

interface PresetFile {
  source: string;
  target: string;
}

function presetFiles(target: string): PresetFile[] {
  const source = path.join(PACKAGE_ROOT, "config", "agent-presets", "lark-safe");
  return [
    {
      source: path.join(source, "agent.cordis.yml"),
      target: path.join(target, "agent.cordis.yml"),
    },
    {
      source: path.join(source, "preset.yml"),
      target: path.join(target, "preset.yml"),
    },
    {
      source: path.join(
        PACKAGE_ROOT,
        "dist",
        "src",
        "plugins",
        "read-only-files.js",
      ),
      target: path.join(target, "read-only-files.js"),
    },
  ];
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function filesMatch(files: PresetFile[]): Promise<boolean> {
  try {
    const pairs = await Promise.all(
      files.map(async ({ source, target }) => [
        await readFile(source),
        await readFile(target),
      ] as const),
    );
    return pairs.every(([source, target]) => source.equals(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface PresetInstallResult {
  path: string;
  installed: boolean;
}

function userPresetRoot(): string {
  const configured = process.env.DSH_HOME?.trim();
  const home = configured
    ? path.resolve(
        configured === "~" || configured.startsWith(`~${path.sep}`)
          ? path.join(os.homedir(), configured.slice(1))
          : configured,
      )
    : path.join(os.homedir(), ".dsh");
  return path.join(home, ".agent-presets");
}

export async function ensureBundledPreset(
  targetRoot = userPresetRoot(),
): Promise<PresetInstallResult> {
  const target = path.join(targetRoot, BUNDLED_PRESET_ID);
  const files = presetFiles(target);
  if (await isDirectory(target)) {
    if (await filesMatch(files)) return { path: target, installed: false };
    throw new Error(
      `preset ${BUNDLED_PRESET_ID} already exists with different contents at ${target}; move or rename it before loading dsh-lark`,
    );
  }

  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    targetRoot,
    `.${BUNDLED_PRESET_ID}-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of presetFiles(temporary)) {
      await copyFile(file.source, file.target);
    }
    await rename(temporary, target);
    return { path: target, installed: true };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      (await isDirectory(target)) &&
      (await filesMatch(files))
    ) {
      return { path: target, installed: false };
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
