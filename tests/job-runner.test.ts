import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../src/core/claude.js";
import { GitAdapter, branchNameForNode, worktreeIdFromBranch, worktreePathForBranch } from "../src/core/git.js";
import {
  assertGraphInvariants,
  branchFromNode,
  createInitialState,
  getNode,
  normalizeAfterBoot,
} from "../src/core/graph.js";
import { JobRunner } from "../src/core/jobs.js";
import { loadOrInitState, saveState } from "../src/core/storage.js";
import { resetTerminalForChildProcess } from "../src/core/terminal.js";
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

  assert.equal(child.status, "AwaitingParentCommit");
  await waitFor(() => getNode(state, child.parents[0]!).status === "sealed");

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

test("git dirty checks ignore system files like .DS_Store and .claude", () => {
  const { repoRoot } = createRepoState();
  fs.mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(repoRoot, ".DS_Store"), "");
  fs.mkdirSync(path.join(repoRoot, ".ccflow", "logs"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".ccflow", "logs", "test.log"), "log entry\n");
  fs.mkdirSync(path.join(repoRoot, ".worktrees", "dummy"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".worktrees", "dummy", "file.txt"), "worktree\n");

  const git = new GitAdapter();

  assert.equal(git.hasDirtyChanges(repoRoot), false);
  assert.equal(git.statusShort(repoRoot), "");
});

test("terminal reset uses hard keyboard reset not pop", () => {
  let captured = "";
  const fakeStdout = {
    isTTY: true,
    write: (data: string) => { captured += data; return true; },
  } as unknown as NodeJS.WriteStream;
  resetTerminalForChildProcess(fakeStdout);
  assert.ok(captured.includes("\x1b[=u"), "should use hard reset not pop");
  assert.ok(!captured.includes("\x1b[<u"), "should not use pop");
});

test("delete two children then tab from root creates next node cleanly", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const runner = new JobRunner(git);
  const rootId = state.currentNodeId;

  // Create two chained children via createNextNode (worktree is clean, skips Claude)
  const nodeA = await runner.createNextNode(state, rootId);
  const nodeB = await runner.createNextNode(state, nodeA.id);

  // Delete B then A — worktree is shared (same wt_main), reset to real parent commits
  await runner.deleteLeaf(state, nodeB.id);
  await runner.deleteLeaf(state, nodeA.id);

  // Root should be a leaf again
  assert.equal(getNode(state, rootId).type, "leaf");
  assert.equal(getNode(state, rootId).children.length, 0);
  assert.equal(state.currentNodeId, rootId);

  // Worktree should be clean after two resets
  assert.equal(git.hasDirtyChanges(repoRoot), false);

  // TAB from root — should succeed without hanging
  const child = await runner.createNextNode(state, rootId);
  assert.ok(child, "should create a child after delete chain");
  assert.equal(getNode(state, child.id).type, "leaf");
  assert.equal(state.currentNodeId, child.id);
  assertGraphInvariants(state);
});

test("CommitFailed node recovers when worktree cleaned and commitLeaf re-runs", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const runner = new JobRunner(git);
  const rootId = state.currentNodeId;

  // Get the real commit hash from the repo
  const rootCommit = git.currentCommit(repoRoot);
  assert.ok(rootCommit, "repo should have a real commit");

  // Create a child node and simulate a failed commit
  const nodeA = await runner.createNextNode(state, rootId);
  const failedNode = getNode(state, nodeA.id);
  failedNode.status = "CommitFailed";
  failedNode.locked = false;
  failedNode.error = "Simulated commit failure";

  // Reset worktree to root's clean state
  git.resetHard(repoRoot, rootCommit);
  assert.equal(git.hasDirtyChanges(repoRoot), false);

  // TAB from the CommitFailed leaf — commitLeaf should see clean worktree and succeed
  const recovered = await runner.createNextNode(state, nodeA.id);
  assert.ok(recovered, "should recover from CommitFailed with clean worktree");
  assert.notEqual(getNode(state, nodeA.id).status, "CommitFailed");
  assertGraphInvariants(state);
});

