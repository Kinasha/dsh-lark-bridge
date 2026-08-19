import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import {
  applyImageLimits,
  larkResourcesToPromptParts,
  readBounded,
  sniffImageMediaType,
  type LarkMessageResourcePort,
  type LarkPromptImagePart,
  type LarkResourceDescriptor,
} from "../src/lark-resources.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.alloc(4),
  Buffer.from("WEBP", "latin1"),
  Buffer.alloc(16),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7", "latin1"), Buffer.alloc(16)]);

function fakeClient(
  bodies: Record<string, Buffer | Error>,
): { client: LarkMessageResourcePort; calls: { messageId: string; fileKey: string; type: string }[]; destroyed: boolean[] } {
  const calls: { messageId: string; fileKey: string; type: string }[] = [];
  const destroyed: boolean[] = [];
  const client: LarkMessageResourcePort = {
    im: {
      messageResource: {
        get: async (input) => {
          calls.push({
            messageId: input.path.message_id,
            fileKey: input.path.file_key,
            type: input.params.type,
          });
          const body = bodies[input.path.file_key];
          if (body instanceof Error) throw body;
          const source = body ?? Buffer.alloc(0);
          return {
            getReadableStream: () => {
              const chunks = [source.subarray(0, 4), source.subarray(4)];
              const stream = Readable.from(chunks.filter((chunk) => chunk.length > 0));
              const index = destroyed.push(false) - 1;
              stream.on("close", () => {
                destroyed[index] = stream.destroyed;
              });
              return stream;
            },
          };
        },
      },
    },
  };
  return { client, calls, destroyed };
}

function image(fileKey: string, fileName?: string): LarkResourceDescriptor {
  return { type: "image", fileKey, ...(fileName === undefined ? {} : { fileName }) };
}

test("sniffs the four accepted types from magic bytes", () => {
  assert.equal(sniffImageMediaType(PNG), "image/png");
  assert.equal(sniffImageMediaType(JPEG), "image/jpeg");
  assert.equal(sniffImageMediaType(GIF), "image/gif");
  assert.equal(sniffImageMediaType(WEBP), "image/webp");
  assert.equal(sniffImageMediaType(PDF), undefined);
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined);
  assert.equal(sniffImageMediaType(Buffer.from("RIFFxxxxNOTW")), undefined);
});

test("reads a bounded stream and destroys it the moment it overflows", async () => {
  const small = Readable.from([Buffer.alloc(10)]);
  assert.equal((await readBounded(small, 100)).length, 10);

  const big = Readable.from([Buffer.alloc(60), Buffer.alloc(60)]);
  await assert.rejects(readBounded(big, 100), /exceeds 100 bytes/);
  assert.equal(big.destroyed, true, "a 100 MB attachment must not be buffered");
});

test("downloads images through the message-resource endpoint", async () => {
  const { client, calls } = fakeClient({ img_1: PNG, img_2: JPEG });
  const result = await larkResourcesToPromptParts(client, {
    messageId: "om_1",
    rawContentType: "post",
    resources: [image("img_1", "a.png"), image("img_2")],
  });

  assert.deepEqual(calls, [
    { messageId: "om_1", fileKey: "img_1", type: "image" },
    { messageId: "om_1", fileKey: "img_2", type: "image" },
  ]);
  assert.equal(result.parts.length, 2);
  assert.equal(result.parts[0]?.mediaType, "image/png");
  assert.equal(result.parts[0]?.name, "a.png");
  assert.equal(result.parts[0]?.data, PNG.toString("base64"));
  assert.equal(result.parts[1]?.name, undefined);
  assert.deepEqual(result.notes, []);
});

test("rejects a PDF wearing a .png name", async () => {
  const { client } = fakeClient({ img_1: PDF });
  const result = await larkResourcesToPromptParts(client, {
    messageId: "om_1",
    rawContentType: "image",
    resources: [image("img_1", "totally-an-image.png")],
  });
  assert.deepEqual(result.parts, [], "the file name is not evidence");
  assert.deepEqual(result.notes, ["[已忽略一个无法识别的图片附件]"]);
});

