import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/**
 * Hint shown to users for each known optional dependency.
 *
 * Keep entries minimal — they're rendered in MCP tool error responses and
 * the LLM has to relay them to the user.
 */
const HINTS: Record<string, string> = {
  pod: 'CocoaPods is required for this tool. Install it via:\n  $ sudo gem install cocoapods\nor\n  $ brew install cocoapods\nThen restart the MCP server.',
  swift: 'The Swift toolchain is required. Install Xcode from the App Store or run:\n  $ xcode-select --install',
  xcodebuild: 'xcodebuild is required. Install Xcode and run:\n  $ sudo xcode-select -s /Applications/Xcode.app',
  xcrun: 'xcrun is required. Install Xcode and run:\n  $ sudo xcode-select -s /Applications/Xcode.app',
  simctl: 'xcrun simctl is required. Install Xcode and accept the license:\n  $ sudo xcodebuild -license accept',
};

const cache = new Map<string, boolean>();

/**
 * Lazily check whether an external CLI is on PATH.
 *
 * Result is cached for the lifetime of the process so repeated tool calls
 * stay cheap. We use `command -v` (POSIX) under /bin/sh because `which` may
 * be absent on minimal systems.
 */
export async function isExternalAvailable(cmd: string): Promise<boolean> {
  const cached = cache.get(cmd);
  if (cached !== undefined) return cached;

  try {
    await pExecFile('/bin/sh', ['-c', `command -v "${cmd}"`]);
    cache.set(cmd, true);
    return true;
  } catch {
    cache.set(cmd, false);
    return false;
  }
}

export class ExternalDependencyError extends Error {
  readonly code = 'E_EXTERNAL_DEP_MISSING';

  constructor(
    public readonly command: string,
    public readonly hint: string,
  ) {
    super(`[xcode-mcp] missing external dependency: ${command}\n${hint}`);
    this.name = 'ExternalDependencyError';
  }
}

/**
 * Throw if the given external CLI is unavailable.
 *
 * Tools wrap their entrypoints with this so the server itself never
 * fails to start when an optional dep (e.g. CocoaPods) is absent — only
 * the specific tool that needs it returns a structured error.
 */
export async function assertExternalAvailable(cmd: string): Promise<void> {
  if (await isExternalAvailable(cmd)) return;
  throw new ExternalDependencyError(
    cmd,
    HINTS[cmd] ?? `Install "${cmd}" and ensure it's on PATH, then restart the MCP server.`,
  );
}

export function clearExternalCheckCache(): void {
  cache.clear();
}

/**
 * Build an env object suitable for passing to child_process.{spawn,execFile}.
 *
 * Tools must NOT read process.env directly (per the runtime-config spec);
 * call this helper instead so any merging happens in one place.
 */
export function subprocessEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}
