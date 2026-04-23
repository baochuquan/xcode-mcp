import { isAbsolute } from "node:path";

export interface Config {
  readonly projectsBaseDir: string;
  readonly allowedPaths: readonly string[];
  readonly debug: boolean;
  readonly logLevel: "error" | "warn" | "info" | "debug";
  readonly enabledTools: readonly string[] | "all";
  readonly version: string;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseArgv(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      out.set(a.slice(2), true);
    } else {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    }
  }
  return out;
}

export function loadConfig(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  pkgVersion: string = "0.0.0",
): Config {
  const cli = parseArgv(argv);

  const projectsBaseDir = String(
    cli.get("projects-dir") ?? env.PROJECTS_BASE_DIR ?? "",
  ).trim();
  if (!projectsBaseDir) {
    throw new Error(
      '[xcode-mcp] PROJECTS_BASE_DIR is required. Set it in your MCP client config under mcpServers.<name>.env, e.g. "PROJECTS_BASE_DIR": "/Users/you/Code".',
    );
  }
  if (!isAbsolute(projectsBaseDir)) {
    throw new Error(
      `[xcode-mcp] PROJECTS_BASE_DIR must be an absolute path, got: ${projectsBaseDir}`,
    );
  }

  const allowedPathsRaw =
    typeof cli.get("allowed-paths") === "string"
      ? (cli.get("allowed-paths") as string)
      : env.ALLOWED_PATHS;
  const allowedPaths = parseList(allowedPathsRaw);

  const debug =
    cli.get("debug") === true || cli.get("debug") === "true"
      ? true
      : parseBool(env.DEBUG);

  const logLevelRaw = (
    (cli.get("log-level") as string | undefined) ??
    env.LOG_LEVEL ??
    "info"
  ).toLowerCase();
  const logLevel = (
    ["error", "warn", "info", "debug"].includes(logLevelRaw)
      ? logLevelRaw
      : "info"
  ) as Config["logLevel"];

  const toolsRaw = env.XCODE_MCP_TOOLS?.trim();
  const enabledToolsList = toolsRaw ? parseList(toolsRaw) : null;
  const enabledTools: Config["enabledTools"] =
    enabledToolsList && enabledToolsList.length > 0
      ? (Object.freeze(enabledToolsList) as readonly string[])
      : "all";

  return Object.freeze({
    projectsBaseDir,
    allowedPaths: Object.freeze(allowedPaths) as readonly string[],
    debug,
    logLevel,
    enabledTools,
    version: pkgVersion,
  });
}
