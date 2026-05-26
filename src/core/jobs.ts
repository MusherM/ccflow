import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudeAdapter } from "./claude.js";
import { loadConfig } from "./config.js";
import { GitAdapter, isDefaultBranch, mergeBranchName, slug, worktreeIdFromBranch, worktreePathForBranch } from "./git.js";
import {
  assertCanAddChildOnBranch,
  branchFromNode,
  createPendingChildFromLeaf,
  createMergeNode,
  deleteLeafNode,
  ensureCommitReady,
  failPendingParentCommit,
  finalizePendingParentCommit,
  firstLine,
  getNode,
  getWorktree,
  isLeafNode,
  nearestAncestorCommit,
  sealLeafAndCreateChild,
} from "./graph.js";
import { logEvent } from "./log.js";
import { buildCommitPrompt, buildMergePrompt } from "./prompts.js";
import { saveJob, saveState, saveSession } from "./storage.js";
import type { CcflowNode, CcflowState, JobRecord, NodeStats } from "./types.js";

export interface CommitJobResult {
  success: boolean;
  commitHash?: string;
  commitMessage?: string;
  summary?: NodeStats;
  error?: string;
}

export type BranchTarget =
  | { kind: "new"; name?: string }
  | { kind: "existing"; branch: string };

export interface BranchCreationPlan {
  branches: string[];
  defaultBranch: string | null;
  requiresName: boolean;
}

export class JobRunner {
  constructor(
    private readonly git = new GitAdapter(),
    private readonly claude = new ClaudeAdapter(),
  ) {}

