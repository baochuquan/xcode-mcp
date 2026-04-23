#!/usr/bin/env node
/**
 * Build entry: compile every src/**.ts to dist/**.js with esbuild.
 *
 * We use esbuild instead of `tsc` for the actual transpile because the
 * combination of zod's recursive types and the SDK's deep generics makes
 * `tsc --noEmit` exhaust >8GB of heap on this codebase. esbuild does no
 * type checking but emits clean ESM in milliseconds.
 *
 * Type checking is run separately via `npm run typecheck` (intentionally
 * scoped, not blocking the build) so the published package is never held
 * hostage to a strict-mode regression in the ported tool code.
 */
import { build } from "esbuild";
import { readdirSync, statSync, chmodSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "dist");

function collectTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTs(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const entryPoints = collectTs(SRC);

await build({
  entryPoints,
  outdir: OUT,
  outbase: SRC,
  format: "esm",
  platform: "node",
  target: "node16",
  bundle: false,
  sourcemap: false,
  logLevel: "info",
});

const indexJs = join(OUT, "index.js");
try {
  chmodSync(indexJs, 0o755);
  console.log(`chmod +x ${relative(ROOT, indexJs)}`);
} catch {
  // index.js may not exist yet on a partial build; ignore.
}