test("merge with a main leaf advances main and records the merge node on main", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const runner = new JobRunner(git);
  const root = state.nodes[state.currentNodeId]!;
  const mainLeaf = await runner.createNextNode(state, root.id);
  const featureLeaf = createCommittedSibling(state, repoRoot, root.id, "feature-merge", {
    fileName: "feature.txt",
    content: "feature change\n",
    message: "feat: feature change",
  });

  fs.writeFileSync(path.join(repoRoot, "main.txt"), "main change\n");
  const mainCommit = git.commit(repoRoot, "feat: main change");
  mainLeaf.git.commitHash = mainCommit;
  mainLeaf.title = "feat: main change";

  const merge = await runner.mergeLeaves(state, [mainLeaf.id, featureLeaf.id]);

  assert.notEqual(merge.git.commitHash, mainCommit);
  assert.equal(merge.git.branch, "main");
  assert.equal(merge.git.worktreeId, "wt_main");
  assert.equal(state.currentNodeId, merge.id);
  assert.equal(state.currentWorktreeId, merge.git.worktreeId);
  assert.equal(state.worktrees[merge.git.worktreeId]?.status, "current");
  assert.equal(state.worktrees[merge.git.worktreeId]?.path, repoRoot);
  assert.equal(git.currentBranch(repoRoot), "main");
  assert.equal(git.currentCommit(repoRoot), merge.git.commitHash);
  assert.equal(git.hasDirtyChanges(repoRoot), false);
  assertGraphInvariants(state);
});

test("merge rejects a selection whose source commits are already ancestors of the base", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const runner = new JobRunner(git);
  const root = state.nodes[state.currentNodeId]!;
  const mainLeaf = await runner.createNextNode(state, root.id);
  const featureLeaf = createCommittedSibling(state, repoRoot, root.id, "ancestor-merge", {
    fileName: "feature.txt",
    content: "feature change\n",
    message: "feat: feature change",
  });

  fs.writeFileSync(path.join(repoRoot, "main.txt"), "main change\n");
  git.commit(repoRoot, "feat: main change");
  const mergeResult = git.merge(featureLeaf.git.commitHash!, repoRoot);
  assert.equal(mergeResult.ok, true);
  const mergedCommit = git.commit(repoRoot, "merge feature into main");
  mainLeaf.git.commitHash = mergedCommit;
  mainLeaf.title = "merge feature into main";
  const nodeCount = Object.keys(state.nodes).length;

  await assert.rejects(
    () => runner.mergeLeaves(state, [mainLeaf.id, featureLeaf.id]),
    /already included/i,
  );

  assert.equal(Object.keys(state.nodes).length, nodeCount);
  assertGraphInvariants(state);
});

test("normalizeAfterBoot converts stale transient session state on locked nodes", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix: string) => `${prefix}_001`,
  });

  const node = state.nodes[state.currentNodeId]!;
  node.status = "Committing";
  node.locked = true;
  node.cc.processId = 99999;

  normalizeAfterBoot(state);

  assert.equal(node.locked, false);
  assert.equal(node.cc.processId, null);
  assert.equal(node.status, "JobFailed");
  assert.ok(node.error?.includes("interrupted"));
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

function createCommittedSibling(
  state: CcflowState,
  repoRoot: string,
  parentId: string,
  suffix: string,
  change: { fileName: string; content: string; message: string },
) {
  const git = new GitAdapter();
  const parent = getNode(state, parentId);
  const branchName = branchNameForNode(suffix);
  const worktreePath = worktreePathForBranch(repoRoot, branchName);
  git.createWorktree({
    repoRoot,
    path: worktreePath,
    branch: branchName,
    baseCommit: parent.git.commitHash!,
  });
  const sibling = branchFromNode(state, {
    nodeId: parent.id,
    worktreeId: worktreeIdFromBranch(branchName),
    worktreePath,
    branchName,
  });
  fs.writeFileSync(path.join(worktreePath, change.fileName), change.content);
  sibling.git.commitHash = git.commit(worktreePath, change.message);
  sibling.title = change.message;
  return sibling;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
