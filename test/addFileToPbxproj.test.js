import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { addFileToPbxproj } from "../dist/utils/pbxprojEditor.js";
import xcode from "xcode";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "MiniApp");

/**
 * Each test gets a fresh copy of the fixture in a tmp dir, so changes from one
 * test never leak into another. We do this synchronously in `before` so we
 * have a deterministic baseline path to log for every assertion.
 */
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "xcode-mcp-pbxproj-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return {
    rootDir: dir,
    xcodeprojPath: join(dir, "MiniApp.xcodeproj"),
    pbxprojPath: join(dir, "MiniApp.xcodeproj", "project.pbxproj"),
    appDir: join(dir, "MiniApp"),
  };
}

/** Returns the parsed pbxproj as the `xcode` package sees it. */
function parsePbxproj(pbxprojPath) {
  const proj = xcode.project(pbxprojPath);
  proj.parseSync();
  return proj;
}

/** Returns true if a PBXFileReference whose path matches `relPath` exists. */
function hasFileRef(proj, relPath) {
  const refs = proj.pbxFileReferenceSection();
  for (const k of Object.keys(refs)) {
    if (k.endsWith("_comment")) continue;
    const r = refs[k];
    if (r && typeof r === "object") {
      const p = r.path;
      if (p === relPath || p === `"${relPath}"`) return true;
    }
  }
  return false;
}

/** Returns true if a build phase comment matches `expectedSuffix`. */
function buildPhaseHasFile(proj, phaseObj, expectedSuffix) {
  if (!phaseObj || !Array.isArray(phaseObj.files)) return false;
  return phaseObj.files.some((f) => f.comment && f.comment.endsWith(expectedSuffix));
}

test("adds a Swift source file to the first target's Sources build phase", async () => {
  const env = freshProject();
  writeFileSync(join(env.appDir, "Foo.swift"), "// foo\n", "utf-8");

  const result = await addFileToPbxproj({
    projectPath: env.xcodeprojPath,
    filePath: join(env.appDir, "Foo.swift"),
  });

  assert.equal(result.alreadyExists, false);
  assert.equal(result.fileKind, "source");
  assert.equal(result.targetName, "MiniApp");
  assert.equal(result.buildPhase, "PBXSourcesBuildPhase");
  assert.equal(result.pbxprojRelativePath, "MiniApp/Foo.swift");

  const proj = parsePbxproj(env.pbxprojPath);
  assert.ok(hasFileRef(proj, "MiniApp/Foo.swift"), "PBXFileReference missing");
  assert.ok(
    buildPhaseHasFile(proj, proj.pbxSourcesBuildPhaseObj(), "Foo.swift in Sources"),
    "Sources build phase doesn't include Foo.swift",
  );
});

test("adds a JSON resource to the Resources build phase", async () => {
  const env = freshProject();
  writeFileSync(join(env.appDir, "config.json"), "{}\n", "utf-8");

  const result = await addFileToPbxproj({
    projectPath: env.xcodeprojPath,
    filePath: join(env.appDir, "config.json"),
  });

  assert.equal(result.fileKind, "resource");
  assert.equal(result.buildPhase, "PBXResourcesBuildPhase");

  const proj = parsePbxproj(env.pbxprojPath);
  assert.ok(hasFileRef(proj, "MiniApp/config.json"));
  assert.ok(
    buildPhaseHasFile(proj, proj.pbxResourcesBuildPhaseObj(), "config.json in Resources"),
  );
});

test("creates intermediate groups when createGroups is true (default)", async () => {
  const env = freshProject();
  const sub = join(env.appDir, "Models");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "User.swift"), "// user\n", "utf-8");

  const result = await addFileToPbxproj({
    projectPath: env.xcodeprojPath,
    filePath: join(sub, "User.swift"),
    groupPath: "MiniApp/Models",
  });

  assert.equal(result.groupPath, "MiniApp/Models");
  assert.equal(result.fileKind, "source");

  const proj = parsePbxproj(env.pbxprojPath);
  // The Models group should exist now under MiniApp.
  const modelsKey = proj.findPBXGroupKey({ name: "Models" });
  assert.ok(modelsKey, "Models group should have been created");
  const models = proj.getPBXGroupByKey(modelsKey);
  assert.ok(
    models.children.some((c) => c.comment === "User.swift"),
    "User.swift should be a child of Models group",
  );
});

test("refuses to create groups when createGroups=false and the group is missing", async () => {
  const env = freshProject();
  writeFileSync(join(env.appDir, "Bar.swift"), "// bar\n", "utf-8");

  await assert.rejects(
    addFileToPbxproj({
      projectPath: env.xcodeprojPath,
      filePath: join(env.appDir, "Bar.swift"),
      groupPath: "MiniApp/DoesNotExist",
      createGroups: false,
    }),
    /not found/,
  );
});

test("rejects unknown target names with a helpful error listing available targets", async () => {
  const env = freshProject();
  writeFileSync(join(env.appDir, "Baz.swift"), "// baz\n", "utf-8");

  await assert.rejects(
    addFileToPbxproj({
      projectPath: env.xcodeprojPath,
      filePath: join(env.appDir, "Baz.swift"),
      targetName: "TotallyMadeUp",
    }),
    /target "TotallyMadeUp" not found.*MiniApp/,
  );
});

test("is idempotent on repeat calls — second call reports alreadyExists and writes nothing", async () => {
  const env = freshProject();
  writeFileSync(join(env.appDir, "Twice.swift"), "// twice\n", "utf-8");

  const first = await addFileToPbxproj({
    projectPath: env.xcodeprojPath,
    filePath: join(env.appDir, "Twice.swift"),
  });
  assert.equal(first.alreadyExists, false);

  const beforeBytes = readFileSync(env.pbxprojPath, "utf-8");

  const second = await addFileToPbxproj({
    projectPath: env.xcodeprojPath,
    filePath: join(env.appDir, "Twice.swift"),
  });
  assert.equal(second.alreadyExists, true);

  const afterBytes = readFileSync(env.pbxprojPath, "utf-8");
  assert.equal(beforeBytes, afterBytes, "pbxproj should not be rewritten on duplicate add");
});

test("xcodebuild -list still parses the project after edits", async () => {
  const env = freshProject();
  writeFileSync(join(env.appDir, "Survived.swift"), "// survived\n", "utf-8");
  await addFileToPbxproj({
    projectPath: env.xcodeprojPath,
    filePath: join(env.appDir, "Survived.swift"),
  });

  // If pbxproj is broken, xcodebuild exits non-zero. We don't need to validate
  // the output content — exit code 0 + non-empty stdout is enough proof.
  const stdout = execFileSync("xcodebuild", ["-list", "-project", env.xcodeprojPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.match(stdout, /Targets:[\s\S]*MiniApp/, "xcodebuild -list output should still mention MiniApp");
});