test("notes an oversized image instead of failing the message", async () => {
  const { client } = fakeClient({ img_1: Buffer.concat([PNG, Buffer.alloc(5_000)]) });
  const result = await larkResourcesToPromptParts(
    client,
    { messageId: "om_1", rawContentType: "image", resources: [image("img_1")] },
    { maxImageBytes: 100 },
  );
  assert.deepEqual(result.parts, []);
  assert.deepEqual(result.notes, ["[已忽略一张过大的图片]"]);
});

test("never downloads a non-image, naming it instead", async () => {
  const { client, calls } = fakeClient({});
  const result = await larkResourcesToPromptParts(client, {
    messageId: "om_1",
    rawContentType: "file",
    resources: [
      { type: "file", fileKey: "f_1", fileName: "report.pdf" },
      { type: "audio", fileKey: "a_1" },
      { type: "video", fileKey: "v_1" },
    ],
  });
  assert.deepEqual(calls, [], "no bytes fetched for content DSH cannot read");
  assert.deepEqual(result.parts, []);
  assert.deepEqual(result.notes, [
    "[用户附带文件：report.pdf（暂不支持读取内容）]",
    "[用户附带语音（暂不支持读取内容）]",
    "[用户附带视频（暂不支持读取内容）]",
  ]);
});

test("skips stickers, which the resource endpoint rejects outright", async () => {
  const { client, calls } = fakeClient({});
  const result = await larkResourcesToPromptParts(client, {
    messageId: "om_1",
    rawContentType: "sticker",
    resources: [{ type: "sticker", fileKey: "s_1" }],
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { parts: [], notes: [] });
});

test("skips card and merge-forward messages wholesale", async () => {
  const { client, calls } = fakeClient({ img_1: PNG });
  for (const rawContentType of ["interactive", "merge_forward"]) {
    const result = await larkResourcesToPromptParts(client, {
      messageId: "om_1",
      rawContentType,
      resources: [image("img_1")],
    });
    assert.deepEqual(calls, [], rawContentType);
    assert.deepEqual(result.notes, ["[该消息中的附件暂不支持读取]"]);
  }
});

test("caps the number of downloaded images", async () => {
  const { client, calls } = fakeClient({ a: PNG, b: PNG, c: PNG });
  const result = await larkResourcesToPromptParts(
    client,
    {
      messageId: "om_1",
      rawContentType: "post",
      resources: [image("a"), image("b"), image("c")],
    },
    { maxImages: 2 },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.parts.length, 2);
  assert.deepEqual(result.notes, ["[已忽略超出 2 张限制的图片]"]);
});

test("continues past a download failure", async () => {
  const { client } = fakeClient({ a: new Error("network"), b: PNG });
  const result = await larkResourcesToPromptParts(client, {
    messageId: "om_1",
    rawContentType: "post",
    resources: [image("a"), image("b")],
  });
  assert.equal(result.parts.length, 1);
  assert.deepEqual(result.notes, ["[一张图片读取失败]"]);
});

test("applies the host image limits before prompting", () => {
  const part = (mediaType: LarkPromptImagePart["mediaType"], bytes: number): LarkPromptImagePart => ({
    type: "image",
    mediaType,
    data: Buffer.alloc(bytes).toString("base64"),
  });

  assert.deepEqual(
    applyImageLimits([part("image/png", 10)], undefined).parts.length,
    1,
    "an absent projection skips the pre-check",
  );

  const byType = applyImageLimits([part("image/webp", 10), part("image/png", 10)], {
    mediaTypes: ["image/png", "image/jpeg"],
  });
  assert.equal(byType.parts.length, 1);
  assert.match(byType.notes[0] ?? "", /image\/webp/);

  const byCount = applyImageLimits(
    [part("image/png", 10), part("image/png", 10), part("image/png", 10)],
    { maxImagesPerMessage: 2 },
  );
  assert.equal(byCount.parts.length, 2);

  const bySize = applyImageLimits([part("image/png", 500), part("image/png", 10)], {
    maxImageBytes: 100,
  });
  assert.equal(bySize.parts.length, 1);

  const byTotal = applyImageLimits([part("image/png", 80), part("image/png", 80)], {
    maxMessageImageBytes: 100,
  });
  assert.equal(byTotal.parts.length, 1);
  assert.match(byTotal.notes[0] ?? "", /总量/);
});
