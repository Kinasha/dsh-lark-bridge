import {
  createElement as h,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type { Config } from "./plugin.js";

const LOCALE_NAMESPACE = "dsh-lark.settings";
const API_PATH = "/dsh-lark/settings/api";

const en = {
  title: "Lark bridge",
  description: "Connects Lark messages and DSH sessions.",
  restart: "Saved changes take effect after DSH restarts.",
  loading: "Loading settings…",
  loadFailed: "Could not load settings.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved. Restart DSH to apply changes.",
  discard: "Discard",
  reset: "Reset",
  overridden: "Overridden",
  invalidNumber: "Enter a positive whole number.",
  showSettings: "Show settings",
  hideSettings: "Hide settings",
  enabled: "Enable bridge",
  workspacePath: "Workspace path",
  workspaceTitle: "Workspace title",
  allowedSenderIds: "Sender allowlist",
  blockedSenderIds: "Sender blocklist",
  listHint: "One sender open_id per line. The blocklist takes precedence.",
  maxConcurrentTopics: "Concurrent topics",
  maxPendingMessages: "Pending message limit",
  eventStatePath: "Admission state file",
  eventRetentionMs: "Admission retention (ms)",
  enableUserAuth: "Enable Web user authorization",
  userAuthStatePath: "User authorization state file",
  userAuthRedirectUri: "OAuth redirect URI",
  appId: "App ID",
  domain: "Open platform",
  replyMode: "Reply style",
  replyModeHint: "\"card\" streams the answer into a Feishu card; \"post\" sends one rich-text reply.",
  enableCardKit: "Allow streaming cards",
  enableCot: "Allow native COT (ByteDance tenants)",
  alwaysPostFinal: "Also send a plain reply",
  streamPrintFrequencyMs: "Typewriter interval (ms)",
  streamPrintStep: "Characters per tick",
  streamElementMaxChars: "Characters per card component",
  enableHtmlReports: "Host HTML reports locally",
  htmlReportOrigin: "Report origin override",
  htmlReportTtlMs: "Report lifetime (ms)",
  enableCardActions: "Accept card button callbacks",
  enableApprovals: "Let Lark users approve tool calls",
  approvalsHint: "Off by default: it lets a chat identity authorize workspace changes.",
  enableQuestions: "Render agent questions as buttons",
  enableInboundResources: "Read attached images",
  maxInboundImages: "Images per message",
  maxInboundImageBytes: "Bytes per image",
  enableBotMenu: "Handle bot menu events",
  enableReactionCommands: "Reactions act as commands",
  interruptEmoji: "Interrupt reaction emoji_type",
  useEventStream: "Receive events by push",
  allowSlashCommands: "Allow DSH slash commands from Lark",
  slashHint: "Off by default: a message starting with / would bypass the model.",
  credentials: "Bot credentials",
  appSecret: "App Secret",
  credentialConfigured: "Configured",
  credentialMissing: "Not set",
  credentialFrom: "From",
  credentialReadOnly: "Supplied by the environment; read-only here.",
  credentialSave: "Save secret",
  credentialClear: "Clear",
  credentialPlaceholder: "Enter to replace; never displayed",
  openBotConfig: "Open bot configuration",
};

const zh: typeof en = {
  title: "飞书桥接",
  description: "连接飞书消息与 DSH Session。",
  restart: "保存的修改将在重启 DSH 后生效。",
  loading: "正在读取设置…",
  loadFailed: "设置读取失败。",
  save: "保存",
  saving: "正在保存…",
  saved: "已保存，重启 DSH 后生效。",
  discard: "放弃修改",
  reset: "重置",
  overridden: "已覆盖",
  invalidNumber: "请输入正整数。",
  showSettings: "显示设置",
  hideSettings: "收起设置",
  enabled: "启用飞书桥接",
  workspacePath: "Workspace 路径",
  workspaceTitle: "Workspace 标题",
  allowedSenderIds: "发送者白名单",
  blockedSenderIds: "发送者黑名单",
  listHint: "每行填写一个 sender open_id；黑名单优先。",
  maxConcurrentTopics: "并行 Topic 数",
  maxPendingMessages: "待处理消息上限",
  eventStatePath: "事件状态文件",
  eventRetentionMs: "事件保留时间（毫秒）",
  enableUserAuth: "启用 Web 用户身份授权",
  userAuthStatePath: "用户授权状态文件",
  userAuthRedirectUri: "OAuth 回调地址",
  appId: "App ID",
  domain: "开放平台",
  replyMode: "回复形态",
  replyModeHint: "card 以飞书卡片流式输出；post 发送一条富文本回复。",
  enableCardKit: "允许流式卡片",
  enableCot: "允许原生 COT（字节租户）",
  alwaysPostFinal: "同时发送纯文本回复",
  streamPrintFrequencyMs: "打字机间隔（毫秒）",
  streamPrintStep: "每次显示字符数",
  streamElementMaxChars: "单个卡片组件字符上限",
  enableHtmlReports: "本地托管 HTML 报告",
  htmlReportOrigin: "报告地址覆盖",
  htmlReportTtlMs: "报告保留时长（毫秒）",
  enableCardActions: "接收卡片按钮回调",
  enableApprovals: "允许飞书用户批准工具调用",
  approvalsHint: "默认关闭：这会让一个聊天身份获得授权变更工作区的能力。",
  enableQuestions: "以按钮呈现助手提问",
  enableInboundResources: "读取消息中的图片",
  maxInboundImages: "单条消息图片数上限",
  maxInboundImageBytes: "单张图片字节上限",
  enableBotMenu: "处理机器人菜单事件",
  enableReactionCommands: "表情回复作为指令",
  interruptEmoji: "中断所用的 emoji_type",
  useEventStream: "以推送方式接收事件",
  allowSlashCommands: "允许飞书消息触发 DSH 斜杠命令",
  slashHint: "默认关闭：以 / 开头的消息会绕过模型直接执行命令。",
  credentials: "机器人凭据",
  appSecret: "App Secret",
  credentialConfigured: "已配置",
  credentialMissing: "未配置",
  credentialFrom: "来源",
  credentialReadOnly: "由环境变量提供，此处只读。",
  credentialSave: "保存密钥",
  credentialClear: "清除",
  credentialPlaceholder: "输入以替换；永不回显",
  openBotConfig: "打开飞书机器人配置",
};

type LocaleKey = keyof typeof en;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "dsh-lark.settings": LocaleKey;
  }
}

