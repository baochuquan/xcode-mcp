import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEnabledGroups,
  TOOL_GROUP_IDS,
} from "../dist/server.js";

test("default 'all' enables every group", () => {
  const { groups, unknown } = resolveEnabledGroups("all");
  assert.deepEqual(groups, [...TOOL_GROUP_IDS]);
  assert.deepEqual(unknown, []);
});

test("explicit list keeps only known groups", () => {
  const { groups, unknown } = resolveEnabledGroups([
    "project",
    "file",
    "bogus",
  ]);
  assert.deepEqual(groups, ["project", "file"]);
  assert.deepEqual(unknown, ["bogus"]);
});

test("all-unknown list falls back to all groups", () => {
  const { groups, unknown } = resolveEnabledGroups(["bogus", "fake"]);
  assert.deepEqual(groups, [...TOOL_GROUP_IDS]);
  assert.deepEqual(unknown, ["bogus", "fake"]);
});

test("duplicates are de-duplicated", () => {
  const { groups } = resolveEnabledGroups(["project", "project", "file"]);
  assert.deepEqual(groups, ["project", "file"]);
});

test("seven canonical group ids exist", () => {
  assert.deepEqual([...TOOL_GROUP_IDS].sort(), [
    "build",
    "cocoapods",
    "file",
    "project",
    "simulator",
    "spm",
    "xcode",
  ]);
});
