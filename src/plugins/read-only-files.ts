import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {
  JsonValue,
  ReadFileLine,
  ReadResultView,
  ToolDefinition,
  ToolExecution,
} from "@deepseek-ai/dsh-tools";

export const name = "lark-read-only-files";
export const inject = ["tools", "fs", "systemPrompt"];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_LENGTH = 2_000;

interface ReadMeta {
  path: string;
  offset: number;
  lines: ReadFileLine[];
  totalLines: number;
}

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

function readArgs(value: unknown): ReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("read arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (typeof args.file_path !== "string") {
    throw new Error("file_path must be a string");
  }
  if (args.offset !== undefined && typeof args.offset !== "number") {
    throw new Error("offset must be a number");
  }
  if (args.limit !== undefined && typeof args.limit !== "number") {
    throw new Error("limit must be a number");
  }
  return {
    file_path: args.file_path,
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

export function isWorkspaceRelativeSearchPath(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return !value.split(/[\\/]+/u).includes("..");
}

const SENSITIVE_DIRECTORIES = new Set([".aws", ".git", ".gnupg", ".ssh"]);
const SENSITIVE_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "service-account.json",
]);
const SAFE_ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

export function isSensitiveWorkspacePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const segments = value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    return true;
  }
  const basename = segments.at(-1);
  if (basename === undefined) return false;
  if (
    basename.startsWith(".env") &&
    !SAFE_ENV_EXAMPLES.has(basename)
  ) {
    return true;
  }
  return (
    SENSITIVE_FILES.has(basename) ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx") ||
    basename.endsWith(".pem")
  );
}

export function readOnlyToolGuard(
  exec: Readonly<ToolExecution>,
): string | undefined {
  if (exec.name !== "glob" && exec.name !== "grep") return undefined;
  const args = exec.arguments as {
    path?: unknown;
    pattern?: unknown;
    include?: unknown;
  };
  if (!isWorkspaceRelativeSearchPath(args.path)) {
    return "lark-safe searches must stay inside the session workspace";
  }
  if (
    isSensitiveWorkspacePath(args.path) ||
    isSensitiveWorkspacePath(args.pattern) ||
    isSensitiveWorkspacePath(args.include)
  ) {
    return "lark-safe searches cannot inspect sensitive credential paths";
  }
  if (
    exec.name === "glob" &&
    args.path === undefined &&
    typeof args.pattern === "string" &&
    !args.pattern.includes("/")
  ) {
    return "lark-safe glob requires an anchored pattern containing / or an explicit path";
  }
  if (
    exec.name === "grep" &&
    args.path === undefined &&
    args.include === undefined
  ) {
    return "lark-safe grep requires an explicit path or include filter";
  }
  return undefined;
}

function readMeta(value: JsonValue | undefined): ReadMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, JsonValue>;
  if (
    typeof candidate.path !== "string" ||
    typeof candidate.offset !== "number" ||
    typeof candidate.totalLines !== "number" ||
    !Array.isArray(candidate.lines)
  ) {
    return undefined;
  }
  const lines: ReadFileLine[] = [];
  for (const line of candidate.lines) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) {
      return undefined;
    }
    const item = line as Record<string, JsonValue>;
    if (typeof item.number !== "number" || typeof item.text !== "string") {
      return undefined;
    }
    lines.push({ number: item.number, text: item.text });
  }
  return {
    path: candidate.path,
    offset: candidate.offset,
    lines,
    totalLines: candidate.totalLines,
  };
}

