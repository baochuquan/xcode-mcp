/**
 * pbxproj editor backed by the `xcode` npm package.
 *
 * Replaces the previous AppleScript-based implementation of `add_file_to_project`
 * which broke on Xcode 14+ (the `add` verb was removed from Xcode's AppleScript
 * dictionary, so any script using `add file …` / `add files …` raised a -2741
 * "expected end of line, but found class name" syntax error).
 *
 * This module operates on `project.pbxproj` directly, so it works regardless of
 * whether Xcode is running and across all Xcode versions that still produce
 * objectVersion >= 46 pbxproj files.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const require = createRequire(import.meta.url);
// `xcode` is CommonJS-only; use createRequire to bring it into ESM cleanly.
const xcode = require("xcode") as typeof import("xcode");

export type FileKind = "source" | "header" | "resource" | "framework" | "other";

export interface AddFileOptions {
  /** Path to the .xcodeproj directory or directly to the project.pbxproj inside it. */
  projectPath: string;
  /** Absolute path of the file to add. Must already exist on disk. */
  filePath: string;
  /** Optional target name to attach the file to. Defaults to the project's first target. */
  targetName?: string;
  /** Optional Xcode group path like "MyApp/Models". Slash-separated. */
  groupPath?: string;
  /** When traversing groupPath, create missing groups instead of failing. Defaults to true. */
  createGroups?: boolean;
}

export interface AddFileResult {
  alreadyExists: boolean;
  fileKind: FileKind;
  /** Path written into the pbxproj (relative to the project's source root). */
  pbxprojRelativePath: string;
  /** Resolved Xcode group hierarchy the file ended up in (slash-separated). */
  groupPath: string;
  /** Resolved target name. */
  targetName: string;
  /** Absolute path of the project.pbxproj file we wrote. */
  pbxprojPath: string;
  /** Build phase the file was added to, if any. */
  buildPhase?: "PBXSourcesBuildPhase" | "PBXResourcesBuildPhase" | "PBXHeadersBuildPhase" | "PBXFrameworksBuildPhase";
}

const SOURCE_EXTENSIONS = new Set([
  ".swift",
  ".m",
  ".mm",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".s",
  ".metal",
]);

const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx"]);

const FRAMEWORK_EXTENSIONS = new Set([".framework", ".a", ".dylib", ".tbd", ".xcframework"]);

const RESOURCE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".pdf",
  ".svg",
  ".heic",
  ".webp",
  ".json",
  ".plist",
  ".xib",
  ".storyboard",
  ".xcassets",
  ".strings",
  ".stringsdict",
  ".ttf",
  ".otf",
  ".ttc",
  ".mp3",
  ".m4a",
  ".wav",
  ".aiff",
  ".caf",
  ".mp4",
  ".m4v",
  ".mov",
  ".html",
  ".css",
  ".js",
  ".rtf",
  ".md",
  ".txt",
  ".xcdatamodeld",
  ".xcdatamodel",
]);

function classifyByExtension(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  if (HEADER_EXTENSIONS.has(ext)) return "header";
  if (FRAMEWORK_EXTENSIONS.has(ext)) return "framework";
  if (RESOURCE_EXTENSIONS.has(ext)) return "resource";
  return "other";
}

function resolvePbxprojPath(projectPath: string): string {
  if (projectPath.endsWith(".pbxproj")) return projectPath;
  if (projectPath.endsWith(".xcodeproj")) {
    return path.join(projectPath, "project.pbxproj");
  }
  return path.join(projectPath, "project.pbxproj");
}

/**
 * Walks (and optionally creates) the group hierarchy under the project's main
 * group. Returns the UUID of the leaf group.
 *
 * Group matching prefers `name`, then falls back to `path` — Xcode allows
 * either, so a group whose folder on disk is "Models" but has no explicit name
 * is matched by the user-supplied "Models" segment.
 */
function resolveGroupKey(
  proj: import("xcode").XcodeProject,
  groupPath: string | undefined,
  createGroups: boolean,
): { groupKey: string; resolvedPath: string } {
  const project = proj.getFirstProject();
  const rootGroupKey = project.firstProject.mainGroup;
  if (!groupPath || !groupPath.trim()) {
    return { groupKey: rootGroupKey, resolvedPath: "" };
  }

  const segments = groupPath
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let currentKey = rootGroupKey;
  const visited: string[] = [];

  for (const segment of segments) {
    const currentGroup = proj.getPBXGroupByKey(currentKey);
    if (!currentGroup) {
      throw new Error(
        `[pbxproj] internal: group ${currentKey} not found while walking "${groupPath}"`,
      );
    }

    let nextKey: string | undefined;
    for (const child of currentGroup.children ?? []) {
      const childGroup = proj.getPBXGroupByKey(child.value);
      if (!childGroup) continue;
      const childName = stripQuotes(childGroup.name) ?? stripQuotes(childGroup.path);
      if (childName === segment) {
        nextKey = child.value;
        break;
      }
    }

    if (!nextKey) {
      if (!createGroups) {
        const so_far = visited.length === 0 ? "<root>" : visited.join("/");
        throw new Error(
          `[pbxproj] group "${segment}" not found under "${so_far}"; pass createGroups=true to create it`,
        );
      }
      nextKey = proj.pbxCreateGroup(segment, segment);
      proj.addToPbxGroup(nextKey, currentKey);
    }

    currentKey = nextKey;
    visited.push(segment);
  }

  return { groupKey: currentKey, resolvedPath: visited.join("/") };
}