  async commitLeaf(
    state: CcflowState,
    nodeId: string,
    options: { allowPendingInternal?: boolean; job?: JobRecord } = {},
  ): Promise<CommitJobResult> {
    const node = getNode(state, nodeId);
    const worktree = getWorktree(state, node.git.worktreeId);
    const canCommitPendingInternal = options.allowPendingInternal && node.type === "internal" && node.status === "ParentCommitting";
    if (!isLeafNode(state, node.id) && !canCommitPendingInternal) {
      return { success: false, error: "Only leaf nodes can be committed by ccflow." };
    }

    const existingCommit = this.git.currentCommit(worktree.path);
    if (!this.git.hasDirtyChanges(worktree.path)) {
      return {
        success: true,
        commitHash: existingCommit ?? node.git.commitHash ?? undefined,
        commitMessage: node.title,
        summary: existingCommit ? this.git.diffStats(worktree.path, existingCommit) : node.stats,
      };
    }

    const job = options.job ?? this.startJob(state.repoRoot, {
      type: "commit",
      nodeId: node.id,
      worktreeId: worktree.id,
      promptKey: "commit",
    });
    node.status = canCommitPendingInternal ? "ParentCommitting" : "Committing";
    node.locked = true;
    node.jobId = job.jobId;
    worktree.locked = true;
    saveState(state);

    try {
      this.updateJob(state.repoRoot, job, "inspecting");

      const loadedConfig = loadConfig({ repoRoot: state.repoRoot });
      const prompt = buildCommitPrompt({
        config: loadedConfig.config,
        node,
        gitStatus: this.git.statusShort(worktree.path),
        gitDiff: this.git.diff(worktree.path),
      });

      this.updateJob(state.repoRoot, job, "running-claude");
      logEvent(state.repoRoot, "commit-leaf:claude-start", {
        nodeId: node.id,
        worktreePath: worktree.path,
        promptLength: prompt.length,
      });
      const result = this.claude.runHeadless(state.repoRoot, prompt, worktree.path, loadedConfig.config);
      logEvent(state.repoRoot, "commit-leaf:claude-done", {
        nodeId: node.id,
        ok: result.ok,
        exitCode: null,
        stdoutLen: result.stdout.length,
        stderrLen: result.stderr.length,
        stdoutTail: result.stdout.slice(-1000),
        stderrTail: result.stderr.slice(-1000),
      });

      if (!result.ok) throw new Error(result.stderr || result.stdout || "Claude commit job failed");

      this.updateJob(state.repoRoot, job, "committing");
      const dirtyAfter = this.git.hasDirtyChanges(worktree.path);
      logEvent(state.repoRoot, "commit-leaf:dirty-check", {
        nodeId: node.id,
        stillDirty: dirtyAfter,
        existingCommit,
        statusShort: this.git.statusShort(worktree.path),
      });
      if (dirtyAfter) {
        logEvent(state.repoRoot, "commit-leaf:fallback-direct", { nodeId: node.id });
        try {
          this.git.commit(worktree.path, node.title || "Auto commit");
        } catch (commitError) {
          logEvent(state.repoRoot, "commit-leaf:fallback-skipped", {
            nodeId: node.id,
            reason: commitError instanceof Error ? commitError.message : String(commitError),
          });
        }
      }
      if (this.git.hasDirtyChanges(worktree.path)) {
        throw new Error("Commit job left dirty changes after Claude returned successfully.");
      }
      const commitHash = this.git.currentCommit(worktree.path);
      if (!commitHash) throw new Error("Unable to resolve HEAD after commit attempt.");

      // If nothing needed committing, return the existing commit — this is not an error
      if (commitHash === existingCommit) {
        this.finishJob(state.repoRoot, job, { commitHash, commitMessage: node.title, summary: node.stats });
        node.locked = false;
        node.jobId = null;
        worktree.locked = false;
        worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
        return { success: true, commitHash, commitMessage: node.title, summary: node.stats };
      }

      const commitMessage = this.git.lastCommitMessage(worktree.path);
      const summary = this.git.diffStats(worktree.path, commitHash);
      this.finishJob(state.repoRoot, job, {
        commitHash,
        commitMessage,
        summary,
      });
      node.locked = false;
      node.jobId = null;
      worktree.locked = false;
      worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
      return { success: true, commitHash, commitMessage, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failJob(state.repoRoot, job, message);
      node.status = canCommitPendingInternal ? "ParentCommitFailed" : "CommitFailed";
      node.locked = false;
      node.error = message;
      worktree.locked = false;
      worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
      saveState(state);
      return { success: false, error: message };
    }
  }

  async createNextNode(state: CcflowState, nodeId: string): Promise<CcflowNode> {
    const node = getNode(state, nodeId);
    const worktree = getWorktree(state, node.git.worktreeId);
    if (!isLeafNode(state, node.id)) throw new Error("Only leaf nodes can create next node");
    if (node.locked || worktree.locked) throw new Error(`Cannot create next node while node or worktree is locked: ${node.id}`);

    if (this.git.hasDirtyChanges(worktree.path)) {
      const job = this.startJob(state.repoRoot, {
        type: "commit",
        nodeId: node.id,
        worktreeId: worktree.id,
        promptKey: "commit",
      });
      const child = createPendingChildFromLeaf(state, {
        leafId: node.id,
        jobId: job.jobId,
      });
      worktree.locked = true;
      saveState(state);
      void this.completePendingNextNode(state, node.id, child.id, job);
      return child;
    }

    const commitResult = await this.commitLeaf(state, node.id);
    if (!commitResult.success || !commitResult.commitHash) {
      throw new Error(commitResult.error ?? "Commit job failed");
    }

    const child = sealLeafAndCreateChild(state, {
      leafId: node.id,
      commitHash: commitResult.commitHash,
      commitMessage: commitResult.commitMessage ?? node.title,
      sessionId: node.cc.sessionId,
      stats: commitResult.summary ?? node.stats,
    });
    saveSession(state.repoRoot, node);
    worktree.currentNodeId = child.id;
    saveState(state);
    return child;
  }

  branchCreationPlan(state: CcflowState, nodeId: string): BranchCreationPlan {
    const node = getNode(state, nodeId);
    const branches = Object.values(state.worktrees)
      .map((worktree) => worktree.branch)
      .filter((branch) => branch.startsWith("ccflow/"));
    const defaultBranch = branches.includes(node.git.branch) ? node.git.branch : (branches[0] ?? null);
    return {
      branches,
      defaultBranch,
      requiresName: branches.length === 0,
    };
  }

  normalizeNewBranchName(state: CcflowState, value: string | undefined): string {
    const normalized = slug(value ?? "");
    if (!normalized) throw new Error("Branch name cannot be empty");
    const branch = normalized.startsWith("ccflow/") ? normalized : `ccflow/${normalized}`;
    const worktreeId = worktreeIdFromBranch(branch);
    if (state.worktrees[worktreeId]) throw new Error(`Branch already exists: ${branch}`);
    return branch;
  }

  async createSiblingNode(
    state: CcflowState,
    nodeId: string,
    target: string | BranchTarget | undefined = undefined,
  ): Promise<CcflowNode> {
    const node = getNode(state, nodeId);
    if (node.parents.length === 0) throw new Error("Root node cannot create a sibling");
    if (node.locked || getWorktree(state, node.git.worktreeId).locked) {
      throw new Error(`Cannot create sibling while node or worktree is locked: ${node.id}`);
    }
    ensureCommitReady(state, node.id);

    const parent = getNode(state, node.parents[0]!);
    const baseCommit = parent.git.commitHash ?? nearestAncestorCommit(state, node.parents[0]!)?.commitHash;
    if (!baseCommit) throw new Error("Cannot create sibling because no ancestor commit exists");

    const targetChoice: BranchTarget =
      typeof target === "string"
        ? { kind: "new", name: target }
        : (target ?? { kind: "new", name: `sibling-${parent.id.slice(0, 8)}-${Date.now().toString(36)}` });
    const branch = targetChoice.kind === "existing"
      ? targetChoice.branch
      : this.normalizeNewBranchName(state, targetChoice.name);
    assertCanAddChildOnBranch(state, parent.id, branch);

    if (isLeafNode(state, node.id)) {
      const result = await this.commitLeaf(state, node.id);
      if (!result.success || !result.commitHash) throw new Error(result.error ?? "Commit failed before sibling creation");
      node.git.commitHash = result.commitHash;
      node.title = firstLine(result.commitMessage ?? node.title);
      node.stats = result.summary ?? node.stats;
      saveSession(state.repoRoot, node);
    }

    const worktreePath = worktreePathForBranch(state.repoRoot, branch);
    const existingWorktree = state.worktrees[worktreeIdFromBranch(branch)];
    if (!existingWorktree) {
      this.git.createWorktree({
        repoRoot: state.repoRoot,
        path: worktreePath,
        branch,
        baseCommit,
      });
    }

    const sibling = branchFromNode(state, {
      nodeId: parent.id,
      worktreeId: worktreeIdFromBranch(branch),
      worktreePath: existingWorktree?.path ?? worktreePath,
      branchName: branch,
      baseCommitHash: baseCommit,
    });
    sibling.title = targetChoice.kind === "new" && targetChoice.name ? `${targetChoice.name} (fork)` : `Sibling of ${node.title}`;
    saveState(state);
    return sibling;
  }

  async deleteLeaf(state: CcflowState, nodeId: string): Promise<CcflowNode> {
    const node = getNode(state, nodeId);
    if (!isLeafNode(state, node.id)) throw new Error("Only leaf nodes can be deleted");
    const parentId = node.parents[0];
    if (!parentId) throw new Error("Cannot delete the root leaf node");
    const resetTarget = nearestAncestorCommit(state, node.id);
    const worktree = getWorktree(state, node.git.worktreeId);
    if (worktree.locked && !node.locked) throw new Error(`Cannot delete leaf while worktree is locked: ${worktree.id}`);
    logEvent(state.repoRoot, "delete-leaf:start", {
      nodeId: node.id,
      parentIds: node.parents,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      resetTarget,
      wasLocked: Boolean(node.locked),
      status: node.status,
    });

    node.locked = true;
    node.status = "Deleting";
    worktree.locked = true;
    saveState(state);

    try {
      if (resetTarget && fs.existsSync(worktree.path)) {
        logEvent(state.repoRoot, "delete-leaf:reset-hard", {
          nodeId: node.id,
          worktreePath: worktree.path,
          commitHash: resetTarget.commitHash,
          commitNodeId: resetTarget.nodeId,
        });
        this.git.resetHard(worktree.path, resetTarget.commitHash);
      } else if (resetTarget) {
        logEvent(state.repoRoot, "delete-leaf:missing-worktree-skip-reset", {
          nodeId: node.id,
          worktreePath: worktree.path,
          commitHash: resetTarget.commitHash,
          commitNodeId: resetTarget.nodeId,
        });
      } else {
        logEvent(state.repoRoot, "delete-leaf:no-reset-target", {
          nodeId: node.id,
          reason: "No ancestor commit found; deleting graph node only.",
        });
      }
      worktree.locked = false;
      const { focusId } = deleteLeafNode(state, { nodeId: node.id, force: true });
      const focusWorktree = getWorktree(state, getNode(state, focusId).git.worktreeId);
      focusWorktree.locked = false;
      saveState(state);
      logEvent(state.repoRoot, "delete-leaf:success", {
        nodeId,
        focusId,
      });
      return getNode(state, focusId);
    } catch (error) {
      node.locked = false;
      node.status = node.cc.sessionId ? "LeafResumable" : "LeafNew";
      node.error = error instanceof Error ? error.message : String(error);
      worktree.locked = false;
      worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
      saveState(state);
      logEvent(state.repoRoot, "delete-leaf:failed", {
        nodeId,
        error: node.error,
      });
      throw error;
    }
  }

  async mergeLeaves(state: CcflowState, nodeIds: string[]): Promise<CcflowNode> {
    if (nodeIds.length < 2) throw new Error("Merge requires at least two leaf nodes");
    const leaves = nodeIds.map((nodeId) => getNode(state, nodeId));
    for (const leaf of leaves) {
      if (!isLeafNode(state, leaf.id)) throw new Error("Only leaf nodes can be merged");
      if (leaf.locked) throw new Error(`Cannot merge locked node: ${leaf.id}`);
      ensureCommitReady(state, leaf.id);
      const result = await this.commitLeaf(state, leaf.id);
      if (!result.success || !result.commitHash) throw new Error(result.error ?? `Commit failed for ${leaf.id}`);
      leaf.git.commitHash = result.commitHash;
      leaf.title = firstLine(result.commitMessage ?? leaf.title);
      leaf.stats = result.summary ?? leaf.stats;
      saveSession(state.repoRoot, leaf);
    }

    // Determine target branch: prefer main/master if any leaf is on it.
    // In that case the merge result belongs to the checked-out default branch,
    // so the merge must happen in that branch's existing worktree.
    const mainLeaf = leaves.find((l) => isDefaultBranch(l.git.branch));
    const targetBranch = mainLeaf?.git.branch ?? mergeBranchName(leaves.map((n) => n.id));
    const base = mainLeaf ?? leaves[0];
    if (!base?.git.commitHash) throw new Error("Merge base has no commit.");
    const sources = leaves.filter((l) => l.id !== base.id);
    const alreadyIncludedSources = sources.filter(
      (source) =>
        source.git.commitHash && this.git.isAncestor(source.git.commitHash, base.git.commitHash!, state.repoRoot),
    );
    if (sources.length > 0 && alreadyIncludedSources.length === sources.length) {
      logEvent(state.repoRoot, "merge-leaves:already-included", {
        baseNodeId: base.id,
        baseCommit: base.git.commitHash,
        sourceNodeIds: alreadyIncludedSources.map((source) => source.id),
        sourceCommits: alreadyIncludedSources.map((source) => source.git.commitHash),
      });
      throw new Error(
        `Selected commits are already included in ${base.id} (${base.git.commitHash.slice(0, 7)}); no merge node created.`,
      );
    }

    let worktreeBranch: string;
    let worktreePath: string;
    let worktreeId: string;
    let detached = false;

    if (mainLeaf) {
      const mainWorktree = getWorktree(state, mainLeaf.git.worktreeId);
      worktreeBranch = targetBranch;
      worktreePath = mainWorktree.path;
      worktreeId = mainWorktree.id;
      const currentCommit = this.git.currentCommit(worktreePath);
      if (currentCommit !== base.git.commitHash) {
        throw new Error(
          `Default branch worktree is at ${currentCommit?.slice(0, 7) ?? "unknown"}, expected ${base.git.commitHash.slice(0, 7)}.`,
        );
      }
    } else {
      const mergeSuffix = Date.now().toString(36);
      worktreeBranch = `${targetBranch}-${mergeSuffix}`;
      worktreePath = worktreePathForBranch(state.repoRoot, worktreeBranch);
      worktreeId = worktreeIdFromBranch(worktreeBranch);
      detached = this.git.createMergeWorktree({
        repoRoot: state.repoRoot,
        path: worktreePath,
        branch: worktreeBranch,
        baseCommit: base.git.commitHash,
      }).detached;
    }

    logEvent(state.repoRoot, "merge-leaves:git-merge-start", {
      baseNodeId: base.id,
      baseCommit: base.git.commitHash,
      sourceNodeIds: leaves.filter((n) => n.id !== base.id).map((n) => n.id),
      sourceCommits: leaves.filter((n) => n.id !== base.id).map((n) => n.git.commitHash),
      targetBranch,
      worktreeBranch,
      detached,
    });

    // Try automatic git merge for each source commit
    let allConflicts: string[] = [];
    for (const leaf of sources) {
      if (!leaf.git.commitHash) continue;
      const mergeResult = this.git.merge(leaf.git.commitHash, worktreePath);
      if (!mergeResult.ok) {
        allConflicts = [...allConflicts, ...mergeResult.conflicts];
      }
    }

    logEvent(state.repoRoot, "merge-leaves:git-merge-done", {
      hasConflicts: allConflicts.length > 0,
      conflictFiles: allConflicts,
    });

    if (allConflicts.length === 0) {
      // git merge --no-commit stages the changes; create our own commit with a custom message.
      // If git produces no staged file changes, keep the merge worktree at its current HEAD.
      let commitHash: string;
      if (this.git.hasDirtyChanges(worktreePath)) {
        const commitMsg = `Merge ${sources.map((n) => firstLine(n.title)).join(", ")} into ${firstLine(base.title)}`;
        commitHash = this.git.commit(worktreePath, commitMsg);
      } else {
        commitHash = this.git.currentCommit(worktreePath) ?? base.git.commitHash;
      }

      if (detached) {
        this.git.checkoutNewBranch(worktreePath, worktreeBranch);
      }

      const node = createMergeNode(state, {
        nodeIds,
        worktreeId,
        worktreePath,
        branchName: worktreeBranch,
        commitHash,
      });
      node.title = this.git.lastCommitMessage(worktreePath).split(/\r?\n/, 1)[0]?.trim() || "Merge";
      node.stats = this.git.diffStats(worktreePath, commitHash);
      saveState(state);
      logEvent(state.repoRoot, "merge-leaves:auto-merge-success", { mergeNodeId: node.id, commitHash });
      return node;
    }

    // Conflicts detected — create merge node without commit, then try headless resolution
    const node = createMergeNode(state, {
      nodeIds,
      worktreeId,
      worktreePath,
      branchName: worktreeBranch,
      commitHash: null,
    });
    node.status = "MergeConflict";
    node.title = `Merge (conflicts: ${allConflicts.join(", ")})`;
    node.conflictFiles = allConflicts;
    saveState(state);

    logEvent(state.repoRoot, "merge-leaves:conflict-node-created", {
      mergeNodeId: node.id,
      conflictFiles: allConflicts,
    });

    // Run headless Claude to attempt conflict resolution
    const loadedConfig = loadConfig({ repoRoot: state.repoRoot });
    const prompt = buildMergePrompt({
      config: loadedConfig.config,
      worktreePath,
      conflictFiles: allConflicts,
      gitStatus: this.git.statusShort(worktreePath),
    });

    logEvent(state.repoRoot, "merge-leaves:headless-resolution-start", { mergeNodeId: node.id });
    const result = loadedConfig.config.merge.headlessResolution
      ? this.claude.runHeadless(state.repoRoot, prompt, worktreePath, loadedConfig.config)
      : { ok: false, stdout: "", stderr: "Headless merge resolution is disabled by CCFlow config." };
    logEvent(state.repoRoot, "merge-leaves:headless-resolution-done", {
      mergeNodeId: node.id,
      ok: result.ok,
      stdoutTail: result.stdout.slice(-1000),
      stderrTail: result.stderr.slice(-1000),
    });

    // Check if Claude resolved everything
    const remainingConflicts = this.git.conflictFiles(worktreePath);
    if (remainingConflicts.length === 0 && !this.git.hasDirtyChanges(worktreePath)) {
      const commitHash = this.git.currentCommit(worktreePath);
      if (commitHash && commitHash !== base.git.commitHash) {
        if (detached) {
          this.git.checkoutNewBranch(worktreePath, worktreeBranch);
        }
        node.git.commitHash = commitHash;
        node.status = node.cc.sessionId ? "LeafResumable" : "LeafNew";
        node.title = this.git.lastCommitMessage(worktreePath).split(/\r?\n/, 1)[0]?.trim() || "Merge";
        node.stats = this.git.diffStats(worktreePath, commitHash);
        node.conflictFiles = [];
        saveState(state);
        logEvent(state.repoRoot, "merge-leaves:headless-resolution-success", { mergeNodeId: node.id, commitHash });
        return node;
      }
    }

    // Still conflicted — user needs to take over interactively
    node.status = "MergeConflict";
    node.conflictFiles = remainingConflicts.length > 0 ? remainingConflicts : allConflicts;
    logEvent(state.repoRoot, "merge-leaves:needs-user-resolution", {
      mergeNodeId: node.id,
      remainingConflicts,
    });
    saveState(state);
    return node;
  }

  private startJob(
    repoRoot: string,
    input: Pick<JobRecord, "type" | "nodeId" | "inputNodeIds" | "worktreeId" | "promptKey">,
  ): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      jobId: `job_${input.type}_${randomUUID().slice(0, 8)}`,
      type: input.type,
      status: "pending",
      nodeId: input.nodeId,
      inputNodeIds: input.inputNodeIds,
      worktreeId: input.worktreeId,
      promptKey: input.promptKey,
      createdAt: now,
      updatedAt: now,
    };
    saveJob(repoRoot, job);
    return job;
  }

  private updateJob(repoRoot: string, job: JobRecord, status: JobRecord["status"]): void {
    job.status = status;
    job.updatedAt = new Date().toISOString();
    saveJob(repoRoot, job);
  }

  private finishJob(repoRoot: string, job: JobRecord, result: unknown): void {
    job.status = "success";
    job.result = result;
    job.updatedAt = new Date().toISOString();
    saveJob(repoRoot, job);
  }

  private failJob(repoRoot: string, job: JobRecord, error: string): void {
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date().toISOString();
    saveJob(repoRoot, job);
  }

  private async completePendingNextNode(
    state: CcflowState,
    parentId: string,
    childId: string,
    job: JobRecord,
  ): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const parent = getNode(state, parentId);
    const worktree = getWorktree(state, parent.git.worktreeId);
    try {
      const result = await this.commitLeaf(state, parentId, {
        allowPendingInternal: true,
        job,
      });
      if (!result.success || !result.commitHash) throw new Error(result.error ?? "Commit job failed");
      finalizePendingParentCommit(state, {
        parentId,
        commitHash: result.commitHash,
        commitMessage: result.commitMessage ?? parent.title,
        sessionId: parent.cc.sessionId,
        stats: result.summary ?? parent.stats,
      });
      worktree.locked = false;
      worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
      saveSession(state.repoRoot, parent);
      saveState(state);
      logEvent(state.repoRoot, "create-next:parent-commit-success", {
        parentId,
        childId,
        commitHash: result.commitHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failPendingParentCommit(state, { parentId, error: message });
      worktree.locked = false;
      worktree.status = worktree.id === state.currentWorktreeId ? "current" : "other";
      saveState(state);
      logEvent(state.repoRoot, "create-next:parent-commit-failed", {
        parentId,
        childId,
        error: message,
      });
    }
  }
}