function renderRead(meta: ReadMeta): string {
  const body = meta.lines.map((line) => `${line.number}: ${line.text}`).join("\n");
  const end = meta.lines.at(-1)?.number ?? Math.max(0, meta.offset - 1);
  const footer =
    end < meta.totalLines
      ? `(Showing lines ${meta.offset}-${end} of ${meta.totalLines}. Use offset=${end + 1} to continue.)`
      : `(End of file - total ${meta.totalLines} lines)`;
  return `<path>${meta.path}</path>\n<type>file</type>\n<content>\n${body}${body ? "\n\n" : ""}${footer}\n</content>`;
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: "tool:read-only-files",
    order: 100,
    text: "You may inspect only non-sensitive files in the session workspace. Never inspect .env files, credential stores, private keys, or VCS metadata. Use targeted read, glob, and grep calls; glob patterns must be anchored and grep needs a path or include filter. You cannot write or edit files and must not claim that you did.",
  });
  ctx.tools.guard(readOnlyToolGuard);
  const definition: ToolDefinition = {
      name: "read",
      description:
        "Read a UTF-8 text file inside the session workspace and return line-numbered content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path to read.",
          },
          offset: {
            type: "number",
            description: "1-based first line to return. Defaults to 1.",
          },
          limit: {
            type: "number",
            description: `Maximum lines to return. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
          },
        },
        required: ["file_path"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            offset: { type: "integer" },
            lines: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  number: { type: "integer" },
                  text: { type: "string" },
                },
                required: ["number", "text"],
              },
            },
            totalLines: { type: "integer" },
          },
          required: ["path", "offset", "lines", "totalLines"],
        },
        render: (_args, value) => [
          { type: "text" as const, text: renderRead(value as unknown as ReadMeta) },
        ],
        presentationMeta: (_args, value) => value,
      },
      isConcurrencySafe: () => true,
      async execute(value, exec) {
        const args = readArgs(value);
        const filePath = args.file_path.trim();
        if (filePath.length === 0) {
          throw new Error("file_path must be a non-empty string");
        }
        if (isSensitiveWorkspacePath(filePath)) {
          throw new Error("lark-safe cannot read sensitive credential files");
        }
        const offset = positiveInteger(args.offset, 1, "offset");
        const limit = positiveInteger(args.limit, DEFAULT_LIMIT, "limit");
        if (limit > MAX_LIMIT) throw new Error(`limit must be at most ${MAX_LIMIT}`);

        const cwd = exec.agent?.session.header.cwd;
        if (cwd === undefined) throw new Error("read requires a session workspace");
        const root = await ctx.fs.resolve(cwd, { signal: exec.signal });
        const target = await ctx.fs.resolve(filePath, { cwd, signal: exec.signal });
        if (!ctx.fs.contains(root, target)) {
          throw new Error("lark-safe read paths must stay inside the session workspace");
        }
        if (isSensitiveWorkspacePath(target.displayPath)) {
          throw new Error("lark-safe cannot read sensitive credential files");
        }
        const info = await ctx.fs.stat(target, exec.signal);
        if (info === undefined) throw new Error(`cannot read ${filePath}: not found`);
        if (info.type !== "file") {
          throw new Error(`cannot read ${filePath}: not a regular file`);
        }
        if (info.size !== undefined && info.size > MAX_FILE_BYTES) {
          throw new Error(`cannot read ${filePath}: file exceeds ${MAX_FILE_BYTES} bytes`);
        }

        const content = await ctx.fs.readText(target, exec.signal);
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          throw new Error(`cannot read ${filePath}: file exceeds ${MAX_FILE_BYTES} bytes`);
        }
        const allLines = content.length === 0 ? [] : content.split(/\r?\n/u);
        if (offset > allLines.length && !(allLines.length === 0 && offset === 1)) {
          throw new Error(
            `offset ${offset} is outside ${filePath} (${allLines.length} lines)`,
          );
        }
        const lines = allLines
          .slice(offset - 1, offset - 1 + limit)
          .map((text, index) => ({
            number: offset + index,
            text:
              text.length > MAX_LINE_LENGTH
                ? `${text.slice(0, MAX_LINE_LENGTH)}... (line truncated)`
                : text,
          }));
        ctx.emit(
          "fs/observed",
          target,
          { kind: "present", version: info.version },
          exec,
        );
        return {
          path: target.displayPath,
          offset,
          lines,
          totalLines: allLines.length,
        };
      },
      presentCall: (value) => {
        try {
          const args = readArgs(value);
          return {
            card: "generic",
            title: `Read ${args.file_path}`,
            kind: "read",
            locations: [{ path: args.file_path, line: args.offset ?? 1 }],
          };
        } catch {
          return undefined;
        }
      },
      presentResult: (_args, result): ReadResultView | undefined => {
        if (result.isError) return undefined;
        const meta = readMeta(result.meta);
        return meta === undefined ? undefined : { card: "read", ...meta };
      },
    };
  ctx.tools.register(definition);
}
