import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitAdapter, branchNameForNode, mergeBranchName, slug, worktreeIdFromBranch, worktreePathForBranch } from "../src/core/git.js";
import {
  assertGraphInvariants,
  branchFromNode,
  createId,
  createInitialState,
  createMergeNode,
  getNode,
  getWorktree,
  nearestAncestorCommit,
  sealLeafAndCreateChild,
  switchCurrentWorktree,
} from "../src/core/graph.js";
import { JobRunner } from "../src/core/jobs.js";
import { runCommand, tryCommand } from "../src/core/shell.js";
import {
  quarantineTerminalInput,
  releaseStdinForChildProcess,
  resetTerminalForChildProcess,
} from "../src/core/terminal.js";
import { loadOrInitState } from "../src/core/storage.js";
import type { CcflowNode, CcflowState } from "../src/core/types.js";

test("shell helpers report success, command failure, and spawn errors", () => {
  assert.equal(runCommand(process.execPath, ["-e", "process.stdout.write(' ok\\n')"]), "ok");

  const failed = tryCommand(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(7)"]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 7);
  assert.equal(failed.stderr, "bad");

  const missing = tryCommand("__ccflow_missing_command__", []);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, null);
  assert.match(missing.stderr, /ENOENT/);

  assert.throws(
    () => runCommand(process.execPath, ["-e", "process.stdout.write('nope'); process.exit(2)"]),
    /failed: nope/,
  );
});

test("terminal helpers reset tty output, release stdin, and quarantine buffered bytes", async () => {
  let output = "";
  resetTerminalForChildProcess({ isTTY: false, write: () => { throw new Error("should not write"); } } as never);
  resetTerminalForChildProcess({ isTTY: true, write: (data: string) => { output += data; return true; } } as never);
  assert.match(output, /\x1b\[=u/);

  const input = new FakeInput();
  input.on("data", () => {});
  releaseStdinForChildProcess(input as never);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.paused, true);
  assert.equal(input.rawModes.at(-1), false);

  input.isRaw = true;
  input.reads.push(Buffer.from("pending"));
  await quarantineTerminalInput({ input: input as never, durationMs: 0 });
  assert.equal(input.rawModes.includes(true), true);
  assert.equal(input.rawModes.at(-1), true);
  assert.equal(input.paused, false);

  const nonTty = new FakeInput();
  nonTty.isTTY = false;
  await quarantineTerminalInput({ input: nonTty as never, durationMs: 0 });
  assert.deepEqual(nonTty.rawModes, []);
});

test("git helpers cover existing repos, detached branches, worktree reuse, and stats fallbacks", () => {
  const repoRoot = createRepo();
  const git = new GitAdapter();
  const existingRoot = git.ensureRepo(path.join(repoRoot, "nested"));
  assert.equal(existingRoot, fs.realpathSync(repoRoot));

  const firstCommit = git.currentCommit(repoRoot);
  assert.ok(firstCommit);
  assert.equal(git.currentBranch(repoRoot), "main");
  assert.equal(git.diffStats(repoRoot, null).filesChanged, 0);

  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "tracked\n");
  const secondCommit = git.commit(repoRoot, "test: tracked");
  const stats = git.diffStats(repoRoot, secondCommit);
  assert.equal(stats.filesChanged, 1);
  assert.equal(stats.insertions, 1);
  assert.equal(stats.deletions, 0);

  const branch = branchNameForNode("reuse");
  const worktreePath = worktreePathForBranch(repoRoot, branch);
  assert.deepEqual(git.createWorktree({ repoRoot, path: worktreePath, branch, baseCommit: firstCommit }), {
    id: worktreeIdFromBranch(branch),
    path: worktreePath,
    branch,
  });
  assert.deepEqual(git.createWorktree({ repoRoot, path: worktreePath, branch, baseCommit: firstCommit }), {
    id: worktreeIdFromBranch(branch),
    path: worktreePath,
    branch,
  });

  const mergeBranch = "ccflow/merge-existing";
  const mergePath = worktreePathForBranch(repoRoot, mergeBranch);
  const mergeWorktree = git.createMergeWorktree({
    repoRoot,
    path: mergePath,
    branch: mergeBranch,
    baseCommit: secondCommit,
    existingBranch: true,
  });
  assert.equal(mergeWorktree.detached, true);
  assert.equal(git.createMergeWorktree({ repoRoot, path: mergePath, branch: mergeBranch, baseCommit: secondCommit }).detached, false);

  runCommand("git", ["checkout", "--detach", firstCommit], { cwd: repoRoot });
  assert.match(git.currentBranch(repoRoot), /^detached-/);
  git.checkoutNewBranch(repoRoot, "after-detach");
  assert.equal(git.currentBranch(repoRoot), "after-detach");

  assert.equal(slug(" Hello/Feature! "), "hello/feature");
  assert.equal(mergeBranchName(["node_abcdefgh", "node_ijklmnop"]), "ccflow/merge-node_abc-node_ijk");
});

