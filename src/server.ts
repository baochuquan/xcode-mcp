import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";
import * as path from "path";
import { runExecFile } from "./utils/execFile.js";

import { ServerConfig, ActiveProject } from "./types/index.js";
import { XcodeServerError } from "./utils/errors.js";
import { findXcodeProjects, findProjectByName } from "./utils/project.js";

import { PathManager } from "./utils/pathManager.js";
import { SafeFileOperations } from "./utils/safeFileOperations.js";
import { ProjectDirectoryState } from "./utils/projectDirectoryState.js";

import type { Config } from "./config.js";

import { registerProjectTools } from "./tools/project/index.js";
import { registerFileTools } from "./tools/file/index.js";
import { registerBuildTools } from "./tools/build/index.js";
import { registerCocoaPodsTools } from "./tools/cocoapods/index.js";
import { registerSPMTools } from "./tools/spm/index.js";
import { registerSimulatorTools } from "./tools/simulator/index.js";
import { registerXcodeTools } from "./tools/xcode/index.js";

/**
 * Stable identifiers for the seven tool groups. Keep this list in sync with
 * the registry table below; both must change together when groups are added,
 * renamed or split.
 */
export const TOOL_GROUP_IDS = [
  "project",
  "file",
  "build",
  "xcode",
  "cocoapods",
  "spm",
  "simulator",
] as const;
export type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];

type Registrar = (server: XcodeServer) => void;

const REGISTRY: Record<ToolGroupId, Registrar> = {
  project: registerProjectTools,
  file: registerFileTools,
  build: registerBuildTools,
  xcode: registerXcodeTools,
  cocoapods: registerCocoaPodsTools,
  spm: registerSPMTools,
  simulator: registerSimulatorTools,
};

/**
 * Decide which tool groups to register based on the XCODE_MCP_TOOLS filter.
 *
 * Returns both the resolved set and any unknown identifiers so the caller
 * can warn (rather than silently ignore typos).
 */
export function resolveEnabledGroups(
  enabled: Config["enabledTools"],
): { groups: ToolGroupId[]; unknown: string[] } {
  if (enabled === "all") {
    return { groups: [...TOOL_GROUP_IDS], unknown: [] };
  }
  const known = new Set<string>(TOOL_GROUP_IDS);
  const groups: ToolGroupId[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of enabled) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (known.has(id)) {
      groups.push(id as ToolGroupId);
    } else {
      unknown.push(id);
    }
  }
  if (groups.length === 0) {
    // All entries unknown — fall back to "all" rather than ship an empty server.
    return { groups: [...TOOL_GROUP_IDS], unknown };
  }
  return { groups, unknown };
}

export class XcodeServer {
  public server: McpServer;
  public config: ServerConfig;
  public activeProject: ActiveProject | null = null;
  public projectFiles: Map<string, string[]> = new Map();

  public pathManager: PathManager;
  public fileOperations: SafeFileOperations;
  public directoryState: ProjectDirectoryState;

  private readonly runtimeConfig: Config;

