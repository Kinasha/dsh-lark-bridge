import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { apply as applySearch } from "@deepseek-ai/dsh-tool-fs-search";
import type {
  PostToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import {
  apply,
  filterSearchResult,
  isSensitiveWorkspacePath,
  isWorkspaceRelativeSearchPath,
  readOnlyToolGuard,
} from "../src/plugins/read-only-files.js";

test("search path guard accepts workspace-relative paths", () => {
  assert.equal(isWorkspaceRelativeSearchPath(undefined), true);
  assert.equal(isWorkspaceRelativeSearchPath("."), true);
  assert.equal(isWorkspaceRelativeSearchPath("src/components"), true);
});

test("search path guard rejects paths that can escape the workspace", () => {
  assert.equal(isWorkspaceRelativeSearchPath("../secret"), false);
  assert.equal(isWorkspaceRelativeSearchPath("src/../../secret"), false);
  assert.equal(isWorkspaceRelativeSearchPath("/tmp/secret"), false);
  assert.equal(isWorkspaceRelativeSearchPath("C:\\secret"), false);
});

test("sensitive credential paths are blocked but examples remain readable", () => {
  assert.equal(isSensitiveWorkspacePath(".env"), true);
  assert.equal(isSensitiveWorkspacePath(".env*"), true);
  assert.equal(isSensitiveWorkspacePath("config/.env.production"), true);
  assert.equal(isSensitiveWorkspacePath(".git/config"), true);
  assert.equal(isSensitiveWorkspacePath("certs/client.pem"), true);
  assert.equal(isSensitiveWorkspacePath(".env.example"), false);
  assert.equal(isSensitiveWorkspacePath("README.md"), false);
});

test("searches must be targeted and cannot name credential files", () => {
  const guard = (name: string, args: Record<string, unknown>) =>
    readOnlyToolGuard({ name, arguments: args } as unknown as ToolExecution);

  assert.match(guard("glob", { pattern: "*" }) ?? "", /anchored pattern/);
  assert.equal(guard("glob", { pattern: "src/**/*.ts" }), undefined);
  assert.match(guard("grep", { pattern: "token" }) ?? "", /path or include/);
  assert.equal(
    guard("grep", { pattern: "bridge", include: "*.ts" }),
    undefined,
  );
  assert.match(
    guard("grep", { pattern: "token", path: ".env" }) ?? "",
    /sensitive credential paths/,
  );
});

test("search results cannot expose sensitive paths matched by wildcards", () => {
  assert.deepEqual(
    filterSearchResult("glob", {
      root: ".",
      paths: [
        "src/index.ts",
        ".env",
        "config/.env.production",
        ".git/config",
        "certs/client.pem",
      ],
    }),
    { root: ".", paths: ["src/index.ts"] },
  );

  assert.deepEqual(
    filterSearchResult("grep", {
      matches: [
        { path: "src/index.ts", lineNumber: 1, line: "safe" },
        { path: "secrets/.env.local", lineNumber: 2, line: "TOKEN=secret" },
        { path: ".ssh/config", lineNumber: 3, line: "Host internal" },
      ],
    }),
    {
      matches: [{ path: "src/index.ts", lineNumber: 1, line: "safe" }],
    },
  );
});

test("workspace safety filters the canonical value returned by search adapters", async () => {
  let listener:
    | ((
        exec: ToolExecution,
        result: Readonly<ToolExecutionResult>,
        next: () => Promise<PostToolDecision>,
      ) => Promise<PostToolDecision>)
    | undefined;
  const context = {
    systemPrompt: { section: () => undefined },
    tools: { guard: () => undefined, register: () => undefined },
    on: (name: string, value: typeof listener) => {
      if (name === "tools/post-execute") listener = value;
    },
  } as unknown as Context;
  apply(context);
  assert.ok(listener);

  const decision = await listener(
    { name: "glob", arguments: {} } as unknown as ToolExecution,
    {
      isError: false,
      value: { root: ".", paths: ["src/index.ts", ".env"] },
      content: [],
    },
    async () => ({ kind: "accept" }),
  );
  assert.deepEqual(decision, {
    kind: "accept",
    value: { root: ".", paths: ["src/index.ts"] },
  });
});

test("workspace safety runs before real search spill materialization", async () => {
  const preset = await readFile(
    new URL(
      "../config/agent-presets/lark-safe/agent.cordis.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    preset.indexOf("id: tool-fs-search") <
      preset.indexOf("id: read-only-files"),
  );

  const definitions = new Map<string, ToolDefinition>();
  const listeners: Array<
    (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ) => Promise<PostToolDecision>
  > = [];
  const spills: string[] = [];
  const context = {
    systemPrompt: { section: () => undefined },
    tools: {
      guard: () => undefined,
      register: (definition: ToolDefinition) => {
        definitions.set(definition.name, definition);
      },
      get: (name: string) => definitions.get(name),
    },
    get: (name: string) =>
      name === "spillStore"
        ? {
            saveText: async (input: { text: string }) => {
              spills.push(input.text);
              return { locator: "spill://result", retrievalHint: "retrieve" };
            },
          }
        : undefined,
    logger: { warn: () => undefined },
    on: (name: string, listener: (typeof listeners)[number]) => {
      if (name === "tools/post-execute") listeners.push(listener);
    },
  } as unknown as Context;
  await applySearch(context, {
    sampleOverCapGlobResults: false,
    globMaxResults: 1,
    grepMaxMatches: 1,
    grepMaxLineBytes: 2_000,
    searchMetaMaxBytes: 64_000,
    rawOutputMaxBytes: 20_000_000,
    graceMs: 3_000,
    stderrMaxBytes: 65_536,
    timeoutMs: 30_000,
  });
  apply(context);

  const exec = {
    name: "glob",
    arguments: { pattern: "**/*" },
  } as unknown as ToolExecution;
  const result = {
    isError: false,
    value: { root: ".", paths: ["src/index.ts", ".env"] },
    content: [],
  } as unknown as ToolExecutionResult;
  const runWaterfall = (index: number): Promise<PostToolDecision> =>
    listeners[index]?.(exec, result, () => runWaterfall(index + 1)) ??
    Promise.resolve({ kind: "accept" });

  assert.deepEqual(await runWaterfall(0), {
    kind: "accept",
    value: { root: ".", paths: ["src/index.ts"] },
  });
  assert.deepEqual(spills, []);
});

test("registered read tool enforces the resolved workspace and returns bounded lines", async () => {
  let definition: ToolDefinition | undefined;
  const root = { displayPath: "/workspace" };
  const target = { displayPath: "/workspace/README.md" };
  const context = {
    systemPrompt: { section: () => undefined },
    tools: {
      guard: () => undefined,
      register: (value: ToolDefinition) => {
        definition = value;
      },
    },
    on: () => undefined,
    fs: {
      resolve: async (value: string) =>
        value === "/workspace" ? root : target,
      contains: () => true,
      stat: async () => ({ type: "file", size: 7, version: "v1" }),
      readText: async () => "one\ntwo",
    },
    emit: () => undefined,
  } as unknown as Context;
  apply(context);
  assert.ok(definition);

  assert.deepEqual(
    await definition.execute({ file_path: "README.md", offset: 2, limit: 1 }, {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: "/workspace" } } },
    } as unknown as ToolRunContext),
    {
      path: "/workspace/README.md",
      offset: 2,
      lines: [{ number: 2, text: "two" }],
      totalLines: 2,
    },
  );
});