test("graph helpers reject invalid lookups and invariant violations", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });

  assert.match(createId("node"), /^node_[0-9a-f-]{8}$/);
  assert.throws(() => getNode(state, "missing"), /Node not found/);
  assert.throws(() => getWorktree(state, "missing"), /Worktree not found/);
  const uncommitted = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: null,
    idFactory: (prefix) => `${prefix}_uncommitted`,
  });
  assert.throws(
    () => branchFromNode(uncommitted, {
      nodeId: "node_uncommitted",
      worktreeId: "wt_bad",
      worktreePath: "/repo/.worktrees/bad",
      branchName: "ccflow/bad",
    }),
    /Cannot branch from node without commit/,
  );
  assert.throws(
    () => sealLeafAndCreateChild(state, {
      leafId: "node_root",
      commitHash: "a",
      commitMessage: "first",
      sessionId: null,
      stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
      idFactory: () => "node_child",
    }) && sealLeafAndCreateChild(state, {
      leafId: "node_root",
      commitHash: "b",
      commitMessage: "second",
      sessionId: null,
      stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    }),
    /Only leaf nodes can create next node/,
  );

  const noCommit = createInitialState({ repoRoot: "/repo", branch: "main", commitHash: "root", idFactory: (prefix) => `${prefix}_a` });
  const leafA = sealLeafAndCreateChild(noCommit, {
    leafId: "node_a",
    commitHash: "commit-a",
    commitMessage: "feat: a",
    sessionId: "session-a",
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    idFactory: (prefix) => `${prefix}_b`,
  });
  leafA.git.commitHash = null;
  assert.throws(
    () => createMergeNode(noCommit, {
      nodeIds: ["node_a", leafA.id],
      worktreeId: "wt_merge",
      worktreePath: "/repo/.worktrees/merge",
      branchName: "ccflow/merge",
    }),
    /Only leaf nodes can be merged/,
  );

  const switchState = createInitialState({ repoRoot: "/repo", branch: "main", commitHash: "root", idFactory: (prefix) => `${prefix}_root` });
  const child = branchFromNode(switchState, {
    nodeId: "node_root",
    worktreeId: "wt_feature",
    worktreePath: "/repo/.worktrees/feature",
    branchName: "ccflow/feature",
    baseCommitHash: "root",
    idFactory: (prefix) => `${prefix}_feature`,
  });
  const selected = switchCurrentWorktree(switchState, child.id);
  assert.equal(selected.id, "wt_feature");
  assert.equal(switchState.currentNodeId, child.id);
  assert.throws(() => switchCurrentWorktree(switchState, "node_root"), /Only leaf nodes/);

  const invariantCases: Array<[string, (copy: CcflowState) => void, RegExp]> = [
    ["version", (copy) => { copy.version = 99 as CcflowState["version"]; }, /Unsupported/],
    ["current node", (copy) => { copy.currentNodeId = "missing"; }, /currentNodeId/],
    ["current worktree", (copy) => { copy.currentWorktreeId = "missing"; }, /currentWorktreeId/],
    ["children internal", (copy) => { copy.nodes.node_root!.type = "leaf"; }, /with children must be internal/],
    ["internal status", (copy) => { copy.nodes.node_root!.status = "LeafNew"; }, /Internal node/],
    ["resumable session", (copy) => { copy.nodes.node_feature!.status = "LeafResumable"; }, /Resumable/],
    ["missing worktree", (copy) => { copy.nodes.node_feature!.git.worktreeId = "missing"; }, /missing worktree/],
    ["missing parent backlink", (copy) => { copy.nodes.node_root!.children = []; }, /does not reference child/],
    ["missing child backlink", (copy) => { copy.nodes.node_feature!.parents = []; }, /does not reference parent/],
    ["multiple current", (copy) => { copy.worktrees.wt_main!.status = "current"; }, /Exactly one/],
    ["current id mismatch", (copy) => { copy.currentWorktreeId = "wt_main"; }, /must match/],
    ["worktree missing current node", (copy) => { copy.worktrees.wt_feature!.currentNodeId = "missing"; }, /missing current node/],
  ];
  for (const [, mutate, message] of invariantCases) {
    const copy = structuredClone(switchState) as CcflowState;
    mutate(copy);
    assert.throws(() => assertGraphInvariants(copy), message);
  }
});