export interface CredentialStatus {
  configured: boolean;
  source?: string;
  writable: boolean;
}

interface Descriptor {
  writable: boolean;
  revision: number;
  value: Config;
  base?: Partial<Config>;
  user?: Partial<Config>;
  /** `schema.toJSON()`; field kinds are derived from it, never hardcoded. */
  schema?: unknown;
  credentials?: Record<string, CredentialStatus>;
}

/** The subset of a serialized schemastery node this form reads. */
export interface SchemaNode {
  type?: string;
  dict?: Record<string, SchemaNode | number>;
  list?: Array<SchemaNode | number>;
  value?: unknown;
  meta?: { default?: unknown; description?: unknown };
}

/** Resolves the `uid + refs` graph emitted by Schemastery `toJSON()`. */
export function schemaDictionary(serialized: unknown): Record<string, SchemaNode> {
  if (typeof serialized !== "object" || serialized === null) return {};
  const graph = serialized as {
    uid?: number;
    refs?: Record<string, SchemaNode>;
    dict?: Record<string, SchemaNode>;
  };
  if (graph.dict !== undefined) return graph.dict;
  if (graph.uid === undefined || graph.refs === undefined) return {};

  const cache = new Map<number, SchemaNode>();
  const resolve = (value: SchemaNode | number | undefined): SchemaNode | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number") return value;
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const source = graph.refs?.[String(value)];
    if (source === undefined) return undefined;
    const node: SchemaNode = {
      ...(source.type === undefined ? {} : { type: source.type }),
      ...(source.value === undefined ? {} : { value: source.value }),
      ...(source.meta === undefined ? {} : { meta: source.meta }),
    };
    cache.set(value, node);
    if (source.list !== undefined) {
      node.list = source.list
        .map((entry) => resolve(entry))
        .filter((entry): entry is SchemaNode => entry !== undefined);
    }
    if (source.dict !== undefined) {
      node.dict = Object.fromEntries(
        Object.entries(source.dict)
          .map(([key, entry]) => [key, resolve(entry)] as const)
          .filter((entry): entry is readonly [string, SchemaNode] => entry[1] !== undefined),
      );
    }
    return node;
  };

  const root = resolve(graph.uid);
  return Object.fromEntries(
    Object.entries(root?.dict ?? {}).filter(
      (entry): entry is [string, SchemaNode] => typeof entry[1] !== "number",
    ),
  );
}

