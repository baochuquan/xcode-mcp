import * as path from 'path';
import * as os from 'os';
import { PathAccessError } from './errors.js';
import type { Config } from '../config.js';

/**
 * PathManager centralizes all path-related operations for consistent and secure path handling.
 *
 * Differences from the upstream xcode-mcp-server implementation:
 *   - Constructed from a frozen Config (no longer reads process.cwd() / .env directly).
 *   - PROJECTS_BASE_DIR is the only "always-allowed" boundary by default.
 *   - Additional roots can be supplied via Config.allowedPaths.
 *   - The notion of a "server root" (process.cwd()) is removed because under
 *     npx the cwd is the user's arbitrary shell directory.
 */
export class PathManager {
  private projectsBaseDir: string;
  private allowedPaths: string[];
  private activeProjectPath: string | undefined;
  private activeProjectRoot: string | undefined;
  private directoryHistory: string[] = [];

  constructor(config: Config) {
    this.projectsBaseDir = this.expandPath(config.projectsBaseDir);
    this.allowedPaths = (config.allowedPaths ?? []).map((p) => this.expandPath(p));
  }

  setActiveProject(projectPath: string): void {
    const expandedPath = this.expandPath(projectPath);
    this.activeProjectPath = expandedPath;
    this.activeProjectRoot = path.dirname(expandedPath);
  }

  setProjectsBaseDir(dirPath: string): void {
    this.projectsBaseDir = this.expandPath(dirPath);
  }

  getActiveProjectPath(): string | undefined {
    return this.activeProjectPath;
  }

  getActiveProjectRoot(): string | undefined {
    return this.activeProjectRoot;
  }

  getProjectsBaseDir(): string {
    return this.projectsBaseDir;
  }

  getAllowedPaths(): readonly string[] {
    return this.allowedPaths;
  }

  /**
   * Expands a path, resolving environment variables and tilde.
   *
   * Note: this is intentionally one of the few places that read process.env.
   * It's a feature for user-supplied path strings (so callers can pass
   * "~/Code" or "$HOME/Projects"), not a way to load server configuration.
   */
  expandPath(inputPath: string): string {
    if (!inputPath) return inputPath;

    if (inputPath.startsWith('~')) {
      inputPath = path.join(os.homedir(), inputPath.slice(1));
    }

    inputPath = inputPath.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      return process.env[name] ?? '';
    });

    inputPath = inputPath.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      return process.env[name] ?? '';
    });

    return path.resolve(inputPath);
  }

  normalizePath(inputPath: string): string {
    if (!inputPath) return inputPath;
    return path.normalize(this.expandPath(inputPath));
  }

  resolveProjectPath(relativePath: string): string {
    const normalizedPath = this.normalizePath(relativePath);
    if (path.isAbsolute(normalizedPath)) {
      return normalizedPath;
    }
    if (this.activeProjectRoot) {
      return path.join(this.activeProjectRoot, normalizedPath);
    }
    return path.join(this.projectsBaseDir, normalizedPath);
  }

  /**
   * Check if a path is allowed based on configured boundaries.
   *
   * A path is allowed iff it is the active project root, the projects base
   * dir, or one of the explicitly allowed paths (or a descendant of any of
   * those).
   */
  isPathAllowed(targetPath: string, _allowWrite = false): boolean {
    const normalizedPath = this.normalizePath(targetPath);

    const candidates: (string | undefined)[] = [
      this.activeProjectRoot,
      this.projectsBaseDir,
      ...this.allowedPaths,
    ];

    for (const root of candidates) {
      if (!root) continue;
      if (
        normalizedPath === root ||
        normalizedPath.startsWith(root + path.sep)
      ) {
        return true;
      }
    }

    return false;
  }

  recordDirectoryChange(from: string, to: string): void {
    this.directoryHistory.push(`${from} → ${to}`);
    if (this.directoryHistory.length > 100) {
      this.directoryHistory.shift();
    }
  }

  getDirectoryHistory(): string[] {
    return [...this.directoryHistory];
  }

  clearDirectoryHistory(): void {
    this.directoryHistory = [];
  }

  getRelativePath(from: string, to: string): string {
    return path.relative(this.normalizePath(from), this.normalizePath(to));
  }

  joinPaths(...paths: string[]): string {
    return this.normalizePath(path.join(...paths));
  }

  isPathWithin(parentPath: string, childPath: string): boolean {
    const normalizedParent = this.normalizePath(parentPath);
    const normalizedChild = this.normalizePath(childPath);
    return (
      normalizedChild === normalizedParent ||
      normalizedChild.startsWith(normalizedParent + path.sep)
    );
  }

  validatePathForReading(targetPath: string): string {
    const normalizedPath = this.normalizePath(targetPath);
    if (!this.isPathAllowed(normalizedPath)) {
      throw new PathAccessError(
        normalizedPath,
        'Path is outside of permitted boundaries for reading',
      );
    }
    return normalizedPath;
  }

  validatePathForWriting(targetPath: string): string {
    const normalizedPath = this.normalizePath(targetPath);
    if (!this.isPathAllowed(normalizedPath, true)) {
      throw new PathAccessError(
        normalizedPath,
        'Path is outside of permitted boundaries for writing',
      );
    }
    return normalizedPath;
  }
}
