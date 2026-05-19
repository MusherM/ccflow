export type NodeType = "leaf" | "internal";

export type NodeStatus =
  | "LeafNew"
  | "LeafRunning"
  | "LeafSuspended"
  | "LeafResumable"
  | "LeafDirty"
  | "Committing"
  | "CommitFailed"
  | "Branching"
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
  branch: string;
  worktreeId: string;
}

export interface NodeClaudeInfo {
  sessionId: string | null;
  processId: number | null;
  resumeMode: ResumeMode;
  tmuxSession?: string | null;
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

export interface CcflowState {
  version: 1;
  repoRoot: string;
  currentWorktreeId: string;
  currentNodeId: string;
  settings: CcflowSettings;
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
  | "failed";

export interface JobRecord {
  jobId: string;
  type: "commit" | "merge";
  status: JobStatus;
  nodeId?: string;
  inputNodeIds?: string[];
  worktreeId?: string;
  promptKey: "commit" | "merge";
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
