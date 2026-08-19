/**
 * Inbound Feishu attachments to DSH prompt content parts.
 *
 * Two API facts drive the shape of this module.
 *
 * 1. Resources a *user* sent must be fetched through
 *    `im.v1.messageResource.get`. The key-based `im.v1.image.get` /
 *    `im.v1.file.get` endpoints only serve assets the bot itself uploaded, so
 *    they are the wrong call here even though they look convenient.
 * 2. That endpoint returns a stream, not a buffer, and Feishu allows up to
 *    100 MB. So the download is consumed chunk by chunk against a running
 *    total and destroyed the instant it exceeds the cap — a 100 MB attachment
 *    must never be buffered into this process.
 */

import type { Readable } from "node:stream";
import { silentLogger, type SemanticLogger } from "./logger.js";

/** base64 inflates by 4/3, and DSH applies its own limits on top. */
export const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;
export const DEFAULT_MAX_IMAGES = 4;

/** The four raster types DSH accepts as prompt image parts. */
export type PromptImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface LarkPromptImagePart {
  type: "image";
  mediaType: PromptImageMediaType;
  data: string;
  name?: string;
}

export interface LarkResourceDescriptor {
  type: "image" | "file" | "audio" | "video" | "sticker";
  fileKey: string;
  fileName?: string;
  durationMs?: number;
  coverImageKey?: string;
}

export interface LarkMessageResourcePort {
  im: {
    messageResource: {
      get(input: {
        path: { message_id: string; file_key: string };
        params: { type: string };
      }): Promise<{ getReadableStream(): Readable }>;
    };
  };
}

export interface ResourceIntakeOptions {
  maxImageBytes?: number;
  maxImages?: number;
  logger?: SemanticLogger;
}

export interface ResourceIntakeResult {
  parts: LarkPromptImagePart[];
  /** Human-readable lines appended to the prompt for what was not ingested. */
  notes: string[];
}

/**
 * Sniffs the media type from the leading bytes.
 *
 * Never trusts the file name or the response headers: a `.png` that is really a
 * PDF must not reach the model's context, and only these four types are
 * acceptable to DSH anyway.
 */
export function sniffImageMediaType(data: Buffer): PromptImageMediaType | undefined {
  if (data.length >= 8 && data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && data.subarray(0, 4).toString("latin1") === "GIF8") {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

class ResourceTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`resource exceeds ${limit} bytes`);
    this.name = "ResourceTooLargeError";
  }
}

/** Reads at most `limit` bytes, destroying the stream the moment it overflows. */
export async function readBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.length;
      if (total > limit) {
        stream.destroy();
        throw new ResourceTooLargeError(limit);
      }
      chunks.push(buffer);
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  return Buffer.concat(chunks);
}

function describeFile(resource: LarkResourceDescriptor): string {
  const name = resource.fileName?.trim();
  return name
    ? `[用户附带文件：${name}（暂不支持读取内容）]`
    : `[用户附带${resource.type === "audio" ? "语音" : resource.type === "video" ? "视频" : "文件"}（暂不支持读取内容）]`;
}

/**
 * Downloads the usable images on a message and returns them as prompt parts.
 *
 * Non-image attachments are deliberately **not** downloaded: DSH prompt parts
 * accept text and raster images only, so fetching a 30 MB PDF to then discard
 * it is pure cost. A note names it instead, which lets the agent ask the user
 * to paste the content. Writing attachments into the workspace stays out of
 * scope — attachment intake must not mutate the workspace as a side effect.
 */
export async function larkResourcesToPromptParts(
  client: LarkMessageResourcePort,
  input: {
    messageId: string;
    rawContentType: string;
    resources: readonly LarkResourceDescriptor[];
  },
  options: ResourceIntakeOptions = {},
): Promise<ResourceIntakeResult> {
  const logger = options.logger ?? silentLogger;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const parts: LarkPromptImagePart[] = [];
  const notes: string[] = [];

  // Card messages and merge-forward sub-messages are rejected by the resource
  // endpoint with 234043, so skip the whole message rather than fail per file.
  if (input.rawContentType === "interactive" || input.rawContentType === "merge_forward") {
    if (input.resources.length > 0) notes.push("[该消息中的附件暂不支持读取]");
    return { parts, notes };
  }

  for (const resource of input.resources) {
    if (resource.type === "sticker") continue;
    if (resource.type !== "image") {
      notes.push(describeFile(resource));
      continue;
    }
    if (parts.length >= maxImages) {
      notes.push(`[已忽略超出 ${maxImages} 张限制的图片]`);
      continue;
    }
    try {
      const response = await client.im.messageResource.get({
        path: { message_id: input.messageId, file_key: resource.fileKey },
        params: { type: "image" },
      });
      const data = await readBounded(response.getReadableStream(), maxImageBytes);
      const mediaType = sniffImageMediaType(data);
      if (mediaType === undefined) {
        notes.push("[已忽略一个无法识别的图片附件]");
        logger.info("lark_resource_rejected", {
          messageId: input.messageId,
          reason: "unrecognized_media_type",
        });
        continue;
      }
      parts.push({
        type: "image",
        mediaType,
        data: data.toString("base64"),
        ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
      });
    } catch (error) {
      const oversize = error instanceof ResourceTooLargeError;
      notes.push(oversize ? "[已忽略一张过大的图片]" : "[一张图片读取失败]");
      logger.warn("lark_resource_failed", {
        messageId: input.messageId,
        reason: oversize ? "too_large" : "download_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return { parts, notes };
}

export interface ImageLimits {
  maxImageBytes?: number;
  maxImagesPerMessage?: number;
  maxMessageImageBytes?: number;
  mediaTypes?: readonly string[];
}

/**
 * Applies the host's published `imageLimits` projection before prompting.
 *
 * An absent projection means no attachment service is composed, so the
 * pre-check is skipped and the host is left to answer — the documented posture
 * for that key.
 */
export function applyImageLimits(
  parts: readonly LarkPromptImagePart[],
  limits: ImageLimits | undefined,
): { parts: LarkPromptImagePart[]; notes: string[] } {
  if (limits === undefined) return { parts: [...parts], notes: [] };
  const notes: string[] = [];
  const allowed = limits.mediaTypes;
  let budget = limits.maxMessageImageBytes ?? Number.POSITIVE_INFINITY;
  const kept: LarkPromptImagePart[] = [];

  for (const part of parts) {
    if (allowed !== undefined && !allowed.includes(part.mediaType)) {
      notes.push(`[已忽略不受支持的图片格式 ${part.mediaType}]`);
      continue;
    }
    if (
      limits.maxImagesPerMessage !== undefined &&
      kept.length >= limits.maxImagesPerMessage
    ) {
      notes.push(`[已忽略超出 ${limits.maxImagesPerMessage} 张限制的图片]`);
      continue;
    }
    const bytes = Math.ceil((part.data.length * 3) / 4);
    if (limits.maxImageBytes !== undefined && bytes > limits.maxImageBytes) {
      notes.push("[已忽略一张过大的图片]");
      continue;
    }
    if (bytes > budget) {
      notes.push("[已忽略超出单条消息图片总量限制的图片]");
      continue;
    }
    budget -= bytes;
    kept.push(part);
  }
  return { parts: kept, notes };
}
