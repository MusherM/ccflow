import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitAdapter } from "../src/core/git.js";
import { loadOrInitState, promptsPath, statePath } from "../src/core/storage.js";

test("loadOrInitState creates repo-local ccflow files and reloads the same graph", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-"));
  const git = new GitAdapter();
  const repoRoot = git.ensureRepo(temp);

  const first = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const second = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });

  assert.equal(fs.existsSync(statePath(repoRoot)), true);
  assert.equal(fs.existsSync(promptsPath(repoRoot)), false);
  assert.equal(second.currentNodeId, first.currentNodeId);
  assert.equal(Object.keys(second.nodes).length, 1);
  assert.equal(second.nodes[second.currentNodeId]?.type, "leaf");
});
