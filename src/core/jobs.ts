import { randomUUID } from "node:crypto";
import path from "node:path";
import { ClaudeAdapter } from "./claude.js";
import { GitAdapter, isDefaultBranch, mergeBranchName, slug, worktreeIdFromBranch, worktreePathForBranch } from "./git.js";
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
        "Review the worktree below. You MUST leave it in a clean committed state — or clean with nothing to commit.",
        "",
        "Step 1 — Find and ignore non-project files:",
        "  - Look at every untracked file",
        "  - For files that do NOT belong (build output, downloads, logs, personal files, etc.), add their patterns to .gitignore",
        "",
        "Step 2 — Stage and commit:",
        "  - Run: git add .  (the updated .gitignore will exclude non-project files)",
        "  - If there are staged changes, run: git commit -m \"<conventional-commit-message>\"",
        "  - If nothing is staged after git add ., stop — do NOT create an empty commit",
        "",
        "Do not ask questions. Follow the steps in order.",
        "",
        "Node:",
        JSON.stringify({ id: node.id, title: node.title, branch: node.git.branch }, null, 2),
        "",
        "Git status:",
        this.git.statusShort(worktree.path) || "(clean)",
        "",
        "Git diff:",
        this.git.diff(worktree.path) || "(no diff)",
      ].join("\n");

      this.updateJob(state.repoRoot, job, "running-claude");
      logEvent(state.repoRoot, "commit-leaf:claude-start", {
        nodeId: node.id,
        worktreePath: worktree.path,
        promptLength: prompt.length,
      });
      const result = this.claude.runHeadless(state.repoRoot, prompt, worktree.path);
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

  async createSiblingNode(state: CcflowState, nodeId: string, customBranchName?: string): Promise<CcflowNode> {
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

    const branch = customBranchName
      ? `ccflow/${slug(customBranchName)}`
      : `ccflow/sibling-${parent.id.slice(0, 8)}-${Date.now().toString(36)}`;
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
    sibling.title = customBranchName ? `${customBranchName} (fork)` : `Sibling of ${node.title}`;
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

    // Determine target branch: prefer main/master if any leaf is on it
    const mainLeaf = leaves.find((l) => isDefaultBranch(l.git.branch));
    const targetBranch = mainLeaf?.git.branch ?? mergeBranchName(leaves.map((n) => n.id));
    const base = mainLeaf ?? leaves[0];
    if (!base?.git.commitHash) throw new Error("Merge base has no commit.");

    const mergeSuffix = Date.now().toString(36);
    const worktreeBranch = mainLeaf
      ? `ccflow/merged-${slug(targetBranch)}-${mergeSuffix}`
      : `${targetBranch}-${mergeSuffix}`;
    const worktreePath = worktreePathForBranch(state.repoRoot, worktreeBranch);
    const worktreeId = worktreeIdFromBranch(worktreeBranch);

    const { detached } = this.git.createMergeWorktree({
      repoRoot: state.repoRoot,
      path: worktreePath,
      branch: worktreeBranch,
      baseCommit: base.git.commitHash,
      existingBranch: mainLeaf != null,
    });

    logEvent(state.repoRoot, "merge-leaves:git-merge-start", {
      baseNodeId: base.id,
      baseCommit: base.git.commitHash,
      sourceNodeIds: leaves.filter((n) => n.id !== base.id).map((n) => n.id),
      sourceCommits: leaves.filter((n) => n.id !== base.id).map((n) => n.git.commitHash),
      targetBranch,
      detached,
    });

    // Try automatic git merge for each source commit
    let allConflicts: string[] = [];
    const sources = leaves.filter((l) => l.id !== base.id);
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
      // If the merge was a no-op (already up to date), use the existing HEAD.
      let commitHash: string;
      if (this.git.hasDirtyChanges(worktreePath)) {
        const commitMsg = `Merge ${sources.map((n) => firstLine(n.title)).join(", ")} into ${firstLine(base.title)}`;
        commitHash = this.git.commit(worktreePath, commitMsg);
      } else {
        commitHash = this.git.currentCommit(worktreePath) ?? base.git.commitHash;
      }

      if (detached && mainLeaf) {
        this.git.updateRef(state.repoRoot, `refs/heads/${targetBranch}`, commitHash);
        this.git.checkoutNewBranch(worktreePath, worktreeBranch);
      }

      const node = createMergeNode(state, {
        nodeIds,
        worktreeId,
        worktreePath,
        branchName: targetBranch,
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
      branchName: targetBranch,
      commitHash: null,
    });
    node.status = "MergeConflict";
    node.title = `Merge (conflicts: ${allConflicts.join(", ")})`;
    saveState(state);

    logEvent(state.repoRoot, "merge-leaves:conflict-node-created", {
      mergeNodeId: node.id,
      conflictFiles: allConflicts,
    });

    // Run headless Claude to attempt conflict resolution
    const prompts = loadPrompts(state.repoRoot);
    const prompt = [
      prompts.merge.system,
      "",
      prompts.merge.prompt,
      "",
      "Merge worktree:",
      worktreePath,
      "",
      "Conflict files:",
      allConflicts.join("\n"),
      "",
      "Git status:",
      this.git.statusShort(worktreePath) || "(clean)",
      "",
      "Resolve all merge conflicts and create a merge commit. If you cannot resolve everything, leave the remaining conflicts for manual resolution.",
    ].join("\n");

    logEvent(state.repoRoot, "merge-leaves:headless-resolution-start", { mergeNodeId: node.id });
    const result = this.claude.runHeadless(state.repoRoot, prompt, worktreePath);
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
        if (detached && mainLeaf) {
          this.git.updateRef(state.repoRoot, `refs/heads/${targetBranch}`, commitHash);
          this.git.checkoutNewBranch(worktreePath, worktreeBranch);
        }
        node.git.commitHash = commitHash;
        node.status = "LeafResumable";
        node.title = this.git.lastCommitMessage(worktreePath).split(/\r?\n/, 1)[0]?.trim() || "Merge";
        node.stats = this.git.diffStats(worktreePath, commitHash);
        saveState(state);
        logEvent(state.repoRoot, "merge-leaves:headless-resolution-success", { mergeNodeId: node.id, commitHash });
        return node;
      }
    }

    // Still conflicted — user needs to take over interactively
    node.status = "MergeConflict";
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
}