export type FieldKind = "boolean" | "number" | "list" | "select" | "text";

export function larkOpenPlatformUrl(
  appId: string,
  domain: "feishu" | "lark",
): string | undefined {
  const normalized = appId.trim();
  if (!normalized) return undefined;
  const origin = domain === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
  return `${origin}/app/${encodeURIComponent(normalized)}`;
}

/**
 * Derives each field's control from the schema the host serializes.
 *
 * The previous three hardcoded Sets had to track `Config` by hand; a new field
 * silently rendered as a text box and saved the wrong type.
 */
export function fieldKind(node: SchemaNode | undefined): FieldKind {
  if (node?.type === "boolean") return "boolean";
  if (node?.type === "number") return "number";
  // `SenderIdList` is a transform over `any`; it is the only list field.
  if (node?.type === "transform") return "list";
  if (node?.type === "union" && (node.list?.length ?? 0) > 0) return "select";
  return "text";
}

export function selectOptions(node: SchemaNode | undefined): string[] {
  return (node?.list ?? [])
    .filter((entry): entry is SchemaNode => typeof entry !== "number")
    .map((entry) => entry.value)
    .filter((value): value is string => typeof value === "string");
}

type FieldName = keyof Config;
type DraftValue = string | boolean;
type Drafts = Partial<Record<FieldName, DraftValue>>;
type Dirty = Partial<Record<FieldName, "set" | "unset">>;

const DEFAULTS: Config = {
  enabled: true,
  workspacePath: ".",
  allowedSenderIds: [],
  blockedSenderIds: [],
  maxConcurrentTopics: 4,
  maxPendingMessages: 256,
  eventRetentionMs: 604_800_000,
  enableUserAuth: true,
  domain: "feishu",
  replyMode: "post",
  enableCardKit: true,
  enableCot: true,
  alwaysPostFinal: false,
  streamPrintFrequencyMs: 70,
  streamPrintStep: 1,
  streamElementMaxChars: 30_000,
  enableHtmlReports: true,
  htmlReportTtlMs: 86_400_000,
  enableCardActions: true,
  enableApprovals: false,
  enableQuestions: true,
  enableInboundResources: true,
  maxInboundImages: 4,
  maxInboundImageBytes: 5_000_000,
  enableBotMenu: true,
  enableReactionCommands: true,
  interruptEmoji: "X",
  useEventStream: true,
  allowSlashCommands: false,
};

/** Fallback used only when the host serves no schema (older builds). */
const FALLBACK_KINDS: Partial<Record<FieldName, FieldKind>> = {
  enabled: "boolean",
  enableUserAuth: "boolean",
  allowedSenderIds: "list",
  blockedSenderIds: "list",
  maxConcurrentTopics: "number",
  maxPendingMessages: "number",
  eventRetentionMs: "number",
};

let schemaNodes: Record<string, SchemaNode> | undefined;

function kindOf(name: FieldName): FieldKind {
  const node = schemaNodes?.[name];
  if (node !== undefined) return fieldKind(node);
  return FALLBACK_KINDS[name] ?? "text";
}

const BOOLEAN_FIELDS = { has: (name: FieldName) => kindOf(name) === "boolean" };
const LIST_FIELDS = { has: (name: FieldName) => kindOf(name) === "list" };
const NUMBER_FIELDS = {
  has: (name: FieldName) => kindOf(name) === "number",
  [Symbol.iterator]: function* (): Generator<FieldName> {
    for (const name of Object.keys(schemaNodes ?? FALLBACK_KINDS) as FieldName[]) {
      if (kindOf(name) === "number") yield name;
    }
  },
};

