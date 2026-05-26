import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitAdapter, worktreeIdFromBranch, worktreePathForBranch } from "../src/core/git.js";
import { initCcflowProject, resolveRepository } from "../src/core/repo.js";
import { loadOrInitState, saveState, statePath } from "../src/core/storage.js";

test("repo resolution supports root, nested paths, explicit repo, and managed worktrees", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-repo-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  initCcflowProject({ repoPath: repoRoot, git });

  const nested = path.join(repoRoot, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(real(resolveRepository({ startPath: nested, git }).repoRoot!), real(repoRoot));

  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-elsewhere-"));
  assert.equal(real(resolveRepository({ startPath: elsewhere, repoPath: repoRoot, git }).repoRoot!), real(repoRoot));

  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const branch = "ccflow/feature";
  const worktreePath = worktreePathForBranch(repoRoot, branch);
  git.createWorktree({ repoRoot, path: worktreePath, branch, baseCommit: git.currentCommit(repoRoot)! });
  state.worktrees[worktreeIdFromBranch(branch)] = {
    id: worktreeIdFromBranch(branch),
    path: worktreePath,
    branch,
    currentNodeId: state.currentNodeId,
    status: "other",
  };
  fs.writeFileSync(statePath(repoRoot), `${JSON.stringify(state, null, 2)}\n`);

  const fromWorktree = resolveRepository({ startPath: worktreePath, git });
  assert.equal(real(fromWorktree.repoRoot!), real(repoRoot));
  assert.equal(fromWorktree.fromManagedWorktree, true);
});

test("init is idempotent and preserves existing state", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-init-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const first = initCcflowProject({ repoPath: repoRoot, git });
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  state.nodes[state.currentNodeId]!.title = "Preserved";
  saveState(state);

  const second = initCcflowProject({ repoPath: repoRoot, git });
  const loaded = JSON.parse(fs.readFileSync(first.stateFile, "utf8"));
  assert.equal(second.alreadyInitialized, true);
  assert.equal(loaded.nodes[loaded.currentNodeId].title, "Preserved");
  assert.equal(fs.existsSync(path.join(repoRoot, ".ccflow", "jobs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, ".ccflow", "sessions")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, ".ccflow", "logs")), true);
  assert.match(fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"), /\.ccflow\//);
});

function real(value: string): string {
  return fs.realpathSync.native(value);
}
