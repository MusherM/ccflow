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
  commitMessage?: string | null;
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
      commitMessage: input.commitMessage ?? null,
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

export function isMergeResultNode(node: CcflowNode): boolean {
  return node.parents.length > 1;
}

export function hasNodeStats(node: CcflowNode): boolean {
  return (
    node.stats.filesChanged !== 0 ||
    node.stats.insertions !== 0 ||
    node.stats.deletions !== 0 ||
    node.stats.symbolsChanged.length > 0
  );
}

export function isPrunableEmptyNode(state: CcflowState, nodeId: string): boolean {
  const node = getNode(state, nodeId);
  return (
    node.parents.length > 0 &&
    node.children.length === 0 &&
    !isMergeResultNode(node) &&
    !node.git.commitHash &&
    !node.cc.sessionId &&
    !hasNodeStats(node) &&
    !node.locked &&
    !node.jobId &&
    !node.pendingParentJobId
  );
}

export function isOperationBlockedNode(state: CcflowState, nodeId: string): boolean {
  const node = getNode(state, nodeId);
  const worktree = getWorktree(state, node.git.worktreeId);
  return (
    Boolean(node.locked) ||
    Boolean(worktree.locked) ||
    node.status === "AwaitingParentCommit" ||
    node.status === "ParentCommitting" ||
    node.status === "ParentCommitFailed" ||
    node.status === "CommitFailed" ||
    node.status === "JobFailed"
  );
}

export function isEditableLeaf(state: CcflowState, nodeId: string): boolean {
  const node = getNode(state, nodeId);
  return isLeafNode(state, node.id) && !isOperationBlockedNode(state, node.id);
}

export function isSafeFocusTarget(state: CcflowState, nodeId: string): boolean {
  const node = state.nodes[nodeId];
  if (!node) return false;
  return node.type === "leaf" || node.status === "sealed" || node.status === "MergeConflict" || Boolean(node.error);
}

export function ensureCommitReady(state: CcflowState, nodeId: string): void {
  const node = getNode(state, nodeId);
  if (node.status === "AwaitingParentCommit") {
    throw new Error(`Node is waiting for parent commit: ${node.id}`);
  }
  if (node.status === "ParentCommitFailed") {
    throw new Error(`Node parent commit failed: ${node.id}`);
  }
  if (node.pendingParentJobId) {
    throw new Error(`Node is waiting for parent job ${node.pendingParentJobId}`);
  }
  for (const parentId of node.parents) {
    const parent = getNode(state, parentId);
    if (parent.status === "ParentCommitting" || parent.status === "ParentCommitFailed") {
      throw new Error(`Parent commit is not ready for node: ${node.id}`);
    }
  }
}

export function assertCanAddChildOnBranch(state: CcflowState, parentId: string, branch: string): void {
  const parent = getNode(state, parentId);
  const existing = parent.children.map((childId) => state.nodes[childId]).find((child) => child?.git.branch === branch);
  if (existing) {
    throw new Error(`Node ${parent.id} already has child ${existing.id} on branch ${branch}`);
  }
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
  leaf.git.commitMessage = input.commitMessage;
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
      commitMessage: null,
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

export function createPendingChildFromLeaf(
  state: CcflowState,
  input: {
    leafId: string;
    jobId: string;
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
  leaf.status = "ParentCommitting";
  leaf.locked = true;
  leaf.jobId = input.jobId;
  leaf.error = null;
  leaf.blockedReason = null;
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
      commitMessage: null,
      branch: leaf.git.branch,
      worktreeId: leaf.git.worktreeId,
    },
    cc: {
      sessionId: null,
      processId: null,
      resumeMode: "new",
    },
    stats: emptyStats(),
    status: "AwaitingParentCommit",
    locked: true,
    pendingParentJobId: input.jobId,
    blockedReason: "Waiting for parent commit to finish.",
  };

  state.nodes[child.id] = child;
  const worktree = getWorktree(state, child.git.worktreeId);
  worktree.currentNodeId = child.id;
  state.currentNodeId = child.id;
  assertGraphInvariants(state);
  return child;
}

