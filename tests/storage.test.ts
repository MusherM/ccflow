import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitAdapter } from "../src/core/git.js";
import {
  ensurePrompts,
  jobsDir,
  loadOrInitState,
  loadPrompts,
  promptsPath,
  saveJob,
  statePath,
  writeJsonAtomic,
} from "../src/core/storage.js";
import type { JobRecord } from "../src/core/types.js";

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

test("prompt, job, and atomic JSON storage helpers write reusable artifacts", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-storage-"));

  assert.equal(fs.existsSync(promptsPath(repoRoot)), false);
  assert.equal(loadPrompts(repoRoot).commit.commands.commit, "git commit");
  ensurePrompts(repoRoot);
  assert.equal(fs.existsSync(promptsPath(repoRoot)), true);
  assert.equal(loadPrompts(repoRoot).merge.strategy, "claude-assisted");

  const job: JobRecord = {
    jobId: "job_commit_test",
    type: "commit",
    status: "pending",
    nodeId: "node_test",
    promptKey: "commit",
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
  };
  saveJob(repoRoot, job);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(jobsDir(repoRoot), `${job.jobId}.json`), "utf8")).nodeId,
    "node_test",
  );

  const custom = path.join(repoRoot, "nested", "value.json");
  writeJsonAtomic(custom, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(custom, "utf8")), { ok: true });
});
