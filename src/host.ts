import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DshClient } from "./dsh-client.js";
import {
  DEFAULT_DSH_PORT,
  DSH_HOME,
  PRESET_PLUGIN_BUILD,
  PRESET_SOURCE,
  PRESET_TARGET,
  PROJECT_ROOT,
  WORKSPACE_PATH,
} from "./config.js";

const DSH_BINARY = path.join(PROJECT_ROOT, "node_modules", ".bin", "dsh");

export async function prepareDshHome(): Promise<void> {
  await mkdir(PRESET_TARGET, { recursive: true });
  await mkdir(WORKSPACE_PATH, { recursive: true });
  const presetFiles: Array<readonly [string, string]> = [
      [
        path.join(PRESET_SOURCE, "agent.cordis.yml"),
        path.join(PRESET_TARGET, "agent.cordis.yml"),
      ],
      [
        path.join(PRESET_SOURCE, "preset.yml"),
        path.join(PRESET_TARGET, "preset.yml"),
      ],
      [PRESET_PLUGIN_BUILD, path.join(PRESET_TARGET, "read-only-files.js")],
    ];
  await Promise.all(
    presetFiles.map(([source, target]) => copyFile(source, target)),
  );
}

export async function assertDshInstalled(): Promise<void> {
  await access(DSH_BINARY);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export class DshWebHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private exit: Promise<number | null> | undefined;

  constructor(
    readonly port = DEFAULT_DSH_PORT,
    readonly baseUrl = `http://127.0.0.1:${port}`,
  ) {}

  async start(): Promise<void> {
    await assertDshInstalled();
    await prepareDshHome();
    const child = spawn(
      DSH_BINARY,
      ["web", "--host", "127.0.0.1", "--port", String(this.port)],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          DSH_HOME,
          DSH_PERMISSION_MODE: "read-only",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.exit = waitForExit(child);
    child.stdout.on("data", (chunk) => process.stdout.write(`[dsh-web] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[dsh-web] ${chunk}`));
    await this.waitUntilReady();
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const client = new DshClient(this.baseUrl, 2_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== undefined && !isRunning(this.child)) {
        throw new Error(
          `dsh web exited before readiness with ${this.child.exitCode ?? this.child.signalCode}`,
        );
      }
      try {
        await client.hostDescribe();
        console.log(`dsh_web=ready url=${this.baseUrl}`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`dsh web did not become ready within ${timeoutMs}ms`);
  }

  async wait(): Promise<number | null> {
    if (this.exit === undefined) throw new Error("dsh web has not been started");
    return this.exit;
  }

  async stop(): Promise<void> {
    const child = this.child;
    const exit = this.exit;
    if (child === undefined || exit === undefined || !isRunning(child)) return;
    child.kill("SIGTERM");
    await Promise.race([
      exit,
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (isRunning(child)) {
      throw new Error("dsh web did not stop after SIGTERM");
    }
  }
}