export const FIELDS: Array<{
  name: FieldName;
  label: LocaleKey;
  wide?: boolean;
}> = [
  { name: "appId", label: "appId", wide: true },
  { name: "enabled", label: "enabled" },
  { name: "workspacePath", label: "workspacePath" },
  { name: "workspaceTitle", label: "workspaceTitle" },
  { name: "maxConcurrentTopics", label: "maxConcurrentTopics" },
  { name: "allowedSenderIds", label: "allowedSenderIds", wide: true },
  { name: "blockedSenderIds", label: "blockedSenderIds", wide: true },
  { name: "maxPendingMessages", label: "maxPendingMessages" },
  { name: "eventRetentionMs", label: "eventRetentionMs" },
  { name: "eventStatePath", label: "eventStatePath", wide: true },
  { name: "enableUserAuth", label: "enableUserAuth", wide: true },
  { name: "userAuthStatePath", label: "userAuthStatePath", wide: true },
  { name: "userAuthRedirectUri", label: "userAuthRedirectUri", wide: true },
  { name: "domain", label: "domain" },
  { name: "replyMode", label: "replyMode" },
  { name: "enableCardKit", label: "enableCardKit" },
  { name: "enableCot", label: "enableCot" },
  { name: "alwaysPostFinal", label: "alwaysPostFinal" },
  { name: "streamPrintFrequencyMs", label: "streamPrintFrequencyMs" },
  { name: "streamPrintStep", label: "streamPrintStep" },
  { name: "streamElementMaxChars", label: "streamElementMaxChars" },
  { name: "enableHtmlReports", label: "enableHtmlReports" },
  { name: "htmlReportTtlMs", label: "htmlReportTtlMs" },
  { name: "htmlReportOrigin", label: "htmlReportOrigin", wide: true },
  { name: "enableCardActions", label: "enableCardActions" },
  { name: "enableApprovals", label: "enableApprovals", wide: true },
  { name: "enableQuestions", label: "enableQuestions" },
  { name: "enableInboundResources", label: "enableInboundResources" },
  { name: "maxInboundImages", label: "maxInboundImages" },
  { name: "maxInboundImageBytes", label: "maxInboundImageBytes" },
  { name: "enableBotMenu", label: "enableBotMenu" },
  { name: "enableReactionCommands", label: "enableReactionCommands" },
  { name: "interruptEmoji", label: "interruptEmoji" },
  { name: "useEventStream", label: "useEventStream" },
  { name: "allowSlashCommands", label: "allowSlashCommands", wide: true },
];

const STYLE = `
.dsh-lark-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsh-lark-card:hover{border-color:var(--dsw-alias-label-dimmed)}.dsh-lark-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-lark-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}
.dsh-lark-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-lark-heading{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.dsh-lark-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.dsh-lark-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsh-lark-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.dsh-lark-chevron-open{transform:rotate(180deg)}
.dsh-lark-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.dsh-lark-note,.dsh-lark-status{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.dsh-lark-grid{display:block}.dsh-lark-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}.dsh-lark-field+.dsh-lark-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-lark-label-row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}.dsh-lark-label-row>span:first-child,.dsh-lark-label-row>label:first-child{min-width:0;flex:1}.dsh-lark-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dsh-lark-input,.dsh-lark-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.dsh-lark-input{height:34px}.dsh-lark-input:focus-visible,.dsh-lark-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.dsh-lark-input:disabled,.dsh-lark-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.dsh-lark-textarea{min-height:68px;padding-top:8px;padding-bottom:8px;resize:vertical}
.dsh-lark-check{display:flex;align-items:center;gap:8px;min-height:22px;flex:1}.dsh-lark-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;padding:0;font-size:12px;line-height:1.5}.dsh-lark-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.dsh-lark-reset:disabled{cursor:default}
.dsh-lark-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.dsh-lark-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.dsh-lark-actions{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px}.dsh-lark-button{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 14px;font-size:13px;line-height:1.5}.dsh-lark-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.dsh-lark-button-primary{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dsh-lark-button:disabled{cursor:default;opacity:.4}.dsh-lark-actions .dsh-lark-status{margin:0 auto 0 0}
`;

function ChevronIcon({ className }: { className: string }) {
  return h("svg", {
    width: 14,
    height: 14,
    className,
    viewBox: "0 0 14 14",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
  }, h("path", {
    d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
    fill: "currentColor",
  }));
}

