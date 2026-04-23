import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";

const ARGV0 = ["node", "/path/to/xcode-mcp"];

test("PROJECTS_BASE_DIR is required", () => {
  assert.throws(
    () => loadConfig(ARGV0, {}, "0.0.0"),
    /PROJECTS_BASE_DIR is required/,
  );
});

test("PROJECTS_BASE_DIR must be absolute", () => {
  assert.throws(
    () => loadConfig(ARGV0, { PROJECTS_BASE_DIR: "relative/path" }, "0.0.0"),
    /must be an absolute path/,
  );
});

test("env-only happy path produces frozen config", () => {
  const cfg = loadConfig(
    ARGV0,
    {
      PROJECTS_BASE_DIR: "/Users/me/Code",
      DEBUG: "true",
      LOG_LEVEL: "debug",
    },
    "1.2.3",
  );
  assert.equal(cfg.projectsBaseDir, "/Users/me/Code");
  assert.equal(cfg.debug, true);
  assert.equal(cfg.logLevel, "debug");
  assert.equal(cfg.enabledTools, "all");
  assert.equal(cfg.version, "1.2.3");
  assert.ok(Object.isFrozen(cfg), "config must be frozen");
});

test("CLI argv overrides env", () => {
  const cfg = loadConfig(
    [...ARGV0, "--projects-dir=/tmp/foo", "--log-level=warn"],
    { PROJECTS_BASE_DIR: "/Users/me/Code", LOG_LEVEL: "info" },
    "0.0.0",
  );
  assert.equal(cfg.projectsBaseDir, "/tmp/foo");
  assert.equal(cfg.logLevel, "warn");
});

test("XCODE_MCP_TOOLS parses to list", () => {
  const cfg = loadConfig(
    ARGV0,
    {
      PROJECTS_BASE_DIR: "/Users/me/Code",
      XCODE_MCP_TOOLS: "project, file ,build",
    },
    "0.0.0",
  );
  assert.deepEqual(cfg.enabledTools, ["project", "file", "build"]);
});

test("ALLOWED_PATHS parses to list", () => {
  const cfg = loadConfig(
    ARGV0,
    {
      PROJECTS_BASE_DIR: "/Users/me/Code",
      ALLOWED_PATHS: "/etc/config,/var/run",
    },
    "0.0.0",
  );
  assert.deepEqual(cfg.allowedPaths, ["/etc/config", "/var/run"]);
});

test("invalid LOG_LEVEL falls back to info", () => {
  const cfg = loadConfig(
    ARGV0,
    { PROJECTS_BASE_DIR: "/Users/me/Code", LOG_LEVEL: "trace" },
    "0.0.0",
  );
  assert.equal(cfg.logLevel, "info");
});