test("job runner covers clean sibling creation and failure state restoration", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const runner = new JobRunner(git);
  const rootId = state.currentNodeId;

  assert.deepEqual(await runner.commitLeaf(state, rootId), {
    success: true,
    commitHash: git.currentCommit(repoRoot),
    commitMessage: "Root",
    summary: git.diffStats(repoRoot, git.currentCommit(repoRoot)),
  });

  const child = await runner.createNextNode(state, rootId);
  assert.equal(child.type, "leaf");
  assert.equal((await runner.commitLeaf(state, rootId)).success, false);
  await assert.rejects(() => runner.createSiblingNode(state, rootId), /Root node cannot create a sibling/);

  const sibling = await runner.createSiblingNode(state, child.id, "Feature Branch");
  assert.match(sibling.git.branch, /^ccflow\/feature-branch$/);
  assert.equal(state.currentNodeId, sibling.id);
  const plan = runner.branchCreationPlan(state, sibling.id);
  assert.equal(plan.requiresName, false);
  assert.equal(plan.defaultBranch, sibling.git.branch);
  await assert.rejects(() => runner.createSiblingNode(state, sibling.id, "Feature Branch"), /already exists/);
  const existingBranchSibling = await runner.createSiblingNode(state, sibling.id, { kind: "existing", branch: sibling.git.branch });
  assert.equal(existingBranchSibling.git.worktreeId, sibling.git.worktreeId);

  const noBase = createInitialState({ repoRoot, branch: "main", commitHash: "base", idFactory: (prefix) => `${prefix}_root` });
  const noBaseChild = sealLeafAndCreateChild(noBase, {
    leafId: "node_root",
    commitHash: "commit",
    commitMessage: "feat: child",
    sessionId: null,
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    idFactory: (prefix) => `${prefix}_child`,
  });
  noBase.nodes.node_root!.git.commitHash = null;
  await assert.rejects(() => runner.createSiblingNode(noBase, noBaseChild.id), /no ancestor commit/);

  const dirty = createRepoState();
  const failingRunner = new JobRunner(git);
  process.env.CCFLOW_DISABLE_CLAUDE_JOBS = "1";
  try {
    fs.appendFileSync(path.join(dirty.repoRoot, "README.md"), "dirty\n");
    const result = await failingRunner.commitLeaf(dirty.state, dirty.state.currentNodeId);
    assert.equal(result.success, false);
    const dirtyNode = getNode(dirty.state, dirty.state.currentNodeId);
    assert.equal(dirtyNode.status, "CommitFailed");
    assert.equal(dirtyNode.locked, false);
    assert.match(dirtyNode.error ?? "", /disabled/);
    assert.equal(dirty.state.worktrees.wt_main?.locked, false);
  } finally {
    delete process.env.CCFLOW_DISABLE_CLAUDE_JOBS;
  }

  const deleteRoot = createRepoState();
  await assert.rejects(() => runner.deleteLeaf(deleteRoot.state, deleteRoot.state.currentNodeId), /Cannot delete the root leaf node/);

  const deleteFail = createRepoState();
  const deleteChild = await runner.createNextNode(deleteFail.state, deleteFail.state.currentNodeId);
  const resetFailureRunner = new JobRunner({
    ...git,
    resetHard: () => { throw new Error("reset boom"); },
  } as unknown as GitAdapter);
  await assert.rejects(() => resetFailureRunner.deleteLeaf(deleteFail.state, deleteChild.id), /reset boom/);
  assert.equal(getNode(deleteFail.state, deleteChild.id).status, "LeafNew");
  assert.equal(deleteFail.state.worktrees.wt_main?.locked, false);
});

