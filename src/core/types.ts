export type NodeType = "leaf" | "internal";

export type NodeStatus =
  | "LeafNew"
  | "LeafRunning"
  | "LeafSuspended"
  | "LeafResumable"
  | "LeafDirty"
  | "AwaitingParentCommit"
  | "Committing"
  | "CommitFailed"
  | "ParentCommitting"
  | "ParentCommitFailed"
  | "Branching"
  | "BranchFailed"
  | "Deleting"
  | "MergeRunning"
  | "MergeConflict"
  | "JobFailed"
  | "sealed";

export type ResumeMode = "attached" | "resume" | "new";

export type WorktreeStatus = "current" | "other" | "dirty" | "clean" | "locked";

export interface NodeStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  symbolsChanged: string[];
}

export interface NodeGitInfo {
  commitHash: string | null;
  commitMessage?: string | null;
  branch: string;
  worktreeId: string;
}

export interface NodeClaudeInfo {
  sessionId: string | null;
  processId: number | null;
  resumeMode: ResumeMode;
}

export interface CcflowNode {
  id: string;
  title: string;
  type: NodeType;
  parents: string[];
  children: string[];
  createdAt: string;
  updatedAt: string;
  git: NodeGitInfo;
  cc: NodeClaudeInfo;
  stats: NodeStats;
  status: NodeStatus;
  locked?: boolean;
  jobId?: string | null;
  pendingParentJobId?: string | null;
  blockedReason?: string | null;
  conflictFiles?: string[];
  error?: string | null;
}

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  currentNodeId: string;
  status: WorktreeStatus;
  locked?: boolean;
}

export interface CcflowSettings {
  worktree: {
    enterLeafAutoSwitch: boolean;
    warnBeforeSwitch: boolean;
  };
  merge: {
    sealMergedInputs: boolean;
  };
}

export interface CcflowUiPreferences {
  focusNodeId?: string;
  graphViewport?: {
    x: number;
    y: number;
  };
}

export interface CcflowState {
  version: 1;
  repoRoot: string;
  currentWorktreeId: string;
  currentNodeId: string;
  settings: CcflowSettings;
  ui?: CcflowUiPreferences;
  nodes: Record<string, CcflowNode>;
  worktrees: Record<string, WorktreeInfo>;
}

export interface PromptCommandConfig {
  diff?: string;
  status?: string;
  commit?: string;
  merge?: string;
  test?: string;
}

export interface PromptEntry {
  system: string;
  prompt: string;
  strategy?: string;
  commands: PromptCommandConfig;
}

export interface PromptsConfig {
  commit: PromptEntry;
  merge: PromptEntry;
}

export type JobStatus =
  | "pending"
  | "preparing"
  | "inspecting"
  | "running-claude"
  | "committing"
  | "success"
  | "conflict"
  | "interrupted"
  | "failed";

export interface JobRecord {
  jobId: string;
  type: "commit" | "merge" | "branch" | "delete";
  status: JobStatus;
  nodeId?: string;
  inputNodeIds?: string[];
  worktreeId?: string;
  promptKey: "commit" | "merge";
  recoverable?: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: unknown;
}

export const emptyStats = (): NodeStats => ({
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  symbolsChanged: [],
});