function stripQuotes(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function resolveTarget(
  proj: import("xcode").XcodeProject,
  targetName: string | undefined,
): { targetUuid: string; targetName: string } {
  if (targetName) {
    const key = proj.findTargetKey(targetName);
    if (!key) {
      const allNames: string[] = [];
      const targets = proj.pbxNativeTargetSection();
      for (const k of Object.keys(targets)) {
        if (k.endsWith("_comment")) continue;
        const t = targets[k];
        if (t && typeof t === "object" && "name" in t) {
          const n = stripQuotes((t as { name: unknown }).name);
          if (n) allNames.push(n);
        }
      }
      throw new Error(
        `[pbxproj] target "${targetName}" not found. Available targets: ${allNames.join(", ") || "(none)"}`,
      );
    }
    return { targetUuid: key, targetName };
  }

  const first = proj.getFirstTarget();
  if (!first || !first.uuid) {
    throw new Error("[pbxproj] project has no targets; cannot pick a default target");
  }
  return { targetUuid: first.uuid, targetName: stripQuotes(first.firstTarget.name) ?? "(unknown)" };
}

export async function addFileToPbxproj(opts: AddFileOptions): Promise<AddFileResult> {
  const pbxprojPath = resolvePbxprojPath(opts.projectPath);

  try {
    await fs.access(pbxprojPath);
  } catch {
    throw new Error(`[pbxproj] project file not found: ${pbxprojPath}`);
  }

  // The "project source root" is the directory that contains the .xcodeproj
  // bundle. pbxproj paths are typically stored relative to this root.
  const xcodeprojDir =
    pbxprojPath.endsWith("/project.pbxproj")
      ? path.dirname(pbxprojPath)
      : pbxprojPath;
  const sourceRoot = path.dirname(xcodeprojDir);

  const proj = xcode.project(pbxprojPath);
  proj.parseSync();

  const fileKind = classifyByExtension(opts.filePath);

  const absoluteFilePath = path.resolve(opts.filePath);
  const relativeFilePath = path.relative(sourceRoot, absoluteFilePath);
  // pbxproj uses forward slashes regardless of OS; normalize defensively.
  const pbxprojRelativePath = relativeFilePath.split(path.sep).join("/");

  // Idempotency: if the file is already referenced anywhere in the project
  // (under the same path) we skip and return success-but-already-exists. This
  // intentionally does not check whether the file is *also* in the chosen
  // target's build phase — supporting "add same file to multiple targets" is
  // out of scope for this tool.
  if (proj.hasFile(pbxprojRelativePath)) {
    const { targetName } = resolveTarget(proj, opts.targetName);
    return {
      alreadyExists: true,
      fileKind,
      pbxprojRelativePath,
      groupPath: opts.groupPath ?? "",
      targetName,
      pbxprojPath,
    };
  }

  const { groupKey, resolvedPath } = resolveGroupKey(
    proj,
    opts.groupPath,
    opts.createGroups ?? true,
  );

  const { targetUuid, targetName } = resolveTarget(proj, opts.targetName);

  // We bypass the high-level helpers (addSourceFile / addResourceFile /
  // addFramework) because addResourceFile in particular calls
  // correctForResourcesPath() which crashes with "Cannot read properties of
  // null (reading 'path')" if the project doesn't already have a
  // top-level group named "Resources" (a Cordova-style assumption baked in
  // for over a decade — see the `xcode` package source). Going one level
  // lower with addFile + manual build-phase wiring works on every project
  // shape.
  const buildPhaseByKind: Record<FileKind, AddFileResult["buildPhase"]> = {
    source: "PBXSourcesBuildPhase",
    resource: "PBXResourcesBuildPhase",
    header: "PBXHeadersBuildPhase",
    framework: "PBXFrameworksBuildPhase",
    other: undefined,
  };
  const buildPhase = buildPhaseByKind[fileKind];

  const file = proj.addFile(pbxprojRelativePath, groupKey, { target: targetUuid });
  if (file === null) {
    // hasFile already returned false above, so this should not happen — but
    // keep the guard so a future regression in the xcode package is loud.
    throw new Error(
      `[pbxproj] xcode.addFile returned null for path=${pbxprojRelativePath} (likely a stale duplicate)`,
    );
  }

  // Headers don't get auto-attached to a build phase: Xcode's default is
  // "Project" visibility, which corresponds to "no PBXBuildFile entry". The
  // user can promote to Public/Private via Xcode UI later.
  if (fileKind !== "header" && buildPhase) {
    file.target = targetUuid;
    file.uuid = proj.generateUuid();
    proj.addToPbxBuildFileSection(file);

    switch (buildPhase) {
      case "PBXSourcesBuildPhase":
        proj.addToPbxSourcesBuildPhase(file);
        break;
      case "PBXResourcesBuildPhase":
        proj.addToPbxResourcesBuildPhase(file);
        break;
      case "PBXFrameworksBuildPhase":
        proj.addToPbxFrameworksBuildPhase(file);
        break;
    }
  }

  await fs.writeFile(pbxprojPath, proj.writeSync(), "utf-8");

  return {
    alreadyExists: false,
    fileKind,
    pbxprojRelativePath,
    groupPath: resolvedPath,
    targetName,
    pbxprojPath,
    buildPhase,
  };
}
