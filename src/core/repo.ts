import fs from "node:fs";
import path from "node:path";
import { GitAdapter } from "./git.js";
import { normalizeAfterBoot } from "./graph.js";
import { ccflowDir, ensureCcflowDirs, loadOrInitState, saveState, statePath } from "./storage.js";
import type { CcflowState } from "./types.js";

export interface RepositoryResolution {
  startPath: string;
  gitRoot: string | null;
  repoRoot: string | null;
  stateFile: string | null;
  initialized: boolean;
  fromManagedWorktree: boolean;
}

export interface InitResult {
  repoRoot: string;
  stateFile: string;
  alreadyInitialized: boolean;
}

export class RepositoryError extends Error {}

export function resolveRepository(input: {
  startPath?: string;
  repoPath?: string;
  git?: GitAdapter;
} = {}): RepositoryResolution {
  const git = input.git ?? new GitAdapter();
  const startPath = path.resolve(input.repoPath ?? input.startPath ?? process.cwd());
  const gitRoot = git.findRepoRoot(startPath);
  if (!gitRoot) {
    return {
      startPath,
      gitRoot: null,
      repoRoot: null,
      stateFile: null,
      initialized: false,
      fromManagedWorktree: false,
    };
  }

  const owner = findCcflowOwnerForGitRoot(gitRoot);
  const repoRoot = owner?.repoRoot ?? gitRoot;
  const file = statePath(repoRoot);
  return {
    startPath,
    gitRoot,
    repoRoot,
    stateFile: file,
    initialized: fs.existsSync(file),
    fromManagedWorktree: Boolean(owner?.fromManagedWorktree),
  };
}

export function initCcflowProject(input: {
  startPath?: string;
  repoPath?: string;
  gitInit?: boolean;
  git?: GitAdapter;
} = {}): InitResult {
  const git = input.git ?? new GitAdapter();
  const startPath = path.resolve(input.repoPath ?? input.startPath ?? process.cwd());
  let resolution = resolveRepository({ startPath, git });
  if (!resolution.gitRoot) {
    if (!input.gitInit) {
      throw new RepositoryError("CCFlow init requires an existing Git repository. Re-run with `ccflow init --git` to create one.");
    }
    git.initRepo(startPath);
    resolution = resolveRepository({ startPath, git });
  }
  if (!resolution.repoRoot) throw new RepositoryError("Unable to resolve repository root.");

  const repoRoot = resolution.repoRoot;
  const alreadyInitialized = fs.existsSync(statePath(repoRoot));
  git.ensureHead(repoRoot);
  git.ensureInternalExcludes(repoRoot);
  ensureCcflowDirs(repoRoot);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  normalizeAfterBoot(state);
  saveState(state);
  return {
    repoRoot,
    stateFile: statePath(repoRoot),
    alreadyInitialized,
  };
}

export function loadInitializedState(repoRoot: string, git = new GitAdapter()): CcflowState {
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  normalizeAfterBoot(state);
  saveState(state);
  return state;
}

function findCcflowOwnerForGitRoot(gitRoot: string): { repoRoot: string; fromManagedWorktree: boolean } | null {
  const matches: Array<{ repoRoot: string; fromManagedWorktree: boolean }> = [];
  for (const candidate of ancestors(gitRoot)) {
    const file = statePath(candidate);
    if (!fs.existsSync(file)) continue;
    const state = readState(file);
    if (!state) continue;
    if (samePath(candidate, gitRoot)) {
      matches.push({ repoRoot: candidate, fromManagedWorktree: false });
      continue;
    }
    const worktreeMatch = Object.values(state.worktrees ?? {}).some((worktree) => samePath(worktree.path, gitRoot));
    if (worktreeMatch) matches.push({ repoRoot: candidate, fromManagedWorktree: true });
  }

  const unique = new Map(matches.map((match) => [realOrResolve(match.repoRoot), match]));
  if (unique.size > 1) {
    throw new RepositoryError(`Ambiguous CCFlow owner for worktree ${gitRoot}. Use --repo to select a repository.`);
  }
  return unique.values().next().value ?? null;
}

function readState(file: string): CcflowState | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CcflowState;
  } catch {
    return null;
  }
}

function ancestors(input: string): string[] {
  const result: string[] = [];
  let current = path.resolve(input);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

function samePath(a: string, b: string): boolean {
  return realOrResolve(a) === realOrResolve(b);
}

function realOrResolve(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function isCcflowInitialized(repoRoot: string): boolean {
  return fs.existsSync(statePath(repoRoot));
}

export function ccflowStateSummary(repoRoot: string): string {
  return `${ccflowDir(repoRoot)} (${fs.existsSync(statePath(repoRoot)) ? "initialized" : "not initialized"})`;
}