function formatValue(name: FieldName, value: unknown): DraftValue {
  if (BOOLEAN_FIELDS.has(name)) return Boolean(value);
  if (LIST_FIELDS.has(name)) return Array.isArray(value) ? value.join("\n") : "";
  return value === undefined || value === null ? "" : String(value);
}

function draftsFrom(value: Config): Drafts {
  return Object.fromEntries(
    FIELDS.map(({ name }) => [name, formatValue(name, value[name])]),
  ) as Drafts;
}

function parsedValue(name: FieldName, value: DraftValue): unknown {
  if (BOOLEAN_FIELDS.has(name)) return Boolean(value);
  const text = String(value).trim();
  if (LIST_FIELDS.has(name)) {
    return [...new Set(text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
  }
  if (NUMBER_FIELDS.has(name)) return Number(text);
  return text;
}

function positiveInteger(value: DraftValue | undefined): boolean {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

async function readDescriptor(signal?: AbortSignal): Promise<Descriptor> {
  const response = await fetch(API_PATH, {
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  const body = (await response.json()) as Descriptor & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "settings request failed");
  return body;
}

function createSettingsCard(ctx: ClientContext) {
  return function LarkSettingsCard() {
    useSyncExternalStore(
      (listener) => ctx.locale.subscribe(listener),
      () => ctx.locale.getSnapshot(),
    );
    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    const [open, setOpen] = useState(false);
    const [descriptor, setDescriptor] = useState<Descriptor>();
    const [drafts, setDrafts] = useState<Drafts>({});
    const [dirty, setDirty] = useState<Dirty>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const [secret, setSecret] = useState("");

    /**
     * Credentials travel on their own operations, not through the settings
     * revision: the value goes in and never comes back, so there is nothing to
     * fence and nothing that could be echoed to the browser.
     */
    const writeCredential = async (
      operation: { op: "credential-set"; ref: string; value: string } | { op: "credential-unset"; ref: string },
    ) => {
      if (descriptor === undefined || saving) return;
      setSaving(true);
      setError("");
      try {
        const response = await fetch(API_PATH, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: descriptor.revision, ops: [operation] }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "credential write failed");
        setSecret("");
        setSaved(true);
        adopt(await readDescriptor());
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setSaving(false);
      }
    };

    const adopt = (next: Descriptor) => {
      schemaNodes = schemaDictionary(next.schema);
      setDescriptor(next);
      setDrafts(draftsFrom(next.value));
      setDirty({});
    };

    useEffect(() => {
      if (!open || descriptor !== undefined) return;
      const controller = new AbortController();
      setLoading(true);
      setError("");
      readDescriptor(controller.signal).then(adopt, (reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
      return () => controller.abort();
    }, [open, descriptor]);

    const invalid = useMemo(
      () =>
        [...NUMBER_FIELDS].some(
          (name) => dirty[name] === "set" && !positiveInteger(drafts[name]),
        ),
      [dirty, drafts],
    );

    const edit = (name: FieldName, value: DraftValue) => {
      setDrafts((current) => ({ ...current, [name]: value }));
      setDirty((current) => ({
        ...current,
        [name]: typeof value === "string" && value.trim() === "" ? "unset" : "set",
      }));
      setError("");
      setSaved(false);
    };

    const reset = (name: FieldName) => {
      const inherited = descriptor?.base?.[name] ?? DEFAULTS[name];
      setDrafts((current) => ({
        ...current,
        [name]: formatValue(name, inherited),
      }));
      setDirty((current) => ({ ...current, [name]: "unset" }));
      setError("");
      setSaved(false);
    };

    const discard = () => {
      if (descriptor !== undefined) adopt(descriptor);
      setError("");
      setSaved(false);
    };

    const save = async () => {
      if (descriptor === undefined || invalid || saving) return;
      const ops = Object.entries(dirty).map(([field, operation]) =>
        operation === "unset"
          ? { op: "unset", path: [field] }
          : {
              op: "set",
              path: [field],
              value: parsedValue(field as FieldName, drafts[field as FieldName] ?? ""),
            },
      );
      if (ops.length === 0) return;
      setSaving(true);
      setError("");
      try {
        const response = await fetch(API_PATH, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: descriptor.revision, ops }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "settings save failed");
        adopt(await readDescriptor());
        setSaved(true);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setSaving(false);
      }
    };

    const fieldNodes = descriptor === undefined
      ? []
      : FIELDS.map(({ name, label, wide }) => {
          const kind = kindOf(name);
          const isBoolean = kind === "boolean";
          const isList = kind === "list";
          const isNumber = kind === "number";
          const options = kind === "select" ? selectOptions(schemaNodes?.[name]) : [];
          const inputId = `plugin-config-lark-${name}`;
          const fieldInvalid = isNumber && dirty[name] === "set" && !positiveInteger(drafts[name]);
          const overridden = dirty[name] === "set" ||
            (dirty[name] === undefined && Object.hasOwn(descriptor.user ?? {}, name));
          const common = {
            disabled: !descriptor.writable || saving,
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              edit(name, isBoolean
                ? (event.target as HTMLInputElement).checked
                : event.target.value),
          };
          const control = isBoolean
            ? h("label", { className: "dsh-lark-check" },
                h("input", {
                  id: inputId,
                  type: "checkbox",
                  checked: Boolean(drafts[name]),
                  ...common,
                }),
                h("span", null, t(label)),
              )
            : isList
              ? h("textarea", {
                  id: inputId,
                  className: "dsh-lark-textarea",
                  value: String(drafts[name] ?? ""),
                  ...common,
                })
              : options.length > 0
              ? h("select", {
                  id: inputId,
                  className: "dsh-lark-input",
                  value: String(drafts[name] ?? ""),
                  ...common,
                }, options.map((option) =>
                  h("option", { key: option, value: option }, option),
                ))
              : h("input", {
                  id: inputId,
                  className: "dsh-lark-input",
                  type: "text",
                  inputMode: isNumber ? "numeric" : undefined,
                  "aria-invalid": fieldInvalid || undefined,
                  value: String(drafts[name] ?? ""),
                  ...common,
                });
          return h("div", {
            className: `dsh-lark-field${wide ? " dsh-lark-field-wide" : ""}`,
            key: name,
          },
          !isBoolean && h("div", { className: "dsh-lark-label-row" },
            h("label", { htmlFor: inputId }, t(label)),
            overridden && h("span", { className: "dsh-lark-badge" }, t("overridden")),
            (overridden || dirty[name] !== undefined) && h("button", {
              className: "dsh-lark-reset",
              type: "button",
              disabled: !descriptor.writable || saving,
              onClick: () => reset(name),
            }, t("reset")),
          ),
          isBoolean && h("div", { className: "dsh-lark-label-row" },
            control,
            overridden && h("span", { className: "dsh-lark-badge" }, t("overridden")),
            (overridden || dirty[name] !== undefined) && h("button", {
              className: "dsh-lark-reset",
              type: "button",
              disabled: !descriptor.writable || saving,
              onClick: () => reset(name),
            }, t("reset")),
          ),
          !isBoolean && control,
          isList && h("span", { className: "dsh-lark-hint" }, t("listHint")),
          fieldInvalid && h("span", { className: "dsh-lark-error" }, t("invalidNumber")),
          );
        });
    const [appIdNode, ...otherFieldNodes] = fieldNodes;
    const openPlatformUrl = larkOpenPlatformUrl(
      String(drafts.appId ?? ""),
      drafts.domain === "lark" ? "lark" : "feishu",
    );

    return h("li", { className: `dsh-lark-card${open ? " dsh-lark-card-open" : ""}` },
      h("button", {
        className: "dsh-lark-header",
        type: "button",
        "aria-expanded": open,
        "aria-label": `${t(open ? "hideSettings" : "showSettings")}: ${t("title")}`,
        onClick: () => setOpen((value) => !value),
      },
      h("span", { className: "dsh-lark-heading" },
        h("span", { className: "dsh-lark-title" }, t("title")),
        h("span", { className: "dsh-lark-description" }, t("description")),
      ),
      h(ChevronIcon, {
        className: `dsh-lark-chevron${open ? " dsh-lark-chevron-open" : ""}`,
      }),
      ),
      open && h("div", { className: "dsh-lark-body" },
        h("p", { className: "dsh-lark-note" }, t("restart")),
        loading && h("p", { className: "dsh-lark-status" }, t("loading")),
        descriptor !== undefined && h("div", { className: "dsh-lark-grid" },
          appIdNode,
          descriptor.credentials !== undefined &&
          h("div", { className: "dsh-lark-field dsh-lark-field-wide" },
            h("div", { className: "dsh-lark-label-row" },
              h("label", { htmlFor: "plugin-config-lark-secret" }, t("appSecret")),
              h("span", { className: "dsh-lark-badge" },
                descriptor.credentials.LARK_APP_SECRET?.configured
                  ? `${t("credentialConfigured")}${
                      descriptor.credentials.LARK_APP_SECRET.source === undefined
                        ? ""
                        : ` · ${t("credentialFrom")} ${descriptor.credentials.LARK_APP_SECRET.source}`
                    }`
                  : t("credentialMissing"),
              ),
            ),
            h("input", {
              id: "plugin-config-lark-secret",
              className: "dsh-lark-input",
              type: "password",
              autoComplete: "off",
              placeholder: t("credentialPlaceholder"),
              value: secret,
              disabled:
                saving || descriptor.credentials.LARK_APP_SECRET?.writable !== true,
              onChange: (event: ChangeEvent<HTMLInputElement>) =>
                setSecret(event.target.value),
            }),
            descriptor.credentials.LARK_APP_SECRET?.writable !== true &&
              h("span", { className: "dsh-lark-hint" }, t("credentialReadOnly")),
            h("div", { className: "dsh-lark-actions" },
              h("button", {
                className: "dsh-lark-button dsh-lark-button-primary",
                type: "button",
                disabled:
                  saving ||
                  secret.trim() === "" ||
                  descriptor.credentials.LARK_APP_SECRET?.writable !== true,
                onClick: () =>
                  void writeCredential({
                    op: "credential-set",
                    ref: "LARK_APP_SECRET",
                    value: secret,
                  }),
              }, t("credentialSave")),
              h("button", {
                className: "dsh-lark-button",
                type: "button",
                disabled:
                  saving ||
                  descriptor.credentials.LARK_APP_SECRET?.configured !== true ||
                  descriptor.credentials.LARK_APP_SECRET?.writable !== true,
                onClick: () =>
                  void writeCredential({ op: "credential-unset", ref: "LARK_APP_SECRET" }),
              }, t("credentialClear")),
            ),
          ),
          openPlatformUrl !== undefined && h("div", { className: "dsh-lark-actions" },
            h("a", {
              className: "dsh-lark-button",
              href: openPlatformUrl,
              target: "_blank",
              rel: "noopener noreferrer",
            }, t("openBotConfig")),
          ),
        ),
        descriptor !== undefined && h("div", { className: "dsh-lark-grid" }, otherFieldNodes),
        error && h("p", { className: "dsh-lark-error" }, `${t("loadFailed")} ${error}`),
        descriptor !== undefined && h("div", { className: "dsh-lark-actions" },
          h("button", {
            className: "dsh-lark-button dsh-lark-button-primary",
            type: "button",
            disabled: !descriptor.writable || saving || invalid || Object.keys(dirty).length === 0,
            onClick: () => void save(),
          }, saving ? t("saving") : t("save")),
          h("button", {
            className: "dsh-lark-button",
            type: "button",
            disabled: saving || Object.keys(dirty).length === 0,
            onClick: discard,
          }, t("discard")),
          saved && h("span", { className: "dsh-lark-status" }, t("saved")),
        ),
      ),
    );
  };
}

export const inject = ["slots", "locale"];

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }), "dsh-lark settings locale");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => undefined;
    const style = document.createElement("style");
    style.dataset.plugin = "@open-aiden/dsh-lark-bridge";
    style.textContent = STYLE;
    document.head.appendChild(style);
    return () => style.remove();
  }, "dsh-lark settings styles");
  const Card = createSettingsCard(ctx);
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register({
      name: "settings.plugin.item",
      key: "dsh-lark-bridge",
      locale: LOCALE_NAMESPACE,
    }, Card),
  );
}
