import { randomUUID } from "node:crypto";
import path from "node:path";
import { ClaudeAdapter } from "./claude.js";
import { GitAdapter, mergeBranchName, worktreeIdFromBranch, worktreePathForBranch } from "./git.js";
import {
  branchFromNode,
  createMergeNode,
  deleteLeafNode,
  firstLine,
  getNode,
  getWorktree,
  isLeafNode,
  nearestAncestorCommit,
  sealLeafAndCreateChild,
} from "./graph.js";
import { logEvent } from "./log.js";
import { loadPrompts, saveJob, saveState, saveSession } from "./storage.js";
import type { CcflowNode, CcflowState, JobRecord, NodeStats } from "./types.js";

export interface CommitJobResult {
  success: boolean;
  commitHash?: string;
  commitMessage?: string;
  summary?: NodeStats;
  error?: string;
}

export interface MergeJobResult {
  success: boolean;
  commitHash?: string;
  branch?: string;
  worktreeId?: string;
  worktreePath?: string;
  conflicts?: string[];
  error?: string;
}

export class JobRunner {
  constructor(
    private readonly git = new GitAdapter(),
    private readonly claude = new ClaudeAdapter(),
  ) {}

  async commitLeaf(state: CcflowState, nodeId: string): Promise<CommitJobResult> {
    const node = getNode(state, nodeId);
    const worktree = getWorktree(state, node.git.worktreeId);
    if (!isLeafNode(state, node.id)) return { success: false, error: "Only leaf nodes can be committed by ccflow." };

    const existingCommit = this.git.currentCommit(worktree.path);
    if (!this.git.hasDirtyChanges(worktree.path)) {
      return {
        success: true,
        commitHash: existingCommit ?? node.git.commitHash ?? undefined,
        commitMessage: node.title,
        summary: existingCommit ? this.git.diffStats(worktree.path, existingCommit) : node.stats,
      };
    }

    const job = this.startJob(state.repoRoot, {
      type: "commit",
      nodeId: node.id,
      worktreeId: worktree.id,
      promptKey: "commit",
    });
    node.status = "Committing";
    node.locked = true;
    node.jobId = job.jobId;
    worktree.locked = true;
    saveState(state);

    try {
      this.updateJob(state.repoRoot, job, "inspecting");
      const prompts = loadPrompts(state.repoRoot);
      const prompt = [
        prompts.commit.system,
        "",
        prompts.commit.prompt,
        "",
        "Node:",
        JSON.stringify({ id: node.id, title: node.title, branch: node.git.branch }, null, 2),
        "",
        "Git status:",
        this.git.statusShort(worktree.path) || "(clean)",
        "",
        "Git diff:",
        this.git.diff(worktree.path) || "(no diff)",
        "",
        "Create exactly one git commit in this worktree before exiting.",
      ].join("\n");

      this.updateJob(state.repoRoot, job, "running-claude");
      const result = this.claude.runHeadless(prompt, worktree.path);
      if (!result.ok) throw new Error(result.stderr || result.stdout || "Claude commit job failed");

      this.updateJob(state.repoRoot, job, "committing");
      if (this.git.hasDirtyChanges(worktree.path)) {
        throw new Error("Claude commit job exited but the worktree is still dirty.");
      }
      const commitHash = this.git.currentCommit(worktree.path);
      if (!commitHash || commitHash === existingCommit) {
        throw new Error("Claude commit job did not create a new commit.");
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
      node.status = "CommitFailed";
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

  async createSiblingNode(state: CcflowState, nodeId: string): Promise<CcflowNode> {
    const node = getNode(state, nodeId);
    if (node.parents.length === 0) throw new Error("Root node cannot create a sibling");

    if (isLeafNode(state, node.id)) {
      const result = await this.commitLeaf(state, node.id);
      if (!result.success || !result.commitHash) throw new Error(result.error ?? "Commit failed before sibling creation");
      node.git.commitHash = result.commitHash;
      node.title = firstLine(result.commitMessage ?? node.title);
      node.stats = result.summary ?? node.stats;
      saveSession(state.repoRoot, node);
    }

    const parent = getNode(state, node.parents[0]!);
    const baseCommit = parent.git.commitHash ?? nearestAncestorCommit(state, node.parents[0]!)?.commitHash;
    if (!baseCommit) throw new Error("Cannot create sibling because no ancestor commit exists");

    const branch = `ccflow/sibling-${parent.id.slice(0, 8)}-${Date.now().toString(36)}`;
    const worktreePath = worktreePathForBranch(state.repoRoot, branch);
    this.git.createWorktree({
      repoRoot: state.repoRoot,
      path: worktreePath,
      branch,
      baseCommit,
    });

    const sibling = branchFromNode(state, {
      nodeId: parent.id,
      worktreeId: worktreeIdFromBranch(branch),
      worktreePath,
      branchName: branch,
      baseCommitHash: baseCommit,
    });
    sibling.title = `Sibling of ${node.title}`;
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
      if (resetTarget) {
        logEvent(state.repoRoot, "delete-leaf:reset-hard", {
          nodeId: node.id,
          worktreePath: worktree.path,
          commitHash: resetTarget.commitHash,
          commitNodeId: resetTarget.nodeId,
        });
        this.git.resetHard(worktree.path, resetTarget.commitHash);
      } else {
        logEvent(state.repoRoot, "delete-leaf:no-reset-target", {
          nodeId: node.id,
          reason: "No ancestor commit found; deleting graph node only.",
        });
      }
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
      const result = await this.commitLeaf(state, leaf.id);
      if (!result.success || !result.commitHash) throw new Error(result.error ?? `Commit failed for ${leaf.id}`);
      leaf.git.commitHash = result.commitHash;
      leaf.title = firstLine(result.commitMessage ?? leaf.title);
      leaf.stats = result.summary ?? leaf.stats;
      saveSession(state.repoRoot, leaf);
    }

    const mergeResult = await this.runMergeJob(state, leaves);
    if (!mergeResult.success || !mergeResult.commitHash || !mergeResult.branch || !mergeResult.worktreeId || !mergeResult.worktreePath) {
      throw new Error(mergeResult.error ?? "Merge job failed");
    }

    const node = createMergeNode(state, {
      nodeIds,
      worktreeId: mergeResult.worktreeId,
      worktreePath: mergeResult.worktreePath,
      branchName: mergeResult.branch,
      commitHash: mergeResult.commitHash,
    });
    node.title = this.git.lastCommitMessage(mergeResult.worktreePath).split(/\r?\n/, 1)[0]?.trim() || "Merge";
    node.stats = this.git.diffStats(mergeResult.worktreePath, mergeResult.commitHash);
    saveState(state);
    return node;
  }

  private async runMergeJob(state: CcflowState, leaves: CcflowNode[]): Promise<MergeJobResult> {
    const branch = mergeBranchName(leaves.map((node) => node.id));
    const worktreePath = worktreePathForBranch(state.repoRoot, branch);
    const worktreeId = worktreeIdFromBranch(branch);
    const base = leaves[0];
    if (!base?.git.commitHash) return { success: false, error: "Merge base has no commit." };

    this.git.createMergeWorktree({
      repoRoot: state.repoRoot,
      path: worktreePath,
      branch,
      baseCommit: base.git.commitHash,
    });

    const job = this.startJob(state.repoRoot, {
      type: "merge",
      inputNodeIds: leaves.map((node) => node.id),
      worktreeId,
      promptKey: "merge",
    });
    try {
      const prompts = loadPrompts(state.repoRoot);
      const sourceCommits = leaves.slice(1).map((node) => node.git.commitHash).filter(Boolean);
      const prompt = [
        prompts.merge.system,
        "",
        prompts.merge.prompt,
        "",
        "Merge worktree:",
        worktreePath,
        "",
        "Source commits to merge:",
        sourceCommits.join("\n"),
        "",
        "Run the necessary git merge commands, resolve conflicts, run checks when practical, and create one merge commit.",
      ].join("\n");

      this.updateJob(state.repoRoot, job, "running-claude");
      const result = this.claude.runHeadless(prompt, worktreePath);
      if (!result.ok) throw new Error(result.stderr || result.stdout || "Claude merge job failed");

      const conflicts = this.git.conflictFiles(worktreePath);
      if (conflicts.length > 0) {
        job.status = "conflict";
        job.error = `Merge conflicts: ${conflicts.join(", ")}`;
        saveJob(state.repoRoot, job);
        return { success: false, branch, worktreeId, worktreePath, conflicts, error: job.error };
      }
      if (this.git.hasDirtyChanges(worktreePath)) {
        throw new Error("Claude merge job exited but the merge worktree is still dirty.");
      }
      const commitHash = this.git.currentCommit(worktreePath);
      if (!commitHash || commitHash === base.git.commitHash) throw new Error("Claude merge job did not create a merge commit.");

      this.finishJob(state.repoRoot, job, { commitHash, branch, worktreeId, worktreePath });
      return { success: true, commitHash, branch, worktreeId, worktreePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failJob(state.repoRoot, job, message);
      return { success: false, branch, worktreeId, worktreePath, error: message };
    }
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
}