export function finalizePendingParentCommit(
  state: CcflowState,
  input: {
    parentId: string;
    commitHash: string;
    commitMessage: string;
    sessionId: string | null;
    stats: NodeStats;
    now?: string;
  },
): void {
  const parent = getNode(state, input.parentId);
  if (parent.status !== "ParentCommitting" && parent.status !== "Committing") {
    throw new Error(`Node is not waiting for a parent commit: ${parent.id}`);
  }
  const now = input.now ?? new Date().toISOString();
  const jobId = parent.jobId ?? null;
  parent.status = "sealed";
  parent.locked = false;
  parent.jobId = null;
  parent.git.commitHash = input.commitHash;
  parent.git.commitMessage = input.commitMessage;
  parent.title = firstLine(input.commitMessage) || parent.title;
  parent.stats = input.stats;
  parent.cc.sessionId = input.sessionId;
  parent.cc.processId = null;
  parent.cc.resumeMode = input.sessionId ? "resume" : "new";
  parent.error = null;
  parent.blockedReason = null;
  parent.updatedAt = now;

  for (const childId of parent.children) {
    const child = getNode(state, childId);
    if (child.pendingParentJobId === jobId || child.status === "AwaitingParentCommit") {
      child.locked = false;
      child.pendingParentJobId = null;
      child.blockedReason = null;
      child.status = child.cc.sessionId ? "LeafResumable" : "LeafNew";
      child.updatedAt = now;
    }
  }
  assertGraphInvariants(state);
}

