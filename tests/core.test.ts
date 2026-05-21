import test from "node:test";
import assert from "node:assert/strict";
import {
  assertGraphInvariants,
  branchFromNode,
  createPendingChildFromLeaf,
  createInitialState,
  createMergeNode,
  deleteLeafNode,
  failPendingParentCommit,
  finalizePendingParentCommit,
  nearestAncestorCommit,
  normalizeAfterBoot,
  sealLeafAndCreateChild,
} from "../src/core/graph.js";

const createdAt = "2026-05-18T10:00:00.000Z";

test("initial state creates one current leaf bound to the main worktree", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_001`,
  });

  assert.equal(state.currentNodeId, "node_001");
  assert.equal(state.currentWorktreeId, "wt_main");
  assert.equal(state.nodes.node_001?.type, "leaf");
  assert.equal(state.nodes.node_001?.status, "LeafNew");
  assert.equal(state.worktrees.wt_main?.status, "current");
  assertGraphInvariants(state);
});

test("creating the next node seals the parent and keeps the child as the editable leaf", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });

  const child = sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "def456",
    commitMessage: "feat: add graph state",
    sessionId: "claude-session-1",
    stats: { filesChanged: 2, insertions: 20, deletions: 3, symbolsChanged: ["Graph.create"] },
    now: "2026-05-18T10:30:00.000Z",
    idFactory: (prefix) => `${prefix}_child`,
  });

  assert.equal(child.id, "node_child");
  assert.equal(state.nodes.node_root?.type, "internal");
  assert.equal(state.nodes.node_root?.status, "sealed");
  assert.equal(state.nodes.node_root?.git.commitHash, "def456");
  assert.deepEqual(state.nodes.node_root?.children, ["node_child"]);
  assert.equal(state.nodes.node_child?.type, "leaf");
  assert.equal(state.nodes.node_child?.git.worktreeId, "wt_main");
  assert.equal(state.currentNodeId, "node_child");
  assertGraphInvariants(state);
});

test("branching from a historical node creates a new worktree-backed leaf", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "def456",
    commitMessage: "feat: base",
    sessionId: null,
    stats: { filesChanged: 1, insertions: 1, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_next`,
  });

  const branch = branchFromNode(state, {
    nodeId: "node_root",
    worktreeId: "wt_feature",
    worktreePath: "/repo/.worktrees/feature",
    branchName: "ccflow/feature",
    now: "2026-05-18T10:20:00.000Z",
    idFactory: (prefix) => `${prefix}_feature`,
  });

  assert.equal(branch.id, "node_feature");
  assert.equal(branch.type, "leaf");
  assert.equal(branch.parents[0], "node_root");
  assert.equal(branch.git.worktreeId, "wt_feature");
  assert.equal(state.worktrees.wt_feature?.path, "/repo/.worktrees/feature");
  assert.equal(state.nodes.node_root?.type, "internal");
  assertGraphInvariants(state);
});

test("merge only accepts leaf nodes and creates a single merge leaf", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "def456",
    commitMessage: "feat: base",
    sessionId: null,
    stats: { filesChanged: 1, insertions: 1, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_main`,
  });
  branchFromNode(state, {
    nodeId: "node_root",
    worktreeId: "wt_feature",
    worktreePath: "/repo/.worktrees/feature",
    branchName: "ccflow/feature",
    now: "2026-05-18T10:20:00.000Z",
    idFactory: (prefix) => `${prefix}_feature`,
  });
  state.nodes.node_main!.git.commitHash = "main789";
  state.nodes.node_feature!.git.commitHash = "feature789";

  assert.throws(
    () =>
      createMergeNode(state, {
        nodeIds: ["node_root", "node_feature"],
        worktreeId: "wt_merge",
        worktreePath: "/repo/.worktrees/merge",
        branchName: "ccflow/merge",
        commitHash: "merge789",
        now: "2026-05-18T10:40:00.000Z",
        idFactory: (prefix) => `${prefix}_bad`,
      }),
    /Only leaf nodes can be merged/,
  );

  const merge = createMergeNode(state, {
    nodeIds: ["node_main", "node_feature"],
    worktreeId: "wt_merge",
    worktreePath: "/repo/.worktrees/merge",
    branchName: "ccflow/merge",
    commitHash: "merge789",
    now: "2026-05-18T10:40:00.000Z",
    idFactory: (prefix) => `${prefix}_merge`,
  });

  assert.equal(merge.id, "node_merge");
  assert.equal(merge.type, "leaf");
  assert.deepEqual(merge.parents, ["node_main", "node_feature"]);
  assert.equal(state.nodes.node_main?.type, "internal");
  assert.equal(state.nodes.node_feature?.type, "internal");
  assert.equal(state.currentNodeId, "node_merge");
  assert.equal(state.currentWorktreeId, "wt_merge");
  assert.equal(state.worktrees.wt_merge?.status, "current");
  assert.equal(state.worktrees.wt_main?.status, "other");
  assertGraphInvariants(state);
});

test("boot normalization converts suspended leaf sessions to resumable state", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_001`,
  });
  const node = state.nodes.node_001!;
  node.status = "LeafSuspended";
  node.cc.sessionId = "claude-session-1";
  node.cc.processId = 123;
  node.cc.resumeMode = "attached";

  normalizeAfterBoot(state);

  assert.equal(node.status, "LeafResumable");
  assert.equal(node.cc.processId, null);
  assert.equal(node.cc.resumeMode, "resume");
  assertGraphInvariants(state);
});

