import { fileURLToPath } from "node:url";
import path from "node:path";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const STATE_ROOT = path.join(PROJECT_ROOT, ".state");
export const DSH_HOME = path.join(STATE_ROOT, "dsh-home");
export const WORKSPACE_PATH = path.join(PROJECT_ROOT, "workspace");
export const DEFAULT_DSH_PORT = 3081;
export const DEFAULT_DSH_URL = `http://127.0.0.1:${DEFAULT_DSH_PORT}`;
export const LARK_WORKSPACE_TITLE = "Feishu";