export function failPendingParentCommit(
  state: CcflowState,
  input: {
    parentId: string;
    error: string;
    now?: string;
  },
): void {
  const parent = getNode(state, input.parentId);
  const now = input.now ?? new Date().toISOString();
  parent.status = "ParentCommitFailed";
  parent.locked = false;
  parent.error = input.error;
  parent.blockedReason = "Parent commit failed.";
  parent.updatedAt = now;
  for (const childId of parent.children) {
    const child = getNode(state, childId);
    if (child.status === "AwaitingParentCommit" || child.pendingParentJobId === parent.jobId) {
      child.status = "ParentCommitFailed";
      child.locked = true;
      child.pendingParentJobId = null;
      child.error = input.error;
      child.blockedReason = "Parent commit failed. Retry the parent commit or delete this pending child.";
      child.updatedAt = now;
    }
  }
  parent.jobId = null;
  assertGraphInvariants(state);
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
  ensureCommitReady(state, base.id);
  if (!base.git.commitHash && !input.baseCommitHash) {
    throw new Error("Cannot branch from node without commit");
  }
  assertCanAddChildOnBranch(state, base.id, input.branchName);

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
      commitMessage: null,
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
    commitMessage?: string | null;
    now?: string;
    idFactory?: IdFactory;
  },
): CcflowNode {
  if (input.nodeIds.length < 2) throw new Error("Merge requires at least two leaf nodes");

  const leaves = input.nodeIds.map((nodeId) => getNode(state, nodeId));
  for (const node of leaves) {
    if (!isLeafNode(state, node.id)) throw new Error("Only leaf nodes can be merged");
    if (node.locked) throw new Error(`Cannot merge locked node: ${node.id}`);
    ensureCommitReady(state, node.id);
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
      commitMessage: input.commitMessage ?? null,
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

  for (const worktree of Object.values(state.worktrees)) {
    if (worktree.status === "current") worktree.status = "other";
  }

  state.nodes[mergeNode.id] = mergeNode;
  state.worktrees[input.worktreeId] = {
    id: input.worktreeId,
    path: input.worktreePath,
    branch: input.branchName,
    currentNodeId: mergeNode.id,
    status: "current",
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
  state.currentWorktreeId = mergeNode.git.worktreeId;
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
  const deletedParentIds = [...node.parents];

  for (const parentId of node.parents) {
    const parent = getNode(state, parentId);
    parent.children = parent.children.filter((childId) => childId !== node.id);
    parent.updatedAt = now;
  }

  delete state.nodes[node.id];

  const pruneResult = pruneEmptyAncestors(state, deletedParentIds, now);
  normalizeChildlessParents(state, [...deletedParentIds, ...pruneResult.touchedParentIds], now);
  removeUnusedWorktrees(state, deletedWorktreeId);

  const focusId = chooseFocusAfterDelete(state, pruneResult.nearestRemainingAncestorId ?? primaryParent.id);
  const focusNode = getNode(state, focusId);
  const focusWorktree = getWorktree(state, focusNode.git.worktreeId);
  for (const worktree of Object.values(state.worktrees)) {
    if (worktree.id === focusWorktree.id) {
      worktree.status = "current";
    } else if (worktree.status === "current") {
      worktree.status = "other";
    }

    const currentNode = state.nodes[worktree.currentNodeId];
    if (
      worktree.id === focusWorktree.id ||
      !currentNode ||
      currentNode.id === node.id ||
      currentNode.git.worktreeId !== worktree.id
    ) {
      const replacementId = chooseWorktreeCurrentNode(state, worktree.id, worktree.id === focusWorktree.id ? focusNode.id : undefined);
      if (!replacementId) throw new Error(`Worktree has no remaining node: ${worktree.id}`);
      worktree.currentNodeId = replacementId;
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
    if (
      node.locked ||
      node.status === "Committing" ||
      node.status === "ParentCommitting" ||
      node.status === "AwaitingParentCommit" ||
      node.status === "MergeRunning" ||
      node.status === "Branching" ||
      node.status === "Deleting"
    ) {
      node.locked = false;
      node.status = node.status === "AwaitingParentCommit" ? "ParentCommitFailed" : "JobFailed";
      node.error = "Job was interrupted because ccflow exited.";
      node.blockedReason = "Interrupted job requires retry, repair, or deletion.";
      node.pendingParentJobId = null;
      node.jobId = null;
    }
  }
  for (const worktree of Object.values(state.worktrees)) {
    worktree.locked = false;
    if (worktree.status === "locked") worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
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
    if (
      node.type === "internal" &&
      node.status !== "sealed" &&
      node.status !== "Branching" &&
      node.status !== "ParentCommitting" &&
      node.status !== "ParentCommitFailed" &&
      node.status !== "JobFailed"
    ) {
      throw new Error(`Internal node must be sealed or branching: ${node.id}`);
    }
    if (node.status === "AwaitingParentCommit" && !node.pendingParentJobId) {
      throw new Error(`Pending child must reference a parent job: ${node.id}`);
    }
    if (node.pendingParentJobId) {
      const parent = node.parents.map((parentId) => state.nodes[parentId]).find(Boolean);
      if (!parent || parent.jobId !== node.pendingParentJobId) {
        throw new Error(`Pending child references missing parent job: ${node.id}`);
      }
    }
    if (node.status === "ParentCommitting" && (!node.jobId || !node.locked)) {
      throw new Error(`Parent commit node must be locked and reference a job: ${node.id}`);
    }
    if (
      node.locked &&
      !node.jobId &&
      !node.pendingParentJobId &&
      node.status !== "Deleting" &&
      node.status !== "MergeConflict" &&
      node.status !== "ParentCommitFailed"
    ) {
      throw new Error(`Locked node must reference a job: ${node.id}`);
    }
    if (isMergeResultNode(node) && node.parents.length < 2) {
      throw new Error(`Merge result must have at least two parents: ${node.id}`);
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
    const childByBranch = new Map<string, string>();
    for (const childId of node.children) {
      const child = state.nodes[childId]!;
      const previousChildId = childByBranch.get(child.git.branch);
      if (previousChildId) {
        throw new Error(`Node ${node.id} has multiple children on branch ${child.git.branch}: ${previousChildId}, ${child.id}`);
      }
      childByBranch.set(child.git.branch, child.id);
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
    const currentNode = state.nodes[worktree.currentNodeId]!;
    if (currentNode.git.worktreeId !== worktree.id) {
      throw new Error(`Worktree current node belongs to another worktree: ${worktree.id}`);
    }
    if (worktree.locked) {
      const owner = Object.values(state.nodes).find((node) => node.git.worktreeId === worktree.id && node.locked);
      if (!owner) throw new Error(`Locked worktree has no locked node owner: ${worktree.id}`);
    }
  }
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function chooseFocusAfterDelete(state: CcflowState, parentId: string): string {
  const parent = state.nodes[parentId];
  if (parent && isSafeFocusTarget(state, parent.id) && isLeafNode(state, parent.id)) return parent.id;
  if (parent) {
    for (const childId of parent.children) {
      const child = state.nodes[childId];
      if (child?.git.worktreeId === parent.git.worktreeId && isSafeFocusTarget(state, child.id) && isLeafNode(state, child.id)) {
        return child.id;
      }
    }
    if (isSafeFocusTarget(state, parent.id)) return parent.id;
    for (const childId of parent.children) {
      if (isSafeFocusTarget(state, childId) && isLeafNode(state, childId)) return childId;
    }
  }
  for (const node of Object.values(state.nodes)) {
    if (node.git.worktreeId === state.currentWorktreeId && isSafeFocusTarget(state, node.id) && isLeafNode(state, node.id)) return node.id;
  }
  for (const node of Object.values(state.nodes)) {
    if (isSafeFocusTarget(state, node.id) && isLeafNode(state, node.id)) return node.id;
  }
  if (state.nodes[state.currentNodeId]) return state.currentNodeId;
  const fallback = Object.values(state.nodes)[0];
  if (!fallback) throw new Error("Cannot choose focus after deleting the last node");
  return fallback.id;
}

function chooseWorktreeCurrentNode(state: CcflowState, worktreeId: string, preferredNodeId?: string): string | null {
  const preferredNode = preferredNodeId ? state.nodes[preferredNodeId] : undefined;
  if (preferredNode?.git.worktreeId === worktreeId) return preferredNode.id;

  const currentNode = state.nodes[state.worktrees[worktreeId]?.currentNodeId ?? ""];
  if (currentNode?.git.worktreeId === worktreeId) return currentNode.id;

  const candidates = Object.values(state.nodes)
    .filter((node) => node.git.worktreeId === worktreeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return candidates.find((node) => isSafeFocusTarget(state, node.id))?.id ?? candidates[0]?.id ?? null;
}

function pruneEmptyAncestors(
  state: CcflowState,
  parentIds: string[],
  now: string,
): { nearestRemainingAncestorId: string | null; touchedParentIds: string[] } {
  let nearestRemainingAncestorId: string | null = null;
  const touchedParentIds: string[] = [];
  const queue = [...parentIds];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) continue;
    if (!isPrunableEmptyNode(state, node.id)) {
      nearestRemainingAncestorId ??= node.id;
      continue;
    }
    const nextParents = [...node.parents];
    for (const parentId of nextParents) {
      const parent = state.nodes[parentId];
      if (!parent) continue;
      parent.children = parent.children.filter((childId) => childId !== node.id);
      parent.updatedAt = now;
      touchedParentIds.push(parent.id);
      queue.push(parent.id);
    }
    delete state.nodes[node.id];
  }
  return { nearestRemainingAncestorId, touchedParentIds };
}

function normalizeChildlessParents(state: CcflowState, candidateIds: string[], now: string): void {
  const queue = [...candidateIds];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) continue;
    queue.push(...node.parents);
    if (node.children.length !== 0 || node.type !== "internal") continue;
    node.type = "leaf";
    node.status = node.cc.sessionId ? "LeafResumable" : "LeafNew";
    node.locked = false;
    node.jobId = null;
    node.error = null;
    node.blockedReason = null;
    node.pendingParentJobId = null;
    node.cc.processId = null;
    node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
    node.updatedAt = now;
  }
}

function removeUnusedWorktrees(state: CcflowState, preferredWorktreeId?: string): void {
  const used = new Set(Object.values(state.nodes).map((node) => node.git.worktreeId));
  const ids = preferredWorktreeId ? [preferredWorktreeId, ...Object.keys(state.worktrees)] : Object.keys(state.worktrees);
  for (const worktreeId of ids) {
    if (worktreeId === "wt_main") continue;
    if (!used.has(worktreeId)) delete state.worktrees[worktreeId];
  }
}