  constructor(runtimeConfig: Config) {
    this.runtimeConfig = runtimeConfig;
    // Mirror runtime fields onto the legacy ServerConfig shape so the
    // ported tool code (which reads server.config.projectsBaseDir) keeps
    // working unchanged.
    this.config = { projectsBaseDir: runtimeConfig.projectsBaseDir };

    this.pathManager = new PathManager(runtimeConfig);
    this.fileOperations = new SafeFileOperations(this.pathManager);
    this.directoryState = new ProjectDirectoryState(this.pathManager);

    this.server = new McpServer(
      {
        name: "xcode-mcp",
        version: runtimeConfig.version,
        description: "An MCP server for Xcode integration (npx-installable)",
      },
      { capabilities: { tools: {}, resources: {} } },
    );

    const { groups, unknown } = resolveEnabledGroups(runtimeConfig.enabledTools);
    if (unknown.length > 0) {
      console.error(
        `[xcode-mcp] ignoring unknown tool group(s) in XCODE_MCP_TOOLS: ${unknown.join(", ")}`,
      );
    }
    console.error(
      `[xcode-mcp] enabled tool groups: ${groups.join(", ")}`,
    );

    for (const id of groups) {
      REGISTRY[id](this);
    }
    this.registerResources();

    // Best-effort active project detection — do not block startup.
    this.detectActiveProject()
      .then((project) => {
        if (project) {
          console.error(
            `[xcode-mcp] detected active project: ${project.name} (${project.path})`,
          );
        }
      })
      .catch((error) => {
        if (runtimeConfig.debug) {
          console.error(
            "[xcode-mcp] active-project detection failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
  }

  private registerResources() {
    this.server.resource(
      "xcode-projects",
      new ResourceTemplate("xcode://projects", { list: undefined }),
      async () => {
        const projects = await findXcodeProjects(this.config.projectsBaseDir);
        return {
          contents: projects.map((project) => ({
            uri: `xcode://projects/${encodeURIComponent(project.name)}`,
            text: project.name,
            mimeType: "application/x-xcode-project" as const,
          })),
        };
      },
    );

    this.server.resource(
      "xcode-project",
      new ResourceTemplate("xcode://projects/{name}", { list: undefined }),
      async (uri, { name }) => {
        const decodedName = decodeURIComponent(name as string);
        const project = await findProjectByName(
          decodedName,
          this.config.projectsBaseDir,
        );
        if (!project) {
          throw new Error(`Project ${decodedName} not found`);
        }
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(project, null, 2),
              mimeType: "application/json" as const,
            },
          ],
        };
      },
    );
  }

  /**
   * Best-effort active project detection. Tries (in order):
   *   1. The frontmost Xcode document, via AppleScript.
   *   2. The most recently modified .xcodeproj/.xcworkspace under
   *      PROJECTS_BASE_DIR.
   *   3. Xcode's recent-workspace defaults.
   *
   * Failures are logged (in debug mode) and swallowed — none of these are
   * required for the server to function.
   */
  public async detectActiveProject(): Promise<ActiveProject | null> {
    try {
      const { stdout: frontmostProject } = await runExecFile("osascript", [
        "-e",
        'tell application "Xcode"\n  if it is running then\n    set projectFile to path of document 1\n    return POSIX path of projectFile\n  end if\nend tell',
      ]);
      if (frontmostProject && frontmostProject.trim()) {
        const cleaned = this.cleanProjectPath(frontmostProject.trim());
        return this.adoptActiveProject(cleaned);
      }
    } catch (error) {
      if (this.runtimeConfig.debug) {
        console.error(
          "[xcode-mcp] AppleScript detection failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    try {
      const projects = await findXcodeProjects(this.config.projectsBaseDir);
      if (projects.length > 0) {
        const projectStats = await Promise.all(
          projects.map(async (project) => ({
            project,
            stats: await fs.stat(project.path),
          })),
        );
        projectStats.sort(
          (a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime(),
        );
        const cleaned = this.cleanProjectPath(projectStats[0].project.path);
        return this.adoptActiveProject(cleaned);
      }
    } catch (error) {
      if (this.runtimeConfig.debug) {
        console.error(
          "[xcode-mcp] base-dir scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return null;
  }

  private cleanProjectPath(p: string): string {
    return p.endsWith("/project.xcworkspace")
      ? p.replace("/project.xcworkspace", "")
      : p;
  }

  private adoptActiveProject(cleanedPath: string): ActiveProject {
    const isWorkspace = cleanedPath.endsWith(".xcworkspace");
    this.activeProject = {
      path: cleanedPath,
      name: path.basename(cleanedPath, path.extname(cleanedPath)),
      isWorkspace,
    };
    this.pathManager.setActiveProject(cleanedPath);
    this.directoryState.setActiveDirectory(path.dirname(cleanedPath));
    return this.activeProject;
  }

  public setActiveProject(project: ActiveProject): void {
    if (project.path.endsWith("/project.xcworkspace")) {
      const cleanedPath = project.path.replace("/project.xcworkspace", "");
      project.path = cleanedPath;
      project.name = path.basename(cleanedPath, path.extname(cleanedPath));
    }
    this.activeProject = project;
    this.pathManager.setActiveProject(project.path);
    this.directoryState.setActiveDirectory(path.dirname(project.path));
  }

  public async start() {
    try {
      console.error(
        `[xcode-mcp] starting xcode-mcp v${this.runtimeConfig.version} (node ${process.version})`,
      );
      console.error(
        `[xcode-mcp] PROJECTS_BASE_DIR=${this.runtimeConfig.projectsBaseDir}`,
      );
      try {
        await fs.access(this.runtimeConfig.projectsBaseDir);
      } catch (err) {
        console.error(
          "[xcode-mcp] warning: PROJECTS_BASE_DIR is not accessible:",
          err instanceof Error ? err.message : String(err),
        );
      }
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("[xcode-mcp] ready (stdio)");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new XcodeServerError(`Server initialization failed: ${msg}`);
    }
  }
}

/**
 * Factory wrapper. Kept thin so callers (index.ts, tests) only need to
 * supply a frozen Config.
 */
export function createServer(config: Config): XcodeServer {
  return new XcodeServer(config);
}
