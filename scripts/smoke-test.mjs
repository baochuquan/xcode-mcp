#!/usr/bin/env node
// Tier 1 smoke test: spawn the MCP server, list all tools via stdio JSON-RPC,
// and validate that every tool is registered with a well-formed input schema.

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ENTRY = resolve(ROOT, "dist", "index.js");

if (!existsSync(ENTRY)) {
  console.error(
    `[smoke] dist/index.js not found at ${ENTRY}. Run \`npm run build\` first.`,
  );
  process.exit(2);
}

const PROJECTS_BASE_DIR = mkdtempSync(join(tmpdir(), "xcode-mcp-smoke-"));

const EXPECTED_TOOL_COUNT = 76;

const EXPECTED_GROUPS = {
  file: 13,
  spm: 15,
  project: 14,
  simulator: 11,
  xcode: 9,
  build: 7,
  cocoapods: 7,
};

const PREFIX_TO_GROUP = {
  read_file: "file",
  write_file: "file",
  copy_file: "file",
  move_file: "file",
  delete_file: "file",
  create_directory: "file",
  list_project_files: "file",
  list_directory: "file",
  get_file_info: "file",
  find_files: "file",
  resolve_path: "file",
  check_file_exists: "file",
  search_in_files: "file",
  init_swift_package: "spm",
  add_swift_package: "spm",
  remove_swift_package: "spm",
  edit_package_swift: "spm",
  build_spm_package: "spm",
  test_spm_package: "spm",
  get_package_info: "spm",
  update_swift_package: "spm",
  swift_package_command: "spm",
  build_swift_package: "spm",
  test_swift_package: "spm",
  show_swift_dependencies: "spm",
  clean_swift_package: "spm",
  dump_swift_package: "spm",
  generate_swift_docs: "spm",
  set_projects_base_dir: "project",
  set_project_path: "project",
  get_active_project: "project",
  find_projects: "project",
  change_directory: "project",
  push_directory: "project",
  pop_directory: "project",
  get_current_directory: "project",
  get_project_configuration: "project",
  detect_active_project: "project",
  add_file_to_project: "project",
  create_workspace: "project",
  add_project_to_workspace: "project",
  create_xcode_project: "project",
  list_booted_simulators: "simulator",
  list_simulators: "simulator",
  boot_simulator: "simulator",
  shutdown_simulator: "simulator",
  install_app: "simulator",
  launch_app: "simulator",
  terminate_app: "simulator",
  open_url: "simulator",
  take_screenshot: "simulator",
  reset_simulator: "simulator",
  list_installed_apps: "simulator",
  pod_install: "cocoapods",
  pod_update: "cocoapods",
  pod_outdated: "cocoapods",
  pod_repo_update: "cocoapods",
  pod_deintegrate: "cocoapods",
  check_cocoapods: "cocoapods",
  pod_init: "cocoapods",
  run_xcrun: "xcode",
  compile_asset_catalog: "xcode",
  run_lldb: "xcode",
  trace_app: "xcode",
  get_xcode_info: "xcode",
  switch_xcode: "xcode",
  export_archive: "xcode",
  validate_app: "xcode",
  generate_icon_set: "xcode",
  analyze_file: "build",
  build_project: "build",
  run_tests: "build",
  list_available_destinations: "build",
  list_available_schemes: "build",
  clean_project: "build",
  archive_project: "build",
};

function startServer() {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PROJECTS_BASE_DIR,
      LOG_LEVEL: "error",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks = [];
  child.stderr.on("data", (b) => stderrChunks.push(b));
  child.on("error", (e) => {
    console.error("[smoke] failed to spawn server:", e);
    process.exit(2);
  });

  return {
    child,
    getStderr: () => Buffer.concat(stderrChunks).toString("utf8"),
  };
}

// JSON-RPC over stdio: messages framed as one JSON object per line (newline-delimited)
function createRpc(child) {
  let nextId = 1;
  const pending = new Map();
  let buf = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg === "object" && "id" in msg && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    }
  });

  function call(method, params) {
    const id = nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(req) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 10000);
    });
  }

  function notify(method, params) {
    const req = { jsonrpc: "2.0", method, params };
    child.stdin.write(JSON.stringify(req) + "\n");
  }

  return { call, notify };
}

function fmtTable(rows) {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const line = (vals) =>
    "  " + vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  return [
    line(cols),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(cols.map((c) => r[c] ?? ""))),
  ].join("\n");
}

async function main() {
  console.log(`[smoke] PROJECTS_BASE_DIR=${PROJECTS_BASE_DIR}`);
  console.log(`[smoke] starting ${ENTRY}`);
  const { child, getStderr } = startServer();
  const rpc = createRpc(child);

  let exitCode = 0;
  try {
    const initResult = await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    });
    console.log(
      `[smoke] initialized → server ${initResult?.serverInfo?.name ?? "?"} v${initResult?.serverInfo?.version ?? "?"}`,
    );
    rpc.notify("notifications/initialized", {});

    const listResult = await rpc.call("tools/list", {});
    const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    console.log(`[smoke] tools/list returned ${tools.length} tools`);

    const issues = [];
    const byGroup = {};
    const seen = new Set();

    for (const t of tools) {
      if (!t?.name) {
        issues.push({ tool: "(unnamed)", problem: "missing name" });
        continue;
      }
      if (seen.has(t.name)) {
        issues.push({ tool: t.name, problem: "duplicate registration" });
        continue;
      }
      seen.add(t.name);

      if (typeof t.description !== "string" || t.description.trim() === "") {
        issues.push({ tool: t.name, problem: "missing description" });
      }

      const schema = t.inputSchema;
      if (!schema || typeof schema !== "object") {
        issues.push({ tool: t.name, problem: "missing inputSchema" });
      } else if (schema.type !== "object") {
        issues.push({
          tool: t.name,
          problem: `inputSchema.type=${schema.type} (expected 'object')`,
        });
      }

      const group = PREFIX_TO_GROUP[t.name];
      if (!group) {
        issues.push({ tool: t.name, problem: "tool not in expected catalog" });
      } else {
        byGroup[group] = (byGroup[group] ?? 0) + 1;
      }
    }

    const expectedNames = new Set(Object.keys(PREFIX_TO_GROUP));
    for (const expected of expectedNames) {
      if (!seen.has(expected)) {
        issues.push({ tool: expected, problem: "missing — not registered" });
      }
    }

    console.log("\n[smoke] tools per group:");
    console.log(
      fmtTable(
        Object.entries(EXPECTED_GROUPS).map(([g, exp]) => ({
          group: g,
          expected: exp,
          actual: byGroup[g] ?? 0,
          status: (byGroup[g] ?? 0) === exp ? "OK" : "MISMATCH",
        })),
      ),
    );

    console.log(
      `\n[smoke] total tools: actual=${tools.length}, expected=${EXPECTED_TOOL_COUNT}`,
    );

    if (issues.length === 0 && tools.length === EXPECTED_TOOL_COUNT) {
      console.log("\n[smoke] ✅ all tools registered with valid schemas");
    } else {
      exitCode = 1;
      console.log(`\n[smoke] ❌ ${issues.length} issue(s):`);
      console.log(fmtTable(issues));
    }
  } catch (err) {
    exitCode = 1;
    console.error("[smoke] ❌ error:", err?.message ?? err);
    const stderr = getStderr();
    if (stderr) console.error("[smoke] server stderr:\n" + stderr);
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000).unref();
  }

  process.exit(exitCode);
}

main();
