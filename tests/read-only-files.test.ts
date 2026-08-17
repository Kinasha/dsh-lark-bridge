import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import {
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
