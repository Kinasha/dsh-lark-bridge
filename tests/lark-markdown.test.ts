import assert from "node:assert/strict";
import test from "node:test";
import {
  renderLarkMarkdown,
  renderMermaidSvgForRasterization,
} from "../src/lark-markdown.js";

test("resolves Mermaid CSS colors before rasterization", () => {
  const svg = renderMermaidSvgForRasterization(`
graph LR
  Web --> Feishu
`);

  assert.doesNotMatch(svg, /var\(--|color-mix\(/);
  assert.doesNotMatch(svg, /@import|(?:href|url)\s*[=(]["']?https?:/i);
  assert.match(svg, /fill="#eff6ff"/);
  assert.match(svg, /fill="#111827"/);
  assert.match(svg, /stroke="#64748b"/);
});

test("keeps GFM tables and renders Mermaid flowcharts as uploaded images", async () => {
  const uploaded: Buffer[] = [];
  const rendered = await renderLarkMarkdown(`
| Item | Status |
| --- | --- |
| Web | Done |

\`\`\`mermaid
graph LR
  Web --> Feishu
\`\`\`
`, async (png) => {
    uploaded.push(png);
    return "img_v3_mermaid";
  });

  assert.match(rendered, /\| Item \| Status \|/);
  assert.doesNotMatch(rendered, /\`\`\`mermaid/);
  assert.match(rendered, /!\[Mermaid 图表\]\(img_v3_mermaid\)/);
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0]!.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test("keeps unsupported Mermaid source in an explicit fallback block", async () => {
  const rendered = await renderLarkMarkdown(`
\`\`\`mermaid
pie title Pets
  "Dogs" : 4
\`\`\`
`);

  assert.match(rendered, /图表暂不支持渲染，已保留 Mermaid 源码/);
  assert.match(rendered, /\`\`\`mermaid/);
  assert.match(rendered, /pie title Pets/);
});
