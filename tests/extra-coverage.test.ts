import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyConfigToState,
  assertSupportedNodeVersion,
  assertTuiRuntimeAvailable,
  runCcflowApp,
} from "../src/app.js";
import { defaultCcflowConfig } from "../src/core/config.js";
import { GitAdapter, branchNameForNode, worktreeIdFromBranch, worktreePathForBranch } from "../src/core/git.js";
import {
  branchFromNode,
  createInitialState,
  createMergeNode,
  getNode,
  getWorktree,
  isLeafNode,
  isMergeResultNode,
  isOperationBlockedNode,
  isSafeFocusTarget,
  nearestAncestorCommit,
  normalizeAfterBoot,
  sealLeafAndCreateChild,
} from "../src/core/graph.js";
import { JobRunner } from "../src/core/jobs.js";
import {
  clearNodeSessionLock,
  launchNodeSessionTab,
  nodeSessionLockPath,
  reconcileNodeSessionState,
} from "../src/core/node-session.js";
import { loadInitializedState } from "../src/core/repo.js";
import { loadOrInitState, loadState, saveState, statePath } from "../src/core/storage.js";
import type { CcflowState } from "../src/core/types.js";

test("applyConfigToState copies worktree and merge settings onto the state", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: () => "node_root",
  });
  const config = defaultCcflowConfig();
  config.worktree.enterLeafAutoSwitch = false;
  config.worktree.warnBeforeSwitch = true;
  config.merge.sealMergedInputs = false;

  applyConfigToState(state, config);

  assert.equal(state.settings.worktree.enterLeafAutoSwitch, false);
  assert.equal(state.settings.worktree.warnBeforeSwitch, true);
  assert.equal(state.settings.merge.sealMergedInputs, false);
});

test("assertSupportedNodeVersion accepts 22.0.0 and rejects 21.x or malformed", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("22.0.0"));
  assert.doesNotThrow(() => assertSupportedNodeVersion("23.1.2"));
  assert.throws(() => assertSupportedNodeVersion("21.9.9"), />=22/);
  assert.throws(() => assertSupportedNodeVersion("not-a-version"), />=22/);
});

test("runCcflowApp respects autoInit=true by initializing a fresh repo", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-app-autoinit-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  // No prior state file: runCcflowApp should call initCcflowProject.
  await runCcflowApp({
    cwd: repoRoot,
    autoInit: true,
    startTui: async () => {},
  });
  assert.equal(fs.existsSync(statePath(repoRoot)), true);
});

test("loadInitializedState normalizes and persists a saved graph", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-app-load-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");

  const state = loadInitializedState(repoRoot, git);
  // The repo root is the path the user gave, not its realpath — match exactly.
  assert.equal(state.repoRoot, repoRoot);
  assert.equal(state.nodes[state.currentNodeId]?.type, "leaf");
  assert.equal(fs.existsSync(statePath(repoRoot)), true);
});

test("isMergeResultNode classifies nodes with 0, 1, and 2+ parents", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  const root = state.nodes.node_root!;
  assert.equal(isMergeResultNode(root), false);

  sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "c1",
    commitMessage: "feat",
    sessionId: null,
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:01:00.000Z",
    idFactory: (prefix) => `${prefix}_child`,
  });
  assert.equal(isMergeResultNode(state.nodes.node_child!), false);
});

test("isSafeFocusTarget accepts sealed, MergeConflict, errored, and leaf nodes", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  const root = state.nodes.node_root!;
  assert.equal(isSafeFocusTarget(state, root.id), true);
  assert.equal(isSafeFocusTarget(state, "missing"), false);

  // Internal node with status=sealed is safe (becomes a branch anchor after merging).
  root.type = "internal";
  root.status = "sealed";
  assert.equal(isSafeFocusTarget(state, root.id), true);

  // Internal node with status=MergeConflict is also safe.
  root.status = "MergeConflict";
  assert.equal(isSafeFocusTarget(state, root.id), true);

  // Internal node with an error message is safe.
  root.status = "LeafNew";
  root.type = "internal";
  root.error = "boom";
  assert.equal(isSafeFocusTarget(state, root.id), true);

  // An internal node with no safe flag should NOT be a focus target.
  root.status = "LeafNew";
  root.type = "internal";
  root.error = null;
  assert.equal(isSafeFocusTarget(state, root.id), false);
});

test("nearestAncestorCommit returns null when no ancestor has a commit", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: null,
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  assert.equal(nearestAncestorCommit(state, "node_root"), null);
});

test("isOperationBlockedNode returns false for non-blocked leaves and unlocked worktrees", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  assert.equal(isOperationBlockedNode(state, "node_root"), false);

  state.nodes.node_root!.status = "LeafNew";
  assert.equal(isOperationBlockedNode(state, "node_root"), false);
});

