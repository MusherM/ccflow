import { randomUUID } from "node:crypto";
import type { CcflowNode, CcflowState, NodeStats, WorktreeInfo } from "./types.js";
import { emptyStats } from "./types.js";

export type IdFactory = (prefix: string) => string;

const defaultSettings = {
  worktree: {
    enterLeafAutoSwitch: true,
    warnBeforeSwitch: false,
  },
  merge: {
    sealMergedInputs: true,
  },
} as const;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function createInitialState(input: {
  repoRoot: string;
  branch: string;
  commitHash: string | null;
  now?: string;
  idFactory?: IdFactory;
}): CcflowState {
  const now = input.now ?? new Date().toISOString();
  const idFactory = input.idFactory ?? createId;
  const rootId = idFactory("node");
  const root: CcflowNode = {
    id: rootId,
    title: "Root",
    type: "leaf",
    parents: [],
    children: [],
    createdAt: now,
    updatedAt: now,
    git: {
      commitHash: input.commitHash,
      branch: input.branch,
      worktreeId: "wt_main",
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: emptyStats(),
    status: "LeafNew",
  };
  const mainWorktree: WorktreeInfo = {
    id: "wt_main",
    path: input.repoRoot,
    branch: input.branch,
    currentNodeId: rootId,
    status: "current",
  };

  return {
    version: 1,
    repoRoot: input.repoRoot,
    currentWorktreeId: mainWorktree.id,
    currentNodeId: rootId,
    settings: structuredClone(defaultSettings),
    nodes: { [rootId]: root },
    worktrees: { [mainWorktree.id]: mainWorktree },
  };
}

export function getNode(state: CcflowState, nodeId: string): CcflowNode {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function getWorktree(state: CcflowState, worktreeId: string): WorktreeInfo {
  const worktree = state.worktrees[worktreeId];
  if (!worktree) throw new Error(`Worktree not found: ${worktreeId}`);
  return worktree;
}

export function isLeafNode(state: CcflowState, nodeId: string): boolean {
  const node = getNode(state, nodeId);
  return node.type === "leaf" && node.children.length === 0;
}

export function sealLeafAndCreateChild(
  state: CcflowState,
  input: {
    leafId: string;
    commitHash: string;
    commitMessage: string;
    sessionId: string | null;
    stats: NodeStats;
    now?: string;
    idFactory?: IdFactory;
  },
): CcflowNode {
  const leaf = getNode(state, input.leafId);
  if (!isLeafNode(state, leaf.id)) {
    throw new Error("Only leaf nodes can create next node");
  }

  const now = input.now ?? new Date().toISOString();
  const idFactory = input.idFactory ?? createId;
  const childId = idFactory("node");

  leaf.type = "internal";
  leaf.status = "sealed";
  leaf.git.commitHash = input.commitHash;
  leaf.title = firstLine(input.commitMessage) || leaf.title;
  leaf.stats = input.stats;
  leaf.cc.sessionId = input.sessionId;
  leaf.cc.processId = null;
  leaf.cc.resumeMode = input.sessionId ? "resume" : "new";
  leaf.updatedAt = now;
  leaf.children.push(childId);

  const child: CcflowNode = {
    id: childId,
    title: "New session",
    type: "leaf",
    parents: [leaf.id],
    children: [],
    createdAt: now,
    updatedAt: now,
    git: {
      commitHash: null,
      branch: leaf.git.branch,
      worktreeId: leaf.git.worktreeId,
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: emptyStats(),
    status: "LeafNew",
  };

  state.nodes[child.id] = child;
  const worktree = getWorktree(state, child.git.worktreeId);
  worktree.currentNodeId = child.id;
  state.currentNodeId = child.id;
  assertGraphInvariants(state);
  return child;
}

export function branchFromNode(
  state: CcflowState,
  input: {
    nodeId: string;
    worktreeId: string;
    worktreePath: string;
    branchName: string;
    baseCommitHash?: string;
    now?: string;
    idFactory?: IdFactory;
  },
): CcflowNode {
  const base = getNode(state, input.nodeId);
  if (!base.git.commitHash && !input.baseCommitHash) {
    throw new Error("Cannot branch from node without commit");
  }

  const now = input.now ?? new Date().toISOString();
  const idFactory = input.idFactory ?? createId;
  const childId = idFactory("node");
  if (!base.children.includes(childId)) {
    base.children.push(childId);
  }
  base.type = "internal";
  if (base.status !== "sealed") base.status = "sealed";
  base.updatedAt = now;

  const worktree: WorktreeInfo = {
    id: input.worktreeId,
    path: input.worktreePath,
    branch: input.branchName,
    currentNodeId: childId,
    status: "other",
  };
  const child: CcflowNode = {
    id: childId,
    title: `Branch from ${base.title}`,
    type: "leaf",
    parents: [base.id],
    children: [],
    createdAt: now,
    updatedAt: now,
    git: {
      commitHash: null,
      branch: input.branchName,
      worktreeId: worktree.id,
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: emptyStats(),
    status: "LeafNew",
  };

  state.nodes[child.id] = child;
  state.worktrees[worktree.id] = worktree;
  state.currentNodeId = child.id;
  assertGraphInvariants(state);
  return child;
}

export function createMergeNode(
  state: CcflowState,
  input: {
    nodeIds: string[];
    worktreeId: string;
    worktreePath: string;
    branchName: string;
    commitHash?: string | null;
    now?: string;
    idFactory?: IdFactory;
  },
): CcflowNode {
  if (input.nodeIds.length < 2) throw new Error("Merge requires at least two leaf nodes");

  const leaves = input.nodeIds.map((nodeId) => getNode(state, nodeId));
  for (const node of leaves) {
    if (!isLeafNode(state, node.id)) throw new Error("Only leaf nodes can be merged");
    if (node.locked) throw new Error(`Cannot merge locked node: ${node.id}`);
    if (!node.git.commitHash) throw new Error(`Cannot merge node without commit: ${node.id}`);
  }

  const now = input.now ?? new Date().toISOString();
  const idFactory = input.idFactory ?? createId;
  const mergeId = idFactory("node");

  const mergeNode: CcflowNode = {
    id: mergeId,
    title: "Merge",
    type: "leaf",
    parents: input.nodeIds,
    children: [],
    createdAt: now,
    updatedAt: now,
    git: {
      commitHash: input.commitHash ?? null,
      branch: input.branchName,
      worktreeId: input.worktreeId,
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: emptyStats(),
    status: "LeafNew",
  };

  state.nodes[mergeNode.id] = mergeNode;
  state.worktrees[input.worktreeId] = {
    id: input.worktreeId,
    path: input.worktreePath,
    branch: input.branchName,
    currentNodeId: mergeNode.id,
    status: "other",
  };

  for (const node of leaves) {
    if (!node.children.includes(mergeNode.id)) node.children.push(mergeNode.id);
    if (state.settings.merge.sealMergedInputs) {
      node.type = "internal";
      node.status = "sealed";
      node.cc.processId = null;
      node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
    }
    node.updatedAt = now;
  }

  state.currentNodeId = mergeNode.id;
  assertGraphInvariants(state);
  return mergeNode;
}

export function deleteLeafNode(
  state: CcflowState,
  input: {
    nodeId: string;
    now?: string;
    force?: boolean;
  },
): { deleted: CcflowNode; focusId: string } {
  const node = getNode(state, input.nodeId);
  if (!isLeafNode(state, node.id)) throw new Error("Only leaf nodes can be deleted");
  if (node.parents.length === 0) throw new Error("Cannot delete the root leaf node");
  if (node.locked && !input.force) throw new Error(`Cannot delete locked node: ${node.id}`);

  const now = input.now ?? new Date().toISOString();
  const primaryParent = getNode(state, node.parents[0]!);
  const deletedWorktreeId = node.git.worktreeId;

  for (const parentId of node.parents) {
    const parent = getNode(state, parentId);
    parent.children = parent.children.filter((childId) => childId !== node.id);
    parent.updatedAt = now;
    if (parent.children.length === 0) {
      parent.type = "leaf";
      parent.status = parent.cc.sessionId ? "LeafResumable" : "LeafNew";
      parent.locked = false;
      parent.jobId = null;
      parent.error = null;
      parent.cc.processId = null;
      parent.cc.resumeMode = parent.cc.sessionId ? "resume" : "new";
    }
  }

  delete state.nodes[node.id];

  const focusId = chooseFocusAfterDelete(state, primaryParent.id);
  const deletedWorktreeStillUsed = Object.values(state.nodes).some(
    (candidate) => candidate.git.worktreeId === deletedWorktreeId,
  );
  if (!deletedWorktreeStillUsed && deletedWorktreeId !== "wt_main") {
    delete state.worktrees[deletedWorktreeId];
  }

  const focusNode = getNode(state, focusId);
  const focusWorktree = getWorktree(state, focusNode.git.worktreeId);
  for (const worktree of Object.values(state.worktrees)) {
    if (worktree.id === focusWorktree.id) {
      worktree.status = "current";
      worktree.currentNodeId = focusNode.id;
    } else if (worktree.status === "current") {
      worktree.status = "other";
    }
    if (worktree.currentNodeId === node.id) {
      worktree.currentNodeId = focusNode.id;
    }
  }
  state.currentNodeId = focusNode.id;
  state.currentWorktreeId = focusWorktree.id;

  assertGraphInvariants(state);
  return { deleted: node, focusId };
}

export function nearestAncestorCommit(
  state: CcflowState,
  nodeId: string,
): { nodeId: string; commitHash: string } | null {
  const start = getNode(state, nodeId);
  const queue = [...start.parents];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (seen.has(currentId)) continue;
    seen.add(currentId);

    const current = state.nodes[currentId];
    if (!current) continue;
    if (current.git.commitHash) {
      return { nodeId: current.id, commitHash: current.git.commitHash };
    }
    queue.push(...current.parents);
  }

  return null;
}

export function switchCurrentWorktree(state: CcflowState, nodeId: string): WorktreeInfo {
  const node = getNode(state, nodeId);
  if (!isLeafNode(state, node.id)) throw new Error("Only leaf nodes can become the current worktree");

  for (const worktree of Object.values(state.worktrees)) {
    if (worktree.status === "current") worktree.status = "other";
  }
  const selected = getWorktree(state, node.git.worktreeId);
  selected.status = "current";
  selected.currentNodeId = node.id;
  state.currentWorktreeId = selected.id;
  state.currentNodeId = node.id;
  return selected;
}

export function normalizeAfterBoot(state: CcflowState): void {
  for (const node of Object.values(state.nodes)) {
    node.cc.processId = null;
    if (node.type !== "leaf") {
      node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
      continue;
    }
    if (node.status === "LeafRunning" || node.status === "LeafSuspended") {
      node.status = node.cc.sessionId ? "LeafResumable" : "LeafNew";
      node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
    }
    if (node.locked || node.status === "Committing" || node.status === "MergeRunning" || node.status === "Deleting") {
      node.locked = false;
      node.status = "JobFailed";
      node.error = "Job was interrupted because ccflow exited.";
    }
  }
}

export function assertGraphInvariants(state: CcflowState): void {
  if (state.version !== 1) throw new Error("Unsupported ccflow state version");
  if (!state.nodes[state.currentNodeId]) throw new Error("currentNodeId does not reference an existing node");
  if (!state.worktrees[state.currentWorktreeId]) throw new Error("currentWorktreeId does not reference a worktree");

  for (const node of Object.values(state.nodes)) {
    if (node.children.length > 0 && node.type !== "internal") {
      throw new Error(`Node with children must be internal: ${node.id}`);
    }
    if (node.type === "internal" && node.status !== "sealed" && node.status !== "Branching") {
      throw new Error(`Internal node must be sealed or branching: ${node.id}`);
    }
    if (node.status === "LeafResumable" && !node.cc.sessionId) {
      throw new Error(`Resumable node must have a Claude session id: ${node.id}`);
    }
    if (!state.worktrees[node.git.worktreeId]) {
      throw new Error(`Node references missing worktree: ${node.id}`);
    }
    for (const parentId of node.parents) {
      const parent = state.nodes[parentId];
      if (!parent) throw new Error(`Node references missing parent: ${node.id}`);
      if (!parent.children.includes(node.id)) {
        throw new Error(`Parent ${parentId} does not reference child ${node.id}`);
      }
    }
    for (const childId of node.children) {
      const child = state.nodes[childId];
      if (!child) throw new Error(`Node references missing child: ${node.id}`);
      if (!child.parents.includes(node.id)) {
        throw new Error(`Child ${childId} does not reference parent ${node.id}`);
      }
    }
  }

  const currentWorktrees = Object.values(state.worktrees).filter((worktree) => worktree.status === "current");
  if (currentWorktrees.length !== 1) throw new Error("Exactly one worktree must be current");
  if (currentWorktrees[0]?.id !== state.currentWorktreeId) {
    throw new Error("currentWorktreeId must match the current worktree status");
  }
  for (const worktree of Object.values(state.worktrees)) {
    if (!state.nodes[worktree.currentNodeId]) {
      throw new Error(`Worktree references missing current node: ${worktree.id}`);
    }
  }
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function chooseFocusAfterDelete(state: CcflowState, parentId: string): string {
  const parent = getNode(state, parentId);
  if (isLeafNode(state, parent.id)) return parent.id;
  for (const childId of parent.children) {
    if (isLeafNode(state, childId)) return childId;
  }
  return parent.id;
}