test("job runner covers fallback direct commit and createNextNode commit failures", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  fs.appendFileSync(path.join(repoRoot, "README.md"), "left dirty after claude\n");

  const runner = new JobRunner(git, {
    runHeadless: () => ({ ok: true, stdout: "ok", stderr: "" }),
  } as never);
  const result = await runner.commitLeaf(state, state.currentNodeId);

  assert.equal(result.success, true);
  assert.equal(git.hasDirtyChanges(repoRoot), false);
  assert.match(git.lastCommitMessage(repoRoot), /Root|Auto commit/);

  const failingNext = new class extends JobRunner {
    override async commitLeaf() {
      return { success: false, error: "commit boom" };
    }
  }();
  await assert.rejects(() => failingNext.createNextNode(state, state.currentNodeId), /commit boom/);

  const dirtyFailure = createRepoState();
  fs.appendFileSync(path.join(dirtyFailure.repoRoot, "README.md"), "dirty but uncommitted\n");
  const badFallbackRunner = new JobRunner({
    ...new GitAdapter(),
    currentCommit: (cwd: string) => new GitAdapter().currentCommit(cwd),
    hasDirtyChanges: (cwd: string) => new GitAdapter().hasDirtyChanges(cwd),
    statusShort: (cwd: string) => new GitAdapter().statusShort(cwd),
    diff: (cwd: string) => new GitAdapter().diff(cwd),
    commit: () => { throw new Error("fallback commit boom"); },
  } as unknown as GitAdapter, {
    runHeadless: () => ({ ok: true, stdout: "ok", stderr: "" }),
  } as never);
  const failure = await badFallbackRunner.commitLeaf(dirtyFailure.state, dirtyFailure.state.currentNodeId);
  assert.equal(failure.success, false);
  assert.match(failure.error ?? "", /left dirty changes/);
});

test("job runner returns a merge-conflict node when automatic merge and Claude resolution cannot finish", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const runner = new JobRunner(git);
  const root = getNode(state, state.currentNodeId);
  const mainLeaf = await runner.createNextNode(state, root.id);
  const featureLeaf = createCommittedSibling(state, repoRoot, root.id, "conflict-feature", {
    fileName: "README.md",
    content: "feature side\n",
    message: "feat: feature side",
  });

  fs.writeFileSync(path.join(repoRoot, "README.md"), "main side\n");
  mainLeaf.git.commitHash = git.commit(repoRoot, "feat: main side");
  mainLeaf.title = "feat: main side";

  const previousDisable = process.env.CCFLOW_DISABLE_CLAUDE_JOBS;
  process.env.CCFLOW_DISABLE_CLAUDE_JOBS = "1";
  try {
    const merge = await runner.mergeLeaves(state, [mainLeaf.id, featureLeaf.id]);
    assert.equal(merge.status, "MergeConflict");
    assert.match(merge.title, /README\.md/);
    assert.equal(merge.git.commitHash, null);
    assert.equal(state.currentNodeId, merge.id);
    assert.equal(git.conflictFiles(state.worktrees[merge.git.worktreeId]!.path).includes("README.md"), true);
  } finally {
    restoreEnv("CCFLOW_DISABLE_CLAUDE_JOBS", previousDisable);
  }
});

test("job runner records a headless merge resolution when conflicts are resolved by the adapter", async () => {
  const { state, repoRoot } = createRepoState();
  const git = new GitAdapter();
  const root = getNode(state, state.currentNodeId);
  const setupRunner = new JobRunner(git);
  const mainLeaf = await setupRunner.createNextNode(state, root.id);
  const featureLeaf = createCommittedSibling(state, repoRoot, root.id, "resolved-conflict-feature", {
    fileName: "README.md",
    content: "feature resolved\n",
    message: "feat: feature resolved",
  });

  fs.writeFileSync(path.join(repoRoot, "README.md"), "main resolved\n");
  mainLeaf.git.commitHash = git.commit(repoRoot, "feat: main resolved");
  mainLeaf.title = "feat: main resolved";

  const resolvingRunner = new JobRunner(git, {
    runHeadless: (_repoRoot: string, _prompt: string, cwd: string) => {
      fs.writeFileSync(path.join(cwd, "README.md"), "resolved by adapter\n");
      git.commit(cwd, "merge: resolved by adapter");
      return { ok: true, stdout: "resolved", stderr: "" };
    },
  } as never);

  const merge = await resolvingRunner.mergeLeaves(state, [mainLeaf.id, featureLeaf.id]);
  assert.equal(merge.status, "LeafNew");
  assert.ok(merge.git.commitHash);
  assert.equal(git.conflictFiles(state.worktrees[merge.git.worktreeId]!.path).length, 0);
  assert.equal(git.hasDirtyChanges(state.worktrees[merge.git.worktreeId]!.path), false);
});

function createRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-coverage-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.mkdirSync(path.join(repoRoot, "nested"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  return repoRoot;
}

function createRepoState(): { state: CcflowState; repoRoot: string } {
  const repoRoot = createRepo();
  const git = new GitAdapter();
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
): CcflowNode {
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = false;
  rawModes: boolean[] = [];
  reads: Buffer[] = [];

  setRawMode(value: boolean): void {
    this.rawModes.push(value);
    this.isRaw = value;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  read(): Buffer | null {
    return this.reads.shift() ?? null;
  }
}