test("normalizeAfterBoot converts every transient state to JobFailed", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  for (const status of [
    "Committing",
    "ParentCommitting",
    "MergeRunning",
    "Branching",
    "Deleting",
  ] as const) {
    const fresh = createInitialState({
      repoRoot: "/repo",
      branch: "main",
      commitHash: "root",
      now: "2026-05-18T10:00:00.000Z",
      idFactory: (prefix) => `${prefix}_root`,
    });
    fresh.nodes.node_root!.status = status;
    fresh.nodes.node_root!.locked = true;
    fresh.nodes.node_root!.jobId = "job_x";
    normalizeAfterBoot(fresh);
    assert.equal(fresh.nodes.node_root!.status, "JobFailed");
    assert.equal(fresh.nodes.node_root!.locked, false);
    assert.match(fresh.nodes.node_root!.error ?? "", /interrupted/);
  }

  const awaitState = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  awaitState.nodes.node_root!.status = "AwaitingParentCommit";
  awaitState.nodes.node_root!.locked = true;
  awaitState.nodes.node_root!.pendingParentJobId = "job_x";
  normalizeAfterBoot(awaitState);
  assert.equal(awaitState.nodes.node_root!.status, "ParentCommitFailed");
  assert.equal(awaitState.nodes.node_root!.pendingParentJobId, null);
});

test("createMergeNode with sealMergedInputs=false keeps the inputs as leaves", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "root",
    now: "2026-05-18T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  state.settings.merge.sealMergedInputs = false;
  sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "c1",
    commitMessage: "feat: a",
    sessionId: null,
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:01:00.000Z",
    idFactory: (prefix) => `${prefix}_a`,
  });
  branchFromNode(state, {
    nodeId: "node_root",
    worktreeId: "wt_b",
    worktreePath: "/repo/.worktrees/b",
    branchName: "ccflow/b",
    baseCommitHash: "root",
    now: "2026-05-18T10:02:00.000Z",
    idFactory: (prefix) => `${prefix}_b`,
  });
  state.nodes.node_a!.git.commitHash = "ca";
  state.nodes.node_b!.git.commitHash = "cb";

  // When sealMergedInputs=false the merge node cannot be created without violating
  // the "leaf with children must be internal" invariant. The function calls
  // assertGraphInvariants which throws for this configuration.
  assert.throws(
    () =>
      createMergeNode(state, {
        nodeIds: ["node_a", "node_b"],
        worktreeId: "wt_main",
        worktreePath: "/repo",
        branchName: "main",
        commitHash: "merge",
        now: "2026-05-18T10:03:00.000Z",
        idFactory: (prefix) => `${prefix}_merge`,
      }),
    /with children must be internal/,
  );
});

test("JobRunner mergeLeaves with headlessResolution=false leaves conflict state untouched", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-merge-noroot-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".ccflow/\n.worktrees/\n");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });

  const root = getNode(state, state.currentNodeId);

  // Build a committed main leaf as a sealed child of root.
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\nmain side\n");
  const mainCommit = git.commit(repoRoot, "feat: main side");
  const mainLeaf = sealLeafAndCreateChild(state, {
    leafId: root.id,
    commitHash: mainCommit,
    commitMessage: "feat: main side",
    sessionId: null,
    stats: { filesChanged: 1, insertions: 1, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:01:00.000Z",
    idFactory: (prefix) => `${prefix}_main`,
  });
  mainLeaf.git.commitHash = mainCommit;
  mainLeaf.title = "feat: main side";

  // Spin up a feature worktree as a sibling of mainLeaf (both children of root).
  const branchName = branchNameForNode("noroot-feature");
  const worktreePath = worktreePathForBranch(repoRoot, branchName);
  git.createWorktree({
    repoRoot,
    path: worktreePath,
    branch: branchName,
    baseCommit: mainCommit,
  });
  fs.writeFileSync(path.join(worktreePath, "README.md"), "feature side\n");
  const featureCommit = git.commit(worktreePath, "feat: feature side");

  const featureLeaf = branchFromNode(state, {
    nodeId: root.id,
    worktreeId: worktreeIdFromBranch(branchName),
    worktreePath,
    branchName,
  });
  featureLeaf.git.commitHash = featureCommit;
  featureLeaf.title = "feat: feature side";

  // Now make a conflict between main and feature on the main branch.
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\nmain conflicting\n");
  mainLeaf.git.commitHash = git.commit(repoRoot, "feat: main conflicting");
  mainLeaf.title = "feat: main conflicting";

  // Disable Claude jobs so the conflict path is forced and headless resolution
  // does not run.
  const previousDisable = process.env.CCFLOW_DISABLE_CLAUDE_JOBS;
  process.env.CCFLOW_DISABLE_CLAUDE_JOBS = "1";
  try {
    const runner = new JobRunner(git);
    const merge = await runner.mergeLeaves(state, [mainLeaf.id, featureLeaf.id]);
    assert.equal(merge.status, "MergeConflict");
    assert.equal(merge.git.commitHash, null);
    assert.equal(state.currentNodeId, merge.id);
  } finally {
    if (previousDisable === undefined) delete process.env.CCFLOW_DISABLE_CLAUDE_JOBS;
    else process.env.CCFLOW_DISABLE_CLAUDE_JOBS = previousDisable;
  }
});