test("deleting a leaf removes it and restores the parent as the focus leaf", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "def456",
    commitMessage: "feat: base",
    sessionId: null,
    stats: { filesChanged: 1, insertions: 1, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_child`,
  });

  const result = deleteLeafNode(state, {
    nodeId: "node_child",
    now: "2026-05-18T10:20:00.000Z",
  });

  assert.equal(result.focusId, "node_root");
  assert.equal(state.nodes.node_child, undefined);
  assert.equal(state.nodes.node_root?.type, "leaf");
  assert.equal(state.nodes.node_root?.status, "LeafNew");
  assert.deepEqual(state.nodes.node_root?.children, []);
  assert.equal(state.currentNodeId, "node_root");
  assertGraphInvariants(state);
});

test("deleting through empty ancestors is valid and resolves reset commit recursively", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  state.nodes.node_root!.type = "internal";
  state.nodes.node_root!.status = "sealed";
  state.nodes.node_root!.children = ["node_empty"];
  state.nodes.node_empty = {
    id: "node_empty",
    title: "Empty hop",
    type: "internal",
    parents: ["node_root"],
    children: ["node_leaf"],
    createdAt: "2026-05-18T10:10:00.000Z",
    updatedAt: "2026-05-18T10:10:00.000Z",
    git: {
      commitHash: null,
      branch: "main",
      worktreeId: "wt_main",
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    status: "sealed",
  };
  state.nodes.node_leaf = {
    id: "node_leaf",
    title: "Nothing happened",
    type: "leaf",
    parents: ["node_empty"],
    children: [],
    createdAt: "2026-05-18T10:20:00.000Z",
    updatedAt: "2026-05-18T10:20:00.000Z",
    git: {
      commitHash: null,
      branch: "main",
      worktreeId: "wt_main",
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    status: "LeafNew",
  };
  state.worktrees.wt_main!.currentNodeId = "node_leaf";
  state.currentNodeId = "node_leaf";

  assert.deepEqual(nearestAncestorCommit(state, "node_leaf"), {
    nodeId: "node_root",
    commitHash: "abc123",
  });

  const result = deleteLeafNode(state, {
    nodeId: "node_leaf",
    now: "2026-05-18T10:30:00.000Z",
  });

  assert.equal(result.focusId, "node_root");
  assert.equal(state.nodes.node_leaf, undefined);
  assert.equal(state.nodes.node_empty, undefined);
  assert.equal(state.currentNodeId, "node_root");
  assertGraphInvariants(state);
});

test("deleting the last leaf on an empty branch prunes the branch path and worktree", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  const branch = branchFromNode(state, {
    nodeId: "node_root",
    worktreeId: "wt_empty",
    worktreePath: "/repo/.worktrees/empty",
    branchName: "ccflow/empty",
    baseCommitHash: "abc123",
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_branch`,
  });
  const leaf = sealLeafAndCreateChild(state, {
    leafId: branch.id,
    commitHash: "abc123",
    commitMessage: "No branch work",
    sessionId: null,
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:20:00.000Z",
    idFactory: (prefix) => `${prefix}_leaf`,
  });
  state.nodes[branch.id]!.git.commitHash = null;
  state.nodes[branch.id]!.stats = { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] };

  const result = deleteLeafNode(state, {
    nodeId: leaf.id,
    now: "2026-05-18T10:30:00.000Z",
  });

  assert.equal(state.nodes[leaf.id], undefined);
  assert.equal(state.nodes[branch.id], undefined);
  assert.equal(state.worktrees.wt_empty, undefined);
  assert.equal(result.focusId, "node_root");
  assert.equal(state.nodes.node_root?.type, "leaf");
  assertGraphInvariants(state);
});

