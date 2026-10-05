import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(here, "package.json"), "utf8"),
) as { peerDependencies: Record<string, string> };
const out = path.resolve(here, "dist");
if (path.dirname(out) !== here) throw new Error("Invalid output path");
fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  external: ["electron", "cordis", ...Object.keys(manifest.peerDependencies)],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
  format: "esm",
  platform: "node",
  target: "node22",
  bundle: true,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  absWorkingDir: here,
});
