#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../package.json after publish (files: ["dist", ...])
    const pkgPath = resolve(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function exitWith(error: unknown, code = 1): never {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[xcode-mcp] fatal: ${msg}\n`);
  if (process.env.DEBUG === "true" && error instanceof Error && error.stack) {
    process.stderr.write(error.stack + "\n");
  }
  process.exit(code);
}

async function main() {
  let config;
  try {
    config = loadConfig(process.argv, process.env, readPackageVersion());
  } catch (err) {
    exitWith(err, 2);
  }

  const server = createServer(config);
  await server.start();
}

process.on("unhandledRejection", (err) => exitWith(err));
process.on("uncaughtException", (err) => exitWith(err));

main().catch((err) => exitWith(err));