test("deleting the last leaf preserves committed branch history", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  const branch = branchFromNode(state, {
    nodeId: "node_root",
    worktreeId: "wt_feature",
    worktreePath: "/repo/.worktrees/feature",
    branchName: "ccflow/feature",
    baseCommitHash: "abc123",
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_branch`,
  });
  const leaf = sealLeafAndCreateChild(state, {
    leafId: branch.id,
    commitHash: "feature123",
    commitMessage: "feat: keep branch",
    sessionId: null,
    stats: { filesChanged: 1, insertions: 2, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:20:00.000Z",
    idFactory: (prefix) => `${prefix}_leaf`,
  });

  const result = deleteLeafNode(state, {
    nodeId: leaf.id,
    now: "2026-05-18T10:30:00.000Z",
  });

  assert.equal(result.focusId, branch.id);
  assert.equal(state.nodes[leaf.id], undefined);
  assert.equal(state.nodes[branch.id]?.type, "leaf");
  assert.equal(state.nodes[branch.id]?.git.commitHash, "feature123");
  assert.equal(state.worktrees.wt_feature?.currentNodeId, branch.id);
  assertGraphInvariants(state);
});

test("pending next-node lifecycle finalizes and fails explicitly", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  const child = createPendingChildFromLeaf(state, {
    leafId: "node_root",
    jobId: "job_commit_1",
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_child`,
  });

  assert.equal(state.nodes.node_root?.status, "ParentCommitting");
  assert.equal(child.status, "AwaitingParentCommit");
  assert.equal(child.locked, true);

  finalizePendingParentCommit(state, {
    parentId: "node_root",
    commitHash: "def456",
    commitMessage: "feat: parent",
    sessionId: "session-1",
    stats: { filesChanged: 1, insertions: 1, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:20:00.000Z",
  });

  assert.equal(state.nodes.node_root?.status, "sealed");
  assert.equal(state.nodes.node_child?.status, "LeafNew");
  assert.equal(state.nodes.node_child?.locked, false);
  assertGraphInvariants(state);

  const failed = createPendingChildFromLeaf(state, {
    leafId: "node_child",
    jobId: "job_commit_2",
    now: "2026-05-18T10:30:00.000Z",
    idFactory: (prefix) => `${prefix}_failed`,
  });
  failPendingParentCommit(state, {
    parentId: "node_child",
    error: "commit boom",
    now: "2026-05-18T10:40:00.000Z",
  });

  assert.equal(state.nodes.node_child?.status, "ParentCommitFailed");
  assert.equal(state.nodes[failed.id]?.status, "ParentCommitFailed");
  assert.match(state.nodes[failed.id]?.blockedReason ?? "", /Parent commit failed/);
  assertGraphInvariants(state);
});

test("forced leaf deletion can remove a leaf locked by an in-progress delete job", () => {
  const state = createInitialState({
    repoRoot: "/repo",
    branch: "main",
    commitHash: "abc123",
    now: createdAt,
    idFactory: (prefix) => `${prefix}_root`,
  });
  sealLeafAndCreateChild(state, {
    leafId: "node_root",
    commitHash: "def456",
    commitMessage: "feat: base",
    sessionId: null,
    stats: { filesChanged: 1, insertions: 1, deletions: 0, symbolsChanged: [] },
    now: "2026-05-18T10:10:00.000Z",
    idFactory: (prefix) => `${prefix}_child`,
  });
  state.nodes.node_child!.locked = true;
  state.nodes.node_child!.status = "Deleting";

  assert.throws(() => deleteLeafNode(state, { nodeId: "node_child" }), /Cannot delete locked node/);

  const result = deleteLeafNode(state, {
    nodeId: "node_child",
    force: true,
    now: "2026-05-18T10:20:00.000Z",
  });

  assert.equal(result.focusId, "node_root");
  assert.equal(state.nodes.node_child, undefined);
  assert.equal(state.nodes.node_root?.type, "leaf");
  assertGraphInvariants(state);
});
