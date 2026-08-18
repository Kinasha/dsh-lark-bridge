import { Resvg } from "@resvg/resvg-js";
import { renderMermaidASCII, renderMermaidSVG } from "beautiful-mermaid";

const MAX_MARKDOWN_LENGTH = 10_000;
const MERMAID_FENCE = /```mermaid[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
const SUPPORTED_MERMAID_HEADER =
  /^(?:(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR)\b|stateDiagram(?:-v2)?\b|sequenceDiagram\b|classDiagram\b|erDiagram\b|xychart-beta\b)/i;

export type LarkImageUploader = (png: Buffer) => Promise<string>;

const MERMAID_COLORS = {
  "--_arrow": "#2563eb",
  "--_group-fill": "#ffffff",
  "--_group-hdr": "#f8fafc",
  "--_inner-stroke": "#cbd5e1",
  "--_key-badge": "#e2e8f0",
  "--_line": "#64748b",
  "--_node-fill": "#eff6ff",
  "--_node-stroke": "#94a3b8",
  "--_text": "#111827",
  "--_text-faint": "#94a3b8",
  "--_text-muted": "#64748b",
  "--_text-sec": "#475569",
} as const;

function textDiagram(definition: string, reason: string): string {
  try {
    const diagram = renderMermaidASCII(definition, { colorMode: "none" });
    return `> ⚠️ ${reason}，已使用文本预览。\n\n\`\`\`text\n${diagram.trimEnd()}\n\`\`\``;
  } catch {
    return `> ⚠️ ${reason}，已保留 Mermaid 源码。\n\n\`\`\`mermaid\n${definition}\n\`\`\``;
  }
}

export function renderMermaidSvgForRasterization(definition: string): string {
  let svg = renderMermaidSVG(definition, {
    bg: "#ffffff",
    fg: "#111827",
    line: "#64748b",
    accent: "#2563eb",
    muted: "#475569",
    surface: "#eff6ff",
    border: "#94a3b8",
    font: "Arial",
  });
  for (const [variable, color] of Object.entries(MERMAID_COLORS)) {
    svg = svg.replaceAll(`var(${variable})`, color);
  }
  svg = svg
    .replaceAll("var(--bg)", "#ffffff")
    .replaceAll("var(--fg)", "#111827")
    .replaceAll("var(--line)", "#64748b")
    .replaceAll("var(--accent)", "#2563eb")
    .replaceAll("var(--muted)", "#475569")
    .replaceAll("var(--surface)", "#eff6ff")
    .replaceAll("var(--border)", "#94a3b8")
    .replace(/<style>[\s\S]*?<\/style>/i,
      "<style>text { font-family: Arial, sans-serif; }</style>");
  if (/<(?:script|image|foreignObject)\b|(?:href|url)\s*[=(]["']?https?:/i.test(svg)) {
    throw new Error("Mermaid SVG contains an external resource");
  }
  if (/var\(--|color-mix\(/i.test(svg)) {
    throw new Error("Mermaid SVG contains an unresolved CSS color");
  }
  return svg;
}

function mermaidPng(definition: string): Buffer {
  const svg = renderMermaidSvgForRasterization(definition);
  const rendered = new Resvg(svg, {
    background: "#ffffff",
    fitTo: { mode: "width", value: 1_400 },
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
  }).render();
  const png = rendered.asPng();
  if (rendered.width > 12_000 || rendered.height > 12_000 || png.length > 10_000_000) {
    throw new Error("Rendered Mermaid image exceeds Feishu limits");
  }
  return png;
}

async function renderMermaidBlock(
  source: string,
  uploadImage: LarkImageUploader | undefined,
): Promise<string> {
  const definition = source.trim();
  const header = definition
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%"));
  if (!header || !SUPPORTED_MERMAID_HEADER.test(header)) {
    return `> ⚠️ 图表暂不支持渲染，已保留 Mermaid 源码。\n\n\`\`\`mermaid\n${definition}\n\`\`\``;
  }
  if (uploadImage === undefined) {
    return textDiagram(definition, "图表图片上传不可用");
  }
  try {
    const imageKey = (await uploadImage(mermaidPng(definition))).trim();
    if (!imageKey) throw new Error("Feishu image upload returned no image key");
    return `![Mermaid 图表](${imageKey})`;
  } catch {
    return textDiagram(definition, "图表图片渲染或上传失败");
  }
}

function truncateMarkdown(markdown: string): string {
  if (markdown.length <= MAX_MARKDOWN_LENGTH) return markdown;
  const prefix = markdown.slice(0, MAX_MARKDOWN_LENGTH - 40).trimEnd();
  const fenceCount = prefix.match(/^```/gm)?.length ?? 0;
  return `${prefix}${fenceCount % 2 === 0 ? "" : "\n```"}\n\n[回复已截断]`;
}

export async function renderLarkMarkdown(
  text: string,
  uploadImage?: LarkImageUploader,
): Promise<string> {
  const normalized = text.trim() || "DeepSeek Harness 未生成文本回复。";
  const rendered: string[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(MERMAID_FENCE)) {
    rendered.push(normalized.slice(cursor, match.index));
    rendered.push(await renderMermaidBlock(match[1] ?? "", uploadImage));
    cursor = match.index + match[0].length;
  }
  rendered.push(normalized.slice(cursor));
  return truncateMarkdown(rendered.join(""));
}
