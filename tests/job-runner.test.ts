import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../src/core/claude.js";
import { GitAdapter, branchNameForNode, worktreeIdFromBranch, worktreePathForBranch } from "../src/core/git.js";
import { branchFromNode, assertGraphInvariants } from "../src/core/graph.js";
import { JobRunner } from "../src/core/jobs.js";
import { loadOrInitState, saveState } from "../src/core/storage.js";
import type { CcflowState } from "../src/core/types.js";
import { claudeCliConfig, withClaudeCliEnv } from "./helpers/claude-cli.js";

test("creating the next leaf delegates the dirty-worktree commit to Claude Code", async () => {
  const claude = claudeCliConfig();
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const readme = path.join(repoRoot, "README.md");
  const beforeCommit = git.currentCommit(repoRoot);
  fs.appendFileSync(readme, "updated by test before Claude commit\n");

  const runner = new JobRunner(git, new ClaudeAdapter());
  const child = await withClaudeCliEnv(claude, () => runner.createNextNode(state, state.currentNodeId));

  assert.equal(state.worktrees[state.currentWorktreeId]?.status, "current");
  assert.equal(state.worktrees[state.currentWorktreeId]?.locked, false);
  assert.equal(state.nodes[child.id]?.type, "leaf");
  assert.match(fs.readFileSync(readme, "utf8"), /updated by test before Claude commit/);
  assert.equal(git.hasDirtyChanges(repoRoot), false);
  assert.notEqual(git.currentCommit(repoRoot), beforeCommit);
  assert.ok(git.lastCommitMessage(repoRoot).length > 0);
  assertGraphInvariants(state);
});

test("git dirty checks ignore ccflow metadata and worktree containers", () => {
  const { repoRoot } = createRepoState();
  fs.mkdirSync(path.join(repoRoot, ".ccflow", "logs"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".ccflow", "logs", "ccflow.log"), "internal log\n");
  fs.mkdirSync(path.join(repoRoot, ".worktrees", "placeholder"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".worktrees", "placeholder", "README.md"), "internal worktree\n");

  const git = new GitAdapter();

  assert.equal(git.hasDirtyChanges(repoRoot), false);
  assert.equal(git.statusShort(repoRoot), "");
});


test("deleting latest leaf in current branch worktree resets files and keeps one current worktree", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const root = state.nodes[state.currentNodeId]!;
  const branchName = branchNameForNode("integration-delete");
  const worktreePath = worktreePathForBranch(repoRoot, branchName);
  git.createWorktree({
    repoRoot,
    path: worktreePath,
    branch: branchName,
    baseCommit: root.git.commitHash!,
  });
  const branchLeaf = branchFromNode(state, {
    nodeId: root.id,
    worktreeId: worktreeIdFromBranch(branchName),
    worktreePath,
    branchName,
  });
  state.currentNodeId = branchLeaf.id;
  state.currentWorktreeId = branchLeaf.git.worktreeId;
  state.worktrees.wt_main!.status = "other";
  state.worktrees[branchLeaf.git.worktreeId]!.status = "current";
  saveState(state);

  const runner = new JobRunner(git);
  const latest = await runner.createNextNode(state, branchLeaf.id);
  const branchReadme = path.join(worktreePath, "README.md");
  fs.writeFileSync(branchReadme, "temporary uncommitted leaf edit\n");

  const focus = await runner.deleteLeaf(state, latest.id);

  assert.equal(focus.id, branchLeaf.id);
  assert.equal(state.nodes[latest.id], undefined);
  assert.equal(state.nodes[branchLeaf.id]?.type, "leaf");
  assert.equal(state.currentWorktreeId, branchLeaf.git.worktreeId);
  assert.equal(state.worktrees[branchLeaf.git.worktreeId]?.status, "current");
  assert.equal(state.worktrees[branchLeaf.git.worktreeId]?.locked, false);
  assert.equal(fs.readFileSync(branchReadme, "utf8"), "initial\n");
  assertGraphInvariants(state);
});

test("deleting through a commitless parent resets to the nearest committed ancestor", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const root = state.nodes[state.currentNodeId]!;
  const branchName = branchNameForNode("empty-parent-delete");
  const worktreePath = worktreePathForBranch(repoRoot, branchName);
  git.createWorktree({
    repoRoot,
    path: worktreePath,
    branch: branchName,
    baseCommit: root.git.commitHash!,
  });
  const emptyParent = branchFromNode(state, {
    nodeId: root.id,
    worktreeId: worktreeIdFromBranch(branchName),
    worktreePath,
    branchName,
  });
  state.currentNodeId = emptyParent.id;
  state.currentWorktreeId = emptyParent.git.worktreeId;
  state.worktrees.wt_main!.status = "other";
  state.worktrees[emptyParent.git.worktreeId]!.status = "current";
  saveState(state);

  const runner = new JobRunner(git);
  const latest = await runner.createNextNode(state, emptyParent.id);
  emptyParent.git.commitHash = null;
  fs.writeFileSync(path.join(worktreePath, "README.md"), "temporary edit under empty parent\n");

  const focus = await runner.deleteLeaf(state, latest.id);

  assert.equal(focus.id, emptyParent.id);
  assert.equal(state.nodes[emptyParent.id]?.type, "leaf");
  assert.equal(state.nodes[emptyParent.id]?.git.commitHash, null);
  assert.equal(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8"), "initial\n");
  assertGraphInvariants(state);
});

function createRepoState(): { state: CcflowState; repoRoot: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-runner-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  return { state, repoRoot };
}
