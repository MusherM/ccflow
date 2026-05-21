import fs from "node:fs";
import path from "node:path";
import { runCommand, tryCommand } from "./shell.js";
import type { NodeStats } from "./types.js";

const gitIdentity = {
  GIT_AUTHOR_NAME: "CCFlow",
  GIT_AUTHOR_EMAIL: "ccflow@local",
  GIT_COMMITTER_NAME: "CCFlow",
  GIT_COMMITTER_EMAIL: "ccflow@local",
};

const userPathspec = [".", ":(exclude).ccflow", ":(exclude).worktrees", ":(exclude).DS_Store", ":(exclude).claude"];

export class GitAdapter {
  ensureRepo(cwd: string): string {
    const existing = tryCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (existing.ok) {
      const root = path.resolve(existing.stdout.trim());
      this.ensureHead(root);
      return root;
    }

    fs.mkdirSync(cwd, { recursive: true });
    runCommand("git", ["init"], { cwd });
    this.ensureHead(cwd);
    return path.resolve(cwd);
  }

  ensureHead(repoRoot: string): void {
    const head = tryCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
    if (head.ok) return;
    runCommand("git", ["commit", "--allow-empty", "-m", "Initialize CCFlow repository"], {
      cwd: repoRoot,
      env: { ...process.env, ...gitIdentity },
    });
  }

  currentCommit(cwd: string): string | null {
    const result = tryCommand("git", ["rev-parse", "HEAD"], { cwd });
    return result.ok ? result.stdout.trim() : null;
  }

  currentBranch(cwd: string): string {
    const branch = tryCommand("git", ["branch", "--show-current"], { cwd });
    if (branch.ok && branch.stdout.trim()) return branch.stdout.trim();
    const abbrev = tryCommand("git", ["rev-parse", "--short", "HEAD"], { cwd });
    return abbrev.ok ? `detached-${abbrev.stdout.trim()}` : "main";
  }

  hasDirtyChanges(cwd: string): boolean {
    return this.statusShort(cwd).length > 0;
  }

  statusShort(cwd: string): string {
    const result = tryCommand("git", ["status", "--porcelain", "--", ...userPathspec], { cwd });
    return result.ok ? result.stdout.trim() : "";
  }

  diff(cwd: string): string {
    const staged = tryCommand("git", ["diff", "--cached", "--", ...userPathspec], { cwd });
    const unstaged = tryCommand("git", ["diff", "--", ...userPathspec], { cwd });
    return [staged.ok ? staged.stdout : "", unstaged.ok ? unstaged.stdout : ""].filter(Boolean).join("\n");
  }

  addAll(cwd: string): void {
    runCommand("git", ["add", "-A", "--", ...userPathspec], { cwd });
  }

  commit(cwd: string, message: string): string {
    this.addAll(cwd);
    runCommand("git", ["commit", "-m", message], {
      cwd,
      env: { ...process.env, ...gitIdentity },
    });
    const commitHash = this.currentCommit(cwd);
    if (!commitHash) throw new Error("Commit succeeded but HEAD could not be resolved");
    return commitHash;
  }

  resetHard(cwd: string, commitHash: string): void {
    runCommand("git", ["reset", "--hard", commitHash], { cwd });
  }

  createWorktree(input: {
    repoRoot: string;
    path: string;
    branch: string;
    baseCommit: string;
  }): { id: string; path: string; branch: string } {
    fs.mkdirSync(path.dirname(input.path), { recursive: true });
    if (!fs.existsSync(input.path)) {
      runCommand("git", ["worktree", "add", "-B", input.branch, input.path, input.baseCommit], {
        cwd: input.repoRoot,
      });
    }
    return { id: worktreeIdFromBranch(input.branch), path: input.path, branch: input.branch };
  }

  createMergeWorktree(input: {
    repoRoot: string;
    path: string;
    branch: string;
    baseCommit: string;
    existingBranch?: boolean;
  }): { id: string; path: string; branch: string; detached: boolean } {
    fs.mkdirSync(path.dirname(input.path), { recursive: true });
    if (!fs.existsSync(input.path)) {
      if (input.existingBranch) {
        runCommand("git", ["worktree", "add", "--detach", input.path, input.baseCommit], {
          cwd: input.repoRoot,
        });
      } else {
        runCommand("git", ["worktree", "add", "-B", input.branch, input.path, input.baseCommit], {
          cwd: input.repoRoot,
        });
      }
    }
    return {
      id: worktreeIdFromBranch(input.branch),
      path: input.path,
      branch: input.branch,
      detached: input.existingBranch ?? false,
    };
  }

  updateRef(repoRoot: string, ref: string, commit: string): void {
    runCommand("git", ["update-ref", ref, commit], { cwd: repoRoot });
  }

  checkoutNewBranch(cwd: string, branch: string): void {
    runCommand("git", ["checkout", "-b", branch], { cwd });
  }

  conflictFiles(cwd: string): string[] {
    const result = tryCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd });
    return result.ok ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  merge(sourceCommit: string, cwd: string): { ok: boolean; conflicts: string[] } {
    const result = tryCommand("git", ["merge", sourceCommit, "--no-commit", "--no-ff"], { cwd });
    if (result.ok) return { ok: true, conflicts: [] };
    return { ok: false, conflicts: this.conflictFiles(cwd) };
  }

  isAncestor(ancestorCommit: string, descendantCommit: string, cwd: string): boolean {
    return tryCommand("git", ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit], { cwd }).ok;
  }

  lastCommitMessage(cwd: string): string {
    const result = tryCommand("git", ["log", "-1", "--pretty=%B"], { cwd });
    return result.ok ? result.stdout.trim() : "";
  }

  diffStats(cwd: string, commitHash?: string | null): NodeStats {
    if (!commitHash) return { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] };
    const short = tryCommand("git", ["diff-tree", "--shortstat", "--no-commit-id", "-r", commitHash], { cwd });
    const names = tryCommand("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash], { cwd });
    const stats = parseShortStat(short.ok ? short.stdout : "");
    const filesChanged = names.ok ? names.stdout.split(/\r?\n/).filter(Boolean).length : stats.filesChanged;
    return {
      ...stats,
      filesChanged,
      symbolsChanged: [],
    };
  }
}

export function isDefaultBranch(branch: string): boolean {
  return branch === "main" || branch === "master";
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function branchNameForNode(nodeId: string): string {
  return `ccflow/${nodeId}`;
}

export function mergeBranchName(nodeIds: string[]): string {
  return slug(`ccflow/merge-${nodeIds.map((id) => id.slice(0, 8)).join("-")}`);
}

export function worktreeIdFromBranch(branch: string): string {
  return `wt_${slug(branch).replaceAll("/", "_")}`;
}

export function worktreePathForBranch(repoRoot: string, branch: string): string {
  return path.join(repoRoot, ".worktrees", slug(branch).replaceAll("/", "-"));
}

function parseShortStat(value: string): Omit<NodeStats, "symbolsChanged"> {
  const files = value.match(/(\d+)\s+files? changed/);
  const insertions = value.match(/(\d+)\s+insertions?\(\+\)/);
  const deletions = value.match(/(\d+)\s+deletions?\(-\)/);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}