test("JobRunner branchCreationPlan returns requiresName=true and defaultBranch=null when no branches", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-branch-plan-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const runner = new JobRunner(git);
  const plan = runner.branchCreationPlan(state, state.currentNodeId);
  assert.equal(plan.requiresName, true);
  assert.equal(plan.defaultBranch, null);
  // The main worktree branch (e.g. "main") does not start with "ccflow/".
  assert.equal(plan.branches.length, 0);
});

test("JobRunner normalizeNewBranchName prefixes with ccflow/ and rejects empty and existing", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-branch-name-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const runner = new JobRunner(git);

  assert.equal(runner.normalizeNewBranchName(state, "Pretty Name"), "ccflow/pretty-name");
  assert.equal(runner.normalizeNewBranchName(state, "ccflow/Already"), "ccflow/already");
  assert.throws(() => runner.normalizeNewBranchName(state, ""), /cannot be empty/);
  assert.throws(() => runner.normalizeNewBranchName(state, "!!!"), /cannot be empty/);

  // The worktree id is derived from the slug of the branch with "/" replaced by "_".
  // "ccflow/already-exists" -> slug "ccflow/already-exists" -> id "wt_ccflow_already-exists".
  state.worktrees["wt_ccflow_already-exists"] = {
    id: "wt_ccflow_already-exists",
    path: "/repo/.worktrees/already-exists",
    branch: "ccflow/already-exists",
    currentNodeId: state.currentNodeId,
    status: "other",
  };
  // "already exists" -> slug "already-exists" -> branch "ccflow/already-exists" -> same id.
  assert.throws(() => runner.normalizeNewBranchName(state, "already exists"), /Branch already exists/);
});

test("JobRunner normalizeNewBranchName rejects already existing ccflow branches", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-branch-already-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  state.worktrees["wt_ccflow_existing"] = {
    id: "wt_ccflow_existing",
    path: "/repo/.worktrees/existing",
    branch: "ccflow/existing",
    currentNodeId: state.currentNodeId,
    status: "other",
  };
  const runner = new JobRunner(git);
  assert.throws(() => runner.normalizeNewBranchName(state, "existing"), /Branch already exists/);
});

test("reconcileNodeSessionState falls back to merged saved fields when in-memory state is older", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-reconcile-saved-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const nodeId = state.currentNodeId;

  // Simulate another process writing a newer state to disk.
  const disk = loadState(repoRoot);
  disk.nodes[nodeId]!.status = "LeafResumable";
  disk.nodes[nodeId]!.cc.sessionId = "newer-session";
  disk.nodes[nodeId]!.cc.resumeMode = "resume";
  disk.nodes[nodeId]!.updatedAt = "2099-01-01T00:00:00.000Z";
  saveState(disk);

  const changed = reconcileNodeSessionState(state);
  assert.equal(changed, true);
  assert.equal(state.nodes[nodeId]?.cc.sessionId, "newer-session");
  assert.equal(state.nodes[nodeId]?.status, "LeafResumable");
});

test("reconcileNodeSessionState keeps pending lock fresh without a pid", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-pending-fresh-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const nodeId = state.currentNodeId;
  const freshStart = new Date().toISOString();

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: null, startedAt: freshStart })}\n`,
  );

  const changed = reconcileNodeSessionState(state);
  assert.equal(changed, true);
  assert.equal(state.nodes[nodeId]?.status, "LeafRunning");
  clearNodeSessionLock(repoRoot, nodeId);
});

test("reconcileNodeSessionState drops pending lock when startedAt is older than the TTL", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-pending-stale-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const nodeId = state.currentNodeId;
  const staleStart = new Date(Date.now() - 60_000).toISOString();

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: null, startedAt: staleStart })}\n`,
  );

  const changed = reconcileNodeSessionState(state);
  assert.equal(changed, false);
  assert.equal(state.nodes[nodeId]?.status, "LeafNew");
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);
});

test("reconcileNodeSessionState drops lock with unparseable startedAt", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-pending-bad-date-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const nodeId = state.currentNodeId;

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: null, startedAt: "not-a-date" })}\n`,
  );

  assert.equal(reconcileNodeSessionState(state), false);
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);
});

test("reconcileNodeSessionState keeps active pid lock when process is alive", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-pid-alive-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const nodeId = state.currentNodeId;

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );

  const changed = reconcileNodeSessionState(state);
  assert.equal(changed, true);
  assert.equal(state.nodes[nodeId]?.status, "LeafRunning");
  clearNodeSessionLock(repoRoot, nodeId);
});

test("launchNodeSessionTab refuses to open a duplicate when a live lock is already held", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-launch-dup-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const nodeId = state.currentNodeId;
  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );

  await assert.rejects(
    () =>
      launchNodeSessionTab(state, nodeId, defaultCcflowConfig(), {
        openTerminalTab: () => ({ terminal: "ghostty" }),
      }),
    /already open/,
  );
  clearNodeSessionLock(repoRoot, nodeId);
});
