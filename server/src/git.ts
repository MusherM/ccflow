import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nodeWorktreePath } from "./paths.js";
import { run, tryRun } from "./shell.js";

export class GitService {
  ensureRepo(repoPath: string) {
    fs.mkdirSync(repoPath, { recursive: true });

    const existing = tryRun("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath });
    if (existing.ok) {
      const topLevel = path.resolve(existing.stdout);
      this.ensureInitialCommit(topLevel);
      return topLevel;
    }

    run("git", ["init"], { cwd: repoPath });
    this.ensureInitialCommit(repoPath);
    return path.resolve(repoPath);
  }

  ensureInitialCommit(repoPath: string) {
    const head = tryRun("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoPath });
    if (head.ok) return;

    run("git", ["commit", "--allow-empty", "-m", "Initialize CCFlow repository"], {
      cwd: repoPath,
      env: {
        GIT_AUTHOR_NAME: "CCFlow",
        GIT_AUTHOR_EMAIL: "ccflow@local",
        GIT_COMMITTER_NAME: "CCFlow",
        GIT_COMMITTER_EMAIL: "ccflow@local"
      }
    });
  }

  currentCommit(repoPath: string) {
    return run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  }

  repoName(repoPath: string) {
    return path.basename(repoPath);
  }

  createInternalRef(repoPath: string, nodeId: string, commit: string) {
    const ref = `refs/ccflow/snapshots/${nodeId}`;
    run("git", ["update-ref", ref, commit], { cwd: repoPath });
    return ref;
  }

  createWorktree(input: {
    projectId: string;
    repoPath: string;
    nodeId: string;
    baseCommit: string;
    kind: string;
  }) {
    const worktreePath = nodeWorktreePath(input.projectId, input.nodeId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    const branch = `ccflow/${input.kind}/${input.nodeId}`;
    if (!fs.existsSync(worktreePath)) {
      run("git", ["worktree", "add", "-B", branch, worktreePath, input.baseCommit], {
        cwd: input.repoPath
      });
    }

    return { worktreePath, branch };
  }

  snapshot(worktreePath: string, nodeId: string) {
    run("git", ["add", "-A"], { cwd: worktreePath });
    const changed = tryRun("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath });
    if (!changed.ok) {
      run(
        "git",
        ["commit", "-m", `Record CCFlow node ${nodeId}`],
        {
          cwd: worktreePath,
          env: {
            GIT_AUTHOR_NAME: "CCFlow",
            GIT_AUTHOR_EMAIL: "ccflow@local",
            GIT_COMMITTER_NAME: "CCFlow",
            GIT_COMMITTER_EMAIL: "ccflow@local"
          }
        }
      );
    }

    const commit = this.currentCommit(worktreePath);
    const ref = this.createInternalRef(worktreePath, nodeId, commit);
    return { commit, ref };
  }

  createRollbackWorktree(input: {
    projectId: string;
    repoPath: string;
    targetNodeId: string;
    targetCommit: string;
  }) {
    const nodeId = randomUUID();
    const { worktreePath } = this.createWorktree({
      projectId: input.projectId,
      repoPath: input.repoPath,
      nodeId,
      baseCommit: input.targetCommit,
      kind: "rollback"
    });
    return { nodeId, worktreePath };
  }

  mergeIntoWorktree(input: { worktreePath: string; sourceCommits: string[] }) {
    for (const commit of input.sourceCommits) {
      const result = tryRun("git", ["merge", "--no-edit", commit], { cwd: input.worktreePath });
      if (!result.ok) {
        const conflicts = this.conflictFiles(input.worktreePath);
        return { clean: false, conflicts, error: result.stderr };
      }
    }
    return { clean: true, conflicts: [] as string[] };
  }

  conflictFiles(worktreePath: string) {
    const output = tryRun("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: worktreePath });
    if (!output.ok || !output.stdout) return [];
    return output.stdout.split("\n").filter(Boolean);
  }

  statusShort(repoPath: string) {
    return run("git", ["status", "--short"], { cwd: repoPath });
  }
}
