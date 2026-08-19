import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["src/client.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "@deepseek-ai/*"],
});

const bundled = result.outputFiles[0]?.text;
if (bundled === undefined) throw new Error("esbuild did not produce a client bundle");

const clientModule = `window.__ModuleLoader__.load({
  id: "@open-aiden/dsh-lark-bridge",
  factory: (require) => {
    const module = { exports: {} };
${bundled}
    return module.exports;
  },
});
`;

await mkdir("dist", { recursive: true });
await writeFile("dist/client.js", clientModule);
