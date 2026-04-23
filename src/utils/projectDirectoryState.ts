import * as path from 'path';
import { PathManager } from './pathManager.js';
import { PathAccessError } from './errors.js';

/**
 * ProjectDirectoryState manages the active directory state
 */
export class ProjectDirectoryState {
  private activeDirectory: string | null = null;
  private directoryStack: string[] = [];
  
  constructor(private pathManager: PathManager) {}
  
  /**
   * Set the active directory with validation
   */
  setActiveDirectory(dirPath: string): void {
    const normalizedPath = this.pathManager.normalizePath(dirPath);
    
    // Validate the path is within allowed boundaries
    if (!this.pathManager.isPathAllowed(normalizedPath)) {
      throw new PathAccessError(
        normalizedPath, 
        "Cannot set active directory outside of permitted boundaries"
      );
    }
    
    // Record the directory change
    if (this.activeDirectory) {
      this.pathManager.recordDirectoryChange(this.activeDirectory, normalizedPath);
    }
    
    this.activeDirectory = normalizedPath;
  }
  
  /**
   * Get the current active directory
   *
   * Resolution order:
   *   1. explicit activeDirectory if set
   *   2. active project root (if a project has been set)
   *   3. PROJECTS_BASE_DIR from PathManager (configured at startup)
   *
   * Never falls back to process.cwd() — under npx, cwd is the user's
   * arbitrary shell directory and would create a confusing security
   * boundary.
   */
  getActiveDirectory(): string {
    if (this.activeDirectory) {
      return this.activeDirectory;
    }

    const projectRoot = this.pathManager.getActiveProjectRoot();
    if (projectRoot) {
      return projectRoot;
    }

    const baseDir = this.pathManager.getProjectsBaseDir();
    if (baseDir) {
      return baseDir;
    }

    throw new Error(
      "[xcode-mcp] no active directory available. Set PROJECTS_BASE_DIR or call set_projects_base_dir first.",
    );
  }
  
  /**
   * Push a directory onto the stack and make it active
   */
  pushDirectory(dirPath: string): void {
    // Save current active directory to stack
    if (this.activeDirectory) {
      this.directoryStack.push(this.activeDirectory);
    }
    
    // Set the new active directory
    this.setActiveDirectory(dirPath);
  }
  
  /**
   * Pop a directory from the stack and make it active
   */
  popDirectory(): string | null {
    if (this.directoryStack.length === 0) {
      return null; // Nothing to pop
    }
    
    // Get the previous directory
    const previousDir = this.directoryStack.pop() || null;
    
    // Set it as active
    if (previousDir) {
      // Don't use setActiveDirectory to avoid validation again
      // We assume directories on the stack were already validated
      const oldDir = this.activeDirectory;
      this.activeDirectory = previousDir;
      
      // Record the change
      if (oldDir) {
        this.pathManager.recordDirectoryChange(oldDir, previousDir);
      }
    }
    
    return previousDir;
  }
  
  /**
   * Resolve a relative path against the active directory
   */
  resolvePath(relativePath: string): string {
    // First, always expand tildes and environment variables
    const expandedPath = this.pathManager.expandPath(relativePath);
    
    // If the path is already absolute, return it normalized
    if (path.isAbsolute(expandedPath)) {
      return this.pathManager.normalizePath(expandedPath);
    }
    
    // Get the active directory
    const activeDir = this.getActiveDirectory();
    
    // Resolve against active directory
    return this.pathManager.joinPaths(activeDir, expandedPath);
  }
  
  /**
   * Get the current directory stack
   */
  getDirectoryStack(): string[] {
    return [...this.directoryStack];
  }
  
  /**
   * Clear the directory stack
   */
  clearDirectoryStack(): void {
    this.directoryStack = [];
  }
} 